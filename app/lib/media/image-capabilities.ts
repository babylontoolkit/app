/**
 * WHICH IMAGE MODEL CAN ACTUALLY DO WHAT (SPEC §4.16, FR7) — and how a transparency request is
 * REALIZED on each gateway.
 *
 * ## Why this is a table and not a flag
 *
 * Transparency used to be one boolean, `ImageDelivery.cutout`, which meant two different things at
 * once: *the user wants alpha* and *run a second priced stage*. On KIE those are the same fact —
 * **no** KIE image model emits an alpha channel, so alpha always costs a
 * `recraft/remove-background` pass. On Comet they come apart: `gpt-image-1.5` produces real alpha in
 * ONE call (live-probed 2026-08-10: 74.31% fully transparent, 6.69% semi, decoded pixel by pixel),
 * while `gpt-image-1` and `gpt-image-2` REFUSE the `background` parameter outright.
 *
 * So the capability is per MODEL, not per provider and certainly not per file format — and it has to
 * be data, because the one thing that must never happen is a transparent request quietly rendering
 * OPAQUE. That is the failure §4.16 already shipped once (a logo with a grey box baked in, over a
 * navy hero, where a dark box does not announce itself) and it is the one failure mode that looks
 * exactly like success.
 *
 * ## The two halves, deliberately separated
 *
 *  1. **Intent** — `resolveImageIntent` in `output-format.ts`: does this art need to sit over other
 *     content? Provider-independent, decided from what the CALLER said.
 *  2. **Realization** — here: given the intent, the gateway and the model, what do we actually send,
 *     what lands on disk, and does a second stage get billed?
 *
 * Keeping them apart is what lets the same user request cost two stages on one provider and one on
 * another without the intent decision knowing anything about gateways.
 *
 * ## Client-safe on purpose
 *
 * The Media panel needs this to decide whether to offer the Background dropdown at all — offering a
 * control that the active provider's model will refuse is how a user is invited to pay for something
 * that cannot happen. So it lives under `app/lib/media/`, beside `output-format.ts`, importing
 * nothing from `~/lib/.server/**`.
 */
import type { ImageOutputFormat } from './output-format';

/** The gateways that serve renders. Mirrors `MEDIA_PROVIDERS`; asserted equal in the specs. */
export type ImageProviderName = 'KIE' | 'Comet';

export interface ImageModelCapability {
  /**
   * The model produces a real alpha channel in ONE call (`background: "transparent"`).
   *
   * ⚠️ NEVER infer this from the output format. `output_format: "png"` buys an RGBA CONTAINER, not
   * transparency — measured across every render this platform produced between 2026-07-19 and
   * 2026-07-23, alpha was pinned at 255 for all 4,227,072 pixels of a "png" render. A fully opaque
   * image in an RGBA container passes a naive `colortype === 6` check, which is how that shipped.
   */
  nativeAlpha: boolean;
}

/*
 * ⚠️ NO `minPixels`. The plan called for a per-model pixel floor here (seedream refuses 1024x1024 with
 * "must be at least 3686400 pixels") and it is deliberately ABSENT rather than declared-and-unread:
 * the seedream models that have such a floor are the ones Comet answers 503 for, so nothing shipped
 * needs it, and a field written by nobody and read by nobody is the `PENDING_RENDER_TTL_MS` class —
 * a promise in a type that no code keeps. What actually protects an unserveable size today is the
 * PRICE LIST: only probed (quality, aspectRatio) cells have rows, so anything else is refused in the
 * quote, before the debit. Add the floor back with the model that needs it, and a test.
 */

/**
 * ⚠️ ABSENT MEANS "NO NATIVE ALPHA", WHICH IS THE SAFE DIRECTION. An unknown model resolves to the
 * cut-out realization (or a refusal when the gateway has no cut-out), never to a bare
 * `background: 'transparent'` the model will ignore or reject. Getting this wrong optimistically
 * ships an opaque image against a paid-for transparent request; getting it wrong pessimistically
 * costs a second stage. The asymmetry decides the default.
 */
const CAPABILITIES: Record<ImageProviderName, Record<string, ImageModelCapability>> = {
  /*
   * KIE: NOTHING has native alpha. Nano Banana (the whole line, Pro and 2 included), Flux and
   * Seedream are all flat RGB, and KIE exposes no transparency parameter to ask for one. This empty
   * record is a MEASUREMENT, not a stub — see `output-format.ts`'s header for the raw numbers.
   */
  KIE: {},

  Comet: {
    /* Live-probed 2026-08-10. The only transparency capability on this gateway. */
    'gpt-image-1.5': { nativeAlpha: true },

    /*
     * Probed and REFUSED the parameter. Listed rather than omitted, because "we know this one cannot"
     * and "we have never heard of this one" are different facts and only the first is evidence.
     */
    'gpt-image-1': { nativeAlpha: false },
    'gpt-image-2': { nativeAlpha: false },

    /* Token-priced nano-banana equivalent. No alpha — Google's image models emit flat RGB. */
    'gemini-3-pro-image': { nativeAlpha: false },
  },
};

/**
 * The model this gateway uses when a request needs real alpha in one call — or `null` when it has
 * none and transparency must be realized some other way (KIE's cut-out pass).
 *
 * Deterministic: the FIRST capable model in declaration order, so the substitution a user sees is
 * stable rather than dependent on object iteration luck.
 */
export function nativeAlphaModelFor(provider: ImageProviderName, preferred?: string): string | null {
  const table = CAPABILITIES[provider] ?? {};

  if (preferred && table[preferred]?.nativeAlpha) {
    return preferred;
  }

  return Object.keys(table).find((id) => table[id].nativeAlpha) ?? null;
}

export function imageModelCapability(provider: ImageProviderName, model: string): ImageModelCapability | undefined {
  return CAPABILITIES[provider]?.[model];
}

/** Does this gateway have ANY way to deliver alpha? Drives whether the panel offers the control. */
export function supportsTransparency(provider: ImageProviderName): boolean {
  return hasCutoutPass(provider) || nativeAlphaModelFor(provider) !== null;
}

/**
 * Does this gateway have a priced cut-out pass — i.e. can it add alpha to a model that has none?
 *
 * KIE does (`recraft/remove-background`); Comet has no equivalent in its catalogue, which is why its
 * transparency is per-model rather than universal.
 *
 * ⚠️ Named and exported so there is ONE writer of that fact. It was inlined as `provider === 'KIE'`
 * in the panel *while the panel also called `supportsTransparency`, which encodes the same rule* —
 * two writers of one fact, which is the shape FR7 objects to and the reason the capability is a table.
 *
 * ⚠️ It answers about the gateway's CATALOGUE, not about the operator's active price list. The list
 * is the authority at quote time (an admin who promotes a list without the cut-out row gets a refusal
 * before the debit, `media.spec.ts`), so the panel can over-offer by exactly that one configuration.
 * Deliberate: the alternative is shipping the price list to the browser to render a dropdown.
 */
export function hasCutoutPass(provider: ImageProviderName): boolean {
  return provider === 'KIE';
}

/**
 * HOW a request is actually served — the realization half.
 *
 * 🔴 Computed ONCE per task in `startMediaTask` and passed to the quote, the provider payload AND the
 * destination path. If those three could each derive it, they could each derive it DIFFERENTLY, and
 * the file would be billed as one thing, written as another and referenced as a third.
 */
export interface ImageDelivery {
  /**
   * The model that will actually be called. Usually the requested one; a transparent request on a
   * gateway whose alpha lives in a different model resolves HERE, and the quote reports this id — so
   * the substitution is billed honestly and visibly, never silently.
   */
  model: string;

  /** A SECOND priced stage is owed (`recraft/remove-background`). Never true when `background` is set. */
  cutout: boolean;

  /** Sent as `background: "transparent"` on the payload — one call, real alpha. */
  background?: 'transparent';

  /**
   * What the gateway is asked to render. **jpg whenever a cut-out follows** — the alpha comes from
   * the second stage regardless, and the cut-out provider caps its INPUT at 5MB, which a 2K PNG
   * (measured 4–6MB) blows while the same image as jpg is ~2MB. `png` when the alpha is native,
   * because there is no second stage to carry it.
   */
  renderFormat: ImageOutputFormat;

  /** What lands in the project. `png` for anything with alpha, otherwise the rendered format. */
  finalFormat: ImageOutputFormat;

  /**
   * Append the flat-backdrop directive to the prompt (`cutoutRenderPrompt`).
   *
   * ⚠️ TRUE ONLY FOR A CUT-OUT. That directive exists for the REMOVER's benefit — it stops the model
   * painting a checkerboard the remover would then have to guess about. Sent to a model producing
   * native alpha it does the opposite of its job: it commands a flat opaque backdrop from a model
   * that was about to give us a genuinely empty one.
   */
  cutoutPrompt: boolean;
}

/** Why a transparent request cannot be served here — a sentence for the refusal, never a downgrade. */
export interface ImageDeliveryRefusal {
  refused: string;
}

export function isRefusal(result: ImageDelivery | ImageDeliveryRefusal): result is ImageDeliveryRefusal {
  return 'refused' in result;
}

export interface RealizeInput {
  provider: ImageProviderName;
  model: string;
  wantsAlpha: boolean;

  /** The caller's explicit format, honoured only when there is no alpha to carry. */
  explicitFormat: ImageOutputFormat;

  /** Does this gateway have a priced cut-out stage available? (`recraft/remove-background`.) */
  cutoutAvailable: boolean;
}

/**
 * Map intent onto a gateway.
 *
 * 🔴 **A transparent request that cannot be served is REFUSED, never downgraded.** Dropping the alpha
 * would deliver the exact thing the user paid extra NOT to get, and report success while doing it.
 * That bug has shipped here once already.
 */
export function realizeImageDelivery(input: RealizeInput): ImageDelivery | ImageDeliveryRefusal {
  if (!input.wantsAlpha) {
    return {
      model: input.model,
      cutout: false,
      renderFormat: input.explicitFormat,
      finalFormat: input.explicitFormat,
      cutoutPrompt: false,
    };
  }

  const native = nativeAlphaModelFor(input.provider, input.model);

  if (native) {
    return {
      model: native,
      cutout: false,
      background: 'transparent',
      renderFormat: 'png',
      finalFormat: 'png',
      cutoutPrompt: false,
    };
  }

  if (input.cutoutAvailable) {
    return {
      model: input.model,
      cutout: true,
      renderFormat: 'jpg',
      finalFormat: 'png',
      cutoutPrompt: true,
    };
  }

  return {
    refused:
      `Transparent images cannot be produced on ${input.provider}: no model there emits an alpha ` +
      'channel and no priced cut-out pass is available to add one. Generate this image opaque ' +
      '(transparent: false), or switch MEDIA_PROVIDER to a gateway that can.',
  };
}
