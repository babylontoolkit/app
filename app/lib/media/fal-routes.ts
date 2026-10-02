/**
 * fal.ai's routes (SPEC §4.16, `_specs/media-gateways_plan.md` T3) — the ONE place a priced fal model id
 * maps onto the queue path it is submitted to and the payload FAMILY that shapes its body.
 *
 * ## Why a table keyed by the PRICE id
 *
 * On fal the model id IS the submit path (`POST https://queue.fal.run/{id}`), so there is no second
 * spelling to drift — but the request bodies differ per family in ways nothing else in the platform
 * can see: Kling wants its duration as a STRING (`"5"`), Grok as an integer, Veo as `"8s"`; Seedream
 * takes an `image_size` where Nano Banana takes `aspect_ratio` + `resolution`. A model priced in the
 * list but absent here would be debited and then sent a body the gateway rejects, so the service asks
 * this table BEFORE the debit (`falRouteRefusal`) and refuses an unroutable model for free.
 *
 * The service builds the payloads from it and the Media panel reads the same table for its model lists
 * and duration choices — one catalogue, two readers, so the panel cannot offer a duration the server
 * would refuse.
 *
 * ## Client-safe on purpose
 *
 * Imports nothing from `~/lib/.server/**` (the panel ships in the browser bundle).
 *
 * ⚠️ **Built from fal's DOCUMENTED shapes** (each model's `https://fal.ai/models/<id>/llms.txt`, read
 * 2026-10-01). The paid render probe (`scripts/fal-media-probe.mjs`) could not run — fal answered 403
 * "Exhausted balance" — so nothing here has been confirmed by a render yet. Every shape decision lives
 * in this file and `fal-client.ts` so the probe can correct it in one place.
 */

/** How a fal model's request body is shaped. Sound families arrive with T6. */
export type FalFamily =
  | 'image-nano'
  | 'image-seedream'
  | 'cutout'
  | 'video-kling'
  | 'video-grok'
  | 'video-veo'
  | 'sfx'
  | 'tts'
  | 'music-minimax';

export interface FalRoute {
  family: FalFamily;

  /** Human label for the Media panel. */
  label: string;

  /**
   * The ONE format this model renders in, for a model with no `output_format` input (Seedream 4.5
   * returns PNG and takes no format field). The service applies it to the delivery decision so the file
   * is NAMED for the bytes it will contain — never `.jpg` around a PNG, which the file route's byte
   * sniffer would flag as a format mismatch.
   */
  fixedFormat?: 'png';
}

/**
 * Every fal model the platform can submit. Keys are the price-list ids (`baked-fal-prices.ts`).
 *
 * ⚠️ Sound rows are priced (T2) but are NOT listed here until T6 builds their payloads: an unroutable
 * model is refused before the debit, which is the honest state for a capability that is not built yet.
 */
export const FAL_ROUTES: Readonly<Record<string, FalRoute>> = {
  'fal-ai/nano-banana-2': { family: 'image-nano', label: 'Nano Banana 2 (default)' },
  'fal-ai/nano-banana-pro': { family: 'image-nano', label: 'Nano Banana Pro' },
  'fal-ai/bytedance/seedream/v4.5/text-to-image': {
    family: 'image-seedream',
    label: 'Seedream 4.5',
    fixedFormat: 'png',
  },
  'fal-ai/bria/background/remove': { family: 'cutout', label: 'Bria background removal' },
  'fal-ai/kling-video/v3/standard/text-to-video': { family: 'video-kling', label: 'Kling 3.0 Standard (default)' },
  'fal-ai/kling-video/v3/pro/text-to-video': { family: 'video-kling', label: 'Kling 3.0 Pro' },
  'xai/grok-imagine-video/text-to-video': { family: 'video-grok', label: 'Grok Imagine Video' },
  'fal-ai/veo3/fast': { family: 'video-veo', label: 'Veo 3 Fast — Google' },
  'fal-ai/veo3': { family: 'video-veo', label: 'Veo 3 — Google, 2x the credits' },
};

export function falRouteFor(model: string): FalRoute | null {
  return FAL_ROUTES[model.trim()] ?? null;
}

/** The video durations each family accepts, in SECONDS — the panel's choices and the quote's wall. */
export const FAL_VIDEO_DURATIONS: Readonly<Record<'video-kling' | 'video-grok' | 'video-veo', readonly number[]>> = {
  /* `"3"`–`"15"` on the wire (a string enum). */
  'video-kling': [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],

  /* `1`–`15` on the wire (an integer). */
  'video-grok': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],

  /* `"4s"` / `"6s"` / `"8s"` on the wire. */
  'video-veo': [4, 6, 8],
};

function isVideoFamily(family: FalFamily): family is keyof typeof FAL_VIDEO_DURATIONS {
  return family in FAL_VIDEO_DURATIONS;
}

/**
 * The duration in the shape the family's wire wants, or `null` when it cannot be expressed.
 *
 * 🔴 NEVER ROUNDED. A per-second render is billed for `durationSeconds`; sending the nearest allowed
 * value instead renders a clip of a different length than the one debited — under-billed in one
 * direction, a short clip in the other. `falRouteRefusal` refuses those durations before the debit.
 */
export function falWireDuration(family: FalFamily, seconds: number): string | number | null {
  if (!isVideoFamily(family) || !FAL_VIDEO_DURATIONS[family].includes(seconds)) {
    return null;
  }

  switch (family) {
    case 'video-kling':
      return String(seconds);

    case 'video-grok':
      return seconds;

    case 'video-veo':
      return `${seconds}s`;

    default: {
      const unreachable: never = family;
      return unreachable;
    }
  }
}

/**
 * Why this request cannot be submitted to fal — a sentence for a refusal BEFORE the debit — or `null`.
 *
 * Two cases: a model the price list prices but this table cannot route (an operator-added row), and a
 * video duration the family cannot render exactly.
 */
export function falRouteRefusal(model: string, durationSeconds?: number): string | null {
  const route = falRouteFor(model);

  if (!route) {
    return (
      `"${model}" is priced on fal but the platform has no request shape for it yet, so it cannot run. ` +
      `Supported fal models: ${Object.keys(FAL_ROUTES)
        .filter((id) => FAL_ROUTES[id].family !== 'cutout')
        .join(', ')}.`
    );
  }

  if (route.family === 'cutout') {
    return null;
  }

  if (isVideoFamily(route.family)) {
    const seconds = durationSeconds ?? defaultFalVideoSeconds(route.family);

    if (falWireDuration(route.family, seconds) === null) {
      return (
        `"${model}" renders ${FAL_VIDEO_DURATIONS[route.family].join(', ')} seconds only — ` +
        `${seconds}s cannot be rendered exactly, so it is refused rather than billed for one length and ` +
        'rendered at another.'
      );
    }
  }

  return null;
}

/** The family's default clip length when the caller states none (Kling/Grok 5s, Veo 8s). */
export function defaultFalVideoSeconds(family: keyof typeof FAL_VIDEO_DURATIONS): number {
  return family === 'video-veo' ? 8 : 5;
}

/** The fal ids of one media kind, in table order — the panel's model lists. */
export function falModelsOfKind(kind: 'image' | 'video'): { id: string; route: FalRoute }[] {
  return Object.entries(FAL_ROUTES)
    .filter(([, route]) =>
      kind === 'image'
        ? route.family === 'image-nano' || route.family === 'image-seedream'
        : isVideoFamily(route.family),
    )
    .map(([id, route]) => ({ id, route }));
}

/**
 * Seedream 4.5's `image_size` per aspect ratio.
 *
 * ⚠️ EXPLICIT SIZES, NOT fal's presets. The presets (`landscape_16_9` is 1024x576, `square_hd`
 * 1024x1024) are below this model's floor — its schema requires each side 1920–4096 OR a total of
 * 2560*1440 to 4096*4096 pixels — so a preset would be refused at fal after the debit. Each size here
 * sits at or above that floor.
 */
export const SEEDREAM_IMAGE_SIZES: Readonly<Record<string, { width: number; height: number }>> = {
  '16:9': { width: 2560, height: 1440 },
  '9:16': { width: 1440, height: 2560 },
  '1:1': { width: 2048, height: 2048 },
  '4:3': { width: 2304, height: 1728 },
  '3:4': { width: 1728, height: 2304 },
};
