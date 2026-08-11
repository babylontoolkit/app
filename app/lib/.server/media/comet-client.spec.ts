/**
 * The Comet media client (SPEC §4.16, T8) — the wire half, and the async contract it has to fake.
 *
 * ## What is actually at risk here
 *
 * §4.16's whole design is debit → enqueue → **return in milliseconds** → the CLIENT polls, precisely so
 * that neither a server request nor the LLM tool loop ever parks on a multi-minute render. KIE is
 * create → task id → poll on all three of its routes; Comet's two IMAGE routes RENDER INSIDE THE
 * REQUEST (measured 16.7s at `quality: low`, ~100s at `high`). So `create` fires the request, does not
 * await it, parks the promise under a synthetic id and returns.
 *
 * That bridge is the load-bearing property, and it is invisible to any test that merely checks the
 * happy path: a client that simply awaited the render would return a perfectly good id, produce a
 * perfectly good image, and silently park the tool loop for a hundred seconds on every generation. So
 * the first test below asserts `create` RESOLVES WHILE THE FETCH IS STILL PENDING, which is the only
 * shape that can fail against that implementation.
 *
 * The second risk is the mirror image: a parked render lives in process memory, so a deploy loses it.
 * A task that can never complete and can never fail is the fifth terminal state `spec/fail-loud.md`
 * exists to forbid — money debited, nothing able to finish it, nothing able to refund it. Hence an id
 * unknown to this process reports FAILED rather than pending-forever, and that is tested with a
 * CONTROL (a known id still reports pending), because "report failed" passes trivially for a client
 * that has stopped tracking renders at all.
 *
 * 🔴 **`response_format` must never be sent.** Measured: 200 with a hosted URL at `low`/`1024x1024`,
 * hard **400 `Unknown parameter: 'response_format'`** at `high`/`1536x1024`, same model, same key,
 * minutes apart. Sending it trades a memory cost for a hard failure on an unknowable subset of
 * renders, AFTER the debit. Nothing about the code's shape prevents someone re-adding it as an
 * optimisation, so the request body is scanned.
 *
 * ⚠️ **No test here may reach the network.** `.env.local` on this machine holds a live `COMET_API_KEY`
 * and these renders cost real money, so `fetch` is stubbed in `beforeEach` and every credential-shaped
 * env var is scrubbed (the `oauth.spec.ts` trap, which has fired four times in this repo).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { supportsTransparency, type ImageProviderName } from '~/lib/media/image-capabilities';
import { MEDIA_PROVIDERS } from '~/lib/.server/agent/config';
import { CometMediaProvider, clearParkedRenders, inlineResultUrl, PENDING_RENDER_TTL_MS } from './comet-client';
import type { MediaEndpoint } from './provider';

const KEY = 'sentinel-comet-key';

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

/**
 * ⚠️ Scrubbed to `undefined` before each test. `env()` falls back to `process.env` and Vitest loads
 * `.env.local`, which on this machine carries a REAL Comet key — a client constructed from it against
 * an unstubbed `fetch` would bill the owner's account for a render nobody asked for.
 */
const SCRUBBED_ENV = ['COMET_API_KEY', 'COMET_BASE_URL', 'KIE_API_KEY', 'MEDIA_PROVIDER', 'LLM_PROVIDER'] as const;

/** A promise a test settles by hand — how "the render is still in flight" is expressed. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

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

  // Module-level map: a render parked by one test would otherwise be visible to the next.
  clearParkedRenders();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearParkedRenders();
});

function client() {
  return new CometMediaProvider(KEY);
}

const IMAGE_TASK = {
  endpoint: 'comet-image' as MediaEndpoint,
  model: 'gpt-image-1.5',
  payload: { prompt: 'a chunky racing wordmark', size: '1536x1024', quality: 'medium' },
};

const B64 = Buffer.from([1, 2, 3, 4]).toString('base64');

/*
 * ------------------------------------------------------------------------------------------------ *
 * The async contract — the property the whole design rests on
 * ------------------------------------------------------------------------------------------------
 */

describe('create RETURNS BEFORE the synchronous render settles', () => {
  it('resolves with a synthetic id while the request is still in flight', async () => {
    /*
     * 🔴 THE LOAD-BEARING TEST. The gate is never released, so `create` can only resolve if it did not
     * await the render — which is the entire reason this client exists rather than being a copy of
     * `kie-client.ts`. A client that awaited would hang here (and would park the LLM tool loop for
     * ~100 seconds per image in production, silently, on the user's bill).
     */
    const gate = deferred<unknown>();
    responder = () => gate.promise as Promise<unknown>;

    const provider = client();
    const taskId = await provider.create(IMAGE_TASK);

    expect(taskId).toMatch(/^comet-local-/);
    expect(seen, 'the render was actually fired, not merely deferred').toHaveLength(1);

    // And it is genuinely still running — the poll path is what will observe the result.
    expect(await provider.query('comet-image', taskId)).toEqual({ state: 'pending' });
  });

  it('mints an id that is unmistakably OURS, never an upstream one', () => {
    /*
     * `kieTaskId` on a Comet image record holds one of these. A reader — or a support query — must be
     * able to tell at a glance that no upstream system knows this string.
     */
    expect(inlineResultUrl('comet-local-abc')).toBe('comet-inline:comet-local-abc');
  });

  it('reports the settled result once the render answers, and serves its bytes from memory', async () => {
    responder = async () => jsonResponse({ data: [{ b64_json: B64 }], output_format: 'png' });

    const provider = client();
    const taskId = await provider.create(IMAGE_TASK);

    await vi.waitFor(async () => {
      expect(await provider.query('comet-image', taskId)).toEqual({
        state: 'succeeded',
        resultUrl: inlineResultUrl(taskId),
      });
    });

    /*
     * The bytes never got a URL, so `download` is the hop that carries them to the sandbox. There is
     * nowhere to re-fetch them FROM — which is why `download` is on the seam rather than being a free
     * function per provider.
     */
    const response = await provider.download(inlineResultUrl(taskId));

    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('honours a backend that volunteers a URL instead of bytes', async () => {
    // Both answer shapes were observed on the same route, minutes apart — neither may be assumed.
    responder = async () => jsonResponse({ data: [{ url: 'https://s3.comet/x.png?X-Amz-Expires=259200' }] });

    const provider = client();
    const taskId = await provider.create(IMAGE_TASK);

    await vi.waitFor(async () => {
      expect(await provider.query('comet-image', taskId)).toMatchObject({
        state: 'succeeded',
        resultUrl: 'https://s3.comet/x.png?X-Amz-Expires=259200',
      });
    });
  });
});

/*
 * ------------------------------------------------------------------------------------------------ *
 * A render this process has never heard of
 * ------------------------------------------------------------------------------------------------
 */

describe('an unknown parked id reports FAILED, so the refund fires', () => {
  it('fails a synthetic id the process has no record of', async () => {
    /*
     * 🔴 A parked render lives in process memory, so a deploy mid-render orphans it. Reporting
     * `pending` would leave a PAID task that can never complete and can never refund — the fifth
     * terminal state. Failed is the honest answer and it routes straight into the existing
     * refund-exactly-once path.
     */
    const state = await client().query('comet-image', 'comet-local-ghost');

    expect(state.state).toBe('failed');
    expect(state.state === 'failed' && state.error).toMatch(/restart|interrupted/i);
  });

  it('does NOT fail a render it IS tracking (control)', async () => {
    /*
     * ⚠️ Without this, the assertion above passes for a client that reports every image task failed —
     * i.e. for one that refunds every render it ever starts.
     */
    const gate = deferred<unknown>();
    responder = () => gate.promise as Promise<unknown>;

    const provider = client();
    const taskId = await provider.create(IMAGE_TASK);

    expect(await provider.query('comet-image', taskId)).toEqual({ state: 'pending' });
  });

  it('publishes a TTL long enough for the slowest measured render', () => {
    // ~100s at `quality: high` — a bound below that would call an ordinary slow render lost.
    expect(PENDING_RENDER_TTL_MS).toBeGreaterThan(120_000);
  });
});

/*
 * ------------------------------------------------------------------------------------------------ *
 * Endpoint discipline — `MediaEndpoint` is a shared, PERSISTED vocabulary
 * ------------------------------------------------------------------------------------------------
 */

describe('a KIE endpoint handed to Comet is refused, never guessed at', () => {
  it.each(['jobs', 'veo'] as MediaEndpoint[])('refuses to create on "%s"', async (endpoint) => {
    /*
     * "Anything that is not video is an image" would POST a KIE task to a Comet route: a debit taken
     * against a task id that means nothing, and a render nothing can ever poll.
     */
    await expect(client().create({ ...IMAGE_TASK, endpoint })).rejects.toThrow(/belongs to another provider/);
    expect(seen, 'refused before any spend').toHaveLength(0);
  });

  it.each(['jobs', 'veo'] as MediaEndpoint[])('refuses to query "%s"', async (endpoint) => {
    await expect(client().query(endpoint, 'kie-1')).rejects.toThrow(/belongs to another provider/);
  });
});

/*
 * ------------------------------------------------------------------------------------------------ *
 * What goes on the wire
 * ------------------------------------------------------------------------------------------------
 */

describe('the image request body', () => {
  beforeEach(() => {
    responder = async () => jsonResponse({ data: [{ b64_json: B64 }] });
  });

  it('NEVER carries response_format — a measured 400 on an unknowable subset of backends', async () => {
    /*
     * 🔴 It looked like the right lever (a URL keeps a multi-MB image out of this process) and it
     * genuinely worked at `low`/`1024x1024`. At `high`/`1536x1024` the same key on the same model
     * returned a hard 400. A parameter that works is not a parameter that will work, and the failure
     * lands AFTER the debit.
     */
    const provider = client();
    await provider.create(IMAGE_TASK);

    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(Object.keys(seen[0].body ?? {})).not.toContain('response_format');
  });

  it('carries the model, n:1 and the priced payload (control for the scan above)', async () => {
    /*
     * ⚠️ Without this the assertion above passes for a client that sends an EMPTY body — a scan for an
     * absent key cannot tell "correctly omitted" from "nothing was sent at all".
     */
    await client().create(IMAGE_TASK);
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(seen[0].url).toBe('https://api.cometapi.com/v1/images/generations');
    expect(seen[0].method).toBe('POST');
    expect(seen[0].body).toMatchObject({
      model: 'gpt-image-1.5',
      n: 1,
      prompt: 'a chunky racing wordmark',
      size: '1536x1024',
      quality: 'medium',
    });
  });

  it('passes a transparent background through verbatim', async () => {
    // The one parameter that buys real alpha on this gateway; dropping it ships an opaque render.
    await client().create({ ...IMAGE_TASK, payload: { ...IMAGE_TASK.payload, background: 'transparent' } });
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(seen[0].body).toMatchObject({ background: 'transparent' });
  });

  it('authenticates with the platform key as a bearer token', async () => {
    await client().create(IMAGE_TASK);
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(seen[0].headers.Authorization).toBe(`Bearer ${KEY}`);
  });
});

describe('the Gemini route', () => {
  it('POSTs the payload VERBATIM to :generateContent and reads inline bytes', async () => {
    /*
     * Native Gemini takes no size, no quality and no format — one shape. Injecting `model` or `n` here
     * (as the OpenAI-compat route needs) is a 400 on a route that has no such fields.
     */
    responder = async () =>
      jsonResponse({
        candidates: [{ content: { parts: [{ inlineData: { data: B64, mimeType: 'image/jpeg' } }] } }],
      });

    const provider = client();
    const taskId = await provider.create({
      endpoint: 'comet-gemini-image',
      model: 'gemini-3-pro-image',
      payload: { contents: [{ parts: [{ text: 'a neon skyline' }] }] },
    });

    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(seen[0].url).toBe('https://api.cometapi.com/v1beta/models/gemini-3-pro-image:generateContent');
    expect(seen[0].body).toEqual({ contents: [{ parts: [{ text: 'a neon skyline' }] }] });

    await vi.waitFor(async () => {
      expect((await provider.query('comet-gemini-image', taskId)).state).toBe('succeeded');
    });

    // The content type comes from what the backend SAYS it produced, never from what we asked for.
    expect((await provider.download(inlineResultUrl(taskId))).headers.get('Content-Type')).toBe('image/jpeg');
  });

  it('accepts the snake_case spelling of the same field', async () => {
    // Both shapes are in the wild; reading only one turns a good render into a refund.
    responder = async () =>
      jsonResponse({ candidates: [{ content: { parts: [{ inline_data: { data: B64, mime_type: 'image/png' } }] } }] });

    const provider = client();
    const taskId = await provider.create({
      endpoint: 'comet-gemini-image',
      model: 'gemini-3-pro-image',
      payload: { contents: [] },
    });

    await vi.waitFor(async () => {
      expect((await provider.query('comet-gemini-image', taskId)).state).toBe('succeeded');
    });
  });

  it('reports "no image data" as a FAILURE, not a success with nothing to download', async () => {
    responder = async () => jsonResponse({ candidates: [{ content: { parts: [{ text: 'I cannot draw that' }] } }] });

    const provider = client();
    const taskId = await provider.create({
      endpoint: 'comet-gemini-image',
      model: 'gemini-3-pro-image',
      payload: { contents: [] },
    });

    await vi.waitFor(async () => {
      expect((await provider.query('comet-gemini-image', taskId)).state).toBe('failed');
    });
  });
});

describe('the video route — the one genuinely async surface', () => {
  it('returns the GATEWAY task id, not a synthetic one', async () => {
    responder = async () => jsonResponse({ id: 'video_abc123' });

    const taskId = await client().create({
      endpoint: 'comet-video',
      model: 'veo3-fast',
      payload: { prompt: 'a fox', seconds: '4' },
    });

    expect(taskId).toBe('video_abc123');
    expect(taskId).not.toMatch(/^comet-local-/);
    expect(seen[0].url).toBe('https://api.cometapi.com/v1/videos');
    expect(seen[0].body).toEqual({ model: 'veo3-fast', prompt: 'a fox', seconds: '4' });
  });

  it('refuses a create that produced no task id, rather than returning "undefined"', async () => {
    responder = async () => jsonResponse({ ok: true });

    await expect(client().create({ endpoint: 'comet-video', model: 'veo3-fast', payload: {} })).rejects.toThrow(
      /no task id/,
    );
  });

  it.each([
    [{ status: 'processing' }, 'pending'],
    [{ status: 'completed', video_url: 'https://s3.comet/v.mp4' }, 'succeeded'],
    [{ status: 'succeeded', url: 'https://s3.comet/v.mp4' }, 'succeeded'],
    [{ status: 'failed', error: { message: 'moderated' } }, 'failed'],
    [{ status: 'cancelled' }, 'failed'],

    // Completed with nothing to fetch is a failure: a success nothing can download is not a success.
    [{ status: 'completed' }, 'failed'],
  ])('reads video status %j as %s', async (body, expected) => {
    responder = async () => jsonResponse(body);

    const state = await client().query('comet-video', 'video_abc123');

    expect(state.state).toBe(expected);
    expect(seen[0].url).toBe('https://api.cometapi.com/v1/videos/video_abc123');
  });
});

/*
 * ------------------------------------------------------------------------------------------------ *
 * Failures — every one of them has to reach the refund path
 * ------------------------------------------------------------------------------------------------
 */

describe('a failed render is REPORTED, never left pending', () => {
  it('settles an HTTP error as failed, carrying the gateway message', async () => {
    responder = async () => jsonResponse({ error: { message: "Unknown parameter: 'response_format'" } }, 400);

    const provider = client();
    const taskId = await provider.create(IMAGE_TASK);

    await vi.waitFor(async () => {
      const state = await provider.query('comet-image', taskId);

      expect(state.state).toBe('failed');
      expect(state.state === 'failed' && state.error).toMatch(/response_format/);
    });
  });

  it('settles a non-JSON answer as failed rather than throwing into the void', async () => {
    responder = async () => ({ ok: true, status: 200, text: async () => '<html>gateway timeout</html>' });

    const provider = client();
    const taskId = await provider.create(IMAGE_TASK);

    await vi.waitFor(async () => {
      expect((await provider.query('comet-image', taskId)).state).toBe('failed');
    });
  });

  it('treats 200-with-no-image as a failure', async () => {
    responder = async () => jsonResponse({ data: [] });

    const provider = client();
    const taskId = await provider.create(IMAGE_TASK);

    await vi.waitFor(async () => {
      const state = await provider.query('comet-image', taskId);

      expect(state.state).toBe('failed');
      expect(state.state === 'failed' && state.error).toMatch(/no image/i);
    });
  });
});

describe('download', () => {
  it('throws describably when the parked bytes are gone', async () => {
    /*
     * The restart case again, one door along. A generic 500 here would read to the user as "the
     * platform broke"; the truth ("the server restarted, generate it again") is actionable.
     */
    await expect(client().download(inlineResultUrl('comet-local-ghost'))).rejects.toThrow(
      /no longer available|generate it again/i,
    );
  });

  it('fetches an ordinary result URL WITHOUT sending the platform key', async () => {
    /*
     * Comet's result URLs are presigned S3 — the signature IS the credential. Attaching our bearer
     * token would leak the platform key to an S3 host (§5), and buy nothing.
     */
    responder = async () => new Response(new Uint8Array([9]));

    const response = await client().download('https://s3.comet/x.png?X-Amz-Signature=abc');

    expect(response.ok).toBe(true);
    expect(seen[0].headers.Authorization).toBeUndefined();
  });

  it('explains an expired URL instead of returning an empty file', async () => {
    responder = async () => new Response('gone', { status: 403 });

    await expect(client().download('https://s3.comet/old.png')).rejects.toThrow(/expire/i);
  });
});

describe('the capability table covers every media gateway', () => {
  it('mirrors MEDIA_PROVIDERS exactly', () => {
    /*
     * `ImageProviderName` is a hand-written mirror of the media provider enum (it has to be — the
     * capability table is CLIENT-SAFE and may not import `~/lib/.server/**`). A gateway added to one
     * and not the other means `CAPABILITIES[provider]` is `undefined` at runtime for a real provider,
     * and `supportsTransparency` quietly answers "no alpha here" for a gateway that has it.
     */
    const mirrored: ImageProviderName[] = [...MEDIA_PROVIDERS];

    expect([...mirrored].sort()).toEqual(['Comet', 'KIE']);

    for (const provider of mirrored) {
      expect(typeof supportsTransparency(provider)).toBe('boolean');
    }
  });
});
