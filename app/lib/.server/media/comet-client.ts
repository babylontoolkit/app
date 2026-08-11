/**
 * Comet media API client (SPEC §4.16) — the wire half of image/video generation on the Comet gateway.
 *
 * Every shape below was LIVE-PROBED against the real API on 2026-08-10; none is taken from Comet's
 * docs, which were demonstrably incomplete for the LLM surface and are no better here. The probe
 * results are recorded in `_specs/cometapi-provider_spec.md`.
 *
 * ## 🔴 TWO OF THE THREE ROUTES ARE SYNCHRONOUS, AND THE SEAM IS ASYNC
 *
 * This is the defining difference from KIE and the reason this file is not a copy of `kie-client.ts`.
 * KIE is create → task id → poll, all three routes. Comet is:
 *
 *  | route                 | wire                                                    | shape        | measured |
 *  |-----------------------|---------------------------------------------------------|--------------|----------|
 *  | `comet-video`         | `POST /v1/videos` → `GET /v1/videos/{id}`                | ASYNC        | id in 1.3s, done in 56s |
 *  | `comet-image`         | `POST /v1/images/generations`                           | SYNCHRONOUS  | 16.7s low → ~100s high |
 *  | `comet-gemini-image`  | `POST /v1beta/models/{model}:generateContent`           | SYNCHRONOUS  | 16.8s |
 *
 * §4.16's whole design is debit → enqueue → **return in milliseconds** → the CLIENT polls, precisely
 * so neither a server request nor the LLM tool loop ever parks on a multi-minute render
 * (`media-tools.ts`'s header says so, and the one time a cap was added on the theory that renders
 * blocked the loop, it was measuring the model's own reasoning). Awaiting a 100-second image inside
 * `provider.create` would make that header false and park the tool loop for real.
 *
 * So the synchronous routes are bridged: `create` FIRES the request, does not await it, parks the
 * promise in a module-level map under a synthetic id, and returns immediately. `query` reports
 * `pending` until the promise settles. The async contract is preserved exactly; the client polls our
 * route as it always did.
 *
 * ⚠️ **A parked render lives in process memory, so a restart loses it** — and a task that can never
 * complete and can never fail is the fifth terminal state `spec/fail-loud.md` exists to forbid: money
 * debited, render running, nothing able to finish it and nothing able to refund it. So an id this
 * process does not hold is reported **FAILED** — immediately, whatever its age — which routes into the
 * existing refund-exactly-once path. Reported, not silently dropped.
 *
 * ⚠️ `PENDING_RENDER_TTL_MS` is what bounds the map, and NOTHING ELSE. An earlier draft of this header
 * claimed the TTL decided when an unknown id became a failure; it never did, and the constant was
 * exported and read by nobody — a false claim in a comment, which is how this repo's defects survive
 * review. Ageing an unknown id would also be the WRONG behaviour: nothing can resolve it at any point
 * in the future, so waiting ten minutes to refund buys the user nothing but a spinner.
 *
 * ## Both image routes return BYTES, not a URL
 *
 * `:generateContent` answers with base64 `inlineData` and has no URL option at all. The
 * OpenAI-compat route nominally takes `response_format: 'url'` — and **that parameter is not
 * usable**: it answered 200 with a hosted URL at `low`/`1024x1024` and a hard 400
 * (`Unknown parameter: 'response_format'`) at `high`/`1536x1024`, same model and key, minutes apart.
 * See `_renderImage`. So a settled image render normally keeps its bytes in the parked entry and
 * `download` serves them from there, which is why `download` is on the seam rather than being a free
 * function per provider. A backend that volunteers a URL is still honoured.
 */
import { createScopedLogger } from '~/utils/logger';
import type { CreateMediaTaskInput, MediaEndpoint, MediaProvider, MediaProviderName, MediaTaskState } from './provider';

const logger = createScopedLogger('comet-media');

const DEFAULT_BASE = 'https://api.cometapi.com/v1';
const UA = 'babylon-toolkit-app-builder/1.0';

/**
 * How long a SETTLED render's entry (and its bytes) is kept before being swept.
 *
 * It bounds memory and nothing else — an entry must outlive the gap between `query` reporting success
 * and `download` collecting the bytes, but a long-running server must not accumulate every image it
 * has ever rendered. Comfortably above the slowest measured render (~100s at `quality: high`) plus a
 * client poll cycle, so a live task is never swept out from under itself.
 *
 * ⚠️ Only SETTLED entries are swept. Sweeping one still in flight would orphan the very render the
 * parking exists to track — turning a slow success into an unrecoverable failure and a refund.
 */
export const PENDING_RENDER_TTL_MS = 10 * 60_000;

/** A synchronous render in flight, or settled and waiting to be collected by `query` / `download`. */
interface ParkedRender {
  startedAt: number;
  state: MediaTaskState;

  /** Bytes for a route that returns them inline (gemini). Absent when the render yielded a URL. */
  bytes?: Uint8Array;
  contentType?: string;
}

/**
 * Module-level and per-process, like the dispatch queue. It holds no credits and no user data — the
 * TASK RECORD in the ObjectStore is the only thing that can finish or refund a render (`service.ts`),
 * and this is a cache in front of it.
 */
const parked = new Map<string, ParkedRender>();

/** Exported for tests — a shared map would otherwise leak between cases. */
export function clearParkedRenders(): void {
  parked.clear();
}

/**
 * Drop settled entries older than the TTL, so a long-lived process does not hold every image it has
 * ever rendered. Called on the read paths rather than on a timer: a sweep that needs an interval is a
 * sweep that keeps a process alive, and there is nothing to collect unless somebody is polling.
 */
function sweepParkedRenders(now: number): void {
  for (const [id, entry] of parked) {
    if (entry.state.state !== 'pending' && now - entry.startedAt > PENDING_RENDER_TTL_MS) {
      parked.delete(id);
    }
  }
}

/**
 * The synthetic id a parked render is polled by.
 *
 * Prefixed so it is unmistakable in a stored record: `kieTaskId` on a Comet image task holds one of
 * these rather than a gateway id, and a reader looking at a task record should be able to tell at a
 * glance that no upstream system knows this string.
 */
function mintLocalTaskId(): string {
  return `comet-local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class CometMediaProvider implements MediaProvider {
  readonly name: MediaProviderName = 'Comet';

  private readonly _apiKey: string;
  private readonly _base: string;

  constructor(apiKey: string, baseUrl?: string) {
    this._apiKey = apiKey;
    this._base = (baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  }

  /** `…/v1beta` — Gemini's native surface. Derived from the SAME base, so one override moves both. */
  private get _geminiBase(): string {
    return `${this._base.replace(/\/v1$/, '')}/v1beta`;
  }

  private _headers(json = true): Record<string, string> {
    return {
      Authorization: `Bearer ${this._apiKey}`,
      'User-Agent': UA,
      Accept: 'application/json',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  private async _json(url: string, method: 'GET' | 'POST', body?: unknown): Promise<any> {
    const response = await fetch(url, {
      method,
      headers: this._headers(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,

      /*
       * Long, because two of these routes RENDER inside the request. It is not a tool-loop stall —
       * the caller has already returned (see the header) — but it must still be bounded, or a
       * gateway that never answers parks a promise forever.
       */
      signal: AbortSignal.timeout(300_000),
    });

    const text = await response.text();

    let parsed: any;

    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Comet returned non-JSON from ${url} (HTTP ${response.status}): ${text.slice(0, 200)}`);
    }

    if (!response.ok) {
      // Comet's error text names the real problem (unpriced model, no channel, bad option) — surface it.
      const message = parsed?.error?.message ?? JSON.stringify(parsed);
      throw new Error(`Comet ${method} ${url} failed (HTTP ${response.status}): ${String(message).slice(0, 300)}`);
    }

    return parsed;
  }

  async create(input: CreateMediaTaskInput): Promise<string> {
    switch (input.endpoint) {
      case 'comet-video':
        return this._createVideo(input);

      case 'comet-image':
        return this._park(this._renderImage(input), input.model);

      case 'comet-gemini-image':
        return this._park(this._renderGeminiImage(input), input.model);

      default:
        /*
         * EXPLICIT, never a fallthrough — the same rule `kie-client.ts` follows. `MediaEndpoint` is a
         * shared persisted vocabulary, so "anything that is not video is an image" would POST a KIE
         * task to a Comet route: a debit taken against a task id that means nothing.
         */
        throw new Error(
          `Comet does not serve the "${input.endpoint}" endpoint — that task belongs to another provider.`,
        );
    }
  }

  /** The one genuinely async route: a real gateway task id, returned in about a second. */
  private async _createVideo(input: CreateMediaTaskInput): Promise<string> {
    const result = await this._json(`${this._base}/videos`, 'POST', { model: input.model, ...input.payload });
    const taskId = result?.id ?? result?.task_id;

    if (!taskId) {
      throw new Error(`Comet createVideo returned no task id: ${JSON.stringify(result).slice(0, 300)}`);
    }

    logger.info(`Comet video task ${taskId} created (${input.model})`);

    return String(taskId);
  }

  /**
   * Park a synchronous render and return at once.
   *
   * ⚠️ The promise is deliberately NOT awaited, and its rejection is handled INSIDE — an unhandled
   * rejection here would be a process-level warning (and, on some runtimes, a crash) for a failure the
   * poll path is perfectly able to report.
   */
  private _park(render: Promise<ParkedRender>, model: string): string {
    const id = mintLocalTaskId();
    parked.set(id, { startedAt: Date.now(), state: { state: 'pending' } });

    render.then(
      (settled) => {
        /*
         * An inline render cannot name itself: the id is minted HERE, after the render promise was
         * created, so the `comet-inline:<id>` URL only becomes expressible once we are back in this
         * closure. Left unresolved, the entry would sit `pending` forever with its bytes in hand —
         * a task that succeeded and can never be collected.
         */
        parked.set(
          id,
          settled.bytes && settled.state.state === 'pending'
            ? { ...settled, state: { state: 'succeeded', resultUrl: inlineResultUrl(id) } }
            : settled,
        );
      },
      (error: Error) => {
        logger.warn(`Comet render ${id} (${model}) failed: ${error.message}`);
        parked.set(id, { startedAt: Date.now(), state: { state: 'failed', error: error.message.slice(0, 500) } });
      },
    );

    logger.info(`Comet render ${id} started (${model}) — synchronous route, parked`);

    return id;
  }

  /**
   * `POST /v1/images/generations` — OpenAI-compatible.
   *
   * 🔴 **`response_format` IS NOT SENT, and that is a measurement, not caution.** It looked like the
   * right lever — a URL keeps a multi-MB image out of this process's memory and lets the ordinary
   * streaming file proxy carry it — and `low`/`1024x1024` genuinely answered 200 with a hosted URL.
   * But `high`/`1536x1024`, same model, same key, minutes later, returned a hard **400
   * `Unknown parameter: 'response_format'`**. Comet's image adaptor is not consistent across its
   * backends (the same per-backend inconsistency the cache probe found on the LLM surface), so a
   * parameter that works is not a parameter that will work.
   *
   * Sending it therefore trades a memory cost for a **hard failure on an unknowable subset of
   * renders**, after the debit. So: never sent, and BOTH answer shapes are accepted — whichever this
   * backend happens to give us.
   */
  private async _renderImage(input: CreateMediaTaskInput): Promise<ParkedRender> {
    const result = await this._json(`${this._base}/images/generations`, 'POST', {
      model: input.model,
      n: 1,
      ...input.payload,
    });

    const url = result?.data?.[0]?.url;

    if (url) {
      return { startedAt: Date.now(), state: { state: 'succeeded', resultUrl: String(url) } };
    }

    const b64 = result?.data?.[0]?.b64_json;

    if (typeof b64 === 'string' && b64) {
      /*
       * The common shape. `output_format` is echoed by the API, so the content type comes from what
       * the backend SAYS it produced rather than from what we asked for — the §4.16 rule that a
       * provider's word about a format is checked against the bytes lives one layer up, in the file
       * route's sniffer, and this must not pre-empt it with a guess.
       */
      return inlineRender(b64, result?.output_format === 'jpeg' ? 'image/jpeg' : 'image/png');
    }

    /*
     * Success with no image is reported as FAILED, deliberately — KIE's client makes the same call
     * for the same reason. A "succeeded" task with nothing to download is a task the delivery path
     * cannot complete and the refund path will never look at.
     */
    return {
      startedAt: Date.now(),
      state: { state: 'failed', error: 'Comet reported success but returned no image.' },
    };
  }

  /** `POST /v1beta/models/{model}:generateContent` — bytes inline, no URL option. */
  private async _renderGeminiImage(input: CreateMediaTaskInput): Promise<ParkedRender> {
    const url = `${this._geminiBase}/models/${encodeURIComponent(input.model)}:generateContent`;
    const result = await this._json(url, 'POST', input.payload);

    const parts: any[] = result?.candidates?.[0]?.content?.parts ?? [];
    const data = parts.map((p) => p?.inlineData ?? p?.inline_data).find((d) => typeof d?.data === 'string' && d.data);

    if (!data) {
      return {
        startedAt: Date.now(),
        state: { state: 'failed', error: 'Comet (Gemini) returned no image data.' },
      };
    }

    return inlineRender(String(data.data), String(data.mimeType ?? data.mime_type ?? 'image/png'));
  }

  async query(endpoint: MediaEndpoint, providerTaskId: string): Promise<MediaTaskState> {
    if (endpoint === 'comet-video') {
      return this._queryVideo(providerTaskId);
    }

    if (endpoint !== 'comet-image' && endpoint !== 'comet-gemini-image') {
      throw new Error(`Comet does not serve the "${endpoint}" endpoint — that task belongs to another provider.`);
    }

    sweepParkedRenders(Date.now());

    const entry = parked.get(providerTaskId);

    if (entry) {
      return entry.state;
    }

    /*
     * 🔴 UNKNOWN TO THIS PROCESS. Either the render is older than the TTL, or the process restarted
     * while it was in flight. Both mean nobody is going to finish it — so say FAILED and let the
     * refund fire, rather than leaving a paid-for task pending forever with nothing able to resolve
     * it. Loud, because it means a user's render was lost to a deploy.
     */
    logger.warn(`Comet render ${providerTaskId} is unknown to this process — reporting failed so it refunds`);

    return {
      state: 'failed',
      error:
        'The render was interrupted (the server restarted while it was still rendering) and cannot be ' +
        'recovered. The credits have been refunded — please generate it again.',
    };
  }

  private async _queryVideo(taskId: string): Promise<MediaTaskState> {
    const info = await this._json(`${this._base}/videos/${encodeURIComponent(taskId)}`, 'GET');
    const status = String(info?.status ?? info?.state ?? '').toLowerCase();

    if (status === 'completed' || status === 'succeeded') {
      const url = info?.video_url ?? info?.url ?? info?.output?.url;

      return url
        ? { state: 'succeeded', resultUrl: String(url) }
        : { state: 'failed', error: 'Comet reported the video completed but returned no URL.' };
    }

    if (status === 'failed' || status === 'error' || status === 'cancelled') {
      const message = info?.error?.message ?? info?.error ?? 'The provider reported the generation failed.';

      return { state: 'failed', error: String(message).slice(0, 500) };
    }

    return { state: 'pending' };
  }

  async download(url: string): Promise<Response> {
    /*
     * A parked render whose bytes never got a URL (the gemini route). Served from memory rather than
     * re-fetched: there is nowhere to re-fetch it FROM, and the platform stores no project files
     * (§4.5.4b) — the bytes' destination is the user's sandbox, and this is the hop.
     */
    if (url.startsWith(INLINE_SCHEME)) {
      const entry = parked.get(url.slice(INLINE_SCHEME.length));

      if (!entry?.bytes) {
        throw new Error(
          'That render is no longer available to download (the server restarted since it finished). ' +
            'Please generate it again.',
        );
      }

      return new Response(entry.bytes as unknown as BodyInit, {
        headers: { 'Content-Type': entry.contentType ?? 'application/octet-stream' },
      });
    }

    /*
     * Comet's result URLs are presigned S3 with an expiry (measured: X-Amz-Expires=259200, 3 days),
     * so the bytes must be fetched promptly — which is exactly why they land in the PROJECT and are
     * never hotlinked. No auth header: the signature is the credential, and sending ours to an S3
     * host would leak the platform key off-gateway (§5).
     */
    const response = await fetch(url, { headers: { 'User-Agent': UA } });

    if (!response.ok || !response.body) {
      throw new Error(
        `Could not download the render (HTTP ${response.status}) — Comet's result URLs expire, ` +
          're-generate if this task is old.',
      );
    }

    return response;
  }
}

/** The pseudo-URL a parked inline render is addressed by. Never leaves this module's own pair. */
const INLINE_SCHEME = 'comet-inline:';

function inlineRender(b64: string, contentType: string): ParkedRender {
  const bytes = Uint8Array.from(Buffer.from(b64, 'base64'));

  return { startedAt: Date.now(), bytes, contentType, state: { state: 'pending' } };
}

/**
 * Finish an inline render by pointing it at itself.
 *
 * Split out because the id is minted by `_park` AFTER the render promise is created, so the
 * `comet-inline:<id>` URL cannot be built inside the render — the map entry is rewritten with its own
 * key once it settles.
 */
export function inlineResultUrl(taskId: string): string {
  return `${INLINE_SCHEME}${taskId}`;
}
