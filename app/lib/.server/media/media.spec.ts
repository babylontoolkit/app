/**
 * Built-in media generation — money-path tests (SPEC §4.16, spec/billing.md).
 *
 * The billing shape under test is the INVERSE of LLM settlement: exact price known up front, debit
 * BEFORE any spend at KIE, refuse-if-unpriced, refuse-if-insufficient, auto-refund EXACTLY ONCE on
 * failure. Every rule here spends or protects real money and fails silently when wrong — same
 * category as `auto-repair.spec.ts` and the credit gate.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsLedger, setLedger } from '~/lib/.server/billing/ledger';
import { setGenerationStore, type GenerationStore, type GenerationUpsert } from '~/lib/.server/billing/generations';
import { invalidateMarketPricesCache } from '~/lib/.server/billing/market-price-store';
import type { ObjectStore } from '~/lib/.server/storage';
import type { CreateMediaTaskInput, MediaProvider, MediaTaskState } from './kie-client';
import { parseTaskState } from './kie-client';
import { getMediaTask } from './store';
import { setMediaDispatcher } from './dispatch';
import {
  buildProviderPayload,
  deriveDestPath,
  MediaRefusedError,
  pollMediaTask,
  quoteMediaRequest,
  startMediaTask,
} from './service';

const USER = 'user-1';
const PROJECT = 'proj-1';

let tmp: string;
let ledger: FsLedger;
let upserts: GenerationUpsert[];

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

class FakeProvider implements MediaProvider {
  created: CreateMediaTaskInput[] = [];
  createError: Error | undefined;
  state: MediaTaskState = { state: 'pending' };
  queries = 0;

  /** When set, `query` awaits it — lets a test hold two polls open simultaneously. */
  gate: Promise<void> | undefined;

  async create(input: CreateMediaTaskInput): Promise<string> {
    if (this.createError) {
      throw this.createError;
    }

    this.created.push(input);

    return `kie-${this.created.length}`;
  }

  async query(): Promise<MediaTaskState> {
    this.queries++;

    if (this.gate) {
      await this.gate;
    }

    return this.state;
  }
}

/*
 * The oauth.spec trap: `env()` falls back to `process.env`, and vitest loads `.env.local`. Every var
 * that changes a price or the enforcement mode is stubbed explicitly, or these tests assert against
 * whatever the developer happens to be running.
 */
const MONEY_ENV = [
  'BILLING_ENFORCED',
  'CREDIT_UNIT_COST_USD',
  'CREDIT_MARGIN',

  /*
   * RETIRED (§4.4a) and therefore MORE dangerous than a stale price, not less: `getBillingConfig`
   * THROWS when this is set, so an operator who still has it in `.env.local` fails every media money
   * assertion here with a `NotConfiguredError` that names a variable this file never mentions.
   */
  'CREATION_FLAT_CREDITS',
] as const;

beforeEach(async () => {
  for (const key of MONEY_ENV) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  invalidateMarketPricesCache();

  /*
   * The production dispatch queue (`dispatch.ts`) sleeps on a REAL timer — spacing between renders and
   * backoff between retries. The refund tests here drive a provider that always throws, so with the
   * real queue each one paid MEDIA_MAX_ATTEMPTS real backoffs and timed out at 5s. The queue's own
   * behaviour is covered against an injected clock in `dispatch.spec.ts`; these tests are about the
   * MONEY, so it is a pass-through here — except in the wiring test below, which spies on it.
   */
  setMediaDispatcher((_label, create) => create());

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'media-'));
  ledger = new FsLedger(tmp);
  setLedger(ledger);

  upserts = [];

  const store: GenerationStore = {
    upsert: async (row: GenerationUpsert) => void upserts.push(row),
    list: async () => [],
  } as unknown as GenerationStore;
  setGenerationStore(store);
});

afterEach(async () => {
  setMediaDispatcher(undefined);
  setLedger(undefined);
  setGenerationStore(undefined);
  await fs.rm(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
  invalidateMarketPricesCache();
});

async function grant(credits: number) {
  await ledger.append({ userId: USER, delta: credits, reason: 'grant' });
}

function imageInput(overrides: Partial<Parameters<typeof startMediaTask>[0]> = {}) {
  return {
    model: 'nano-banana-2',
    prompt: 'a neon city skyline',
    options: { resolution: '2K' },
    userId: USER,
    projectId: PROJECT,
    provider: new FakeProvider(),
    objectStore: memoryStore(),
    ...overrides,
  };
}

describe('quoting', () => {
  it('prices the default image at the worked example: $0.06 → 24 credits', () => {
    const quote = quoteMediaRequest({ model: 'nano-banana-2', prompt: 'x', options: { resolution: '2K' } });

    expect(quote).toMatchObject({ model: 'nano-banana-2', kind: 'image', usd: 0.06, credits: 24 });
  });

  it('refuses an unknown model by name, listing what IS available', () => {
    expect(() => quoteMediaRequest({ model: 'imagen-9', prompt: 'x', options: {} })).toThrow(MediaRefusedError);
    expect(() => quoteMediaRequest({ model: 'imagen-9', prompt: 'x', options: {} })).toThrow(/not in the Marketplace/);
  });

  it('refuses a per-second model without a duration, saying so', () => {
    expect(() =>
      quoteMediaRequest({ model: 'kling-3.0/video', prompt: 'x', options: { mode: 'pro', sound: true } }),
    ).toThrow(/durationSeconds/);
  });

  it('refuses options no variant prices, listing the priced variants', () => {
    expect(() => quoteMediaRequest({ model: 'nano-banana-2', prompt: 'x', options: { resolution: '8K' } })).toThrow(
      /Priced variants/,
    );
  });

  it('prices a transparent image as render + cut-out, in ONE number', () => {
    /*
     * $0.06 render + $0.005 cut-out = $0.065 → 26 credits. The user asked for one asset and gets one
     * debit; the button, the debit and the ledger note all come from this quote.
     */
    const quote = quoteMediaRequest({
      model: 'nano-banana-2',
      prompt: 'a wordmark',
      options: { resolution: '2K', transparent: true },
    });

    expect(quote.usd).toBeCloseTo(0.065, 9);
    expect(quote.credits).toBe(26);
    expect(quote.delivery).toMatchObject({ cutout: true, renderFormat: 'jpg', finalFormat: 'png' });
    expect(quote.cutoutUsd).toBe(0.005);
  });

  it('charges nothing extra for an opaque image', () => {
    const quote = quoteMediaRequest({
      model: 'nano-banana-2',
      prompt: 'a hero background',
      options: { resolution: '2K', transparent: false },
    });

    expect(quote.credits).toBe(24);
    expect(quote.delivery).toMatchObject({ cutout: false });
    expect(quote.cutoutUsd).toBeUndefined();
  });

  it('refuses 4K + transparent up front — the cut-out pass caps at 4096px a side', () => {
    /*
     * Refused in the QUOTE, so the panel says so before any spend. Discovering it at stage 2 would
     * mean paying for a render whose cut-out then fails and refunds — correct, but a wasted round
     * trip and a confusing one.
     */
    expect(() =>
      quoteMediaRequest({ model: 'nano-banana-2', prompt: 'a logo', options: { resolution: '4K', transparent: true } }),
    ).toThrow(/4K is too large for the cut-out pass/);
  });

  it('refuses the cut-out model as a primary model instead of wasting a debit on it', () => {
    // It takes an image, not a prompt — naming it is always a mistake, and it is caught before the debit.
    expect(() => quoteMediaRequest({ model: 'recraft/remove-background', prompt: 'a logo', options: {} })).toThrow(
      /not a model you generate with/,
    );
  });

  it('prices a Kling clip per second: pro+audio 5s = $0.675 → 270 credits', () => {
    const quote = quoteMediaRequest({
      model: 'kling-3.0/video',
      prompt: 'x',
      options: { mode: 'pro', sound: true },
      durationSeconds: 5,
    });

    expect(quote.usd).toBeCloseTo(0.675, 9);
    expect(quote.credits).toBe(270);
  });
});

describe('the dispatch queue is actually wired in', () => {
  beforeEach(() => vi.stubEnv('BILLING_ENFORCED', 'true'));

  /*
   * 🔴 THE WIRING TEST. Every other test in this file installs a PASS-THROUGH dispatcher so it can
   * measure the money without paying real backoff — which means none of them would notice if
   * `startMediaTask` stopped routing through the queue at all. That is precisely the shape of defect
   * this codebase keeps finding: correct units, correct integration, nothing exercising the seam
   * between them (the MCP relay's three defects, and both of today's).
   */
  it('routes provider.create through the dispatcher, not directly', async () => {
    await grant(100);

    const seen: string[] = [];
    setMediaDispatcher(async (label, create) => {
      seen.push(label);
      return create();
    });

    const provider = new FakeProvider();
    const started = await startMediaTask(imageInput({ provider, objectStore: memoryStore() }));

    expect(seen, 'startMediaTask called provider.create without going through the queue').toHaveLength(1);

    // Labelled with the task id, so a live log line names the render that is being dispatched.
    expect(seen[0]).toBe(started.taskId);
    expect(provider.created).toHaveLength(1);
  });

  /*
   * The debit precedes the queue, so a dispatcher that never calls `create` must still leave the
   * charge and the refund path intact — this is what makes retrying inside the queue safe.
   */
  it('has already debited by the time the dispatcher runs', async () => {
    await grant(100);

    let balanceAtDispatch = -1;
    setMediaDispatcher(async (_label, create) => {
      balanceAtDispatch = await ledger.balance(USER);
      return create();
    });

    await startMediaTask(imageInput({ provider: new FakeProvider(), objectStore: memoryStore() }));

    expect(balanceAtDispatch).toBe(76);
  });
});

describe('starting a render (billing enforced)', () => {
  beforeEach(() => vi.stubEnv('BILLING_ENFORCED', 'true'));

  it('debits the EXACT quoted credits before the provider is called', async () => {
    await grant(100);

    const provider = new FakeProvider();
    const objectStore = memoryStore();
    const started = await startMediaTask(imageInput({ provider, objectStore }));

    expect(started.credits).toBe(24);
    expect(await ledger.balance(USER)).toBe(76);
    expect(provider.created).toHaveLength(1);

    // The task record exists, pending, carrying what was actually debited.
    const record = await getMediaTask(objectStore, PROJECT, started.taskId);
    expect(record).toMatchObject({ status: 'pending', credits: 24, kieTaskId: 'kie-1' });
  });

  it('REFUSES with 402 when the balance cannot cover it — and never calls the provider', async () => {
    await grant(10);

    const provider = new FakeProvider();

    await expect(startMediaTask(imageInput({ provider }))).rejects.toMatchObject({
      name: 'MediaRefusedError',
      statusCode: 402,
    });

    expect(provider.created, 'no spend at KIE without the debit').toHaveLength(0);
    expect(await ledger.balance(USER), 'nothing was taken').toBe(10);
  });

  it('refunds immediately when KIE refuses the task, and marks the anchor failed', async () => {
    await grant(100);

    const provider = new FakeProvider();
    provider.createError = new Error('moderation flag');

    await expect(startMediaTask(imageInput({ provider }))).rejects.toMatchObject({ statusCode: 502 });

    expect(await ledger.balance(USER), 'the debit came straight back').toBe(100);
    expect(upserts.at(-1)?.status).toBe('failed');
  });

  /*
   * The fifth terminal state (`spec/fail-loud.md`): debited, rendering at KIE, and NO task record —
   * so nothing can ever poll it and nothing can ever refund it. The caller only sees "could not
   * start", which reads as a refusal that cost nothing. Money gone, silently.
   */
  it('refunds when the task record cannot be stored — a render nothing can poll is a failure', async () => {
    await grant(100);

    const provider = new FakeProvider();
    const objectStore = memoryStore();

    objectStore.put = async () => {
      throw new Error('object store unavailable');
    };

    await expect(startMediaTask(imageInput({ provider, objectStore }))).rejects.toMatchObject({
      name: 'MediaRefusedError',
      statusCode: 500,
    });

    expect(provider.created, 'the render did start — that is why this must refund').toHaveLength(1);
    expect(await ledger.balance(USER), 'the debit came back').toBe(100);
    expect(upserts.at(-1)?.status).toBe('failed');
  });

  it('anchors a generations row BEFORE the debit (the FK rule)', async () => {
    await grant(100);
    await startMediaTask(imageInput());

    const anchor = upserts[0];
    expect(anchor).toMatchObject({ userId: USER, projectId: PROJECT, model: 'nano-banana-2', provider: 'KIE' });
    expect(anchor.id?.startsWith('med_')).toBe(true);
  });

  it('refuses an empty prompt before any money moves', async () => {
    await grant(100);
    await expect(startMediaTask(imageInput({ prompt: '  ' }))).rejects.toThrow(/prompt/i);
    expect(await ledger.balance(USER)).toBe(100);
  });
});

describe('starting a render (unmetered beta mode)', () => {
  it('proceeds WITHOUT blocking when the balance cannot cover it — and without overdrawing', async () => {
    // No grant at all: the 'media' reason may not go negative, so the debit fails and is skipped.
    const provider = new FakeProvider();
    const started = await startMediaTask(imageInput({ provider }));

    expect(provider.created).toHaveLength(1);
    expect(started.credits, 'nothing was debited').toBe(0);
    expect(await ledger.balance(USER)).toBe(0);
  });

  it('still records the debit when the balance covers it — recording is always on', async () => {
    await grant(100);
    await startMediaTask(imageInput());
    expect(await ledger.balance(USER)).toBe(76);
  });
});

describe('polling', () => {
  beforeEach(() => vi.stubEnv('BILLING_ENFORCED', 'true'));

  async function startPending(provider: FakeProvider, objectStore: ObjectStore) {
    await grant(100);

    return startMediaTask(imageInput({ provider, objectStore }));
  }

  it('stays pending while KIE is rendering', async () => {
    const provider = new FakeProvider();
    const objectStore = memoryStore();
    const started = await startPending(provider, objectStore);

    const task = await pollMediaTask({ projectId: PROJECT, taskId: started.taskId, provider, objectStore });
    expect(task?.status).toBe('pending');
  });

  it('records the result URL on success and completes the anchor', async () => {
    const provider = new FakeProvider();
    const objectStore = memoryStore();
    const started = await startPending(provider, objectStore);

    provider.state = { state: 'succeeded', resultUrl: 'https://cdn.kie.ai/x.png' };

    const task = await pollMediaTask({ projectId: PROJECT, taskId: started.taskId, provider, objectStore });

    expect(task).toMatchObject({ status: 'succeeded', resultUrl: 'https://cdn.kie.ai/x.png' });
    expect(upserts.at(-1)?.status).toBe('completed');
    expect(await ledger.balance(USER), 'a successful render keeps its charge').toBe(76);
  });

  it('refunds a failed render EXACTLY once across repeated polls', async () => {
    const provider = new FakeProvider();
    const objectStore = memoryStore();
    const started = await startPending(provider, objectStore);

    provider.state = { state: 'failed', error: 'render exploded' };

    const first = await pollMediaTask({ projectId: PROJECT, taskId: started.taskId, provider, objectStore });
    expect(first).toMatchObject({ status: 'failed', refunded: true, error: 'render exploded' });
    expect(await ledger.balance(USER), 'refunded').toBe(100);

    // Poll again — terminal states are sticky and the refund must not repeat.
    const second = await pollMediaTask({ projectId: PROJECT, taskId: started.taskId, provider, objectStore });
    expect(second?.status).toBe('failed');
    expect(await ledger.balance(USER), 'refunded ONCE').toBe(100);
  });

  it('refunds exactly once even when two polls race', async () => {
    const provider = new FakeProvider();
    const objectStore = memoryStore();
    const started = await startPending(provider, objectStore);

    provider.state = { state: 'failed', error: 'boom' };

    let release!: () => void;
    provider.gate = new Promise((resolve) => (release = resolve));

    const polls = Promise.all([
      pollMediaTask({ projectId: PROJECT, taskId: started.taskId, provider, objectStore }),
      pollMediaTask({ projectId: PROJECT, taskId: started.taskId, provider, objectStore }),
    ]);

    release();
    await polls;

    expect(await ledger.balance(USER), 'the race produced ONE refund').toBe(100);
  });

  it('treats a flaky status check as still-pending, never as a failure', async () => {
    const provider = new FakeProvider();
    const objectStore = memoryStore();
    const started = await startPending(provider, objectStore);

    provider.query = async () => {
      throw new Error('socket hang up');
    };

    const task = await pollMediaTask({ projectId: PROJECT, taskId: started.taskId, provider, objectStore });
    expect(task?.status, 'no refund, no failure — ask again later').toBe('pending');
    expect(await ledger.balance(USER)).toBe(76);
  });

  it('404s cleanly for a task that does not exist', async () => {
    const provider = new FakeProvider();
    expect(
      await pollMediaTask({ projectId: PROJECT, taskId: 'med_ghost', provider, objectStore: memoryStore() }),
    ).toBeNull();
  });
});

/**
 * The cut-out pass (§4.16) — the second stage that turns a flat RGB render into real alpha.
 *
 * It exists because `output_format: "png"` never produced a transparent pixel: measured across every
 * render 2026-07-19 → 2026-07-23, KIE returned either JPEG bytes behind a `.png` URL or an RGBA
 * container with alpha pinned at 255. Two stages, ONE task, ONE debit — and the failure direction is
 * always "say so and refund", never "hand over the opaque one".
 */
describe('the cut-out pass', () => {
  beforeEach(() => vi.stubEnv('BILLING_ENFORCED', 'true'));

  const RENDER_URL = 'https://cdn.kie.ai/render.jpg';
  const CUTOUT_URL = 'https://cdn.kie.ai/cutout.png';

  async function startTransparent(provider: FakeProvider, objectStore: ObjectStore) {
    await grant(100);

    return startMediaTask(
      imageInput({ provider, objectStore, prompt: 'a wordmark', options: { resolution: '2K', transparent: true } }),
    );
  }

  it('debits both stages once, up front, and lands the file as .png', async () => {
    const provider = new FakeProvider();
    const objectStore = memoryStore();
    const started = await startTransparent(provider, objectStore);

    expect(started.credits).toBe(26);
    expect(started.destPath).toMatch(/\.png$/);
    expect(await ledger.balance(USER)).toBe(74);

    // One debit, not two: the user asked for one asset.
    expect((await ledger.list(USER)).filter((e) => e.reason === 'media')).toHaveLength(1);

    const record = await getMediaTask(objectStore, PROJECT, started.taskId);
    expect(record).toMatchObject({ status: 'pending', cutout: true, stage: 'render', credits: 26 });
  });

  it('chains the cut-out when the render lands, and stays pending until it finishes', async () => {
    const provider = new FakeProvider();
    const objectStore = memoryStore();
    const started = await startTransparent(provider, objectStore);

    provider.state = { state: 'succeeded', resultUrl: RENDER_URL };

    const mid = await pollMediaTask({ projectId: PROJECT, taskId: started.taskId, provider, objectStore });

    /*
     * 🔴 The render is OPAQUE. Reporting success here would deliver exactly what the user paid extra
     * NOT to get — and would report it as a transparent asset.
     */
    expect(mid).toMatchObject({ status: 'pending', stage: 'cutout', renderUrl: RENDER_URL, kieTaskId: 'kie-2' });
    expect(mid?.resultUrl, 'the opaque render is never the deliverable').toBeUndefined();

    expect(provider.created[1]).toMatchObject({
      endpoint: 'jobs',
      model: 'recraft/remove-background',
      payload: { image: RENDER_URL },
    });

    // Stage 2 finishes: THAT is the result the project gets.
    provider.state = { state: 'succeeded', resultUrl: CUTOUT_URL };

    const done = await pollMediaTask({ projectId: PROJECT, taskId: started.taskId, provider, objectStore });

    expect(done).toMatchObject({ status: 'succeeded', resultUrl: CUTOUT_URL, renderUrl: RENDER_URL });
    expect(await ledger.balance(USER), 'a delivered cut-out keeps its charge').toBe(74);
  });

  it('fails LOUDLY and refunds in full when the cut-out cannot start', async () => {
    const provider = new FakeProvider();
    const objectStore = memoryStore();
    const started = await startTransparent(provider, objectStore);

    provider.state = { state: 'succeeded', resultUrl: RENDER_URL };
    provider.createError = new Error('recraft is down');

    const task = await pollMediaTask({ projectId: PROJECT, taskId: started.taskId, provider, objectStore });

    expect(task).toMatchObject({ status: 'failed', refunded: true });
    expect(task?.error).toMatch(/cut-out pass could not start/);
    expect(task?.resultUrl, 'the opaque render is NOT quietly substituted').toBeUndefined();
    expect(await ledger.balance(USER), 'both stages refunded').toBe(100);
    expect(upserts.at(-1)?.status).toBe('failed');
  });

  it('refunds BOTH stages when the render itself fails', async () => {
    const provider = new FakeProvider();
    const objectStore = memoryStore();
    const started = await startTransparent(provider, objectStore);

    provider.state = { state: 'failed', error: 'moderated' };

    await pollMediaTask({ projectId: PROJECT, taskId: started.taskId, provider, objectStore });

    // 26, not 24 — the refund is what was debited, and the cut-out never ran.
    expect(await ledger.balance(USER)).toBe(100);
  });

  it('refunds a failed cut-out exactly once across repeated polls', async () => {
    const provider = new FakeProvider();
    const objectStore = memoryStore();
    const started = await startTransparent(provider, objectStore);

    provider.state = { state: 'succeeded', resultUrl: RENDER_URL };
    await pollMediaTask({ projectId: PROJECT, taskId: started.taskId, provider, objectStore });

    provider.state = { state: 'failed', error: 'cut-out exploded' };

    await pollMediaTask({ projectId: PROJECT, taskId: started.taskId, provider, objectStore });
    await pollMediaTask({ projectId: PROJECT, taskId: started.taskId, provider, objectStore });

    expect(await ledger.balance(USER), 'refunded ONCE').toBe(100);
  });

  it('leaves an ordinary opaque image single-stage', async () => {
    const provider = new FakeProvider();
    const objectStore = memoryStore();

    await grant(100);

    const started = await startMediaTask(imageInput({ provider, objectStore }));

    provider.state = { state: 'succeeded', resultUrl: 'https://cdn.kie.ai/hero.jpg' };

    const task = await pollMediaTask({ projectId: PROJECT, taskId: started.taskId, provider, objectStore });

    expect(task).toMatchObject({ status: 'succeeded', resultUrl: 'https://cdn.kie.ai/hero.jpg' });
    expect(provider.created, 'no second KIE call for art that needs no alpha').toHaveLength(1);
  });
});

describe('wire shapes', () => {
  it('builds the Veo flat payload', () => {
    const payload = buildProviderPayload('veo3_fast', {
      model: 'veo3_fast',
      prompt: 'a fox',
      options: { resolution: '1080p', aspectRatio: '16:9' },
      durationSeconds: 8,
    });

    expect(payload).toMatchObject({ model: 'veo3_fast', resolution: '1080p', duration: 8, prompt: 'a fox' });
  });

  it('builds the kling-3.0 jobs input with mode and stringified duration', () => {
    const payload = buildProviderPayload('kling-3.0/video', {
      model: 'kling-3.0/video',
      prompt: 'a fox',
      options: { mode: '4K', sound: true },
      durationSeconds: 10,
    });

    expect(payload).toMatchObject({ mode: '4K', sound: true, duration: '10', multi_shots: false });
  });

  it('builds the image input, defaulting photographic art to jpg (§4.16 — the size win)', () => {
    const payload = buildProviderPayload('nano-banana-2', {
      model: 'nano-banana-2',
      prompt: 'a fox',
      options: { resolution: '2K', aspectRatio: '1:1' },
    });

    // Unspecified + no transparency signal → jpg (a big photographic png is what froze the tab).
    expect(payload).toMatchObject({ resolution: '2K', aspect_ratio: '1:1', output_format: 'jpg' });
  });

  it('RENDERS a cut-out as jpg — the alpha comes from stage 2, and Recraft caps its input at 5MB', () => {
    /*
     * The instinct is to render transparency-needing art as png. That buys nothing (no image model on
     * KIE emits alpha) and actively breaks the pass that does: a 2K PNG measured 4-6MB against
     * Recraft's 5MB input limit, where the same image as jpg is ~2MB.
     */
    const payload = buildProviderPayload('nano-banana-2', {
      model: 'nano-banana-2',
      prompt: 'a team logo',
      options: {},
    });

    expect(payload).toMatchObject({ output_format: 'jpg' });
  });

  it('appends the flat-backdrop directive to a cut-out prompt, and only to a cut-out prompt', () => {
    const cut = buildProviderPayload('nano-banana-2', {
      model: 'nano-banana-2',
      prompt: 'a team logo',
      options: { transparent: true },
    });
    const plain = buildProviderPayload('nano-banana-2', {
      model: 'nano-banana-2',
      prompt: 'a photographic sunset',
      options: {},
    });

    expect(String(cut.prompt)).toContain('a team logo');
    expect(String(cut.prompt).toLowerCase()).toContain('checkerboard');
    expect(plain.prompt).toBe('a photographic sunset');
  });

  /* A misread "failed" would refund a render that succeeded — KIE's shapes are all covered. */
  it.each([
    [{ state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://r/x.png'] }) }, 'succeeded'],
    [{ successFlag: 1, response: { resultUrls: ['https://r/x.mp4'] } }, 'succeeded'],
    [{ status: 'completed', resultUrls: ['https://r/y.png'] }, 'succeeded'],
    [{ state: 'fail', errorMessage: 'nope' }, 'failed'],
    [{ successFlag: 2 }, 'failed'],
    [{ successFlag: 3, msg: 'moderated' }, 'failed'],
    [{ state: 'queuing' }, 'pending'],
    [{}, 'pending'],
  ])('parses KIE status shape %j as %s', (data, expected) => {
    expect(parseTaskState(data as Record<string, unknown>).state).toBe(expected);
  });

  it('reports success-with-no-URL as a FAILURE — bytes we cannot fetch are not a success', () => {
    expect(parseTaskState({ state: 'success' })).toMatchObject({ state: 'failed' });
  });
});

describe('destination paths', () => {
  it('derives a slugged path under public/assets/generated with a task-id suffix (photographic → jpg)', () => {
    const dest = deriveDestPath('image', { model: 'm', prompt: 'A Neon City!! At Night', options: {} }, 'med_abc123_x');

    /*
     * The extension MUST match the format the job was built with (`resolveImageOutputFormat`), or the
     * file is written as one type and referenced as another. Photographic prompt, unspecified → jpg.
     */
    expect(dest).toMatch(/^public\/assets\/generated\/a-neon-city-at-night-[a-z0-9_]+\.jpg$/);
  });

  it('honours jpg and video extensions, and lands a cut-out as png', () => {
    expect(
      deriveDestPath('image', { model: 'm', prompt: 'sky', options: { outputFormat: 'jpg' } }, 'med_abc123_x'),
    ).toMatch(/\.jpg$/);
    expect(deriveDestPath('video', { model: 'm', prompt: 'sky', options: {} }, 'med_abc123_x')).toMatch(/\.mp4$/);

    /*
     * The path follows `finalFormat`, never what KIE rendered: a cut-out is rendered as jpg and
     * delivered as an RGBA png. Getting this backwards writes the file as one type and references it
     * as another.
     */
    expect(deriveDestPath('image', { model: 'm', prompt: 'a brand logo', options: {} }, 'med_abc123_x')).toMatch(
      /\.png$/,
    );
    expect(
      deriveDestPath('image', { model: 'm', prompt: 'sky', options: { transparent: true } }, 'med_abc123_x'),
    ).toMatch(/\.png$/);
  });

  it('prefers a caller file name over the prompt slug (extension still follows the resolved format)', () => {
    /*
     * The file name drives the SLUG; the extension follows the format. "hero-bg" is photographic with no
     * explicit format, so it lands as jpg regardless of the .png the caller happened to type.
     */
    expect(
      deriveDestPath('image', { model: 'm', prompt: 'whatever', options: {}, fileName: 'hero-bg.png' }, 'med_abc123_x'),
    ).toMatch(/^public\/assets\/generated\/hero-bg-[a-z0-9_]+\.jpg$/);
  });
});
