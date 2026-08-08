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
import type { MediaProvider, MediaEndpoint } from './kie-client';
import { putMediaTask, getMediaTask, type MediaTaskRecord } from './store';
import { cutoutRenderPrompt, resolveImageDelivery, type ImageDelivery } from '~/lib/media/output-format';

const logger = createScopedLogger('media-service');

/** Veo model ids use the dedicated endpoint; everything else is a jobs model. */
const VEO_MODELS = new Set(['veo3', 'veo3_fast', 'veo3_lite']);

/**
 * The cut-out model — stage 2 of a transparent image (§4.16). Not a model anyone selects: it takes an
 * image URL, not a prompt, so naming it as a primary model is always a mistake and is refused below
 * BEFORE the debit rather than after a wasted render.
 */
export const CUTOUT_MODEL = 'recraft/remove-background';

/**
 * Recraft's input limits (their docs): ≤5MB, ≤16MP, ≤4096px on a side, ≥256px.
 *
 * Only the dimension cap can be violated by a request we would otherwise accept — a 4K nano-banana
 * render is 5504×3072. Refused UP FRONT in the quote so the panel says so before spending, instead of
 * paying for a render whose cut-out then fails and refunds.
 */
const CUTOUT_MAX_RESOLUTION_NOTE = '4K is too large for the cut-out pass (it caps at 4096px a side) — use 2K or 1K.';

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
  /** Canonical priced model id (aliases resolved). */
  model: string;
  kind: 'image' | 'video';

  /** The TOTAL raw cost — render plus the cut-out pass when there is one. What credits derive from. */
  usd: number;
  credits: number;

  /** How this image is delivered (cut-out pass, rendered format, final format). Images only. */
  delivery?: ImageDelivery;

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
export function quoteMediaRequest(request: MediaRequest, context?: unknown): MediaQuote {
  const list = activeMarketPrices();

  if (request.model === CUTOUT_MODEL) {
    throw new MediaRefusedError(
      `"${CUTOUT_MODEL}" is the automatic cut-out pass, not a model you generate with — it takes an ` +
        'image, not a prompt. Ask for transparency instead (transparent: true) and it runs by itself.',
    );
  }

  const price = lookupMediaPrice(list, {
    model: request.model,
    options: lookupOptions(request),
    durationSeconds: request.durationSeconds,
  });

  if (!price) {
    throw new MediaRefusedError(unpricedMessage(list, request));
  }

  const config = getBillingConfig(context);
  const kind = findMediaModel(list, price.model)!.pricing.kind;

  if (kind !== 'image') {
    return { model: price.model, kind, usd: price.usd, credits: creditsForRawCost(price.usd, config) };
  }

  const delivery = deliveryFor(request);

  if (!delivery.cutout) {
    return { model: price.model, kind, usd: price.usd, credits: creditsForRawCost(price.usd, config), delivery };
  }

  if (String(request.options.resolution ?? '').toUpperCase() === '4K') {
    throw new MediaRefusedError(CUTOUT_MAX_RESOLUTION_NOTE);
  }

  const cutoutPrice = lookupMediaPrice(list, { model: CUTOUT_MODEL, options: {} });

  /*
   * Refuse, never silently degrade. Dropping the cut-out would deliver an OPAQUE image against a
   * request for a transparent one — which is precisely the failure that shipped a logo with a
   * checkerboard baked into it, and it would report success while doing so.
   */
  if (!cutoutPrice) {
    throw new MediaRefusedError(
      `Transparent images need the cut-out pass ("${CUTOUT_MODEL}"), which is not in the active ` +
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
  };
}

/** The delivery decision for an image request — one place, so quote/payload/path cannot disagree. */
function deliveryFor(request: MediaRequest): ImageDelivery {
  return resolveImageDelivery({
    explicitFormat: request.options.outputFormat as string | undefined,
    transparent: request.options.transparent as boolean | string | undefined,
    fileName: (request as { fileName?: string }).fileName,
    prompt: request.prompt,
  });
}

/** Duration participates in variant matching too (kling-2.6 prices per 5s/10s video). */
function lookupOptions(request: MediaRequest): Record<string, string | number | boolean> {
  return request.durationSeconds !== undefined
    ? { ...request.options, durationSeconds: request.durationSeconds }
    : request.options;
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

  return needsDuration
    ? `"${found.id}" is priced per second, so durationSeconds is required to price the render.`
    : `No priced variant of "${found.id}" matches ${JSON.stringify(request.options)}. ` +
        `Priced variants: ${found.pricing.variants.map((v) => JSON.stringify(v.options)).join(', ')}.`;
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
  kind: 'image' | 'video';
}

export async function startMediaTask(input: StartMediaInput): Promise<StartedMediaTask> {
  await ensureMarketPrices(input.context);

  if (!input.prompt?.trim()) {
    throw new MediaRefusedError('A prompt is required to generate media.');
  }

  const quote = quoteMediaRequest(input, input.context);
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
    provider: 'KIE',
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
        endpoint: endpointFor(quote.model),
        model: quote.model,
        payload: buildProviderPayload(quote.model, input, quote.delivery),
      }),
    );
  } catch (error) {
    // The task never started, so the money comes straight back and the anchor says failed.
    await refundMediaTask(
      input.userId,
      id,
      debited,
      `KIE refused the task: ${(error as Error).message}`,
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
    endpoint: endpointFor(quote.model),
    model: quote.model,
    prompt: input.prompt,
    options: input.options,
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
  provider: MediaProvider;
  objectStore: ObjectStore;
  context?: unknown;
}

/**
 * Advance a task by asking KIE once. Terminal states are sticky; the failure path refunds EXACTLY
 * once (the `refunded` latch on the record, inside the per-task serialisation).
 */
export async function pollMediaTask(input: PollMediaInput): Promise<MediaTaskRecord | null> {
  return serialised(input.taskId, async () => {
    const record = await getMediaTask(input.objectStore, input.projectId, input.taskId);

    if (!record || record.status !== 'pending') {
      return record;
    }

    let state;

    try {
      state = await input.provider.query(record.endpoint, record.kieTaskId);
    } catch (error) {
      // A flaky poll is NOT a failed render — stay pending; the next poll asks again.
      logger.warn(`Poll for ${record.id} failed transiently: ${(error as Error).message}`);
      return record;
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
          const cutoutTaskId = await input.provider.create({
            endpoint: 'jobs',
            model: CUTOUT_MODEL,
            payload: { image: state.resultUrl },
          });

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

function endpointFor(model: string): MediaEndpoint {
  return VEO_MODELS.has(model) ? 'veo' : 'jobs';
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
 * Shape the createTask body for a priced request. The SAME `options` record that priced the task
 * feeds this, so the price lookup and the payload can never disagree about what was asked for.
 *
 * v1 is prompt-only (no reference-image uploads); the fields are additive when that lands.
 */
export function buildProviderPayload(
  model: string,
  request: MediaRequest,
  delivery?: ImageDelivery,
): Record<string, unknown> {
  const o = request.options;

  if (VEO_MODELS.has(model)) {
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
  const image = delivery ?? deliveryFor(request);

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
 * Where the bytes land in the project. Always under `public/assets/generated/` — user-visible,
 * referenced by path from game code, pushed to their repo like any other asset (§4.5.4b).
 */
export function deriveDestPath(
  kind: 'image' | 'video',
  request: MediaRequest & { fileName?: string },
  taskId: string,
  delivery?: ImageDelivery,
): string {
  // `finalFormat` — what actually lands on disk after any cut-out pass, never what KIE rendered.
  const ext = kind === 'video' ? 'mp4' : (delivery ?? deliveryFor(request)).finalFormat;
  const preferred = request.fileName?.replace(/\.[a-zA-Z0-9]+$/, '');
  const slug = (preferred || request.prompt)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  // The task-id suffix keeps two renders of the same prompt from silently overwriting each other.
  return `public/assets/generated/${slug || kind}-${taskId.slice(4, 10)}.${ext}`;
}
