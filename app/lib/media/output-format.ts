/**
 * How an image render is DELIVERED (SPEC §4.16) — its file format, and whether it gets a cut-out pass.
 *
 * ## Why this is a function and not a constant default
 *
 * Image renders used to default to PNG, on the reasoning "alpha is never lost by accident". That was
 * safe for logos and catastrophic for backgrounds: a 2K PHOTOGRAPHIC png is ~10MB where the same image
 * as jpg is under 1MB for no visible difference — and a landing brief commissions several big
 * photographic backgrounds (hero, scenery, car beauty shots) at once. Those multi-MB PNGs are what blew
 * the working-copy serialize up to gigabytes of base64 and froze the tab (the §4.16 media crash).
 *
 * ## 🔴 PNG NEVER MEANT TRANSPARENT, AND ASKING FOR IT NEVER WORKED (measured 2026-07-23)
 *
 * The png-for-logos rule above rested on a premise that was never true: that `output_format: "png"`
 * buys alpha. It does not. Google's image models — the whole Nano Banana line, including Pro and
 * Nano Banana 2 — emit FLAT RGB with no alpha channel, and KIE exposes no transparency parameter to
 * ask for one (their nano-banana-2 input is prompt / image_input / aspect_ratio / resolution /
 * output_format, nothing else). The model has no concept of see-through, so when a prompt says
 * "transparent background" it renders a PICTURE of transparency: the editor checkerboard (it reads
 * that pattern as a style, not as UI chrome) or a flat backdrop.
 *
 * Measured across every render this platform has produced, 2026-07-19 → 2026-07-23, before and after
 * the jpg default, all sent with an explicit `output_format: "png"`:
 *
 *  - `/ggc/…` results are **JPEG bytes behind a `.png` URL** — the requested format is ignored outright.
 *  - `/workers/images/…` results are real PNGs, sometimes colortype 2 (no alpha channel at all) and
 *    sometimes colortype 6 (RGBA) — but **alpha pinned at 255 for every one of 4,227,072 pixels**.
 *
 * Not one transparent pixel, ever. An RGBA container with a fully opaque image passes a naive
 * "colortype === 6" check, which is how this survived: a logo shipped with a grey box behind it, over
 * a navy hero where a dark box does not announce itself, and the only loud failure was the render that
 * happened to paint a checkerboard.
 *
 * So transparency is not a FORMAT decision, it is a PIPELINE decision — the alpha has to be cut out
 * after the fact (`recraft/remove-background`, the one transparency capability in KIE's whole catalog).
 * This module decides both halves together, because they are one decision:
 *
 *   1. Does this art need to sit over other content? → `cutout`.
 *   2. Given that, what does KIE render and what lands on disk? → `renderFormat` / `finalFormat`.
 *
 * ⚠️ Note what `cutout` does NOT key off: the image MODEL. No image model on KIE emits alpha (Flux
 * and Seedream are flat RGB too), so the pass is about what the art is FOR, never about who rendered
 * it. Swapping the default model changes nothing here.
 *
 * Pure and exported so the decision is tested rather than re-derived at each call site — the job
 * builder, the price quote and the destination path must all agree, or the file is written as one
 * format, billed as another, and referenced as a third.
 */

export type ImageOutputFormat = 'png' | 'jpg';

/**
 * Words that mean "this art probably needs a transparent background". Deliberately conservative,
 * because a false positive now costs REAL MONEY (a cut-out pass the user did not ask for) rather than
 * just bytes, and a false negative ships a flat background behind a logo.
 *
 * 🔴 `silhouette` is deliberately ABSENT, and must stay absent. It is a style word, not a transparency
 * word: a live hero prompt reading "distant mesa silhouettes" matched it and shipped a 2K photographic
 * background as PNG. Under the old rule that cost bytes; under this one it would spend credits.
 */
const TRANSPARENCY_HINTS = [
  'logo',
  'emblem',
  'badge',
  'crest',
  'sprite',
  'icon',
  'wordmark',
  'cutout',
  'cut-out',
  'cut out',
  'decal',
  'sticker',
  'transparent background',
  'no background',
  'alpha channel',
];

export interface ImageDeliveryHints {
  /** The caller's explicit `output_format`, if any. Anything but a clean png/jpg is "unspecified". */
  explicitFormat?: string;

  /**
   * The caller's explicit transparency intent (`transparent: true` on the tool, the panel's
   * Background dropdown). This is the ONE reliable signal — it asks the question the model can
   * actually answer ("must this sit over other content?") instead of one about file containers.
   */
  transparent?: boolean | string;

  fileName?: string;
  prompt?: string;
}

/**
 * The INTENT half — what the caller asked for, with no gateway in it.
 *
 * 🔴 Split out from the realization on 2026-08-10 (T8). `ImageDelivery.cutout` used to mean two
 * things at once — *the user wants alpha* and *run a second priced stage* — which was correct only
 * for as long as KIE was the only gateway, because there those ARE the same fact. On Comet
 * `gpt-image-1.5` produces real alpha in one call, so the two come apart, and a boolean that fuses
 * them cannot express it. This one answers only the question a caller can actually answer.
 */
export interface ImageIntent {
  /** Must this art sit over other content? */
  wantsAlpha: boolean;

  /** The caller's format, normalised. Honoured only when there is no alpha to carry. */
  format: ImageOutputFormat;
}

export interface ImageDelivery {
  /** Run `recraft/remove-background` on the render — the only way to get real alpha. Costs extra. */
  cutout: boolean;

  /**
   * What KIE is asked to render. **jpg whenever a cut-out follows** — the alpha comes from the second
   * stage regardless, and the cut-out provider caps its INPUT at 5MB, which a 2K PNG (measured 4–6MB)
   * blows while the same image as jpg is ~2MB.
   */
  renderFormat: ImageOutputFormat;

  /** What lands in the project. `png` for a cut-out (RGBA), otherwise the rendered format. */
  finalFormat: ImageOutputFormat;
}

/** Coerce a wire value that may be a real boolean or the string form a `<select>` produces. */
function isTrue(value: boolean | string | undefined): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  return undefined;
}

/**
 * Resolve the format for an image render, ignoring transparency. Kept separate because plenty of
 * callers only need "what extension is this" — the delivery decision is the one that spends money.
 */
export function resolveImageOutputFormat(explicit: string | undefined): ImageOutputFormat {
  const chosen = explicit?.trim().toLowerCase();

  if (chosen === 'png' || chosen === 'jpg') {
    return chosen;
  }

  return 'jpg';
}

/**
 * Decide the whole delivery for one image request.
 *
 * Precedence, strongest first:
 *
 *  1. An explicit `transparent` — true or FALSE. A stated `false` wins over every hint, so a photo
 *     whose prompt happens to mention a logo cannot be charged for a cut-out it does not need.
 *  2. An explicit `output_format: "png"`. The tools and the brief have told the model for months that
 *     png means transparency; honouring that as intent is what finally makes the instruction TRUE
 *     instead of quietly buying an opaque RGBA container.
 *  3. A transparency hint in the file name or prompt — the safety net for a model that says nothing.
 *
 * An explicit `jpg` with no `transparent` flag is opaque, hints or not: jpg is the format that CANNOT
 * carry alpha, so reading it as a transparency request would be reading it backwards.
 */
export function resolveImageDelivery(hints: ImageDeliveryHints = {}): ImageDelivery {
  const { wantsAlpha, format } = resolveImageIntent(hints);

  if (wantsAlpha) {
    return { cutout: true, renderFormat: 'jpg', finalFormat: 'png' };
  }

  return { cutout: false, renderFormat: format, finalFormat: format };
}

/**
 * The INTENT, with no gateway in it — "must this art sit over other content?", plus the caller's
 * format for when the answer is no.
 *
 * 🔴 This is `resolveImageDelivery`'s decision half, extracted so the same question can be answered
 * once and REALIZED differently per gateway (`media/image-capabilities.ts`). The precedence is
 * unchanged and is asserted against the old behaviour, because it is the part users have been
 * training against for months:
 *
 *  1. An explicit `transparent` — true or FALSE. A stated `false` wins over every hint, so a photo
 *     whose prompt happens to mention a logo cannot be charged for alpha it does not need.
 *  2. An explicit `output_format: "png"`. The tools and the brief have told the model for months that
 *     png means transparency; honouring that as INTENT is what finally makes the instruction true
 *     instead of quietly buying an opaque RGBA container.
 *  3. A transparency hint in the file name or prompt — the safety net for a model that says nothing.
 *
 * An explicit `jpg` with no `transparent` flag is opaque, hints or not: jpg is the format that CANNOT
 * carry alpha, so reading it as a transparency request would be reading it backwards.
 */
export function resolveImageIntent(hints: ImageDeliveryHints = {}): ImageIntent {
  const explicit = hints.explicitFormat?.trim().toLowerCase();
  const stated = isTrue(hints.transparent);

  const wantsAlpha = stated ?? (explicit === 'png' ? true : explicit === 'jpg' ? false : hintsSayTransparent(hints));

  return { wantsAlpha, format: resolveImageOutputFormat(hints.explicitFormat) };
}

function hintsSayTransparent(hints: ImageDeliveryHints): boolean {
  const haystack = `${hints.fileName ?? ''} ${hints.prompt ?? ''}`.toLowerCase();

  return TRANSPARENCY_HINTS.some((hint) => haystack.includes(hint));
}

/**
 * The stage-1 prompt for art that will be cut out.
 *
 * Two jobs, both learned from the measurements above. It stops the model PAINTING transparency — a
 * checkerboard baked into the pixels is what the user sees as "the logo is blocking the cars", and a
 * background remover asked to remove a checkerboard is being asked to guess which checks are art (this
 * logo genuinely contains a checkered-flag ribbon). And it asks for the flat uniform backdrop that
 * makes the cut-out unambiguous.
 *
 * Appended, never substituted: the caller's art direction is theirs, and rewriting a user's prompt is
 * how you silently change what they asked for.
 */
export function cutoutRenderPrompt(prompt: string): string {
  return (
    `${prompt.trim()}\n\n` +
    'BACKGROUND (overrides any background described above): place the subject alone on a COMPLETELY ' +
    'FLAT, SOLID, UNIFORM background of a single colour that does not appear in the subject, edge to ' +
    'edge. No gradient, no texture, no vignette, no scenery, no shadow cast onto the background. ' +
    'NEVER draw a checkerboard, chequered grid or grey-and-white square pattern to represent ' +
    'transparency — the background is removed automatically afterwards, so a painted "transparent" ' +
    'pattern would be baked into the artwork permanently.'
  );
}
