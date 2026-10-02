/**
 * fal END TO END, against a stubbed network (SPEC §4.16, `_specs/media-gateways_plan.md` T7 step 4).
 *
 * ## Why this is the acceptance run, and not a live one
 *
 * T7's acceptance is a live render of every kind on fal. The platform's fal account is LOCKED — every
 * submit answers `403 {"detail":"User is locked. Reason: Exhausted balance…"}` (checked 2026-10-01) —
 * so the plan's own fallback applies: run the same steps against a stubbed fal.
 *
 * What is REAL here: the three media routes (quote/start, poll, file), the service, the ledger, the
 * task store and `FalMediaProvider` itself — the URLs it builds, the `Key` header, the queue's status
 * relation, the result parsing. What is stubbed: `fetch`, answering the way fal's queue documents
 * (submit → `{request_id, response_url, status_url}`; status `IN_QUEUE` → `IN_PROGRESS` → `COMPLETED`;
 * a result JSON per model family) and serving files whose MAGIC BYTES are real — a PNG with a real
 * alpha channel for the cut-out, a JPEG, an MP4 `ftyp` box, an MP3 `ID3` tag — so "the right file
 * landed" is decided by reading bytes, never by trusting a URL's extension.
 *
 * ⚠️ No test here may reach the network: `.env.local` holds a REAL `FAL_API_KEY`. Every credential is
 * scrubbed and a sentinel key set; the stub fails any URL it does not recognise.
 *
 * ⚠️ Lives here, not in `app/routes/` — a spec in that folder 500s every request (§4.5.6).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsLedger, setLedger } from '~/lib/.server/billing/ledger';
import { setGenerationStore, type GenerationStore } from '~/lib/.server/billing/generations';
import { invalidateMarketPricesCache } from '~/lib/.server/billing/market-price-store';
import { setObjectStore, type ObjectStore } from '~/lib/.server/storage';
import { FsProjectStore, setProjectStore } from '~/lib/.server/projects/store';
import type { Project } from '~/lib/.server/projects/types';
import { createMediaTools } from '~/lib/.server/agent/media-tools';
import { sniffImageType } from '~/lib/media/sniff';
import { setMediaDispatcher } from './dispatch';
import { FalMediaProvider } from './fal-client';

const USER = { id: 'user-1', email: 'a@example.com', emailVerified: true } as const;

vi.mock('~/lib/.server/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireVerifiedUser: async () => USER,
  requireUser: async () => USER,
}));

const SCRUBBED_ENV = [
  'MEDIA_PROVIDER',
  'LLM_PROVIDER',
  'KIE_API_KEY',
  'COMET_API_KEY',
  'FAL_API_KEY',
  'BILLING_ENFORCED',
  'CREDIT_UNIT_COST_USD',
  'CREDIT_MARGIN',
  'MEDIA_CALLBACK_URL',
  'APP_URL',
] as const;

const FAL_KEY = 'sentinel-fal-key';
const START_BALANCE = 10_000;

/*
 * ------------------------------------------------------------------------------------------------ *
 * Real file bytes
 * ------------------------------------------------------------------------------------------------ *
 */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;

  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }

  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;

  for (const b of bytes) {
    c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  }

  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  const typeBytes = new TextEncoder().encode(type);

  view.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));

  return out;
}

/** A real 8×8 RGBA PNG: a 2×2 gold coin in the middle, every other pixel fully transparent. */
function transparentPng(): Uint8Array {
  const size = 8;
  const raw = new Uint8Array(size * (1 + size * 4));

  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0; // filter: none

    for (let x = 0; x < size; x++) {
      const at = y * (1 + size * 4) + 1 + x * 4;
      const coin = x >= 3 && x <= 4 && y >= 3 && y <= 4;
      raw.set(coin ? [0xff, 0xc8, 0x00, 0xff] : [0, 0, 0, 0], at);
    }
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit, colour type 6 (RGBA)

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array()),
  ];

  return concat(parts);
}

/** Decode an unfiltered RGBA PNG (what `transparentPng` writes): colour type and alpha histogram. */
function decodeRgbaPng(bytes: Uint8Array): { colorType: number; transparent: number; total: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let colorType = -1;
  const idat: Uint8Array[] = [];

  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = new DataView(data.buffer, data.byteOffset).getUint32(0);
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    }

    offset += 12 + length;
  }

  const raw = inflateSync(concat(idat));
  const stride = 1 + width * 4;
  let transparent = 0;
  let total = 0;

  for (let row = 0; row * stride < raw.length; row++) {
    for (let x = 0; x < width; x++) {
      total++;

      if (raw[row * stride + 1 + x * 4 + 3] === 0) {
        transparent++;
      }
    }
  }

  return { colorType, transparent, total };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;

  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }

  return out;
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const MP4 = new Uint8Array([
  0,
  0,
  0,
  0x18,
  ...new TextEncoder().encode('ftypisom'),
  0,
  0,
  2,
  0,
  0x69,
  0x73,
  0x6f,
  0x6d,
]);
const MP3 = new Uint8Array([...new TextEncoder().encode('ID3'), 3, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64]);
const PNG_ALPHA = transparentPng();

/*
 * ------------------------------------------------------------------------------------------------ *
 * The stubbed fal queue
 * ------------------------------------------------------------------------------------------------ *
 */

interface FalJob {
  model: string;
  body: Record<string, unknown>;
  polls: number;
  fail: boolean;
}

/** Every request the stub saw — the only way to assert where a poll went. */
let seen: Array<{ method: string; url: string; auth?: string }>;
let jobs: Map<string, FalJob>;
let nextId: number;

const FILE_ORIGIN = 'https://v3.fal.media/files';

/** What fal's result JSON looks like for each model family (fal docs). */
function resultFor(id: string, job: FalJob): Record<string, unknown> {
  if (job.model === 'fal-ai/bria/background/remove') {
    return { image: { url: `${FILE_ORIGIN}/${id}.png` } };
  }

  if (/elevenlabs|minimax-music/.test(job.model)) {
    return { audio: { url: `${FILE_ORIGIN}/${id}.mp3` } };
  }

  if (/veo3|kling|grok-imagine-video/.test(job.model)) {
    return { video: { url: `${FILE_ORIGIN}/${id}.mp4` } };
  }

  const ext = job.body.output_format === 'png' ? 'png' : 'jpg';

  return { images: [{ url: `${FILE_ORIGIN}/${id}.${ext}` }] };
}

const FILES: Record<string, Uint8Array> = { png: PNG_ALPHA, jpg: JPEG, mp4: MP4, mp3: MP3 };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function falFetch(input: unknown, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const headers = (init?.headers ?? {}) as Record<string, string>;
  seen.push({ method, url, auth: headers.Authorization });

  const file = url.match(/^https:\/\/v3\.fal\.media\/files\/[^/]+\.(png|jpg|mp4|mp3)$/);

  if (file) {
    return new Response(FILES[file[1]], { status: 200 });
  }

  if (!url.startsWith('https://queue.fal.run/')) {
    throw new Error(`the stub refuses a request off fal: ${method} ${url}`);
  }

  const route = url.slice('https://queue.fal.run/'.length);
  const request = route.match(/^(.+)\/requests\/([^/]+?)(\/status)?$/);

  if (method === 'POST' && !request) {
    const id = `req-${++nextId}`;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const text = String(body.prompt ?? body.text ?? '');
    jobs.set(id, { model: route, body, polls: 0, fail: text.includes('FAIL_AFTER_ACCEPT') });

    // fal drops a model's subpath in its queue URLs (veo3/fast lives under veo3).
    const parent = route === 'fal-ai/veo3/fast' ? 'fal-ai/veo3' : route;
    const base = `https://queue.fal.run/${parent}/requests/${id}`;

    return jsonResponse({ request_id: id, response_url: base, status_url: `${base}/status`, queue_position: 0 });
  }

  const job = request ? jobs.get(request[2]) : undefined;

  if (!request || !job || method !== 'GET') {
    return jsonResponse({ detail: 'Not found' }, 404);
  }

  if (request[3]) {
    const status = ['IN_QUEUE', 'IN_PROGRESS'][job.polls++] ?? 'COMPLETED';

    return jsonResponse(
      status === 'COMPLETED' && job.fail
        ? { status, error: 'Unprocessable: the text could not be voiced', error_type: 'validation_error' }
        : { status, request_id: request[2] },
    );
  }

  return jsonResponse(resultFor(request[2], job));
}

/*
 * ------------------------------------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------------------------------------ *
 */

function memoryStore(): ObjectStore {
  const objects = new Map<string, Uint8Array>();

  return {
    backend: 'filesystem',
    put: async (key, bytes) => void objects.set(key, bytes),
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => void objects.delete(key),
    list: async (prefix) =>
      [...objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ key: k, size: v.length })),
  };
}

let tmp: string;
let ledger: FsLedger;
let objectStore: ObjectStore;
let project: Project;

beforeEach(async () => {
  for (const key of SCRUBBED_ENV) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  vi.stubEnv('BILLING_ENFORCED', 'true');
  vi.stubEnv('LLM_PROVIDER', 'Anthropic');
  vi.stubEnv('MEDIA_PROVIDER', 'FAL');
  vi.stubEnv('FAL_API_KEY', FAL_KEY);
  invalidateMarketPricesCache();

  objectStore = memoryStore();
  setObjectStore(objectStore);
  setMediaDispatcher((_label, create) => create());

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fal-e2e-'));
  ledger = new FsLedger(tmp);
  setLedger(ledger);
  setGenerationStore({ upsert: async () => undefined, list: async () => [] } as unknown as GenerationStore);

  const projects = new FsProjectStore(path.join(tmp, 'projects'));
  setProjectStore(projects);
  project = await projects.create({ userId: USER.id, name: 'Coin Run', templateId: 'blank' });

  await ledger.append({ userId: USER.id, delta: START_BALANCE, reason: 'grant' });

  seen = [];
  jobs = new Map();
  nextId = 0;
  vi.stubGlobal('fetch', falFetch);
});

afterEach(async () => {
  setMediaDispatcher(undefined);
  setLedger(undefined);
  setGenerationStore(undefined);
  setObjectStore(undefined);
  setProjectStore(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  invalidateMarketPricesCache();
  await fs.rm(tmp, { recursive: true, force: true });
});

interface PanelRequest {
  model: string;
  prompt: string;
  options?: Record<string, string | number | boolean>;
  durationSeconds?: number;
}

async function mediaAction(body: Record<string, unknown>) {
  const { action } = await import('~/routes/api.projects.$projectId.media');
  const response = await action({
    request: new Request('http://localhost/api/projects/x/media', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
    params: { projectId: project.id },
    context: {},
  } as never);

  return { status: response.status, data: (await response.json()) as Record<string, any> };
}

async function poll(taskId: string) {
  const { loader } = await import('~/routes/api.projects.$projectId.media.$taskId');
  const response = await loader({
    request: new Request(`http://localhost/api/projects/x/media/${taskId}`),
    params: { projectId: project.id, taskId },
    context: {},
  } as never);

  return ((await response.json()) as { task: Record<string, any> }).task;
}

async function file(taskId: string) {
  const { loader } = await import('~/routes/api.projects.$projectId.media.$taskId.file');
  const response = await loader({
    request: new Request(`http://localhost/api/projects/x/media/${taskId}/file`),
    params: { projectId: project.id, taskId },
    context: {},
  } as never);

  return {
    status: response.status,
    type: response.headers.get('Content-Type'),
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

/** Poll until terminal (bounded — the stub completes on the 3rd status read per stage). */
async function pollToEnd(taskId: string) {
  let task = await poll(taskId);

  for (let i = 0; i < 10 && task.status === 'pending'; i++) {
    task = await poll(taskId);
  }

  return task;
}

const mediaDebits = async () => (await ledger.list(USER.id)).filter((e) => e.reason === 'media');

/**
 * The panel's whole path for one request: quote → start → poll → file. Returns what landed and what it
 * cost, and asserts the money: the debit is EXACTLY the quoted number, taken once.
 */
async function generate(request: PanelRequest) {
  const before = await ledger.balance(USER.id);
  const debitsBefore = (await mediaDebits()).length;

  const quote = await mediaAction({ action: 'quote', ...request, prompt: '' });
  const speech = /tts/.test(request.model);

  // Speech prices its TEXT; the panel quotes it with the words (an empty-prompt quote is refused).
  const priced = speech ? await mediaAction({ action: 'quote', ...request }) : quote;

  expect(priced.status, `quote ${request.model}: ${priced.data.message}`).toBe(200);

  const started = await mediaAction({ action: 'start', ...request });

  expect(started.status, `start ${request.model}: ${started.data.message}`).toBe(200);
  expect(started.data.credits, 'the debit is the number on the Generate button').toBe(priced.data.credits);
  expect(await ledger.balance(USER.id)).toBe(before - priced.data.credits);
  expect((await mediaDebits()).length, 'exactly one debit').toBe(debitsBefore + 1);

  const pending = await poll(started.data.taskId);

  expect(pending.status, 'IN_QUEUE is pending, never a failure').toBe('pending');

  const task = await pollToEnd(started.data.taskId);

  return { quote: priced.data, started: started.data, task };
}

async function delivered(taskId: string, destPath: string) {
  const got = await file(taskId);

  expect(got.status).toBe(200);
  expect(destPath).toMatch(/^public\/assets\/generated\/[a-z0-9-]+\.(png|jpg|mp4|mp3)$/);

  // The BYTES decide the type, and they agree with the extension the project file is written under.
  expect(sniffImageType(got.bytes)).toBe(destPath.split('.').pop());

  return got;
}

/*
 * ------------------------------------------------------------------------------------------------ *
 * The acceptance steps
 * ------------------------------------------------------------------------------------------------ *
 */

describe('fal end to end — the Media panel path (quote → debit → poll → deliver)', () => {
  it('one opaque image', async () => {
    const { started, task } = await generate({
      model: 'fal-ai/nano-banana-2',
      prompt: 'a neon city skyline at night, photographic',
      options: { resolution: '1K', aspectRatio: '16:9', transparent: false },
    });

    expect(task.status).toBe('succeeded');
    expect(started.destPath).toMatch(/\.jpg$/);

    const got = await delivered(started.taskId, started.destPath);

    expect(got.type).toBe('image/jpeg');

    // Every fal call carried fal's `Key` scheme — the platform key, never Bearer.
    expect(
      seen.filter((s) => s.url.startsWith('https://queue.fal.run/')).every((s) => s.auth === `Key ${FAL_KEY}`),
    ).toBe(true);
  });

  it('one TRANSPARENT image — two stages, one debit, a PNG whose pixels are mostly transparent', async () => {
    const { started, task } = await generate({
      model: 'fal-ai/nano-banana-2',
      prompt: 'a shiny gold coin icon',
      options: { resolution: '1K', aspectRatio: '1:1', transparent: true },
    });

    expect(task).toMatchObject({ status: 'succeeded', stage: 'cutout' });
    expect(started.destPath).toMatch(/\.png$/);

    // Stage 1 rendered on nano-banana-2, stage 2 was bria — both submitted, one debit (asserted above).
    const submits = seen.filter((s) => s.method === 'POST').map((s) => s.url);

    expect(submits).toEqual([
      'https://queue.fal.run/fal-ai/nano-banana-2',
      'https://queue.fal.run/fal-ai/bria/background/remove',
    ]);
    expect([...jobs.values()][1].body).toMatchObject({ image_url: expect.stringMatching(/\.jpg$/) });

    const got = await delivered(started.taskId, started.destPath);
    const png = decodeRgbaPng(got.bytes);

    expect(png.colorType, 'RGBA').toBe(6);
    expect(png.transparent / png.total, 'most pixels outside the subject are fully transparent').toBeGreaterThan(0.8);
  });

  it('one 4-second video with audio off', async () => {
    const { started, task } = await generate({
      model: 'fal-ai/veo3/fast',
      prompt: 'a gold coin spinning on a dark table',
      options: { sound: false, aspectRatio: '16:9' },
      durationSeconds: 4,
    });

    expect(task.status).toBe('succeeded');
    expect(jobs.get('req-1')?.body).toMatchObject({ duration: '4s', generate_audio: false });

    // Polled under the PARENT path fal hands back, never the model's `/fast` subpath.
    expect(seen.some((s) => s.url === 'https://queue.fal.run/fal-ai/veo3/requests/req-1/status')).toBe(true);
    expect(seen.some((s) => s.url.includes('veo3/fast/requests'))).toBe(false);

    expect((await delivered(started.taskId, started.destPath)).type).toBe('video/mp4');
  });

  it('one sound effect (5 s, the default length, quoted and sent alike)', async () => {
    const { quote, started, task } = await generate({
      model: 'fal-ai/elevenlabs/sound-effects/v2',
      prompt: 'arcade coin pickup chime, short and bright',
      options: { loop: false },
      durationSeconds: 5,
    });

    expect(quote.usd).toBeCloseTo(0.01, 10); // $0.002/s × 5 s
    expect(task.status).toBe('succeeded');
    expect(jobs.get('req-1')?.body).toEqual({
      text: 'arcade coin pickup chime, short and bright',
      duration_seconds: 5,
      loop: false,
    });
    expect((await delivered(started.taskId, started.destPath)).type).toBe('audio/mpeg');
  });

  it('one speech line', async () => {
    const { started, task } = await generate({
      model: 'fal-ai/elevenlabs/tts/turbo-v2.5',
      prompt: 'Coin collected!',
      options: { voice: 'Rachel' },
    });

    expect(task.status).toBe('succeeded');
    expect(jobs.get('req-1')?.body).toEqual({ text: 'Coin collected!', voice: 'Rachel' });
    expect((await delivered(started.taskId, started.destPath)).type).toBe('audio/mpeg');
  });

  it('one music track (polled — no callback needed on fal)', async () => {
    const { started, task } = await generate({
      model: 'fal-ai/minimax-music/v2.6',
      prompt: 'short upbeat chiptune background loop for a coin collecting game',
      options: { instrumental: true },
    });

    expect(task.status).toBe('succeeded');
    expect(jobs.get('req-1')?.body).toMatchObject({ is_instrumental: true });
    expect((await delivered(started.taskId, started.destPath)).type).toBe('audio/mpeg');
  });

  it('an invalid request fal ACCEPTS then fails (COMPLETED with error) is refunded exactly once', async () => {
    const { task } = await generate({
      model: 'fal-ai/elevenlabs/tts/turbo-v2.5',
      prompt: 'FAIL_AFTER_ACCEPT — say this',
      options: { voice: 'Rachel' },
    });

    expect(task.status).toBe('failed');
    expect(task.error).toMatch(/could not be voiced/);
    expect(await ledger.balance(USER.id), 'refunded in full').toBe(START_BALANCE);

    // Polling a terminal task again never refunds twice.
    await poll(task.id);
    await poll(task.id);

    expect((await ledger.list(USER.id)).filter((e) => e.reason === 'refund')).toHaveLength(1);
    expect(await ledger.balance(USER.id)).toBe(START_BALANCE);
  });

  it('a task started on FAL still polls and delivers via FAL after MEDIA_PROVIDER switches to KIE', async () => {
    const started = await mediaAction({
      action: 'start',
      model: 'fal-ai/elevenlabs/sound-effects/v2',
      prompt: 'coin pickup',
      options: { loop: false },
      durationSeconds: 2,
    });

    expect(started.status).toBe(200);

    // The operator flips the switch mid-render.
    vi.stubEnv('MEDIA_PROVIDER', 'KIE');
    vi.stubEnv('KIE_API_KEY', 'sentinel-kie');

    const task = await pollToEnd(started.data.taskId);

    expect(task.status).toBe('succeeded');
    expect(
      seen.every((s) => /^https:\/\/(queue\.fal\.run|v3\.fal\.media)\//.test(s.url)),
      'nothing asked KIE',
    ).toBe(true);
    expect((await delivered(started.data.taskId, started.data.destPath)).type).toBe('audio/mpeg');
  });
});

describe('fal end to end — the agent tool path', () => {
  it('"add a coin pickup sound, short background music and a transparent coin icon" creates three fal tasks, all delivered', async () => {
    const events: Array<{ taskId: string; destPath: string }> = [];
    const tools = createMediaTools({
      userId: USER.id,
      projectId: project.id,
      provider: new FalMediaProvider(FAL_KEY),
      objectStore,
      emit: (event) => void events.push(event as never),
    }) as unknown as Record<string, { execute: (args: unknown, opts: unknown) => Promise<string> }>;

    const call = (name: string, args: unknown, id: string) =>
      tools[name].execute(args, { toolCallId: id, messages: [] });

    const results = await Promise.all([
      call('generate_sound', { prompt: 'arcade coin pickup chime', kind: 'sound_effect', duration: 1 }, 'c1'),
      call(
        'generate_sound',
        { prompt: 'short upbeat chiptune background music loop', kind: 'music', instrumental: true },
        'c2',
      ),
      call('generate_image', { prompt: 'a shiny gold coin icon', transparent: true, file_name: 'coin' }, 'c3'),
    ]);

    for (const result of results) {
      expect(result).toMatch(/^Started/);
    }

    expect(
      seen
        .filter((s) => s.method === 'POST')
        .map((s) => s.url)
        .sort(),
    ).toEqual([
      'https://queue.fal.run/fal-ai/elevenlabs/sound-effects/v2',
      'https://queue.fal.run/fal-ai/minimax-music/v2.6',
      'https://queue.fal.run/fal-ai/nano-banana-2',
    ]);
    expect(events).toHaveLength(3);
    expect((await mediaDebits()).length, 'three debits, one per task').toBe(3);

    // The client then polls each task and writes its file — through the same routes as the panel.
    for (const event of events) {
      const task = await pollToEnd(event.taskId);

      expect(task.status, event.destPath).toBe('succeeded');
      await delivered(event.taskId, event.destPath);
    }

    const coin = events.find((e) => e.destPath.includes('/coin-'))!;

    expect(coin.destPath).toMatch(/\.png$/);
    expect(decodeRgbaPng((await file(coin.taskId)).bytes).colorType).toBe(6);
  });
});
