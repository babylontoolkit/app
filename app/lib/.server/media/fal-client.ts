/**
 * fal.ai media client (SPEC §4.16, `_specs/media-gateways_plan.md` T3) — the wire half of renders on the
 * fal gateway: images, the transparency cut-out, and video.
 *
 * fal is a QUEUE, which is exactly the shape the seam already has (create → id → poll), so nothing is
 * parked in process memory and a deploy loses nothing:
 *
 *  | step    | wire                                                         |
 *  |---------|--------------------------------------------------------------|
 *  | submit  | `POST https://queue.fal.run/{model}` → `{ request_id, response_url, status_url, … }` |
 *  | status  | `GET {response_url}/status` → `IN_QUEUE` / `IN_PROGRESS` / `COMPLETED` |
 *  | result  | `GET {response_url}` → model-shaped JSON with the file URL (`falResultUrl`) |
 *  | file    | a public GET on `v3.fal.media` etc. — no key                 |
 *
 * Auth is `Authorization: Key <FAL_API_KEY>` (not `Bearer`).
 *
 * ## 🔴 THE TASK ID IS fal's `response_url`, AND NO URL IS EVER REBUILT FROM THE MODEL ID
 *
 * fal's status and result URLs DROP the model's subpath: a job submitted to `fal-ai/veo3/fast` lives
 * under `fal-ai/veo3/requests/{id}`. Rebuilding `…/{model}/requests/{id}/status` from the stored model
 * would poll a path fal does not serve for that job — the render would never complete, and the refund
 * path would eventually fire on art that rendered fine. So `create` returns the `response_url` fal gave
 * us, it is stored as the provider task id (`kieTaskId` — a historical name that holds any gateway's
 * id), and the status URL is DERIVED from it (`statusUrlFor`), the one relation fal documents.
 *
 * ## 🔴 A FAILED JOB ALSO REPORTS `COMPLETED`
 *
 * Measured (2026-10-01 probe): the status body carries NO `error` field — the result GET answers 422
 * with a `detail` list. fal documents `error` / `error_type` beside `COMPLETED`, so both are read.
 * Reading `COMPLETED` as success would deliver nothing and report a succeeded task the download path
 * cannot complete.
 *
 * ## SSRF wall
 *
 * The task id comes back out of STORAGE and is fetched with the platform key attached. `query` refuses
 * anything that is not an `https://queue.fal.run/` URL before any request is made, so a corrupt or
 * tampered record can never point the key at another host.
 *
 * Confirmed by `scripts/fal-media-probe.mjs` (2026-10-01, 13 jobs): the status-URL relation, the
 * failed-job shape and the result field names. Each lives in ONE function here.
 */
import { classifyHttpRefusal, classifyTransportFailure, MediaCreateError } from './create-failure';
import { createScopedLogger } from '~/utils/logger';
import type { CreateMediaTaskInput, MediaEndpoint, MediaProvider, MediaProviderName, MediaTaskState } from './provider';

const logger = createScopedLogger('fal-media');

/** fal's one queue host. Every task id must live under it (the SSRF wall). */
export const FAL_QUEUE_ORIGIN = 'https://queue.fal.run';

const UA = 'babylon-toolkit-app-builder/1.0';

/** A fal model id as a URL path: lowercase-ish segments, no traversal, no query. */
const FAL_MODEL_ID = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)+$/i;

/**
 * Is this a URL on fal's queue host? The SSRF wall for every id read back from storage.
 *
 * Parsed, never prefix-matched: `https://queue.fal.run.evil.example/…` and
 * `https://queue.fal.run@evil.example/…` both START with the origin string.
 */
export function isFalQueueUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return (
      url.protocol === 'https:' &&
      url.hostname === 'queue.fal.run' &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

/**
 * The status URL for a stored `response_url` — `{response_url}/status`, fal's documented relation.
 *
 * ⚠️ The ONE place this is derived. If the probe finds the relation differs, fix it here.
 */
export function statusUrlFor(responseUrl: string): string {
  const url = new URL(responseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/status`;

  return url.toString();
}

/**
 * The file URL out of a fal result, whatever the model's shape — or `null` when there is none.
 *
 * fal's result JSON is model-dependent: images `{images:[{url}]}`, the cut-out `{image:{url}}`, video
 * `{video:{url}}`, audio usually `{audio:{url}}` but some models `{audio:"<url>"}` or
 * `{audio_file:{url}}`. Exported for direct tests — a missed shape here is a succeeded render reported
 * as failed and refunded.
 */
export function falResultUrl(json: unknown): string | null {
  const result = (json ?? {}) as Record<string, any>;
  const candidates: unknown[] = [
    Array.isArray(result.images) ? result.images[0]?.url : undefined,
    result.image?.url,
    result.video?.url,
    result.audio?.url,
    typeof result.audio === 'string' ? result.audio : undefined,
    result.audio_file?.url,
  ];

  const url = candidates.find((candidate): candidate is string => typeof candidate === 'string' && candidate !== '');

  return url ?? null;
}

/**
 * fal's error text, readably. `detail` is a string on most refusals (`User is locked. Reason: Exhausted
 * balance…`) and a list of `{loc, msg}` on a validation 422.
 */
export function describeFalError(body: unknown, fallback: string): string {
  const parsed = (body ?? {}) as Record<string, any>;
  const detail = parsed.detail ?? parsed.error ?? parsed.message;

  if (typeof detail === 'string' && detail) {
    return detail;
  }

  if (Array.isArray(detail) && detail.length) {
    return detail
      .map((item) => {
        const where = Array.isArray(item?.loc) ? `${item.loc.join('.')}: ` : '';
        return `${where}${item?.msg ?? JSON.stringify(item)}`;
      })
      .join('; ');
  }

  if (detail && typeof detail === 'object') {
    return JSON.stringify(detail);
  }

  return fallback;
}

export class FalMediaProvider implements MediaProvider {
  readonly name: MediaProviderName = 'FAL';

  private readonly _apiKey: string;

  constructor(apiKey: string) {
    this._apiKey = apiKey;
  }

  private _headers(json: boolean): Record<string, string> {
    return {
      Authorization: `Key ${this._apiKey}`,
      'User-Agent': UA,
      Accept: 'application/json',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  /** One request, parsed. Returns the status alongside the body so callers decide what a status means. */
  private async _request(url: string, method: 'GET' | 'POST', body?: unknown): Promise<{ status: number; json: any }> {
    let response: Response;

    try {
      response = await fetch(url, {
        method,
        headers: this._headers(body !== undefined),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      /* A timeout may have been ACCEPTED (ambiguous); a refused connection was never sent (`create-failure.ts`). */
      throw classifyTransportFailure(error);
    }

    let text: string;

    try {
      text = await response.text();
    } catch (error) {
      throw new MediaCreateError(
        `fal answered HTTP ${response.status} but the body could not be read: ${(error as Error)?.message}`,
        'ambiguous',
      );
    }

    let json: any;

    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { detail: text.slice(0, 200) };
    }

    return { status: response.status, json };
  }

  /**
   * 🔴 EXPLICIT, never a fallthrough — the rule `kie-client.ts` follows. The endpoint vocabulary is
   * shared and persisted, so a KIE (or retired-gateway) task handed here must be refused,
   * not POSTed to fal.
   */
  private _assertFalEndpoint(endpoint: MediaEndpoint): void {
    if (endpoint !== 'fal-queue') {
      throw new MediaCreateError(
        `fal does not serve the "${endpoint}" endpoint — that task belongs to another provider.`,
        'not-sent',
      );
    }
  }

  async create(input: CreateMediaTaskInput): Promise<string> {
    this._assertFalEndpoint(input.endpoint);

    if (!FAL_MODEL_ID.test(input.model)) {
      throw new MediaCreateError(`"${input.model}" is not a fal model id.`, 'not-sent');
    }

    /*
     * `sync_mode` is STRIPPED even if a caller set it: it makes fal return the file inline as a data URI
     * instead of a URL, which the queue/poll/download path has no way to deliver.
     */
    const { sync_mode: _syncMode, ...payload } = input.payload;

    const { status, json } = await this._request(`${FAL_QUEUE_ORIGIN}/${input.model}`, 'POST', payload);

    if (status < 200 || status >= 300) {
      // fal's `detail` names the real problem (no balance, a bad option) — surface it, capped.
      throw classifyHttpRefusal(
        status,
        `fal refused the request (HTTP ${status}): ${describeFalError(json, 'no detail').slice(0, 300)}`,
      );
    }

    const responseUrl = json?.response_url;

    if (typeof responseUrl !== 'string' || !isFalQueueUrl(responseUrl)) {
      /* A 2xx is an ACCEPTED request — it is rendering and billed; we just cannot name it (D9). */
      throw new MediaCreateError(
        `fal accepted the request but returned no usable response_url: ${JSON.stringify(json).slice(0, 300)}`,
        'ambiguous',
      );
    }

    logger.info(`fal request ${json?.request_id ?? '(no id)'} queued (${input.model})`);

    return responseUrl;
  }

  async query(endpoint: MediaEndpoint, providerTaskId: string): Promise<MediaTaskState> {
    this._assertFalEndpoint(endpoint);

    // The SSRF wall — BEFORE any request. This id was read back from storage and carries our key.
    if (!isFalQueueUrl(providerTaskId)) {
      throw new Error(`Refusing to poll a fal task id that is not a ${FAL_QUEUE_ORIGIN} URL.`);
    }

    /*
     * Any non-2xx on the STATUS read throws, which the service treats as a flaky poll (stay pending,
     * ask again) — never as a failed render. A 5xx is fal having a bad minute; a 401/403 is OUR key or
     * account, which says nothing about whether the user's render succeeded, so refunding on it could
     * refund art that is about to land.
     */
    const status = await this._request(statusUrlFor(providerTaskId), 'GET');

    if (status.status < 200 || status.status >= 300) {
      throw new Error(`fal status check failed (HTTP ${status.status}): ${describeFalError(status.json, '')}`);
    }

    const state = String(status.json?.status ?? '');

    if (state === 'IN_QUEUE' || state === 'IN_PROGRESS') {
      return { state: 'pending' };
    }

    if (state !== 'COMPLETED') {
      throw new Error(`fal reported an unrecognised status "${state}".`);
    }

    if (status.json?.error) {
      return { state: 'failed', error: failedMessage(status.json) };
    }

    const result = await this._request(providerTaskId, 'GET');

    if (result.status >= 500 || result.status === 429) {
      throw new Error(`fal result read failed (HTTP ${result.status}).`);
    }

    if (result.status < 200 || result.status >= 300) {
      // The job is COMPLETED and its result is refused — fal's way of reporting a failed render.
      return {
        state: 'failed',
        error: `fal: ${describeFalError(result.json, `the render failed (HTTP ${result.status})`)}`.slice(0, 500),
      };
    }

    if (result.json?.error) {
      return { state: 'failed', error: failedMessage(result.json) };
    }

    const url = falResultUrl(result.json);

    return url
      ? { state: 'succeeded', resultUrl: url }
      : { state: 'failed', error: 'fal reported the render completed but returned no file URL.' };
  }

  async download(url: string): Promise<Response> {
    /*
     * fal's output files are public GETs (`v3.fal.media`, …), so the key is NOT sent — it would leak the
     * platform credential to a CDN host (§5). https only: a result URL is data fal handed us.
     */
    if (!/^https:\/\//i.test(url)) {
      throw new Error('Refusing to download a fal result that is not an https URL.');
    }

    const response = await fetch(url, { headers: { 'User-Agent': UA } });

    if (!response.ok || !response.body) {
      throw new Error(
        `Could not download the render (HTTP ${response.status}) — fal's output files can expire, ` +
          're-generate if this task is old.',
      );
    }

    return response;
  }
}

/** A COMPLETED-with-error body as one sentence: the error text plus its type when fal gives one. */
function failedMessage(body: Record<string, any>): string {
  const error = typeof body.error === 'string' ? body.error : JSON.stringify(body.error);
  const type = body.error_type ? ` (${String(body.error_type)})` : '';

  return `fal: ${error}${type}`.slice(0, 500);
}
