/**
 * The fal.ai media client (SPEC §4.16, `_specs/media-gateways_plan.md` T3) — the wire half.
 *
 * ## What is actually at risk here
 *
 *  1. **The status URL.** fal's status/result URLs DROP the model's subpath (`fal-ai/veo3/fast` is
 *     polled under `fal-ai/veo3/requests/…`). A client that rebuilt the URL from the model id would
 *     poll a path fal does not serve for that job — the render never completes and the refund fires on
 *     art that rendered fine. So the poll URL must be DERIVED from the stored `response_url`.
 *  2. **A failed job reports `COMPLETED`.** Only `error` / `error_type` say otherwise. Reading it as a
 *     success reports a task delivered that has nothing to deliver.
 *  3. **The SSRF wall.** The task id comes back out of STORAGE and is fetched with the platform key —
 *     a non-fal id must be refused with NO request made, or a tampered record points our key anywhere.
 *  4. **A flaky poll is not a failure** — a 5xx throws (the service keeps the task pending).
 *
 * ⚠️ **No test here may reach the network.** `.env.local` on this machine holds a REAL `FAL_API_KEY`,
 * so `fetch` is stubbed in `beforeEach` and every credential-shaped env var is scrubbed (the
 * `oauth.spec.ts` trap). The client is constructed with a sentinel key, never from `env()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeFalError, FalMediaProvider, falResultUrl, isFalQueueUrl, statusUrlFor } from './fal-client';
import type { MediaEndpoint } from './provider';

const KEY = 'sentinel-fal-key';

/** Every request the stub saw, in order — the only way to assert what did NOT go on the wire. */
interface SeenRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

let seen: SeenRequest[];

/** What the next fetch answers with; a function so a test can vary per call. */
let responder: (request: SeenRequest) => Promise<unknown>;

const SCRUBBED_ENV = ['FAL_API_KEY', 'KIE_API_KEY', 'COMET_API_KEY', 'MEDIA_PROVIDER', 'LLM_PROVIDER'] as const;

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
  for (const key of SCRUBBED_ENV) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  seen = [];
  responder = async () => jsonResponse({});

  vi.stubGlobal('fetch', async (input: unknown, init: any) => {
    const request: SeenRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    seen.push(request);

    return responder(request);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function client() {
  return new FalMediaProvider(KEY);
}

const FAL: MediaEndpoint = 'fal-queue';

/** What fal's submit answers, per its docs — `response_url` WITHOUT the `/fast` subpath for Veo Fast. */
function submitted(model: string, id = 'req-123') {
  const parent = model === 'fal-ai/veo3/fast' ? 'fal-ai/veo3' : model;
  const base = `https://queue.fal.run/${parent}/requests/${id}`;

  return {
    request_id: id,
    response_url: base,
    status_url: `${base}/status`,
    cancel_url: `${base}/cancel`,
    queue_position: 0,
  };
}

describe('create — submit to the queue', () => {
  it('submits to queue.fal.run with Key auth and returns response_url', async () => {
    responder = async () => jsonResponse(submitted('fal-ai/nano-banana-2'));

    const id = await client().create({
      endpoint: FAL,
      model: 'fal-ai/nano-banana-2',
      payload: { prompt: 'a skyline', num_images: 1, resolution: '2K' },
    });

    expect(id).toBe('https://queue.fal.run/fal-ai/nano-banana-2/requests/req-123');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: 'https://queue.fal.run/fal-ai/nano-banana-2', method: 'POST' });

    // `Key`, not `Bearer` — fal's scheme. A Bearer header is a 401 on every request.
    expect(seen[0].headers.Authorization).toBe(`Key ${KEY}`);
    expect(seen[0].body).toEqual({ prompt: 'a skyline', num_images: 1, resolution: '2K' });
  });

  it('never sends sync_mode', async () => {
    responder = async () => jsonResponse(submitted('fal-ai/nano-banana-2'));

    // Even a caller that set it gets it stripped: it makes fal answer with a data URI, not a URL.
    await client().create({
      endpoint: FAL,
      model: 'fal-ai/nano-banana-2',
      payload: { prompt: 'x', sync_mode: true },
    });

    expect(seen[0].body).not.toHaveProperty('sync_mode');
    expect(seen[0].body).toEqual({ prompt: 'x' });
  });

  it('surfaces fal’s detail text when it refuses the submit (the exhausted-balance 403)', async () => {
    responder = async () =>
      jsonResponse(
        {
          detail: 'User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing.',
        },
        403,
      );

    await expect(client().create({ endpoint: FAL, model: 'fal-ai/nano-banana-2', payload: {} })).rejects.toThrow(
      /HTTP 403.*Exhausted balance/,
    );
  });

  it('refuses a response with no response_url, or one off fal’s queue host', async () => {
    responder = async () => jsonResponse({ request_id: 'r1' });
    await expect(client().create({ endpoint: FAL, model: 'fal-ai/nano-banana-2', payload: {} })).rejects.toThrow(
      /no usable response_url/,
    );

    responder = async () => jsonResponse({ request_id: 'r1', response_url: 'https://evil.example/requests/r1' });
    await expect(client().create({ endpoint: FAL, model: 'fal-ai/nano-banana-2', payload: {} })).rejects.toThrow(
      /no usable response_url/,
    );
  });

  it('refuses another gateway’s endpoint without reaching the wire', async () => {
    await expect(client().create({ endpoint: 'jobs', model: 'nano-banana-2', payload: {} })).rejects.toThrow(
      /does not serve the "jobs" endpoint/,
    );
    expect(seen).toEqual([]);
  });
});

describe('query — the status URL and the states', () => {
  it('polls the status URL derived from response_url, never one rebuilt from the model id', async () => {
    const { response_url: responseUrl } = submitted('fal-ai/veo3/fast');

    responder = async () => jsonResponse({ status: 'IN_PROGRESS' });

    await client().query(FAL, responseUrl);

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://queue.fal.run/fal-ai/veo3/requests/req-123/status');

    // 🔴 The rebuilt-from-the-model-id path fal does not serve for this job.
    expect(seen[0].url).not.toContain('/fast/requests');
    expect(seen[0].headers.Authorization).toBe(`Key ${KEY}`);
  });

  it('IN_QUEUE and IN_PROGRESS are pending', async () => {
    const { response_url: responseUrl } = submitted('fal-ai/nano-banana-2');

    for (const status of ['IN_QUEUE', 'IN_PROGRESS']) {
      responder = async () => jsonResponse({ status, queue_position: 1 });
      expect(await client().query(FAL, responseUrl), status).toEqual({ state: 'pending' });
    }

    // Pending never reads the result.
    expect(seen.every((request) => request.url.endsWith('/status'))).toBe(true);
  });

  it('COMPLETED with error is failed, not succeeded', async () => {
    const { response_url: responseUrl } = submitted('fal-ai/nano-banana-2');

    responder = async () =>
      jsonResponse({ status: 'COMPLETED', error: 'Content policy violation', error_type: 'content_policy' });

    const state = await client().query(FAL, responseUrl);

    expect(state.state).toBe('failed');
    expect(state).toMatchObject({ error: expect.stringContaining('Content policy violation') });
    expect(state).toMatchObject({ error: expect.stringContaining('content_policy') });
  });

  it('COMPLETED reads the result at response_url and returns its file URL (control)', async () => {
    const { response_url: responseUrl } = submitted('fal-ai/nano-banana-2');

    responder = async (request) =>
      request.url.endsWith('/status')
        ? jsonResponse({ status: 'COMPLETED' })
        : jsonResponse({ images: [{ url: 'https://v3.fal.media/files/a.jpg' }] });

    expect(await client().query(FAL, responseUrl)).toEqual({
      state: 'succeeded',
      resultUrl: 'https://v3.fal.media/files/a.jpg',
    });
    expect(seen.map((request) => request.url)).toEqual([`${responseUrl}/status`, responseUrl]);
  });

  it('a COMPLETED result with no file URL, or with an error, is failed', async () => {
    const { response_url: responseUrl } = submitted('fal-ai/nano-banana-2');

    responder = async (request) =>
      request.url.endsWith('/status') ? jsonResponse({ status: 'COMPLETED' }) : jsonResponse({ seed: 42 });
    expect((await client().query(FAL, responseUrl)).state).toBe('failed');

    responder = async (request) =>
      request.url.endsWith('/status')
        ? jsonResponse({ status: 'COMPLETED' })
        : jsonResponse({ detail: 'Model failed to generate' }, 422);
    expect(await client().query(FAL, responseUrl)).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('Model failed to generate'),
    });
  });

  it('a 503 on status throws (flaky poll)', async () => {
    const { response_url: responseUrl } = submitted('fal-ai/nano-banana-2');

    responder = async () => jsonResponse({ detail: 'upstream unavailable' }, 503);

    await expect(client().query(FAL, responseUrl)).rejects.toThrow(/HTTP 503/);
  });

  it('a 5xx reading the result throws too — never a refund for art that may have rendered', async () => {
    const { response_url: responseUrl } = submitted('fal-ai/nano-banana-2');

    responder = async (request) =>
      request.url.endsWith('/status') ? jsonResponse({ status: 'COMPLETED' }) : jsonResponse({}, 502);

    await expect(client().query(FAL, responseUrl)).rejects.toThrow(/HTTP 502/);
  });

  it('refuses a task id outside queue.fal.run', async () => {
    for (const id of [
      'https://evil.example/fal-ai/x/requests/1',
      'https://queue.fal.run.evil.example/fal-ai/x/requests/1',
      'https://queue.fal.run@evil.example/fal-ai/x/requests/1',
      'http://queue.fal.run/fal-ai/x/requests/1',
      'kie-task-123',
    ]) {
      await expect(client().query(FAL, id), id).rejects.toThrow(/Refusing to poll/);
    }

    // The load-bearing half: no request was made, so the key went nowhere.
    expect(seen).toEqual([]);
  });

  it('refuses another gateway’s endpoint on the poll, without reaching the wire', async () => {
    await expect(client().query('comet-video', submitted('fal-ai/veo3').response_url)).rejects.toThrow(
      /another provider/,
    );
    expect(seen).toEqual([]);
  });
});

describe('falResultUrl — every result shape fal documents', () => {
  const OUT = 'https://v3.fal.media/files/out';

  it('falResultUrl reads images, image, video, audio object, audio string and audio_file', () => {
    expect(falResultUrl({ images: [{ url: `${OUT}.jpg` }], seed: 1 })).toBe(`${OUT}.jpg`);
    expect(falResultUrl({ image: { url: `${OUT}.png`, content_type: 'image/png' } })).toBe(`${OUT}.png`);
    expect(falResultUrl({ video: { url: `${OUT}.mp4` } })).toBe(`${OUT}.mp4`);
    expect(falResultUrl({ audio: { url: `${OUT}.mp3` } })).toBe(`${OUT}.mp3`);
    expect(falResultUrl({ audio: `${OUT}-s.mp3` })).toBe(`${OUT}-s.mp3`);
    expect(falResultUrl({ audio_file: { url: `${OUT}-f.mp3` } })).toBe(`${OUT}-f.mp3`);
  });

  it('CONTROL — returns null when there is no file, rather than inventing one', () => {
    expect(falResultUrl({})).toBeNull();
    expect(falResultUrl({ images: [] })).toBeNull();
    expect(falResultUrl({ image: { url: '' } })).toBeNull();
    expect(falResultUrl(null)).toBeNull();
  });
});

describe('the URL helpers', () => {
  it('derives the status URL by appending /status — and only that', () => {
    expect(statusUrlFor('https://queue.fal.run/fal-ai/veo3/requests/abc')).toBe(
      'https://queue.fal.run/fal-ai/veo3/requests/abc/status',
    );
    expect(statusUrlFor('https://queue.fal.run/fal-ai/veo3/requests/abc/')).toBe(
      'https://queue.fal.run/fal-ai/veo3/requests/abc/status',
    );
  });

  it('isFalQueueUrl is parsed, not prefix-matched', () => {
    expect(isFalQueueUrl('https://queue.fal.run/fal-ai/x/requests/1')).toBe(true);
    expect(isFalQueueUrl('https://queue.fal.run.evil.example/x')).toBe(false);
    expect(isFalQueueUrl('https://queue.fal.run@evil.example/x')).toBe(false);
    expect(isFalQueueUrl('https://queue.fal.run:8443/x')).toBe(false);
    expect(isFalQueueUrl('not a url')).toBe(false);
  });

  it('describeFalError reads a string detail and a validation list', () => {
    expect(describeFalError({ detail: 'User is locked.' }, 'x')).toBe('User is locked.');
    expect(describeFalError({ detail: [{ loc: ['body', 'duration'], msg: 'bad value' }] }, 'x')).toBe(
      'body.duration: bad value',
    );
    expect(describeFalError({}, 'fallback')).toBe('fallback');
  });
});

describe('download', () => {
  it('fetches the public file WITHOUT the platform key', async () => {
    responder = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });

    const response = await client().download('https://v3.fal.media/files/a.png');

    expect(response.ok).toBe(true);
    expect(seen[0].url).toBe('https://v3.fal.media/files/a.png');

    // The key must never travel to a CDN host (§5).
    expect(JSON.stringify(seen[0].headers)).not.toContain(KEY);
  });

  it('refuses a non-https result URL', async () => {
    await expect(client().download('http://v3.fal.media/files/a.png')).rejects.toThrow(/https/);
    expect(seen).toEqual([]);
  });
});
