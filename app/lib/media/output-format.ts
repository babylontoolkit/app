/**
 * Choosing an image render's file format (SPEC §4.16).
 *
 * ## Why this is a function and not a constant default
 *
 * Image renders used to default to PNG, on the reasoning "alpha is never lost by accident". That was
 * safe for logos and catastrophic for backgrounds: a 2K PHOTOGRAPHIC png is ~10MB where the same image
 * as jpg is under 1MB for no visible difference — and a landing brief commissions several big
 * photographic backgrounds (hero, scenery, car beauty shots) at once. Those multi-MB PNGs are what blew
 * the working-copy serialize up to gigabytes of base64 and froze the tab (the §4.16 media crash).
 *
 * The model is already TOLD to prefer jpg and reserve png for transparency, but guidance is not a
 * guarantee — when it says nothing, we must not silently pick the 10× format. So:
 *
 *   1. An EXPLICIT choice always wins. The model asked for png (or jpg); it gets it. This preserves the
 *      alpha-safety the old default was protecting — the caller who needs transparency states it.
 *   2. UNSPECIFIED defaults to **jpg**, because the overwhelmingly common unspecified image is
 *      photographic and photographic art is where the weight is.
 *   3. …UNLESS the file name or prompt reads like transparency-needing art (a logo, emblem, sprite,
 *      icon, cut-out), in which case unspecified falls back to png. This is a heuristic, not a promise —
 *      it exists so a model that forgot to say "png" on a logo does not ship a logo with a background,
 *      which is the one failure the old png-default was actually preventing.
 *
 * Pure and exported so the decision is tested rather than re-derived at each call site (the job builder
 * and the destination path must agree on the extension, or the file is written as one format and
 * referenced as another).
 */

export type ImageOutputFormat = 'png' | 'jpg';

/**
 * Words that mean "this art probably needs a transparent background". Deliberately conservative — a
 * false positive costs ~10× the bytes (a photographic image kept as png), a false negative ships a
 * flat background behind a logo. We bias toward png only on strong signals.
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
  'transparent',
  'alpha',
  'silhouette',
];

/**
 * Resolve the output format for an image render.
 *
 * `explicit` is whatever the caller passed (the model's `output_format`, the panel's dropdown) — any
 * value other than a clean `png`/`jpg` is treated as unspecified rather than trusted.
 */
export function resolveImageOutputFormat(
  explicit: string | undefined,
  hints: { fileName?: string; prompt?: string } = {},
): ImageOutputFormat {
  const chosen = explicit?.trim().toLowerCase();

  if (chosen === 'png' || chosen === 'jpg') {
    return chosen;
  }

  const haystack = `${hints.fileName ?? ''} ${hints.prompt ?? ''}`.toLowerCase();

  if (TRANSPARENCY_HINTS.some((hint) => haystack.includes(hint))) {
    return 'png';
  }

  return 'jpg';
}
