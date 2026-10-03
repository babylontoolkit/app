/**
 * KIE media API client (SPEC §4.16) — the wire half of built-in image/video generation.
 *
 * Ported from the owner's `temp/kie-image-mcp` (the verified wire reference): images and most video
 * models go through the generic jobs endpoint (`POST /api/v1/jobs/createTask` → poll
 * `GET /api/v1/jobs/recordInfo`); Google Veo 3.1 has its own flat-body endpoint
 * (`POST /api/v1/veo/generate` → `GET /api/v1/veo/record-info`). Same host and same `Bearer`
 * `KIE_API_KEY` the LLM provider already uses (`providers/kie.ts`) — one key, both kinds of spend.
 *
 * This module does WIRE ONLY: build the request, create the task, query it once, download a result.
 * No polling loops (the client polls our route per request), no billing (service.ts debits BEFORE
 * calling this), no filesystem.
 *
 * ⚠️ **The SEAM lives in `provider.ts`, not here.** It used to be declared in this file, which was
 * fine while KIE was the only media gateway and wrong the moment a second one existed — the interface
 * every provider implements cannot live inside one of them. This module now holds only KIE, and
 * imports its types.
 *
 * Result URLs expire (~3 days image / ~14 days video) — which is exactly why `download` exists: the
 * bytes must land in the user's PROJECT, not be hotlinked.
 */
import { createScopedLogger } from '~/utils/logger';
import type { CreateMediaTaskInput, MediaEndpoint, MediaProvider, MediaProviderName, MediaTaskState } from './provider';
import { classifyTransportFailure, MediaCreateError } from './create-failure';

const logger = createScopedLogger('kie-media');

const API = 'https://api.kie.ai';
const UA = 'babylon-toolkit-app-builder/1.0';

/** KIE's two Suno routes (§4.16 sound). Both are polled on the SAME record-info endpoint. */
const SUNO_CREATE_PATH: Record<'suno-sounds' | 'suno-music', string> = {
  'suno-sounds': '/api/v1/generate/sounds',
  'suno-music': '/api/v1/generate',
};

const SUNO_POLL_PATH = '/api/v1/generate/record-info';

function isSunoEndpoint(endpoint: MediaEndpoint): endpoint is 'suno-sounds' | 'suno-music' {
  return endpoint === 'suno-sounds' || endpoint === 'suno-music';
}

export class KieMediaProvider implements MediaProvider {
  readonly name: MediaProviderName = 'KIE';

  private readonly _apiKey: string;

  constructor(apiKey: string) {
    this._apiKey = apiKey;
  }

  /**
   * One request, with its HTTP status. A fetch that throws is classified for the money (`create-failure.ts`):
   * a timeout is AMBIGUOUS (the body may have been accepted), a refused connection is `not-sent`.
   */
  private async _send(url: string, method: 'GET' | 'POST', body?: unknown): Promise<{ status: number; text: string }> {
    let response: Response;

    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this._apiKey}`,
          'User-Agent': UA,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw classifyTransportFailure(error);
    }

    try {
      return { status: response.status, text: await response.text() };
    } catch (error) {
      throw new MediaCreateError(
        `KIE answered HTTP ${response.status} but the body could not be read: ${(error as Error)?.message}`,
        'ambiguous',
      );
    }
  }

  private async _request(url: string, method: 'GET' | 'POST', body?: unknown): Promise<any> {
    const { status, text } = await this._send(url, method, body);

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`KIE returned non-JSON from ${url} (HTTP ${status}): ${text.slice(0, 200)}`);
    }
  }

  /**
   * 🔴 EXPLICIT, never a fallthrough. `MediaEndpoint` is a shared PERSISTED vocabulary that now names
   * another gateway's routes too, so "anything that is not veo is jobs" would quietly POST a fal or
   * retired-gateway task to KIE's jobs endpoint — a debit taken, a task id that means nothing, and a poll that can
   * only ever time out. Refusing names the mismatch instead.
   */
  private _assertKieEndpoint(
    endpoint: MediaEndpoint,
  ): asserts endpoint is 'jobs' | 'veo' | 'suno-sounds' | 'suno-music' {
    if (endpoint !== 'jobs' && endpoint !== 'veo' && !isSunoEndpoint(endpoint)) {
      throw new MediaCreateError(
        `KIE does not serve the "${endpoint}" endpoint — that task belongs to another provider.`,
        'not-sent',
      );
    }
  }

  async create(input: CreateMediaTaskInput): Promise<string> {
    this._assertKieEndpoint(input.endpoint);

    /*
     * Suno takes a FLAT body (prompt/model/options at the top level), unlike the jobs endpoint's
     * `{ model, input }` envelope — `service.ts` has already shaped it, including the `model` field
     * (the Suno VERSION, e.g. V5), which is not the priced model id.
     */
    const url = isSunoEndpoint(input.endpoint)
      ? `${API}${SUNO_CREATE_PATH[input.endpoint]}`
      : input.endpoint === 'veo'
        ? `${API}/api/v1/veo/generate`
        : `${API}/api/v1/jobs/createTask`;
    const body =
      isSunoEndpoint(input.endpoint) || input.endpoint === 'veo'
        ? input.payload
        : { model: input.model, input: input.payload };

    const { status, text } = await this._send(url, 'POST', body);

    let result: any;

    try {
      result = JSON.parse(text);
    } catch {
      /* No body we can read: a 4xx is a refusal; anything else may have been accepted. */
      const detail = `KIE returned non-JSON from ${url} (HTTP ${status}): ${text.slice(0, 200)}`;

      throw status >= 400 && status < 500
        ? new MediaCreateError(detail, 'refused', status === 429)
        : new MediaCreateError(detail, 'ambiguous');
    }

    const taskId = result?.data?.taskId;

    if (!taskId || ((input.endpoint === 'veo' || isSunoEndpoint(input.endpoint)) && result?.code !== 200)) {
      // KIE's error text names the real problem (bad option, moderation) — surface it, capped.
      throw classifyKieRejection(status, result, `KIE createTask failed: ${JSON.stringify(result).slice(0, 300)}`);
    }

    logger.info(`KIE task ${taskId} created (${input.endpoint}, ${input.model})`);

    return String(taskId);
  }

  async query(endpoint: MediaEndpoint, kieTaskId: string): Promise<MediaTaskState> {
    this._assertKieEndpoint(endpoint);

    const path = isSunoEndpoint(endpoint)
      ? SUNO_POLL_PATH
      : endpoint === 'veo'
        ? '/api/v1/veo/record-info'
        : '/api/v1/jobs/recordInfo';

    const info = await this._request(`${API}${path}?taskId=${encodeURIComponent(kieTaskId)}`, 'GET');
    const data = info?.data ?? {};

    return isSunoEndpoint(endpoint) ? parseSunoTaskState(data) : parseTaskState(data);
  }

  download(url: string): Promise<Response> {
    return downloadResult(url);
  }
}

/**
 * The money class of a KIE create answer that carried no usable task (`create-failure.ts`, D9).
 *
 * KIE answers HTTP 200 with its own `code` in the body. Its documented codes: 401/402/404/422 and 501
 * ("generation failed") / 505 ("feature disabled") are definite refusals; 429 (rate limited) and 455
 * ("service unavailable") are refusals worth retrying; 500 is a server error that says nothing about
 * whether the task was created, so it is AMBIGUOUS. A body with no code falls back to the HTTP status.
 * Exported for direct tests.
 */
export function classifyKieRejection(httpStatus: number, body: any, detail: string): MediaCreateError {
  const code = typeof body?.code === 'number' ? body.code : Number(body?.code);

  if (Number.isFinite(code) && code !== 200) {
    if (code === 429 || code === 455) {
      return new MediaCreateError(detail, 'refused', true);
    }

    if ((code >= 400 && code < 500) || code === 501 || code === 505) {
      return new MediaCreateError(detail, 'refused');
    }

    return new MediaCreateError(detail, 'ambiguous');
  }

  if (httpStatus >= 400 && httpStatus < 500) {
    return new MediaCreateError(detail, 'refused', httpStatus === 429);
  }

  /* A 200 with no task id and no error code — KIE may have created a task we cannot name. */
  return new MediaCreateError(detail, 'ambiguous');
}

/**
 * KIE's status shape is inconsistent across model families (the MCP reference tolerates all of them):
 * `state`/`status` strings on jobs, `successFlag` numbers on veo and some jobs rows, and the result
 * URLs live in `resultJson` (a JSON STRING), `response`, or flat fields depending on the model.
 * Exported for direct tests — a misread "failed" here would refund a render that actually succeeded.
 */
export function parseTaskState(data: Record<string, any>): MediaTaskState {
  const state = data.state || data.status;
  const flag = data.successFlag;

  if (state === 'success' || state === 'completed' || flag === 1) {
    const url = extractResultUrl(data);

    return url
      ? { state: 'succeeded', resultUrl: url }
      : { state: 'failed', error: 'KIE reported success but returned no result URL.' };
  }

  if (state === 'fail' || state === 'failed' || flag === 2 || flag === 3) {
    const message = data.errorMessage || data.msg || 'The provider reported the generation failed.';

    return { state: 'failed', error: String(message).slice(0, 500) };
  }

  return { state: 'pending' };
}

/**
 * Suno's status shape, which shares nothing with the jobs one — hence a second parser rather than a
 * widened first (SPEC §4.16 sound).
 *
 * `status` is UPPERCASE (`SUCCESS`), the pending set has two states that READ like success
 * (`TEXT_SUCCESS`, `FIRST_SUCCESS` — lyrics done, first track done) and the audio URL lives in
 * `response.sunoData[]`, which `extractResultUrl` does not know about. Running these through
 * `parseTaskState` would read every in-progress Suno task as a failure and refund a render that is
 * still going — money back for art the user is about to receive, and our account billed anyway.
 *
 * Exported for direct tests, like its sibling.
 */
export function parseSunoTaskState(data: Record<string, any>): MediaTaskState {
  const status = data.status;

  if (status === 'SUCCESS') {
    // KIE's current schema is snake_case; older Suno responses used camelCase. Tolerate both.
    const tracks: unknown[] = Array.isArray(data.response?.sunoData) ? data.response.sunoData : [];
    const url = tracks
      .map((track) => (track as Record<string, unknown>)?.audio_url || (track as Record<string, unknown>)?.audioUrl)
      .find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);

    return url
      ? { state: 'succeeded', resultUrl: url }
      : { state: 'failed', error: 'Suno reported success but returned no audio URL.' };
  }

  if (SUNO_PENDING_STATES.includes(status)) {
    return { state: 'pending' };
  }

  const message = data.failMsg || data.errorMessage || data.msg || `Suno reported state ${status ?? '(missing)'}.`;

  return { state: 'failed', error: String(message).slice(0, 500) };
}

/** `TEXT_SUCCESS`/`FIRST_SUCCESS` are PENDING, whatever they read like — see `parseSunoTaskState`. */
const SUNO_PENDING_STATES = ['PENDING', 'TEXT_SUCCESS', 'FIRST_SUCCESS'];

function extractResultUrl(data: Record<string, any>): string | undefined {
  const candidates: unknown[] = [];
  const rawJson = data.resultJson;

  if (typeof rawJson === 'string' && rawJson) {
    try {
      candidates.push(JSON.parse(rawJson));
    } catch {
      // fall through to the other shapes
    }
  }

  if (data.response && typeof data.response === 'object') {
    candidates.push(data.response);
  }

  candidates.push(data);

  for (const candidate of candidates) {
    const c = candidate as Record<string, any>;
    const urls = c?.resultUrls || c?.fullResultUrls;

    if (Array.isArray(urls) && urls.length && typeof urls[0] === 'string') {
      return urls[0];
    }

    if (typeof c?.videoUrl === 'string' && c.videoUrl) {
      return c.videoUrl;
    }

    if (typeof c?.mp4Url === 'string' && c.mp4Url) {
      return c.mp4Url;
    }
  }

  return undefined;
}

/**
 * Stream a finished render's bytes. Returns the raw Response so the file route can pipe it through
 * without buffering a multi-hundred-MB video in memory.
 *
 * ⚠️ Exported for its own tests and used by `KieMediaProvider.download`. Routes must NOT import it
 * directly — the file route did, which is how the download half stayed provider-blind while polling
 * became provider-aware. Go through the task's provider.
 */
export async function downloadResult(url: string): Promise<Response> {
  const response = await fetch(url, { headers: { 'User-Agent': UA } });

  if (!response.ok || !response.body) {
    throw new Error(`Could not download the render (HTTP ${response.status}) — KIE URLs expire, re-generate if old.`);
  }

  return response;
}
