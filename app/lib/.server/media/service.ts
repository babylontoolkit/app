/**
 * The media generation service (SPEC §4.16) — the money path for built-in image/video generation.
 *
 * The billing shape is the INVERSE of an LLM generation, and every rule here follows from that one
 * fact. An LLM generation's cost is unknowable up front, so the gate is a cheap balance check and
 * settlement records whatever reality cost, negative balance allowed (§4.6). A media render's cost
 * is EXACT before it runs (the Marketplace price list), so:
 *
 *   price → refuse-if-unpriced → anchor → DEBIT (refused on insufficient balance) → create KIE task
 *
 * The debit happens BEFORE any spend at KIE, may never overdraw (ledger reason 'media', migration
 * 0009), and a task that later fails auto-refunds exactly once. If we cannot price it, it does not
 * run — `lookupMediaPrice` has no most-expensive fallback on purpose (spec/billing.md).
 *
 * This module does no HTTP and no filesystem beyond its stores: routes own auth/ownership, the
 * `MediaProvider` seam owns the wire, which is what lets `media.spec.ts` drive every money rule
 * against fakes.
 */
import { createScopedLogger } from '~/utils/logger';
import { env } from '~/lib/.server/env';
import { isGoogleVideoModel, soundKindForModel, type SoundKind } from '~/lib/media/provider-defaults';
import { dispatchMediaCreate } from './dispatch';
import { getMonitor } from '~/lib/.server/monitoring';
import { recordRefundOutcome } from '~/lib/.server/monitoring/paid-path-rates';
import { ALERT_SIGNALS } from '~/lib/.server/monitoring/events';
import { getLedger } from '~/lib/.server/billing/ledger';
import { getGenerationStore } from '~/lib/.server/billing/generations';
import { getBillingConfig, creditsForRawCost } from '~/lib/.server/billing/rates';
import { activeMarketPrices, ensureMarketPrices } from '~/lib/.server/billing/market-price-store';
import { lookupMediaPrice, findMediaModel, type MarketPriceList } from '~/lib/.server/billing/market-prices';
import type { ObjectStore } from '~/lib/.server/storage';
import {
  mediaProviderOf,
  retiredMediaGatewayError,
  type MediaEndpoint,
  type MediaProvider,
  type MediaProviderName,
  type MediaProviderResolver,
  type MediaTaskState,
} from './provider';
import { putMediaTask, getMediaTask, type MediaTaskRecord } from './store';
import { cutoutRenderPrompt, resolveImageIntent } from '~/lib/media/output-format';
import {
  allCutoutModels,
  cutoutModelFor,
  isRefusal,
  realizeImageDelivery,
  type ImageDelivery,
} from '~/lib/media/image-capabilities';
import {
  defaultFalVideoSeconds,
  falRouteFor,
  falRouteRefusal,
  falWireDuration,
  SEEDREAM_IMAGE_SIZES,
} from '~/lib/media/fal-routes';

const logger = createScopedLogger('media-service');

/**
 * The cut-out model for a gateway — stage 2 of a transparent image (§4.16). Not a model anyone selects:
 * it takes an image URL, not a prompt, so naming ANY gateway's cut-out as a primary model is always a
 * mistake and is refused below BEFORE the debit rather than after a wasted render.
 *
 * Per gateway since fal joined (T4): KIE's `recraft/remove-background`, fal's
 * `fal-ai/bria/background/remove`. The table is `CUTOUT_MODEL_BY_PROVIDER`
 * (`image-capabilities.ts`) — the panel reads the same one.
 */
export { cutoutModelFor };

/**
 * How stage 2 is CREATED on each gateway, given stage 1's result URL — or `null` where there is no
 * cut-out. A record, so a new gateway must answer here or fail to compile.
 *
 * 🔴 KIE's entry is byte-identical to what the poll path hardcoded before T4 (`{ image }` on `jobs`);
 * fal's input field is `image_url` on its one queue route.
 */
const CUTOUT_TASK_BY_PROVIDER: Record<
  MediaProviderName,
  ((renderUrl: string) => { endpoint: MediaEndpoint; payload: Record<string, unknown> }) | null
> = {
  KIE: (renderUrl) => ({ endpoint: 'jobs', payload: { image: renderUrl } }),
  FAL: (renderUrl) => ({ endpoint: 'fal-queue', payload: { image_url: renderUrl } }),
};

/** The stage-2 create input for a gateway, or `null` when it has no cut-out pass. */
export function cutoutTaskFor(
  provider: MediaProviderName,
  renderUrl: string,
): { endpoint: MediaEndpoint; model: string; payload: Record<string, unknown> } | null {
  const model = cutoutModelFor(provider);
  const build = CUTOUT_TASK_BY_PROVIDER[provider];

  return model && build ? { model, ...build(renderUrl) } : null;
}

/**
 * Recraft's input limits (their docs): ≤5MB, ≤16MP, ≤4096px on a side, ≥256px.
 *
 * Only the dimension cap can be violated by a request we would otherwise accept — a 4K nano-banana
 * render is 5504×3072. Refused UP FRONT in the quote so the panel says so before spending, instead of
 * paying for a render whose cut-out then fails and refunds.
 */
const CUTOUT_MAX_RESOLUTION_NOTE = '4K is too large for the cut-out pass (it caps at 4096px a side) — use 2K or 1K.';

/**
 * What a finished task IS — images, video clips and now sound (§4.16 `generate_sound`).
 *
 * One alias rather than the literal union repeated across the quote, the started task and the stored
 * record: those three must agree, and three hand-written copies is how they stop agreeing.
 */
export type MediaTaskKind = 'image' | 'video' | 'audio';

/**
 * Where KIE posts a finished Suno MUSIC job.
 *
 * 🔴 **Music, and only music, requires a callback URL KIE can reach** — their Suno music API rejects a
 * request without one even though we poll for the result and never read the callback (D7: the route is
 * a 200 no-op; polling stays the only source of truth). So this is a precondition of the REQUEST, not
 * a delivery mechanism, which is why a music request with no resolvable URL is refused in the QUOTE —
 * before any debit — rather than failing at KIE after the user has been charged.
 *
 * Effects and speech never send one: a callback configured for music must not be attached to jobs that
 * did not ask for it.
 *
 * ⚠️ A LOOPBACK OR PRIVATE ADDRESS IS REFUSED, not accepted. `http://localhost:5173/...` parses as a
 * perfectly valid http URL, so a parse-only check would let a dev machine's `APP_URL` through — and
 * the request would then be DEBITED and handed to KIE with a callback nobody outside this machine can
 * reach. Refusing costs nothing; accepting spends the user's credits on a request that cannot be
 * delivered. "Can KIE reach it" is the actual question, and an unroutable host is the one case we can
 * answer without asking.
 */
function resolveMediaCallbackUrl(context: unknown): string | null {
  const explicit = env(context, 'MEDIA_CALLBACK_URL')?.trim();
  const appUrl = env(context, 'APP_URL')?.trim();
  const candidate = explicit || (appUrl ? `${appUrl.replace(/\/+$/, '')}/api/media/kie-callback` : '');

  if (!candidate) {
    return null;
  }

  try {
    const url = new URL(candidate);

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null;
    }

    return isPubliclyRoutableHost(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Loopback, link-local, CGNAT and the RFC1918 ranges — hosts no external service can call back to. */
function isPubliclyRoutableHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1') {
    return false;
  }

  // `::ffff:127.0.0.1` is the same unroutable host wearing a v6 spelling.
  const mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  const ipv4 = (mapped?.[1] ?? host).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);

  if (!ipv4) {
    // A name we cannot classify is assumed routable — DNS is not ours to resolve here.
    return !host.startsWith('fc') && !host.startsWith('fd') && !host.startsWith('fe80:');
  }

  const [a, b] = ipv4.slice(1).map(Number);

  return !(
    a === 127 ||
    a === 10 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

export class MediaRefusedError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 422) {
    super(message);
    this.name = 'MediaRefusedError';
    this.statusCode = statusCode;
  }
}

export interface MediaRequest {
  model: string;
  prompt: string;

  /** Request options — the SAME record prices the task and shapes the provider payload. */
  options: Record<string, string | number | boolean>;
  durationSeconds?: number;
}

export interface MediaQuote {
  /**
   * Canonical priced model id (aliases resolved) — and, for a transparent request, the model that
   * will ACTUALLY be called.
   *
   * 🔴 On a gateway whose alpha lives in a different model than the one asked for, this reports the
   * substitute. It drives the generations anchor and the ledger note, so
   * the swap is billed against the model that ran and is visible on the button — never silent.
   */
  model: string;
  kind: MediaTaskKind;

  /** The TOTAL raw cost — render plus the cut-out pass when there is one. What credits derive from. */
  usd: number;
  credits: number;

  /** How this image is delivered (which model, alpha strategy, formats). Images only. */
  delivery?: ImageDelivery;

  /**
   * The options the price was looked up with and the payload must be built from.
   *
   * The two must be the SAME record or a render is billed for one configuration and asked for
   * another — the invariant that already binds the delivery decision, extended to the options,
   * because a gateway with its own vocabulary (e.g. one pricing on `quality` where KIE prices on `resolution`) needs
   * them normalised once rather than at each call site.
   *
   * ⚠️ IMAGES ONLY, strictly. A video quote returns the caller's record unchanged: `durationSeconds`
   * is merged in for variant MATCHING (`lookupOptions`) but is its own field on the request and the
   * record, so duplicating it here would be a second copy of one fact rather than a normalisation.
   */
  options: Record<string, string | number | boolean>;

  /** The cut-out pass's own raw cost, for the admin/step log. Present only when `delivery.cutout`. */
  cutoutUsd?: number;
}

/**
 * Price a request against the ACTIVE list, or refuse. The one pricing door — start uses exactly this,
 * so the number the UI showed on the button is the number the ledger debits.
 *
 * A transparent image is priced as ONE task with TWO stages: the render plus the cut-out. Both are
 * quoted here and debited together, because the user asked for one asset and a half-delivered
 * transparent image (an opaque render, cut-out skipped) is the silent failure this whole pipeline
 * exists to remove.
 */
export function quoteMediaRequest(
  request: MediaRequest,
  mediaProvider: MediaProviderName,
  context?: unknown,
): MediaQuote {
  /*
   * 🔴 THE MEDIA PROVIDER'S OWN LIST, AND THE PARAMETER IS REQUIRED AND SECOND ON PURPOSE.
   *
   * Prices are per gateway. A default here — 'KIE', or worse "whichever list was loaded last" —
   * would price a fal render off KIE's rows the day a caller forgot to pass it: the wrong number
   * on the Generate button, the wrong debit in the ledger, and nothing to throw. Putting it before
   * the optional `context` makes every call site state it, so the compiler enumerates the work
   * instead of a reviewer having to.
   */
  const list = activeMarketPrices(mediaProvider);

  if (allCutoutModels().includes(request.model.trim())) {
    throw new MediaRefusedError(
      `"${request.model.trim()}" is the automatic cut-out pass, not a model you generate with — it takes an ` +
        'image, not a prompt. Ask for transparency instead (transparent: true) and it runs by itself.',
    );
  }

  const config = getBillingConfig(context);

  /*
   * 🔴 KIND FIRST, and from the REQUESTED model.
   *
   * Everything below this point is image machinery — the alpha intent, the model substitution, the
   * cut-out chain — and running any of it against a video request would let a prompt that happens to
   * say "logo" resolve a video to an image model. `findMediaModel` is a pure lookup and takes no
   * position on options, so it can answer "what kind of thing is this" before anything is priced.
   */
  const requested = findMediaModel(list, request.model);

  if (!requested) {
    throw new MediaRefusedError(unpricedMessage(list, request));
  }

  /*
   * 🔴 AUDIO BEFORE THE VIDEO FALLTHROUGH. That branch is `kind !== 'image'`, so a sound row reaching
   * it would be priced correctly and then labelled `kind: 'video'` — an `.mp4` destination path for
   * MP3 bytes, the panel counting it as a clip, and the file proxy defaulting its content type to
   * `video/mp4`. Billed right, delivered wrong, nothing thrown.
   */
  if (requested.pricing.kind === 'audio') {
    // fal's sound rows are priced (T2) but have no request shape until T6 — refused before any debit.
    refuseUnroutable(mediaProvider, requested.id);

    const soundKind = soundKindForModel(requested.id) ?? 'sound_effect';
    const options = { ...request.options };

    if (soundKind === 'music') {
      const callbackUrl = resolveMediaCallbackUrl(context);

      if (!callbackUrl) {
        throw new MediaRefusedError(
          "Music generation needs a PUBLICLY REACHABLE callback URL — KIE's Suno music API rejects a " +
            'request without one, even though we poll for the result. Set MEDIA_CALLBACK_URL (or ' +
            'APP_URL) to an address KIE can reach from the internet; localhost and private addresses ' +
            'are refused here rather than charged for. Sound effects and speech need no callback.',
        );
      }

      options.callbackUrl = callbackUrl;
    }

    const price = lookupMediaPrice(list, {
      model: request.model,
      options: lookupOptions(request),

      // Speech is billed per 1,000 characters of what it will SPEAK, which is the prompt verbatim.
      textChars: request.prompt?.length ?? 0,
    });

    if (!price) {
      throw new MediaRefusedError(unpricedMessage(list, request));
    }

    return {
      model: price.model,
      kind: 'audio',
      usd: price.usd,
      credits: creditsForRawCost(price.usd, config),
      options,
    };
  }

  if (requested.pricing.kind !== 'image') {
    /*
     * Normalised per gateway like the image options below — fal prices Kling and Veo on
     * `generate_audio` where KIE prices on `sound`. KIE passes through UNCHANGED.
     */
    const options = providerVideoOptions(requested.id, request, mediaProvider);
    const videoRequest = { ...request, options };
    const videoPrice = lookupMediaPrice(list, {
      model: request.model,
      options: lookupOptions(videoRequest),
      durationSeconds: request.durationSeconds,
    });

    if (!videoPrice) {
      throw new MediaRefusedError(unpricedMessage(list, videoRequest));
    }

    refuseUnroutable(mediaProvider, videoPrice.model, request.durationSeconds);

    return {
      model: videoPrice.model,
      kind: 'video',
      usd: videoPrice.usd,
      credits: creditsForRawCost(videoPrice.usd, config),
      options,
    };
  }

  /*
   * 🔴 THE REALIZATION IS DECIDED BEFORE THE PRICE, because on some gateways it CHANGES the model.
   *
   * The intent ("must this sit over other content?") is provider-independent; how it is served is not.
   * On KIE and fal nothing emits alpha, so transparency is a second priced stage on the requested
   * model. A gateway whose alpha lived in a DIFFERENT model would have a transparent request RESOLVE to
   * that model — and it would have to be priced as that model. Pricing the requested model and then calling a
   * different one is the priced-but-not-listed mis-bill wearing media clothes.
   */
  const intent = resolveImageIntent(imageHints(request));
  const cutoutModel = cutoutModelFor(mediaProvider);
  const realized = realizeImageDelivery({
    provider: mediaProvider,
    model: request.model,
    wantsAlpha: intent.wantsAlpha,
    explicitFormat: intent.format,
    cutoutAvailable: Boolean(cutoutModel && lookupMediaPrice(list, { model: cutoutModel, options: {} })),
  });

  /*
   * Refuse BEFORE the debit and never downgrade. A transparent request served opaque delivers exactly
   * what the user paid extra not to get, and reports success while doing it — the §4.16 failure that
   * shipped a logo with a grey box behind it.
   */
  if (isRefusal(realized)) {
    throw new MediaRefusedError(realized.refused);
  }

  const options = providerImageOptions(request, mediaProvider);
  const price = lookupMediaPrice(list, { model: realized.model, options });

  if (!price) {
    throw new MediaRefusedError(unpricedMessage(list, { ...request, model: realized.model, options }));
  }

  refuseUnroutable(mediaProvider, price.model);

  const kind = 'image' as const;
  const delivery: ImageDelivery = withFixedRenderFormat(mediaProvider, { ...realized, model: price.model });

  if (!delivery.cutout) {
    return {
      model: price.model,
      kind,
      usd: price.usd,
      credits: creditsForRawCost(price.usd, config),
      delivery,
      options,
    };
  }

  if (String(request.options.resolution ?? '').toUpperCase() === '4K') {
    throw new MediaRefusedError(CUTOUT_MAX_RESOLUTION_NOTE);
  }

  const cutoutPrice = cutoutModel ? lookupMediaPrice(list, { model: cutoutModel, options: {} }) : null;

  /*
   * Refuse, never silently degrade. Dropping the cut-out would deliver an OPAQUE image against a
   * request for a transparent one — which is precisely the failure that shipped a logo with a
   * checkerboard baked into it, and it would report success while doing so.
   */
  if (!cutoutPrice) {
    throw new MediaRefusedError(
      `Transparent images need the cut-out pass ("${cutoutModel}"), which is not in the active ` +
        'Marketplace price list, so it cannot be billed. Add that row in Settings → Admin → ' +
        'Marketplace prices, or generate this image opaque (transparent: false).',
    );
  }

  const usd = price.usd + cutoutPrice.usd;

  return {
    model: price.model,
    kind,
    usd,
    credits: creditsForRawCost(usd, config),
    delivery,
    cutoutUsd: cutoutPrice.usd,
    options,
  };
}

/**
 * 🔴 DURATION PARTICIPATES IN VARIANT MATCHING — it is an OPTION, not just a multiplier.
 *
 * `kling-2.6` prices per (durationSeconds, sound): all four of its variants are keyed on the duration,
 * so a lookup that passes `options` raw matches none of them and the quote REFUSES a model the panel
 * and the `generate_video` tool both offer. That is exactly what happened when T8's rewrite dropped
 * this helper — every `kling-2.6` render became unquotable on KIE with the whole suite green, because
 * `market-prices.spec.ts` tests `lookupMediaPrice` directly with the duration already merged in and
 * `media.spec.ts` only ever drove `kling-3.0`, which is keyed on `mode`.
 *
 * The separate `durationSeconds` argument is what MULTIPLIES a `per_second` price. Both are needed and
 * they are not the same thing.
 */
function lookupOptions(request: MediaRequest): Record<string, string | number | boolean> {
  return request.durationSeconds !== undefined
    ? { ...request.options, durationSeconds: request.durationSeconds }
    : request.options;
}

/** What the intent decision is read from — one place, so no call site invents a different question. */
function imageHints(request: MediaRequest) {
  return {
    explicitFormat: request.options.outputFormat as string | undefined,
    transparent: request.options.transparent as boolean | string | undefined,
    fileName: (request as { fileName?: string }).fileName,
    prompt: request.prompt,
  };
}

/**
 * The gateways price images on DIFFERENT option vocabularies, and this is the one translation.
 *
 * KIE and fal both price images on `resolution` (1K/2K/4K) today, so this passes through; it stays a
 * per-gateway switch because a gateway with its own vocabulary must normalise here — once, into the
 * record the quote carries — so the price lookup and the provider payload never ask for different
 * things.
 */
function providerImageOptions(
  request: MediaRequest,
  mediaProvider: MediaProviderName,
): Record<string, string | number | boolean> {
  switch (mediaProvider) {
    case 'KIE':
    case 'FAL':
      // Both price images on `resolution` (fal's Nano Banana rows are keyed 1K/2K/4K, like KIE's).
      return request.options;

    default: {
      const unreachable: never = mediaProvider;
      throw new MediaRefusedError(`Unknown media provider: ${String(unreachable)}`, 503);
    }
  }
}

/**
 * The video twin of `providerImageOptions` — the one translation into the vocabulary a gateway's VIDEO
 * rows are priced on, folded into the record that prices the render AND builds its payload.
 *
 * KIE passes through unchanged (byte-identical to before T3). fal:
 *  - Kling and Veo price on `generate_audio` (both tools and the panel say `sound`) — and fal DEFAULTS
 *    it to TRUE on the wire, so it is always stated: an unstated value would render audio the user was
 *    not charged for;
 *  - Grok prices on `resolution` and has no audio switch; an unstated resolution is fal's own default,
 *    `720p`, so the row priced is the clip rendered.
 */
function providerVideoOptions(
  model: string,
  request: MediaRequest,
  mediaProvider: MediaProviderName,
): Record<string, string | number | boolean> {
  switch (mediaProvider) {
    case 'KIE':
      return request.options;

    case 'FAL': {
      const o = request.options;

      switch (falRouteFor(model)?.family) {
        case 'video-kling':
        case 'video-veo':
          return { ...o, generate_audio: Boolean(o.generate_audio ?? o.sound ?? false) };

        case 'video-grok':
          return { ...o, resolution: str(o.resolution, '720p') };

        default:
          return o;
      }
    }

    default: {
      const unreachable: never = mediaProvider;
      throw new MediaRefusedError(`Unknown media provider: ${String(unreachable)}`, 503);
    }
  }
}

/**
 * Refuse, BEFORE the debit, a priced model this gateway cannot actually submit. Only fal has a route
 * table (`fal-routes.ts`): a row an operator adds to fal's price list for a model the platform has no
 * request shape for — or a video length fal cannot render exactly — would otherwise be debited and then
 * refused at fal. KIE routes by model family and has no such table.
 */
const ROUTE_REFUSAL: Record<MediaProviderName, (model: string, durationSeconds?: number) => string | null> = {
  KIE: () => null,
  FAL: falRouteRefusal,
};

function refuseUnroutable(mediaProvider: MediaProviderName, model: string, durationSeconds?: number): void {
  const refusal = ROUTE_REFUSAL[mediaProvider](model, durationSeconds);

  if (refusal) {
    throw new MediaRefusedError(refusal);
  }
}

/**
 * A model that renders in ONE format (no `output_format` input — Seedream 4.5 on fal returns PNG) has
 * that format applied to the delivery decision, so the file is named for the bytes it will contain.
 * A cut-out still ends as PNG; only what stage 1 renders changes.
 */
const FIXED_RENDER_FORMAT: Record<MediaProviderName, (model: string) => 'png' | null> = {
  KIE: () => null,
  FAL: (model) => falRouteFor(model)?.fixedFormat ?? null,
};

function withFixedRenderFormat(mediaProvider: MediaProviderName, delivery: ImageDelivery): ImageDelivery {
  const fixed = FIXED_RENDER_FORMAT[mediaProvider](delivery.model);

  return fixed ? { ...delivery, renderFormat: fixed, finalFormat: delivery.cutout ? 'png' : fixed } : delivery;
}

function unpricedMessage(list: MarketPriceList, request: MediaRequest): string {
  const found = findMediaModel(list, request.model);

  if (!found) {
    return (
      `"${request.model}" is not in the Marketplace price list, so it cannot run — an unpriced render ` +
      `cannot be billed. Available media models: ${Object.keys(list.media).join(', ') || '(none)'}.`
    );
  }

  const needsDuration = found.pricing.unit === 'per_second' && !request.durationSeconds;

  if (needsDuration) {
    return `"${found.id}" is priced per second, so durationSeconds is required to price the render.`;
  }

  if (found.pricing.unit === 'per_1k_chars' && !request.prompt?.trim()) {
    return `"${found.id}" is priced per 1,000 characters, so the text to speak is required to price it.`;
  }

  return (
    `No priced variant of "${found.id}" matches ${JSON.stringify(request.options)}. ` +
    `Priced variants: ${found.pricing.variants.map((v) => JSON.stringify(v.options)).join(', ')}.`
  );
}

export interface StartMediaInput extends MediaRequest {
  userId: string;
  projectId: string;

  /** Optional caller-preferred file name (sanitised); the service derives the rest of the path. */
  fileName?: string;

  provider: MediaProvider;
  objectStore: ObjectStore;
  context?: unknown;
}

export interface StartedMediaTask {
  taskId: string;
  destPath: string;
  credits: number;
  usd: number;
  model: string;
  kind: MediaTaskKind;
}

export async function startMediaTask(input: StartMediaInput): Promise<StartedMediaTask> {
  /*
   * The provider comes off the INSTANCE, not off config: `startMediaTask` is handed the client the
   * caller resolved, and stamping the record from anything else would let the two disagree — a task
   * created on one gateway and labelled as another is a task nothing can poll.
   */
  const mediaProvider = input.provider.name;

  await ensureMarketPrices(mediaProvider, input.context);

  if (!input.prompt?.trim()) {
    throw new MediaRefusedError('A prompt is required to generate media.');
  }

  const quote = quoteMediaRequest(input, mediaProvider, input.context);
  const config = getBillingConfig(input.context);
  const ledger = getLedger(input.context);
  const id = `med_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const destPath = deriveDestPath(quote.kind, input, id, quote.delivery);

  /*
   * The FK anchor, before the debit — `credit_ledger.generation_id` references `generations(id)`
   * (the same rule `settleGeneration` documents: without the row, Postgres rejects the debit and the
   * catch would read as "insufficient credits" to the user while actually being a bug of ours).
   */
  await getGenerationStore(input.context).upsert({
    id,
    userId: input.userId,
    projectId: input.projectId,
    model: quote.model,

    // The gateway that will actually be billed — what the §4.10 margin report attributes spend by.
    provider: mediaProvider,
    creditsCharged: quote.credits,
    rawCostUsd: quote.usd,
    status: 'running',
  });

  /*
   * DEBIT BEFORE SPEND — the defining difference from LLM settlement. reason 'media' may never
   * overdraw (migration 0009): with billing enforced, an insufficient balance throws here and the
   * KIE task is never created. Unmetered mode (beta/local) records the debit when the balance
   * covers it and otherwise charges nothing — it must not block, and it must not overdraw either.
   */
  let debited = 0;

  try {
    await ledger.append({
      userId: input.userId,
      delta: -quote.credits,
      reason: 'media',
      generationId: id,
      note: `${quote.model}: ${quote.kind} (${JSON.stringify(input.options).slice(0, 120)})`,
    });
    debited = quote.credits;
  } catch (error) {
    if (config.enforced) {
      throw new MediaRefusedError(
        `Not enough credits: this ${quote.kind} costs ${quote.credits} credits. Add credits to generate it.`,
        402,
      );
    }

    logger.warn(`Unmetered media task ${id} not debited (${(error as Error).message}) — proceeding.`);
  }

  let kieTaskId: string;

  try {
    /*
     * 🔴 THROUGH THE QUEUE (`dispatch.ts`): one render dispatched at a time, spaced, with per-image
     * retry. The debit above has already happened, so a retry here NEVER re-debits — one task, one
     * charge, up to MEDIA_MAX_ATTEMPTS attempts at getting it accepted. Only a final failure reaches
     * the catch below, which refunds exactly as it always did.
     */
    kieTaskId = await dispatchMediaCreate(id, () =>
      input.provider.create({
        endpoint: endpointFor(mediaProvider, quote.model),
        model: quote.model,
        payload: buildProviderPayload(quote.model, { ...input, options: quote.options }, quote.delivery, mediaProvider),
      }),
    );
  } catch (error) {
    // The task never started, so the money comes straight back and the anchor says failed.
    await refundMediaTask(
      input.userId,
      id,
      debited,

      // Named by GATEWAY, never hardcoded: this string is the ledger note on a real refund.
      `${mediaProvider} refused the task: ${(error as Error).message}`,
      input.context,
    );
    await getGenerationStore(input.context)
      .upsert({ id, userId: input.userId, model: quote.model, status: 'failed' })
      .catch(() => undefined);

    recordRefundOutcome(getMonitor(input.context), 'media', true);

    throw new MediaRefusedError(`The provider refused the render: ${(error as Error).message}`, 502);
  }

  const now = new Date().toISOString();
  const record: MediaTaskRecord = {
    id,
    projectId: input.projectId,
    userId: input.userId,
    kind: quote.kind,
    provider: mediaProvider,
    endpoint: endpointFor(mediaProvider, quote.model),
    model: quote.model,
    prompt: input.prompt,

    /*
     * The NORMALISED options — the exact record the price was looked up with and the payload was
     * built from, not the caller's raw one. A record that stores what was asked for while having been
     * billed for something else is how a task becomes unauditable.
     */
    options: quote.options,
    durationSeconds: input.durationSeconds,
    destPath,
    usd: quote.usd,
    credits: debited,
    status: 'pending',
    kieTaskId,

    /*
     * A cut-out task is born in stage 'render'. The poll path chains stage 2 when this is set — and
     * it is stored rather than re-derived, so a price-list change mid-render can never make a task
     * that was PAID for as transparent finish as an opaque one.
     */
    ...(quote.delivery?.cutout ? { cutout: true as const, stage: 'render' as const } : {}),
    createdAt: now,
    updatedAt: now,
  };

  /*
   * 🔴 THE TASK RECORD IS THE ONLY THING THAT CAN EVER FINISH OR REFUND THIS RENDER.
   *
   * By this line the user has been DEBITED and KIE is rendering. The record is what the poll route
   * reads to deliver the bytes, and what the failure path reads to refund. Left unguarded, an object
   * store hiccup here produced a fifth terminal state (`spec/fail-loud.md`): money gone, render
   * running, nothing able to poll it, nothing able to refund it, and the tool result reporting only
   * that the task "could not start" — the exact silent shape this spec exists to remove.
   *
   * So: refund, mark the anchor failed, and refuse out loud. The render at KIE is not recoverable
   * (it is already paid for on OUR account), but the user's credits are, and that is the half that
   * is ours to get right.
   */
  try {
    await putMediaTask(input.objectStore, record);
  } catch (error) {
    const message = `the render started but its task record could not be stored: ${(error as Error).message}`;
    logger.error(`Media task ${id} orphaned — ${message}`);

    await refundMediaTask(input.userId, id, debited, message, input.context);
    await getGenerationStore(input.context)
      .upsert({ id, userId: input.userId, model: quote.model, status: 'failed' })
      .catch(() => undefined);

    recordRefundOutcome(getMonitor(input.context), 'media', true);

    throw new MediaRefusedError(`The render could not be tracked, so it was cancelled and refunded: ${message}`, 500);
  }

  logger.info(
    `Media task ${id} started: ${quote.model}${quote.delivery?.cutout ? ' + cut-out' : ''} → ${destPath} ` +
      `(${debited} credits, $${quote.usd})`,
  );

  return { taskId: id, destPath, credits: debited, usd: quote.usd, model: quote.model, kind: quote.kind };
}

/*
 * Poll serialisation: two concurrent polls of the same task must not both observe 'pending → failed'
 * and refund twice. Chained per-task promises make the read-check-write sections run one at a time.
 */
const pollChains = new Map<string, Promise<unknown>>();

async function serialised<T>(taskId: string, work: () => Promise<T>): Promise<T> {
  const previous = pollChains.get(taskId) ?? Promise.resolve();
  const run = previous.then(work, work);
  const tail = run.catch(() => undefined);
  pollChains.set(taskId, tail);

  try {
    return await run;
  } finally {
    if (pollChains.get(taskId) === tail) {
      pollChains.delete(taskId);
    }
  }
}

export interface PollMediaInput {
  projectId: string;
  taskId: string;

  /**
   * 🔴 A RESOLVER, NOT A PROVIDER. The gateway is read off the RECORD — see `store.ts`'s `provider`
   * field. A caller that handed in an instance would be handing in "whoever is configured right
   * now", which is a different fact from "whoever is rendering this", and the two diverge for
   * exactly as long as a render takes.
   */
  resolveProvider: MediaProviderResolver;

  objectStore: ObjectStore;
  context?: unknown;
}

/**
 * Advance a task by asking its provider once. Terminal states are sticky; the failure path refunds
 * EXACTLY once (the `refunded` latch on the record, inside the per-task serialisation).
 */
export async function pollMediaTask(input: PollMediaInput): Promise<MediaTaskRecord | null> {
  return serialised(input.taskId, async () => {
    const record = await getMediaTask(input.objectStore, input.projectId, input.taskId);

    if (!record || record.status !== 'pending') {
      return record;
    }

    /*
     * 🔴 A task on a RETIRED gateway is never sent anywhere: no client is resolved, so neither the
     * retired gateway nor KIE (the unknown-name fallback) is asked about it. It takes the ordinary
     * failure path below, so the `refunded` latch refunds it exactly once.
     */
    const retired = retiredMediaGatewayError(record);
    const provider = retired ? null : input.resolveProvider(mediaProviderOf(record));

    let state: MediaTaskState;

    if (retired || !provider) {
      state = { state: 'failed', error: retired ?? 'internal: no media provider for this task' };
    } else {
      try {
        state = await provider.query(record.endpoint, record.kieTaskId);
      } catch (error) {
        // A flaky poll is NOT a failed render — stay pending; the next poll asks again.
        logger.warn(`Poll for ${record.id} failed transiently: ${(error as Error).message}`);
        return record;
      }
    }

    if (state.state === 'pending') {
      return record;
    }

    const updated: MediaTaskRecord = { ...record, updatedAt: new Date().toISOString() };

    if (state.state === 'succeeded') {
      /*
       * STAGE 1 DONE, CUT-OUT STILL OWED. The render is opaque — handing it over now would deliver
       * exactly the thing the user paid extra NOT to get, and would report success while doing it.
       * So chain stage 2 and stay `pending`: the client is already polling, the credits are already
       * debited, and nothing else in the pipeline needs to know there were two calls.
       */
      if (record.cutout && record.stage === 'render') {
        try {
          /*
           * The cut-out for THE TASK'S gateway (the same provider this poll resolved from the record),
           * never the configured one. A gateway with no cut-out cannot have stamped `cutout: true` —
           * but if a record ever claims it, that is a refusal to start stage 2, refunded below, never a
           * quiet delivery of the opaque render.
           */
          const cutoutTask = cutoutTaskFor(mediaProviderOf(record), state.resultUrl);

          if (!cutoutTask || !provider) {
            throw new Error(`${mediaProviderOf(record)} has no cut-out pass`);
          }

          const cutoutTaskId = await provider.create(cutoutTask);

          updated.stage = 'cutout';
          updated.renderUrl = state.resultUrl;
          updated.kieTaskId = cutoutTaskId;
          await putMediaTask(input.objectStore, updated);

          logger.info(`Media task ${record.id}: render done, cut-out task ${cutoutTaskId} started`);

          return updated;
        } catch (error) {
          /*
           * The cut-out could not start. The render exists and cost us real money, but the USER
           * asked for a transparent asset and is not getting one — that is a failed task, refunded
           * in full, said out loud. Quietly delivering the opaque render instead is the silent
           * degradation this pipeline was built to end.
           */
          const message = `the cut-out pass could not start: ${(error as Error).message}`;
          logger.error(`Media task ${record.id} ${message}`);

          updated.status = 'failed';
          updated.error = message;

          if (!record.refunded && record.credits > 0) {
            await refundMediaTask(record.userId, record.id, record.credits, message, input.context);
            updated.refunded = true;
          }

          await getGenerationStore(input.context)
            .upsert({ id: record.id, userId: record.userId, model: record.model, status: 'failed' })
            .catch(() => undefined);
          await putMediaTask(input.objectStore, updated);
          recordRefundOutcome(getMonitor(input.context), 'media', true);

          return updated;
        }
      }

      updated.status = 'succeeded';
      updated.resultUrl = state.resultUrl;
      await getGenerationStore(input.context)
        .upsert({ id: record.id, userId: record.userId, model: record.model, status: 'completed' })
        .catch(() => undefined);
    } else {
      updated.status = 'failed';
      updated.error = state.error;

      if (!record.refunded && record.credits > 0) {
        await refundMediaTask(record.userId, record.id, record.credits, state.error, input.context);
        updated.refunded = true;
      }

      await getGenerationStore(input.context)
        .upsert({ id: record.id, userId: record.userId, model: record.model, status: 'failed' })
        .catch(() => undefined);
    }

    await putMediaTask(input.objectStore, updated);

    /*
     * One media task reaching a TERMINAL state is one unit of paid work, so this is where the refund
     * rate gets both its numerator and its denominator (`spec/fail-loud.md` Stage C). Recorded here
     * rather than inside `refundMediaTask`, which only ever sees the failures — a window fed only its
     * numerator sits at 100% and alerts on the first refund.
     *
     * Reaching this line IS the terminal check — the two non-terminal outcomes (a still-pending render
     * and the mid-flight cut-out chain) both return earlier, and the compiler agrees: `updated.status`
     * narrows to `'succeeded' | 'failed'` here. Counting a cut-out's stage 1 would double-count the
     * same asset when stage 2 lands.
     */
    recordRefundOutcome(getMonitor(input.context), 'media', updated.status === 'failed');

    return updated;
  });
}

/** The compensating row (§4.6 "failed generations auto-refund" — same rule, media flavour). */
async function refundMediaTask(
  userId: string,
  mediaId: string,
  credits: number,
  reason: string,
  context?: unknown,
): Promise<void> {
  if (credits <= 0) {
    return;
  }

  try {
    await getLedger(context).append({
      userId,
      delta: credits,
      reason: 'refund',
      generationId: mediaId,
      note: `media refund: ${reason.slice(0, 200)}`,
    });
    logger.info(`Refunded ${credits} credits to ${userId} for failed media task ${mediaId}`);
  } catch (error) {
    // The user paid for a render they never got. Nothing downstream can see this — so alert (rule 4).
    logger.error(`FAILED TO REFUND media task ${mediaId}: ${(error as Error).message}`);
    getMonitor(context).alert(
      ALERT_SIGNALS.LEDGER_INTEGRITY,
      `Refund of ${credits} credits for failed media task ${mediaId} did NOT land — the user is still ` +
        `charged for a render they did not get: ${(error as Error).message}`,
      { severity: 'critical', scope: 'media-refund', userId, tags: { mediaId, credits } },
    );
  }
}

/**
 * Which upstream route this render is created on and polled at — a PROVIDER decision, not a model one.
 *
 * Explicit per provider rather than "veo or jobs", because the value is persisted and shared: the
 * moment a second gateway exists, a default of `'jobs'` would stamp a fal task with KIE's route and
 * make it unpollable forever.
 */
function endpointFor(provider: MediaProviderName, model: string): MediaEndpoint {
  switch (provider) {
    case 'KIE': {
      /*
       * Sound first: `soundKindForModel` is the ONE writer of "which sound is this" (the same rule
       * `isGoogleVideoModel` follows below), and the two Suno routes differ from each other as much
       * as either differs from jobs. ElevenLabs speech is an ordinary KIE job.
       */
      const sound = soundKindForModel(model);

      if (sound) {
        return sound === 'sound_effect' ? 'suno-sounds' : sound === 'music' ? 'suno-music' : 'jobs';
      }

      /*
       * ONE writer of "is this a Google Veo model" (`media/provider-defaults.ts`). This was a private
       * `VEO_MODELS` set of three exact KIE ids, and a since-removed per-gateway router asked the same question a
       * third way (`startsWith('veo')`) — three spellings of one fact, in one file. The set was also
       * spelling-brittle: it lists `veo3_fast` and would route a hyphenated `veo3-fast` to the wrong
       * endpoint, which is unpollable-forever rather than an error. Same rule as `isSecretPath`.
       */
      return isGoogleVideoModel(model) ? 'veo' : 'jobs';
    }

    case 'FAL':
      // fal has ONE route for every model — the routing lives in the `response_url` it returns.
      return 'fal-queue';

    default: {
      const unreachable: never = provider;
      throw new MediaRefusedError(`Unknown media provider: ${String(unreachable)}`, 503);
    }
  }
}

/**
 * A finished render's bytes, fetched by THE TASK'S provider (never the configured one).
 *
 * The file route used to import KIE's `downloadResult` directly, which was invisible as a coupling
 * until a second gateway existed — polling would have become provider-aware while downloading
 * silently stayed on KIE, so a fal task's URL would be fetched with KIE's handling.
 */
export async function downloadMediaResult(
  record: Pick<MediaTaskRecord, 'id' | 'provider' | 'resultUrl'>,
  resolveProvider: MediaProviderResolver,
): Promise<Response> {
  if (!record.resultUrl) {
    throw new MediaRefusedError('That render has no result URL yet.', 409);
  }

  // Never fetched from a retired gateway's storage — nor through KIE's downloader in its place.
  const retired = retiredMediaGatewayError(record);

  if (retired) {
    throw new MediaRefusedError(
      `${record.provider} is no longer a media gateway; its renders cannot be downloaded.`,
      410,
    );
  }

  return resolveProvider(mediaProviderOf(record)).download(record.resultUrl);
}

/*
 * ------------------------------------------------------------------------------------------------ *
 * Provider payloads — ported from the MCP wire reference (`temp/kie-image-mcp`)
 * ------------------------------------------------------------------------------------------------
 */

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback;
}

/**
 * 🔴 THE REALIZATION IS PASSED IN, NEVER RE-DERIVED.
 *
 * The payload builder and the destination path used to fall back to computing the delivery decision
 * themselves when none was handed to them. That was survivable while the decision depended only on
 * the request — three call sites, one pure function, same answer. It stopped being survivable when
 * the decision started depending on the GATEWAY: a re-derivation here has no provider to consult, so
 * it would silently answer the KIE question on a fal task, and the file would be billed as one
 * thing, written as another and referenced as a third.
 *
 * So there is no fallback. An image with no delivery decision is a programming error and says so.
 */
function requireDelivery(delivery: ImageDelivery | undefined, model: string): ImageDelivery {
  if (!delivery) {
    throw new Error(`internal: image request for "${model}" reached the wire with no delivery decision`);
  }

  return delivery;
}

/**
 * Shape the createTask body for a priced request. The SAME `options` record that priced the task
 * feeds this, so the price lookup and the payload can never disagree about what was asked for.
 *
 * v1 is prompt-only (no reference-image uploads); the fields are additive when that lands.
 */
export function buildProviderPayload(
  model: string,
  request: MediaRequest,
  delivery?: ImageDelivery,
  mediaProvider: MediaProviderName = 'KIE',
): Record<string, unknown> {
  switch (mediaProvider) {
    case 'KIE':
      return buildKiePayload(model, request, delivery);

    case 'FAL':
      return buildFalPayload(model, request, delivery);

    default: {
      // Exhaustive: a fourth gateway must choose its payload builder here, never fall into KIE's.
      const unreachable: never = mediaProvider;
      throw new MediaRefusedError(`Unknown media provider: ${String(unreachable)}`, 503);
    }
  }
}

/** KIE's createTask bodies — byte-identical to what `buildProviderPayload` built before T3. */
function buildKiePayload(model: string, request: MediaRequest, delivery?: ImageDelivery): Record<string, unknown> {
  const o = request.options;
  const soundKind = soundKindForModel(model);

  if (soundKind) {
    return buildSoundPayload(soundKind, model, request);
  }

  if (isGoogleVideoModel(model)) {
    // Same one writer as `endpointFor` — the Veo payload shape and the Veo route must never disagree.
    return {
      prompt: request.prompt,
      model,
      aspect_ratio: str(o.aspectRatio, '16:9'),
      resolution: str(o.resolution, '720p'),
      duration: request.durationSeconds ?? 8,
      enableTranslation: true,
    };
  }

  if (model.startsWith('kling-3.0')) {
    return {
      prompt: request.prompt,
      sound: Boolean(o.sound ?? false),
      aspect_ratio: str(o.aspectRatio, '16:9'),
      duration: String(request.durationSeconds ?? 5),
      mode: str(o.mode, 'pro'),
      multi_shots: false,
    };
  }

  if (model.startsWith('kling')) {
    return {
      prompt: request.prompt,
      sound: Boolean(o.sound ?? false),
      aspect_ratio: str(o.aspectRatio, '16:9'),
      duration: String(request.durationSeconds ?? 5),
    };
  }

  if (model.startsWith('bytedance/')) {
    return {
      prompt: request.prompt,
      aspect_ratio: str(o.aspectRatio, '16:9'),
      duration: request.durationSeconds ?? 5,
      generate_audio: Boolean(o.sound ?? false),
      ...(o.resolution ? { resolution: str(o.resolution, '720p') } : {}),
    };
  }

  if (model.startsWith('grok')) {
    return {
      prompt: request.prompt,
      aspect_ratio: str(o.aspectRatio, '16:9'),
      duration: request.durationSeconds ?? 5,
      ...(o.resolution ? { resolution: str(o.resolution, '720p') } : {}),
    };
  }

  // Image models (nano-banana-2 et al) — the jobs image shape.
  const image = requireDelivery(delivery, model);

  return {
    /*
     * A cut-out render gets a flat-backdrop directive appended. Without it the model paints its own
     * idea of transparency — a checkerboard — into the artwork, which a background remover then has
     * to guess about (this logo genuinely contains a checkered-flag ribbon).
     */
    prompt: image.cutout ? cutoutRenderPrompt(request.prompt) : request.prompt,
    image_input: [],
    aspect_ratio: str(o.aspectRatio, '16:9'),
    resolution: str(o.resolution, '2K'),

    /*
     * `renderFormat`, NOT the final format: a cut-out renders as jpg (Recraft caps its input at 5MB,
     * which a 2K PNG blows) and becomes a PNG in stage 2.
     */
    output_format: image.renderFormat,
  };
}

/**
 * KIE's three sound bodies (§4.16), ported from the owner's `kie-sound` MCP.
 *
 * The options are already validated — `validateSoundRequest` (agent/media-tools) and the Media panel
 * are the two doors, and both run it — so this only SHAPES them. Fields are omitted when unset rather
 * than sent as defaults, because Suno and ElevenLabs both treat an explicit null as a value.
 *
 * ⚠️ `model` here is the Suno VERSION (`V5`), not the priced model id (`suno/generate-sounds`). The
 * two are different facts and the wire wants the version; the ledger wants the id.
 */
function buildSoundPayload(kind: SoundKind, model: string, request: MediaRequest): Record<string, unknown> {
  const o = request.options;
  const optional = (key: string, as: 'string' | 'number' | 'boolean') =>
    o[key] !== undefined && typeof o[key] === as ? o[key] : undefined;

  if (kind === 'speech') {
    // The jobs envelope adds `{ model, input }` around this — see `KieMediaProvider.create`.
    const input: Record<string, unknown> = {
      text: request.prompt,
      voice: str(o.voice, DEFAULT_SPEECH_VOICE),
    };

    for (const [option, apiField] of [
      ['stability', 'stability'],
      ['similarityBoost', 'similarity_boost'],
      ['speechStyle', 'style'],
      ['speed', 'speed'],
      ['languageCode', 'language_code'],
    ] as const) {
      const value = o[option];

      if (value !== undefined) {
        input[apiField] = value;
      }
    }

    return input;
  }

  if (kind === 'sound_effect') {
    return {
      prompt: request.prompt,
      model: str(o.sunoModel, 'V5'),
      soundLoop: Boolean(o.loop ?? false),
      ...(optional('tempo', 'number') !== undefined ? { soundTempo: o.tempo } : {}),
      ...(optional('key', 'string') !== undefined ? { soundKey: o.key } : {}),
    };
  }

  const customMode = Boolean(o.customMode ?? false);

  return {
    prompt: request.prompt,
    model: str(o.sunoModel, 'V5'),
    customMode,
    instrumental: Boolean(o.instrumental ?? true),
    ...(customMode && o.style !== undefined ? { style: o.style } : {}),
    ...(customMode && o.title !== undefined ? { title: o.title } : {}),
    ...(customMode && o.negativeTags !== undefined ? { negativeTags: o.negativeTags } : {}),
    ...(customMode && o.vocalGender !== undefined ? { vocalGender: o.vocalGender } : {}),
    ...(customMode && o.duration !== undefined ? { duration: o.duration } : {}),

    // Resolved in the quote, BEFORE the debit — a music request without one never gets this far.
    callBackUrl: o.callbackUrl,
  };
}

/** KIE's documented default ElevenLabs voice ("James") — the MCP's default, kept. */
const DEFAULT_SPEECH_VOICE = 'EkK5I93UQWFDigLMpZcX';

/**
 * fal's request bodies (`_specs/media-gateways_plan.md` T3), shaped by the model's FAMILY in
 * `fal-routes.ts` — built from each model's documented input (`https://fal.ai/models/<id>/llms.txt`).
 *
 * ⚠️ `sync_mode` is never set (the client strips it too): it returns the file inline as a data URI,
 * which the queue/poll/download path cannot deliver.
 *
 * Video options arrive NORMALISED by `providerVideoOptions` — the same record that priced the render —
 * so `generate_audio` and Grok's `resolution` here are exactly what was billed.
 */
function buildFalPayload(model: string, request: MediaRequest, delivery?: ImageDelivery): Record<string, unknown> {
  const o = request.options;
  const route = falRouteFor(model);

  if (!route) {
    // The quote refuses an unroutable model before the debit, so reaching here is a programming error.
    throw new Error(`internal: fal model "${model}" reached the wire with no route`);
  }

  switch (route.family) {
    case 'image-nano':
    case 'image-seedream': {
      const image = requireDelivery(delivery, model);

      /*
       * A cut-out render gets the flat-backdrop directive, exactly as on KIE — stage 2 (Bria) supplies
       * the alpha, and the directive stops the model painting a checkerboard it would have to guess
       * about.
       */
      const prompt = image.cutoutPrompt ? cutoutRenderPrompt(request.prompt) : request.prompt;

      if (route.family === 'image-seedream') {
        // No `output_format` input on this model — it renders PNG (`fixedFormat` in the route table).
        return {
          prompt,
          num_images: 1,
          image_size: SEEDREAM_IMAGE_SIZES[str(o.aspectRatio, '16:9')] ?? SEEDREAM_IMAGE_SIZES['16:9'],
        };
      }

      return {
        prompt,
        num_images: 1,
        aspect_ratio: str(o.aspectRatio, '16:9'),
        resolution: str(o.resolution, '2K'),

        // `renderFormat`, NOT the final format — a cut-out renders as jpeg and becomes a PNG in stage 2.
        output_format: image.renderFormat === 'jpg' ? 'jpeg' : 'png',
      };
    }

    case 'video-kling':
    case 'video-veo':
    case 'video-grok': {
      const seconds = request.durationSeconds ?? defaultFalVideoSeconds(route.family);
      const duration = falWireDuration(route.family, seconds);

      if (duration === null) {
        // Refused in the quote (`falRouteRefusal`) — never rounded to a length that was not billed.
        throw new Error(`internal: ${seconds}s reached the wire for "${model}", which cannot render it`);
      }

      const base = { prompt: request.prompt, aspect_ratio: str(o.aspectRatio, '16:9'), duration };

      if (route.family === 'video-grok') {
        return { ...base, resolution: str(o.resolution, '720p') };
      }

      return {
        ...base,

        // Stated always: fal defaults it to TRUE, and the price row was matched on this exact value.
        generate_audio: Boolean(o.generate_audio ?? false),

        // Veo takes 720p/1080p (and prices them alike); Kling has no resolution input.
        ...(route.family === 'video-veo' && /^(720p|1080p)$/i.test(str(o.resolution, ''))
          ? { resolution: str(o.resolution, '720p').toLowerCase() }
          : {}),
      };
    }

    case 'cutout':
      // Stage 2 is created by the poll path (`cutoutTaskFor`), never quoted as a primary model.
      throw new Error(`internal: the fal cut-out "${model}" is not a model a request is built for`);

    case 'sfx':
    case 'tts':
    case 'music-minimax':
      // T6. No route lists these families yet, so the quote refuses them before any debit.
      throw new Error(`internal: fal sound ("${model}") has no payload builder yet`);

    default: {
      const unreachable: never = route.family;
      throw new Error(`internal: unknown fal family ${String(unreachable)}`);
    }
  }
}

/**
 * Where the bytes land in the project. Always under `public/assets/generated/` — user-visible,
 * referenced by path from game code, pushed to their repo like any other asset (§4.5.4b).
 */
export function deriveDestPath(
  kind: MediaTaskKind,
  request: MediaRequest & { fileName?: string },
  taskId: string,
  delivery?: ImageDelivery,
): string {
  /*
   * `finalFormat` — what actually lands on disk after any cut-out pass, never what was rendered.
   * Audio is always MP3: both KIE sound APIs return MP3 and neither transcodes.
   */
  const ext =
    kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : requireDelivery(delivery, request.model).finalFormat;
  const preferred = request.fileName?.replace(/\.[a-zA-Z0-9]+$/, '');
  const slug = (preferred || request.prompt)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  // The task-id suffix keeps two renders of the same prompt from silently overwriting each other.
  return `public/assets/generated/${slug || kind}-${taskId.slice(4, 10)}.${ext}`;
}
