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

const logger = createScopedLogger('kie-media');

const API = 'https://api.kie.ai';
const UA = 'babylon-toolkit-app-builder/1.0';

export class KieMediaProvider implements MediaProvider {
  readonly name: MediaProviderName = 'KIE';

  private readonly _apiKey: string;

  constructor(apiKey: string) {
    this._apiKey = apiKey;
  }

  private async _request(url: string, method: 'GET' | 'POST', body?: unknown): Promise<any> {
    const response = await fetch(url, {
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

    const text = await response.text();

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`KIE returned non-JSON from ${url} (HTTP ${response.status}): ${text.slice(0, 200)}`);
    }
  }

  /**
   * 🔴 EXPLICIT, never a fallthrough. `MediaEndpoint` is a shared PERSISTED vocabulary that now names
   * another gateway's routes too, so "anything that is not veo is jobs" would quietly POST a Comet
   * task to KIE's jobs endpoint — a debit taken, a task id that means nothing, and a poll that can
   * only ever time out. Refusing names the mismatch instead.
   */
  private _assertKieEndpoint(endpoint: MediaEndpoint): asserts endpoint is 'jobs' | 'veo' {
    if (endpoint !== 'jobs' && endpoint !== 'veo') {
      throw new Error(`KIE does not serve the "${endpoint}" endpoint — that task belongs to another provider.`);
    }
  }

  async create(input: CreateMediaTaskInput): Promise<string> {
    this._assertKieEndpoint(input.endpoint);

    const result =
      input.endpoint === 'veo'
        ? await this._request(`${API}/api/v1/veo/generate`, 'POST', input.payload)
        : await this._request(`${API}/api/v1/jobs/createTask`, 'POST', { model: input.model, input: input.payload });

    const taskId = result?.data?.taskId;

    if (!taskId || (input.endpoint === 'veo' && result?.code !== 200)) {
      // KIE's error text names the real problem (bad option, moderation) — surface it, capped.
      throw new Error(`KIE createTask failed: ${JSON.stringify(result).slice(0, 300)}`);
    }

    logger.info(`KIE task ${taskId} created (${input.endpoint}, ${input.model})`);

    return String(taskId);
  }

  async query(endpoint: MediaEndpoint, kieTaskId: string): Promise<MediaTaskState> {
    this._assertKieEndpoint(endpoint);

    const url =
      endpoint === 'veo'
        ? `${API}/api/v1/veo/record-info?taskId=${encodeURIComponent(kieTaskId)}`
        : `${API}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(kieTaskId)}`;

    const info = await this._request(url, 'GET');
    const data = info?.data ?? {};

    return parseTaskState(data);
  }

  download(url: string): Promise<Response> {
    return downloadResult(url);
  }
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
