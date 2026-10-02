/**
 * The media provider SEAM (SPEC §4.16) — the interface, the persisted endpoint vocabulary, and the
 * one factory that turns a provider NAME into a client.
 *
 * ## Why this module exists at all
 *
 * Media generation shipped with the seam living inside `kie-client.ts`, which was correct while KIE
 * was the only gateway that served renders. It stopped being correct the moment a second gateway did:
 * four call sites constructed `new KieMediaProvider(...)` concretely, `downloadResult` was a free
 * function the file route imported directly, and `MediaEndpoint` was a KIE-shaped `'jobs' | 'veo'`
 * union that is PERSISTED on every task record. A second provider added under that shape would have
 * been a fifth concrete `new` and a second free function.
 *
 * So the interface moved out of the implementation. `kie-client.ts` now holds only KIE.
 *
 * ## 🔴 THE PROVIDER IS A PROPERTY OF THE TASK, NEVER OF CURRENT CONFIG
 *
 * `MEDIA_PROVIDER` is an operator switch, and a render takes minutes. Flip it while a KIE render is in
 * flight and every later poll would ask the WRONG gateway about a task id it has never heard of — the
 * task never completes, and the refund path eventually fires on a render that may well have succeeded:
 * the user is refunded for art they did not get, our account is billed for art nobody receives, and
 * nothing throws. That is why `MediaTaskRecord.provider` is stamped at creation and why `poll` and
 * `download` take a RESOLVER (`MediaProviderResolver`) rather than an instance — the service reads the
 * name off the record and asks for that one. A caller cannot accidentally hand in "whatever is
 * configured now", because it does not hand in a provider at all.
 *
 * A record written before that field existed resolves to `'KIE'` (`mediaProviderOf`) — the only
 * gateway that could have written it.
 *
 * ## `download` is part of the interface
 *
 * It was a free function because KIE's result URLs are plain signed GETs. Another gateway's may need
 * different handling, and the route must ask THE TASK'S provider — the same rule as polling, for the
 * same reason.
 *
 * ## A gateway can be RETIRED, and its records outlive it
 *
 * Comet served renders until 2026-10-01 (removed by owner decision: a security issue). Its task
 * records are still in storage, stamped with its name. They are never sent anywhere: the poll fails
 * them with `retiredMediaGatewayError` and refunds through the ordinary latch, and nothing resolves a
 * client for them (`mediaProviderOf` throws rather than quietly answering KIE).
 */
import { createScopedLogger } from '~/utils/logger';
import { NotConfiguredError } from '~/lib/.server/env';
import {
  getMediaConfig,
  MEDIA_PROVIDERS,
  RETIRED_MEDIA_PROVIDERS,
  type MediaProviderName,
  type RetiredMediaProviderName,
} from '~/lib/.server/agent/config';
import { KieMediaProvider } from './kie-client';
import { FalMediaProvider } from './fal-client';

const logger = createScopedLogger('media-provider');

export { MEDIA_PROVIDERS, RETIRED_MEDIA_PROVIDERS };

/*
 * Gateways that USED to serve renders (declared beside `MEDIA_PROVIDERS` in `config.ts`). A task record
 * may still name one — the field is persisted — so the store's type accepts it, and nothing else does.
 */
export type { MediaProviderName, RetiredMediaProviderName };

/**
 * Which upstream route a task is polled on. **PERSISTED** on the task record, so this union is a
 * storage format: values may be added, never renamed, or every in-flight and historical task written
 * under the old spelling becomes unpollable.
 *
 * `jobs` / `veo` are KIE's two shapes, and `suno-sounds` / `suno-music` its two audio ones (§4.16
 * `generate_sound`; ElevenLabs speech rides `jobs` like any other KIE job).
 *
 * ⚠️ The three `comet-*` values are KEPT ONLY SO OLD RECORDS STILL PARSE. Comet is no longer a media
 * gateway (2026-10-01) and nothing creates a task on them; a record carrying one is failed and
 * refunded on its next poll (`retiredMediaGatewayError`). Removing them would turn those records into
 * a type the store cannot describe.
 *
 * `fal-queue` is fal.ai's ONE route for every model (T3): submit to `queue.fal.run/{model}`, poll the
 * `response_url` it returns. One value is enough because fal's routing lives in the stored id itself.
 */
export type MediaEndpoint =
  | 'jobs'
  | 'veo'
  | 'suno-sounds'
  | 'suno-music'
  | 'comet-image'
  | 'comet-gemini-image'
  | 'comet-video'
  | 'fal-queue';

export interface CreateMediaTaskInput {
  endpoint: MediaEndpoint;

  /** The provider's model slug — `service.ts` has already resolved aliases and priced it. */
  model: string;

  /** The request body's input/payload, already shaped by `service.ts` (`buildProviderPayload`). */
  payload: Record<string, unknown>;
}

export type MediaTaskState =
  | { state: 'pending' }
  | { state: 'succeeded'; resultUrl: string }
  | { state: 'failed'; error: string };

/** The seam the service depends on — a fake implements this in `media.spec.ts`. */
export interface MediaProvider {
  /**
   * Which gateway this is. Read by `startMediaTask` to STAMP the task record, so the poll that
   * happens ten minutes later can find its way back here. A provider that lied about its name would
   * hand every one of its tasks to somebody else.
   */
  readonly name: MediaProviderName;

  create(input: CreateMediaTaskInput): Promise<string>;
  query(endpoint: MediaEndpoint, providerTaskId: string): Promise<MediaTaskState>;

  /**
   * Stream a finished render's bytes. Returns the raw `Response` so the file route can pipe it
   * through without buffering a multi-hundred-MB video in memory.
   */
  download(url: string): Promise<Response>;
}

/** How the service gets from a task record's provider NAME to a client. */
export type MediaProviderResolver = (name: MediaProviderName) => MediaProvider;

/**
 * 🔴 THE ONE PLACE A STORED TASK ON A RETIRED GATEWAY IS ANSWERED: the failure sentence its next poll
 * records (and refunds under), or `null` for a task on a live gateway. The poll checks this BEFORE it
 * resolves a client, so the retired gateway is never contacted — and neither is KIE, which would be
 * asked about a task id it never issued.
 */
export function retiredMediaGatewayError(record: { provider?: string }): string | null {
  const retired = RETIRED_MEDIA_PROVIDERS.find((name) => name === record.provider);

  return retired ? `${retired} is no longer a media gateway; this render was refunded.` : null;
}

/**
 * Which gateway a stored task belongs to.
 *
 * `undefined` → `'KIE'`, because a record written before the field existed can only have come from
 * KIE, which was the sole media gateway. An unrecognised string is treated the same way and logged:
 * the alternative — throwing — would make one corrupt record permanently unpollable and unrefundable,
 * which is a worse answer than asking the incumbent and reporting a failure it can actually explain.
 */
export function mediaProviderOf(record: { id?: string; provider?: string }): MediaProviderName {
  if (retiredMediaGatewayError(record)) {
    /*
     * Never the KIE fallback below: KIE would be asked about (or handed the URL of) a task it never
     * issued. A refusal the operator can read is the honest answer; the poll path never gets here.
     */
    throw new NotConfiguredError(
      `Media task ${record.id ?? '(unknown)'}`,
      `It was created on ${record.provider}, which is no longer a media gateway.`,
    );
  }

  const name = MEDIA_PROVIDERS.find((candidate) => candidate === record.provider);

  if (!name && record.provider) {
    logger.warn(`media task ${record.id ?? '(unknown)'} names provider "${record.provider}" — treating it as KIE`);
  }

  return name ?? 'KIE';
}

/**
 * Build the client for a provider. The ONE place a media client is constructed — routes and the proxy
 * go through here so a new gateway is one entry, not a fifth `new` somewhere nobody greps.
 *
 * ⚠️ THROWS for a gateway with no client. Use it on paths where media IS the request (the media
 * routes, the poll, the download) and the caller wants the refusal reported; use
 * `resolveMediaProvider` on paths where media is one capability among many.
 *
 * It throws `NotConfiguredError` specifically, and that is not decoration: it is in `http.ts`'s
 * `SAFE_ERRORS`, so its text reaches the operator. A plain `Error` here becomes a generic 500
 * ("Something went wrong on our end"), which would make this module's promise of a *describable*
 * refusal false — the class of defect where the comment says one thing and the wire says another.
 */
export function mediaProviderFor(name: MediaProviderName, apiKey: string, _baseUrl?: string): MediaProvider {
  /*
   * `_baseUrl` is still threaded from `mediaBaseUrlFor` so a gateway that gains an origin override
   * needs one line here, not a change at every call site. No live gateway has one today.
   */
  switch (name) {
    case 'KIE':
      return new KieMediaProvider(apiKey);

    case 'FAL':
      // One public queue host and no base-URL override (`mediaBaseUrlFor` answers null for fal).
      return new FalMediaProvider(apiKey);

    default: {
      // Exhaustive: a new name in `MEDIA_PROVIDERS` is a compile error here, not a runtime surprise.
      const unreachable: never = name;
      throw new NotConfiguredError(`Media provider "${String(unreachable)}"`, 'It has no client.');
    }
  }
}

/**
 * 🔴 THE NON-THROWING DOOR — the media provider for this request, or `null`.
 *
 * `mediaProviderFor` throws, `getMediaProvider` throws on a typo'd `MEDIA_PROVIDER`, and the agent
 * proxy resolves media tools in STRAIGHT-LINE code on every turn that has a project. Composing those
 * three meant an unserveable media capability took down the whole generation: on a box with
 * a gateway whose media client had not shipped `/api/agent` returned HTTP 500 before a
 * token — no chat at all, because image generation was unavailable.
 *
 * That is this repo's own standing rule arriving in a new place: **a degraded capability reports
 * "off", never "on" — and it must not take the request down** (the `/api/me` premium-hint entry). The
 * honest degradation is "no media tools this turn"; the model then says it cannot generate art, which
 * is true, instead of the user getting nothing.
 *
 * It is LOUD in the log and silent to the request — the fail-loud rule's shape for a capability that
 * is not what was asked for. Never use it where media IS the request: a Media-panel Generate that
 * quietly did nothing would be the silent no-op §4.16 exists to prevent.
 */
export function resolveMediaProvider(context?: unknown): MediaProvider | null {
  try {
    const config = getMediaConfig(context);

    if (!config) {
      return null;
    }

    return mediaProviderFor(config.provider, config.apiKey, config.baseUrl);
  } catch (error) {
    logger.warn(`No media provider this request — media tools are off: ${(error as Error).message}`);

    return null;
  }
}
