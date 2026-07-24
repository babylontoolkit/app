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
import { getLedger } from '~/lib/.server/billing/ledger';
import { getGenerationStore } from '~/lib/.server/billing/generations';
import { getBillingConfig, creditsForRawCost } from '~/lib/.server/billing/rates';
import { activeMarketPrices, ensureMarketPrices } from '~/lib/.server/billing/market-price-store';
import { lookupMediaPrice, findMediaModel, type MarketPriceList } from '~/lib/.server/billing/market-prices';
import type { ObjectStore } from '~/lib/.server/storage';
import type { MediaProvider, MediaEndpoint } from './kie-client';
import { putMediaTask, getMediaTask, type MediaTaskRecord } from './store';
import { resolveImageOutputFormat } from '~/lib/media/output-format';

const logger = createScopedLogger('media-service');

/** Veo model ids use the dedicated endpoint; everything else is a jobs model. */
const VEO_MODELS = new Set(['veo3', 'veo3_fast', 'veo3_lite']);

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
  usd: number;
  credits: number;
}

/**
 * Price a request against the ACTIVE list, or refuse. The one pricing door — start uses exactly this,
 * so the number the UI showed on the button is the number the ledger debits.
 */
export function quoteMediaRequest(request: MediaRequest, context?: unknown): MediaQuote {
  const list = activeMarketPrices();
  const price = lookupMediaPrice(list, {
    model: request.model,
    options: lookupOptions(request),
    durationSeconds: request.durationSeconds,
  });

  if (!price) {
    throw new MediaRefusedError(unpricedMessage(list, request));
  }

  const config = getBillingConfig(context);

  return {
    model: price.model,
    kind: findMediaModel(list, price.model)!.pricing.kind,
    usd: price.usd,
    credits: creditsForRawCost(price.usd, config),
  };
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
  const destPath = deriveDestPath(quote.kind, input, id);

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
    kieTaskId = await input.provider.create({
      endpoint: endpointFor(quote.model),
      model: quote.model,
      payload: buildProviderPayload(quote.model, input),
    });
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
    createdAt: now,
    updatedAt: now,
  };
  await putMediaTask(input.objectStore, record);

  logger.info(`Media task ${id} started: ${quote.model} → ${destPath} (${debited} credits, $${quote.usd})`);

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
    logger.error(`FAILED TO REFUND media task ${mediaId}: ${(error as Error).message}`);
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
export function buildProviderPayload(model: string, request: MediaRequest): Record<string, unknown> {
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
  return {
    prompt: request.prompt,
    image_input: [],
    aspect_ratio: str(o.aspectRatio, '16:9'),
    resolution: str(o.resolution, '2K'),
    output_format: resolveImageOutputFormat(o.outputFormat as string | undefined, {
      fileName: (request as { fileName?: string }).fileName,
      prompt: request.prompt,
    }),
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
): string {
  const ext =
    kind === 'video'
      ? 'mp4'
      : resolveImageOutputFormat(request.options.outputFormat as string | undefined, {
          fileName: request.fileName,
          prompt: request.prompt,
        });
  const preferred = request.fileName?.replace(/\.[a-zA-Z0-9]+$/, '');
  const slug = (preferred || request.prompt)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  // The task-id suffix keeps two renders of the same prompt from silently overwriting each other.
  return `public/assets/generated/${slug || kind}-${taskId.slice(4, 10)}.${ext}`;
}
