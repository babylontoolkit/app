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
import { invalidateMarketPricesCache, promoteMarketPrices } from '~/lib/.server/billing/market-price-store';
import { BAKED_MARKET_PRICES } from '~/lib/.server/billing/baked-market-prices';
import { setObjectStore, type ObjectStore } from '~/lib/.server/storage';
import type { CreateMediaTaskInput, MediaProvider, MediaProviderName, MediaTaskState } from './provider';
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

/** The in-memory ObjectStore the price list is read from (and, in one test, promoted into). */
let priceStore: ObjectStore;

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
  /** Stamped onto every record this provider starts — the KIE path is the AC7 control here. */
  name: MediaProviderName;

  constructor(name: MediaProviderName = 'KIE') {
    this.name = name;
  }

  created: CreateMediaTaskInput[] = [];
  downloaded: string[] = [];
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

  async download(url: string): Promise<Response> {
    this.downloaded.push(url);

    return new Response(new Uint8Array([1, 2, 3]));
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

  /*
   * ⚠️ The oauth.spec trap, FOURTH occurrence — and this pair is the live one. `.env.local` now holds
   * a real `COMET_API_KEY`, and `MEDIA_PROVIDER` decides which gateway's price list every assertion
   * below is measured against. Unstubbed, a developer who has flipped either var runs these money
   * tests on a different set of prices than CI does, and can reach a real credential.
   */
  'MEDIA_PROVIDER',
  'LLM_PROVIDER',
  'KIE_API_KEY',
  'COMET_API_KEY',
] as const;

beforeEach(async () => {
  for (const key of MONEY_ENV) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  invalidateMarketPricesCache();

  /*
   * 🔴 `startMediaTask` calls `ensureMarketPrices`, which READS THE OBJECT STORE. Left alone that
   * resolves the operator's real `.data` directory, so every price assertion below would be measured
   * against whatever list this machine happens to have promoted — the `oauth.spec.ts` trap in storage
   * form, green on CI and failing only for the person who used the admin panel. Empty memory store →
   * the baked list, which is what these numbers are.
   */
  priceStore = memoryStore();
  setObjectStore(priceStore);

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
  setObjectStore(undefined);
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
    const quote = quoteMediaRequest({ model: 'nano-banana-2', prompt: 'x', options: { resolution: '2K' } }, 'KIE');

    expect(quote).toMatchObject({ model: 'nano-banana-2', kind: 'image', usd: 0.06, credits: 24 });
  });

  it('refuses an unknown model by name, listing what IS available', () => {
    expect(() => quoteMediaRequest({ model: 'imagen-9', prompt: 'x', options: {} }, 'KIE')).toThrow(MediaRefusedError);
    expect(() => quoteMediaRequest({ model: 'imagen-9', prompt: 'x', options: {} }, 'KIE')).toThrow(
      /not in the Marketplace/,
    );
  });

  it('refuses a per-second model without a duration, saying so', () => {
    expect(() =>
      quoteMediaRequest({ model: 'kling-3.0/video', prompt: 'x', options: { mode: 'pro', sound: true } }, 'KIE'),
    ).toThrow(/durationSeconds/);
  });

  it('refuses options no variant prices, listing the priced variants', () => {
    expect(() =>
      quoteMediaRequest({ model: 'nano-banana-2', prompt: 'x', options: { resolution: '8K' } }, 'KIE'),
    ).toThrow(/Priced variants/);
  });

  it('prices kling-2.6, whose variants are keyed on DURATION', () => {
    /*
     * 🔴 THE REGRESSION THIS EXISTS FOR, and it shipped green. T8's rewrite of `quoteMediaRequest`
     * dropped `lookupOptions`, which merges `durationSeconds` INTO the option record before variant
     * matching. All four `kling-2.6` variants are keyed on `durationSeconds`, so the lookup matched
     * none of them and every kling-2.6 render — offered by both the Media panel and the
     * `generate_video` tool — became unquotable on the INCUMBENT provider.
     *
     * Nothing caught it: `market-prices.spec.ts` drives `lookupMediaPrice` directly with the duration
     * already inside `options`, and every video case in this file used `kling-3.0`, which is keyed on
     * `mode`. A whole model class had no coverage — the "a path every test drove around" shape.
     *
     * ⚠️ **`sound` IS HELD CONSTANT AND THE PRICES ARE ASSERTED AS LITERALS, and the first draft of
     * this test did neither.** It compared `{5s, sound:false}` against `{10s, sound:true}` and asserted
     * only that the second cost more — which the SOUND dimension satisfies on its own. A mutation that
     * merged a hardcoded `durationSeconds: 5` (i.e. a 50% under-charge on every 10-second render) left
     * it GREEN, and the plan claimed it was mutation-verified. Varying two dimensions to test one is
     * the `PROGRESS_CAP` vacuity trap: both sides of the comparison moved together.
     */
    const priceOf = (durationSeconds: number) =>
      quoteMediaRequest({ model: 'kling-2.6', prompt: 'a fox', options: { sound: false }, durationSeconds }, 'KIE').usd;

    expect(priceOf(5)).toBeCloseTo(0.275, 9);
    expect(priceOf(10)).toBeCloseTo(0.55, 9);

    // The other axis, pinned the same way — the duration match must not be satisfying `sound` by luck.
    const withSound = quoteMediaRequest(
      { model: 'kling-2.6', prompt: 'a fox', options: { sound: true }, durationSeconds: 10 },
      'KIE',
    );

    expect(withSound.usd).toBeCloseTo(1.1, 9);
    expect(withSound.kind).toBe('video');
  });

  it('prices a transparent image as render + cut-out, in ONE number', () => {
    /*
     * $0.06 render + $0.005 cut-out = $0.065 → 26 credits. The user asked for one asset and gets one
     * debit; the button, the debit and the ledger note all come from this quote.
     */
    const quote = quoteMediaRequest(
      {
        model: 'nano-banana-2',
        prompt: 'a wordmark',
        options: { resolution: '2K', transparent: true },
      },
      'KIE',
    );

    expect(quote.usd).toBeCloseTo(0.065, 9);
    expect(quote.credits).toBe(26);
    expect(quote.delivery).toMatchObject({ cutout: true, renderFormat: 'jpg', finalFormat: 'png' });
    expect(quote.cutoutUsd).toBe(0.005);
  });

  it('charges nothing extra for an opaque image', () => {
    const quote = quoteMediaRequest(
      {
        model: 'nano-banana-2',
        prompt: 'a hero background',
        options: { resolution: '2K', transparent: false },
      },
      'KIE',
    );

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
      quoteMediaRequest(
        { model: 'nano-banana-2', prompt: 'a logo', options: { resolution: '4K', transparent: true } },
        'KIE',
      ),
    ).toThrow(/4K is too large for the cut-out pass/);
  });

  it('refuses the cut-out model as a primary model instead of wasting a debit on it', () => {
    // It takes an image, not a prompt — naming it is always a mistake, and it is caught before the debit.
    expect(() =>
      quoteMediaRequest({ model: 'recraft/remove-background', prompt: 'a logo', options: {} }, 'KIE'),
    ).toThrow(/not a model you generate with/);
  });

  it('prices a Kling clip per second: pro+audio 5s = $0.675 → 270 credits', () => {
    const quote = quoteMediaRequest(
      {
        model: 'kling-3.0/video',
        prompt: 'x',
        options: { mode: 'pro', sound: true },
        durationSeconds: 5,
      },
      'KIE',
    );

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

    const task = await pollMediaTask({
      projectId: PROJECT,
      taskId: started.taskId,
      resolveProvider: () => provider,
      objectStore,
    });
    expect(task?.status).toBe('pending');
  });

  it('records the result URL on success and completes the anchor', async () => {
    const provider = new FakeProvider();
    const objectStore = memoryStore();
    const started = await startPending(provider, objectStore);

    provider.state = { state: 'succeeded', resultUrl: 'https://cdn.kie.ai/x.png' };

    const task = await pollMediaTask({
      projectId: PROJECT,
      taskId: started.taskId,
      resolveProvider: () => provider,
      objectStore,
    });

    expect(task).toMatchObject({ status: 'succeeded', resultUrl: 'https://cdn.kie.ai/x.png' });
    expect(upserts.at(-1)?.status).toBe('completed');
    expect(await ledger.balance(USER), 'a successful render keeps its charge').toBe(76);
  });

  it('refunds a failed render EXACTLY once across repeated polls', async () => {
    const provider = new FakeProvider();
    const objectStore = memoryStore();
    const started = await startPending(provider, objectStore);

    provider.state = { state: 'failed', error: 'render exploded' };

    const first = await pollMediaTask({
      projectId: PROJECT,
      taskId: started.taskId,
      resolveProvider: () => provider,
      objectStore,
    });
    expect(first).toMatchObject({ status: 'failed', refunded: true, error: 'render exploded' });
    expect(await ledger.balance(USER), 'refunded').toBe(100);

    // Poll again — terminal states are sticky and the refund must not repeat.
    const second = await pollMediaTask({
      projectId: PROJECT,
      taskId: started.taskId,
      resolveProvider: () => provider,
      objectStore,
    });
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
      pollMediaTask({ projectId: PROJECT, taskId: started.taskId, resolveProvider: () => provider, objectStore }),
      pollMediaTask({ projectId: PROJECT, taskId: started.taskId, resolveProvider: () => provider, objectStore }),
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

    const task = await pollMediaTask({
      projectId: PROJECT,
      taskId: started.taskId,
      resolveProvider: () => provider,
      objectStore,
    });
    expect(task?.status, 'no refund, no failure — ask again later').toBe('pending');
    expect(await ledger.balance(USER)).toBe(76);
  });

  it('404s cleanly for a task that does not exist', async () => {
    const provider = new FakeProvider();
    expect(
      await pollMediaTask({
        projectId: PROJECT,
        taskId: 'med_ghost',
        resolveProvider: () => provider,
        objectStore: memoryStore(),
      }),
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

    const mid = await pollMediaTask({
      projectId: PROJECT,
      taskId: started.taskId,
      resolveProvider: () => provider,
      objectStore,
    });

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

    const done = await pollMediaTask({
      projectId: PROJECT,
      taskId: started.taskId,
      resolveProvider: () => provider,
      objectStore,
    });

    expect(done).toMatchObject({ status: 'succeeded', resultUrl: CUTOUT_URL, renderUrl: RENDER_URL });
    expect(await ledger.balance(USER), 'a delivered cut-out keeps its charge').toBe(74);
  });

  it('fails LOUDLY and refunds in full when the cut-out cannot start', async () => {
    const provider = new FakeProvider();
    const objectStore = memoryStore();
    const started = await startTransparent(provider, objectStore);

    provider.state = { state: 'succeeded', resultUrl: RENDER_URL };
    provider.createError = new Error('recraft is down');

    const task = await pollMediaTask({
      projectId: PROJECT,
      taskId: started.taskId,
      resolveProvider: () => provider,
      objectStore,
    });

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

    await pollMediaTask({ projectId: PROJECT, taskId: started.taskId, resolveProvider: () => provider, objectStore });

    // 26, not 24 — the refund is what was debited, and the cut-out never ran.
    expect(await ledger.balance(USER)).toBe(100);
  });

  it('refunds a failed cut-out exactly once across repeated polls', async () => {
    const provider = new FakeProvider();
    const objectStore = memoryStore();
    const started = await startTransparent(provider, objectStore);

    provider.state = { state: 'succeeded', resultUrl: RENDER_URL };
    await pollMediaTask({ projectId: PROJECT, taskId: started.taskId, resolveProvider: () => provider, objectStore });

    provider.state = { state: 'failed', error: 'cut-out exploded' };

    await pollMediaTask({ projectId: PROJECT, taskId: started.taskId, resolveProvider: () => provider, objectStore });
    await pollMediaTask({ projectId: PROJECT, taskId: started.taskId, resolveProvider: () => provider, objectStore });

    expect(await ledger.balance(USER), 'refunded ONCE').toBe(100);
  });

  it('leaves an ordinary opaque image single-stage', async () => {
    const provider = new FakeProvider();
    const objectStore = memoryStore();

    await grant(100);

    const started = await startMediaTask(imageInput({ provider, objectStore }));

    provider.state = { state: 'succeeded', resultUrl: 'https://cdn.kie.ai/hero.jpg' };

    const task = await pollMediaTask({
      projectId: PROJECT,
      taskId: started.taskId,
      resolveProvider: () => provider,
      objectStore,
    });

    expect(task).toMatchObject({ status: 'succeeded', resultUrl: 'https://cdn.kie.ai/hero.jpg' });
    expect(provider.created, 'no second KIE call for art that needs no alpha').toHaveLength(1);
  });
});

/**
 * COMET — the same money rules on a gateway whose transparency works completely differently (T8).
 *
 * On KIE, "the user wants alpha" and "run a second priced stage" are the same fact, because no KIE
 * image model emits an alpha channel. On Comet they come apart: `gpt-image-1.5` produces real alpha in
 * ONE call. Three things therefore have to be true here and are each silent when wrong:
 *
 *  1. **ONE debit for ONE stage.** Charging a cut-out that never runs is theft by arithmetic.
 *  2. **The QUOTE and the ANCHOR name the model that actually runs.** A transparent request for
 *     `gemini-3-pro-image` resolves to `gpt-image-1.5`; pricing the requested model and calling a
 *     different one is the priced-but-not-listed mis-bill wearing media clothes.
 *  3. **An unpriced variant is refused BEFORE the debit, with ZERO ledger rows.** `lookupMediaPrice`
 *     has no most-expensive fallback on purpose — media debits run before spend.
 */
describe('Comet — transparency in ONE stage', () => {
  function cometInput(overrides: Partial<Parameters<typeof startMediaTask>[0]> = {}) {
    return {
      model: 'gpt-image-1.5',
      prompt: 'a chunky racing wordmark',
      options: {},
      userId: USER,
      projectId: PROJECT,
      provider: new FakeProvider('Comet'),
      objectStore: memoryStore(),
      ...overrides,
    };
  }

  describe('quoting', () => {
    it('prices a transparent image as ONE stage, on the model that can actually do it', () => {
      /*
       * 🔴 The requested model is deliberately one that CANNOT do alpha. An assertion made against
       * `gpt-image-1.5` in the first place passes for a quote that never substitutes anything — i.e.
       * for the defect where a transparent request runs on a flat-RGB model and reports success.
       */
      const quote = quoteMediaRequest(
        { model: 'gemini-3-pro-image', prompt: 'a wordmark', options: { transparent: true } },
        'Comet',
      );

      expect(quote.model, 'the substitution is visible on the quote, never silent').toBe('gpt-image-1.5');
      expect(quote.usd).toBeCloseTo(0.062, 9);
      expect(quote.credits).toBe(25);

      // No second stage: alpha comes out of the same call, so there is nothing else to bill.
      expect(quote.cutoutUsd, 'nothing extra is charged for alpha on this gateway').toBeUndefined();
      expect(quote.delivery).toEqual({
        model: 'gpt-image-1.5',
        cutout: false,
        background: 'transparent',
        renderFormat: 'png',
        finalFormat: 'png',
        cutoutPrompt: false,
      });
    });

    it('leaves an OPAQUE request on the model that was asked for (the substitution control)', () => {
      /*
       * ⚠️ Pairs with the test above. Without it, "resolves to gpt-image-1.5" passes for a quote that
       * hardcodes one model and silently re-prices every render on this gateway.
       */
      const quote = quoteMediaRequest(
        { model: 'gemini-3-pro-image', prompt: 'a photographic hero', options: {} },
        'Comet',
      );

      expect(quote.model).toBe('gemini-3-pro-image');
      expect(quote.usd).toBeCloseTo(0.017, 9);
      expect(quote.credits).toBe(7);
      expect(quote.delivery).toMatchObject({ cutout: false, finalFormat: 'jpg' });
      expect(quote.delivery?.background).toBeUndefined();
    });

    it('normalises the gateway options ONCE, into the record that prices the render', () => {
      /*
       * Comet prices `gpt-image-1.5` on `(quality, aspectRatio)`; KIE prices on `resolution`. The quote
       * carries the normalised record so the price lookup and the provider payload cannot ask for
       * different things — a render billed for one configuration and rendered at another.
       */
      const quote = quoteMediaRequest({ model: 'gpt-image-1.5', prompt: 'x', options: {} }, 'Comet');

      expect(quote.options).toEqual({ aspectRatio: '16:9', quality: 'medium' });
      expect(quote.credits, 'the default cell is medium 16:9 — $0.062').toBe(25);
    });

    it.each([
      [{ quality: 'low', aspectRatio: '1:1' }, 0.029, 12],
      [{ quality: 'medium', aspectRatio: '1:1' }, 0.049, 20],
      [{ quality: 'high', aspectRatio: '1:1' }, 0.129, 52],
      [{ quality: 'low', aspectRatio: '16:9' }, 0.032, 13],
      [{ quality: 'medium', aspectRatio: '16:9' }, 0.062, 25],
      [{ quality: 'high', aspectRatio: '16:9' }, 0.181, 73],
    ])('prices the probed cell %j at $%s → %i credits', (options, usd, credits) => {
      const quote = quoteMediaRequest({ model: 'gpt-image-1.5', prompt: 'x', options }, 'Comet');

      expect(quote.usd).toBeCloseTo(usd, 9);
      expect(quote.credits).toBe(credits);
    });

    it('prices Comet video per second', () => {
      // $0.08/s x 4s = $0.32 → 128 credits. Comet bills video in the platform's own unit.
      const quote = quoteMediaRequest(
        { model: 'veo3-fast', prompt: 'a fox running', options: {}, durationSeconds: 4 },
        'Comet',
      );

      expect(quote).toMatchObject({ kind: 'video', credits: 128 });
      expect(quote.usd).toBeCloseTo(0.32, 9);
      expect(quote.delivery, 'video needs no delivery decision at all').toBeUndefined();
    });

    it('never runs the image machinery over a VIDEO request', () => {
      /*
       * Kind is decided FIRST, from the requested model. Otherwise a video prompt that happens to say
       * "logo" would resolve a video to an image model — and be billed as one.
       */
      const quote = quoteMediaRequest(
        { model: 'veo3-fast', prompt: 'a spinning team logo', options: { transparent: true }, durationSeconds: 4 },
        'Comet',
      );

      expect(quote.model).toBe('veo3-fast');
      expect(quote.kind).toBe('video');
    });

    it('prices against COMET rows, never KIE ones (the two lists are separate)', () => {
      // KIE's default image model is not on this gateway at all — it must refuse, not price it.
      expect(() => quoteMediaRequest({ model: 'nano-banana-2', prompt: 'x', options: {} }, 'Comet')).toThrow(
        /not in the Marketplace/,
      );
    });
  });

  describe('starting a render (billing enforced)', () => {
    beforeEach(() => vi.stubEnv('BILLING_ENFORCED', 'true'));

    it('debits ONCE for ONE stage, and the anchor names the model that ran', async () => {
      await grant(100);

      const provider = new FakeProvider('Comet');
      const objectStore = memoryStore();
      const started = await startMediaTask(
        cometInput({ provider, objectStore, model: 'gemini-3-pro-image', options: { transparent: true } }),
      );

      expect(started.model, 'the substituted model is what the caller is told ran').toBe('gpt-image-1.5');
      expect(started.credits).toBe(25);
      expect(await ledger.balance(USER)).toBe(75);

      // ONE row, not two — there is no cut-out stage on this gateway.
      expect((await ledger.list(USER)).filter((e) => e.reason === 'media')).toHaveLength(1);

      // The generations anchor drives the §4.10 margin report: it must name what was actually billed.
      expect(upserts[0]).toMatchObject({ model: 'gpt-image-1.5', provider: 'Comet' });

      const record = await getMediaTask(objectStore, PROJECT, started.taskId);
      expect(record).toMatchObject({
        status: 'pending',
        provider: 'Comet',
        endpoint: 'comet-image',
        model: 'gpt-image-1.5',
        credits: 25,
      });
      expect(record?.cutout, 'no second stage is owed').toBeUndefined();
      expect(record?.stage).toBeUndefined();
      expect(started.destPath).toMatch(/\.png$/);

      // One upstream call, carrying the parameter that actually buys the alpha.
      expect(provider.created).toHaveLength(1);
      expect(provider.created[0]).toMatchObject({
        endpoint: 'comet-image',
        model: 'gpt-image-1.5',
        payload: { background: 'transparent', size: '1536x1024', quality: 'medium' },
      });
    });

    it('stores the NORMALISED options — what was priced is what was asked for', async () => {
      await grant(100);

      const objectStore = memoryStore();
      const provider = new FakeProvider('Comet');
      const started = await startMediaTask(cometInput({ provider, objectStore }));

      const record = await getMediaTask(objectStore, PROJECT, started.taskId);

      expect(record?.options).toEqual({ aspectRatio: '16:9', quality: 'medium' });
      expect(provider.created[0].payload).toMatchObject({ size: '1536x1024', quality: 'medium' });
    });

    it('REFUSES an unpriced (quality, aspectRatio) pair with ZERO ledger rows', async () => {
      /*
       * 🔴 Only the six probed cells exist. An unlisted pair has no measured token count, so it has no
       * price — and a media debit runs BEFORE the spend, so it is refused rather than priced off a
       * neighbouring cell. Zero ledger rows is the assertion that matters: a refusal that has already
       * taken the money is not a refusal.
       */
      await grant(100);

      const provider = new FakeProvider('Comet');

      await expect(startMediaTask(cometInput({ provider, options: { quality: 'ultra' } }))).rejects.toThrow(
        /Priced variants/,
      );

      expect(await ledger.balance(USER), 'nothing was taken').toBe(100);
      expect(
        (await ledger.list(USER)).filter((e) => e.reason === 'media'),
        'no debit row at all',
      ).toHaveLength(0);
      expect(upserts, 'not even an anchor was written').toHaveLength(0);
      expect(provider.created, 'no spend at the gateway').toHaveLength(0);
    });

    it('starts a Comet video on the video route with a STRING duration', async () => {
      await grant(200);

      const provider = new FakeProvider('Comet');
      const objectStore = memoryStore();
      const started = await startMediaTask(
        cometInput({ provider, objectStore, model: 'veo3-fast', durationSeconds: 4, prompt: 'a fox' }),
      );

      expect(started.credits).toBe(128);
      expect(started.destPath).toMatch(/\.mp4$/);
      expect(provider.created[0]).toMatchObject({
        endpoint: 'comet-video',
        model: 'veo3-fast',
        payload: { prompt: 'a fox', seconds: '4' },
      });
    });

    it('never chains a second call when the render lands', async () => {
      await grant(100);

      const provider = new FakeProvider('Comet');
      const objectStore = memoryStore();
      const started = await startMediaTask(cometInput({ provider, objectStore, options: { transparent: true } }));

      provider.state = { state: 'succeeded', resultUrl: 'comet-inline:comet-local-1' };

      const task = await pollMediaTask({
        projectId: PROJECT,
        taskId: started.taskId,
        resolveProvider: () => provider,
        objectStore,
      });

      expect(task).toMatchObject({ status: 'succeeded', resultUrl: 'comet-inline:comet-local-1' });
      expect(provider.created, 'the alpha already came out of call one').toHaveLength(1);
      expect(await ledger.balance(USER), 'a delivered render keeps its charge').toBe(75);
    });

    it('refunds a failed Comet render EXACTLY once when two polls race', async () => {
      /*
       * The same concurrency harness as the KIE case: two polls both observing pending → failed must
       * produce ONE compensating row. Re-run on this gateway because the record's provider now decides
       * which client is asked, and a second refund is money invented out of nothing.
       */
      await grant(100);

      const provider = new FakeProvider('Comet');
      const objectStore = memoryStore();
      const started = await startMediaTask(cometInput({ provider, objectStore }));

      provider.state = { state: 'failed', error: 'the render was interrupted' };

      let release!: () => void;
      provider.gate = new Promise((resolve) => (release = resolve));

      const polls = Promise.all([
        pollMediaTask({ projectId: PROJECT, taskId: started.taskId, resolveProvider: () => provider, objectStore }),
        pollMediaTask({ projectId: PROJECT, taskId: started.taskId, resolveProvider: () => provider, objectStore }),
      ]);

      release();
      await polls;

      expect(await ledger.balance(USER), 'the race produced ONE refund').toBe(100);
      expect((await ledger.list(USER)).filter((e) => e.reason === 'refund')).toHaveLength(1);
    });
  });
});

/**
 * A transparency that CANNOT be served is refused before the debit — on any gateway.
 *
 * KIE has no native alpha, so its whole transparency capability is the `recraft/remove-background`
 * row in the active price list. Remove that row (an operator promoting a trimmed list; exactly the
 * state the panel's promote button can produce) and the gateway has no way at all to deliver alpha.
 *
 * 🔴 The only acceptable answer is a refusal with NOTHING debited. Falling through to an opaque render
 * hands over precisely the thing the user paid extra not to get, and reports success while doing it —
 * the §4.16 failure that shipped a logo with a grey box baked into it.
 */
describe('a transparency with no mechanism refuses before the debit', () => {
  beforeEach(() => vi.stubEnv('BILLING_ENFORCED', 'true'));

  /** The shipped KIE list with its ONE transparency capability removed. */
  const WITHOUT_CUTOUT = {
    ...BAKED_MARKET_PRICES,
    media: Object.fromEntries(
      Object.entries(BAKED_MARKET_PRICES.media).filter(([id]) => id !== 'recraft/remove-background'),
    ),
  };

  it('refuses, with ZERO ledger rows and no anchor', async () => {
    await grant(100);
    expect((await promoteMarketPrices(priceStore, 'KIE', WITHOUT_CUTOUT)).ok, 'the trimmed list is valid').toBe(true);

    const provider = new FakeProvider('KIE');

    await expect(
      startMediaTask(imageInput({ provider, prompt: 'a team logo', options: { resolution: '2K', transparent: true } })),
    ).rejects.toMatchObject({ name: 'MediaRefusedError' });

    expect(await ledger.balance(USER), 'a refusal that took the money is not a refusal').toBe(100);
    expect((await ledger.list(USER)).filter((e) => e.reason === 'media')).toHaveLength(0);
    expect(upserts).toHaveLength(0);
    expect(provider.created, 'nothing was rendered').toHaveLength(0);
  });

  it('still serves the SAME request when the cut-out row is present (the control)', async () => {
    /*
     * ⚠️ Without this, the refusal above passes for a service that refuses every transparent request —
     * a "safe" failure that silently removes the feature.
     */
    await grant(100);

    const provider = new FakeProvider('KIE');
    const started = await startMediaTask(
      imageInput({ provider, prompt: 'a team logo', options: { resolution: '2K', transparent: true } }),
    );

    expect(started.credits).toBe(26);
    expect(provider.created).toHaveLength(1);
  });

  it('leaves an OPAQUE request untouched by the missing row (the second control)', async () => {
    // The cut-out row prices a stage an opaque render never runs; losing it must change nothing here.
    await grant(100);
    await promoteMarketPrices(priceStore, 'KIE', WITHOUT_CUTOUT);

    const started = await startMediaTask(imageInput({ prompt: 'a photographic hero' }));

    expect(started.credits).toBe(24);
  });
});

describe('wire shapes', () => {
  /*
   * The delivery decision comes from the REAL quote, exactly as production composes it — the payload
   * builder no longer derives one for itself (it has no gateway to derive it against, and guessing
   * would answer the KIE question on a Comet task). Routing these through `quoteMediaRequest` makes
   * them exercise the actual composition rather than a convenience default.
   */
  const deliveryFor = (request: Parameters<typeof quoteMediaRequest>[0]) =>
    quoteMediaRequest({ ...request, options: { resolution: '2K', ...request.options } }, 'KIE').delivery;
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
    const request = { model: 'nano-banana-2', prompt: 'a fox', options: { resolution: '2K', aspectRatio: '1:1' } };
    const payload = buildProviderPayload('nano-banana-2', request, deliveryFor(request));

    // Unspecified + no transparency signal → jpg (a big photographic png is what froze the tab).
    expect(payload).toMatchObject({ resolution: '2K', aspect_ratio: '1:1', output_format: 'jpg' });
  });

  it('RENDERS a cut-out as jpg — the alpha comes from stage 2, and Recraft caps its input at 5MB', () => {
    /*
     * The instinct is to render transparency-needing art as png. That buys nothing (no image model on
     * KIE emits alpha) and actively breaks the pass that does: a 2K PNG measured 4-6MB against
     * Recraft's 5MB input limit, where the same image as jpg is ~2MB.
     */
    const request = { model: 'nano-banana-2', prompt: 'a team logo', options: {} };
    const payload = buildProviderPayload('nano-banana-2', request, deliveryFor(request));

    expect(payload).toMatchObject({ output_format: 'jpg' });
  });

  it('appends the flat-backdrop directive to a cut-out prompt, and only to a cut-out prompt', () => {
    const cutRequest = { model: 'nano-banana-2', prompt: 'a team logo', options: { transparent: true } };
    const plainRequest = { model: 'nano-banana-2', prompt: 'a photographic sunset', options: {} };
    const cut = buildProviderPayload('nano-banana-2', cutRequest, deliveryFor(cutRequest));
    const plain = buildProviderPayload('nano-banana-2', plainRequest, deliveryFor(plainRequest));

    expect(String(cut.prompt)).toContain('a team logo');
    expect(String(cut.prompt).toLowerCase()).toContain('checkerboard');
    expect(plain.prompt).toBe('a photographic sunset');
  });

  /**
   * Comet's three request shapes — composed EXACTLY as `startMediaTask` composes them (quote first,
   * then the payload from the quote's normalised options and its delivery decision). Building them
   * from a hand-made delivery would test a convenience path production does not use.
   */
  const cometPayloadFor = (request: Parameters<typeof quoteMediaRequest>[0]) => {
    const quote = quoteMediaRequest(request, 'Comet');

    return buildProviderPayload(quote.model, { ...request, options: quote.options }, quote.delivery, 'Comet');
  };

  it('maps aspectRatio to one of the two PROBED sizes', () => {
    /*
     * `gpt-image-1.5` is token-priced and its token count is a function of `(size, quality)`, so an
     * unprobed aspect has no price row. Anything else in this map would be a size we have never
     * measured a price for.
     */
    expect(cometPayloadFor({ model: 'gpt-image-1.5', prompt: 'a hero', options: {} })).toEqual({
      prompt: 'a hero',
      size: '1536x1024',
      quality: 'medium',
      output_format: 'jpeg',
    });

    expect(cometPayloadFor({ model: 'gpt-image-1.5', prompt: 'a tile', options: { aspectRatio: '1:1' } })).toEqual({
      prompt: 'a tile',
      size: '1024x1024',
      quality: 'medium',
      output_format: 'jpeg',
    });
  });

  it('STATES the output format, and it matches the extension the file will be given', () => {
    /*
     * 🔴 An unstated `output_format` is not a neutral omission — it is a silent extension/content
     * mismatch on the DEFAULT path. `deriveDestPath` names the file from `finalFormat`, which for an
     * ordinary photographic request is `jpg`, while `gpt-image-1.5` with no format asked returns
     * OpenAI's default PNG. The result: PNG bytes written behind a `.jpg` name on every opaque Comet
     * image, tripping the file proxy's `media-format-mismatch` monitor on normal traffic.
     *
     * `jpeg` on the wire, `jpg` in the filename — the API's spelling and ours differ, which is exactly
     * the kind of detail that makes this worth asserting as a PAIR rather than in two places.
     */
    const opaque = { model: 'gpt-image-1.5', prompt: 'a hero background', options: {} };
    const opaqueQuote = quoteMediaRequest(opaque, 'Comet');

    expect(cometPayloadFor(opaque)).toMatchObject({ output_format: 'jpeg' });
    expect(deriveDestPath('image', opaque, 'med_abc123_x', opaqueQuote.delivery)).toMatch(/\.jpg$/);

    // ...and a transparent render is png at BOTH ends, or the alpha is thrown away by the container.
    const alpha = { model: 'gpt-image-1.5', prompt: 'a team logo', options: { transparent: true } };
    const alphaQuote = quoteMediaRequest(alpha, 'Comet');

    expect(cometPayloadFor(alpha)).toMatchObject({ output_format: 'png' });
    expect(deriveDestPath('image', alpha, 'med_abc123_x', alphaQuote.delivery)).toMatch(/\.png$/);
  });

  it('asks for real alpha with `background`, and does NOT append the cut-out directive', () => {
    /*
     * 🔴 THE MOST DESTRUCTIVE THING IN THIS FILE IF IT REGRESSES. `cutoutRenderPrompt` commands a flat
     * OPAQUE backdrop for a background remover's benefit. Sent to a model that was about to hand us a
     * genuinely empty one it destroys exactly what was paid for — and the result looks like a
     * perfectly good render, which is why it needs a test rather than a comment.
     */
    const comet = cometPayloadFor({ model: 'gpt-image-1.5', prompt: 'a team logo', options: { transparent: true } });

    expect(comet).toMatchObject({ background: 'transparent', prompt: 'a team logo' });
    expect(String(comet.prompt).toLowerCase()).not.toContain('checkerboard');

    /*
     * CONTROL: the same intent on KIE still gets the directive. Without this pairing, the assertion
     * above passes for a pipeline that has stopped appending it anywhere — which would put a painted
     * checkerboard back into every KIE cut-out.
     */
    const kieRequest = {
      model: 'nano-banana-2',
      prompt: 'a team logo',
      options: { resolution: '2K', transparent: true },
    };
    const kie = buildProviderPayload('nano-banana-2', kieRequest, quoteMediaRequest(kieRequest, 'KIE').delivery);

    expect(String(kie.prompt).toLowerCase()).toContain('checkerboard');
  });

  it('sends the native Gemini shape — no size, no quality, no format', () => {
    // That route takes `contents` and nothing else; a stray `size` is a 400 on a route with no sizes.
    expect(cometPayloadFor({ model: 'gemini-3-pro-image', prompt: 'a neon skyline', options: {} })).toEqual({
      contents: [{ parts: [{ text: 'a neon skyline' }] }],
    });
  });

  it('stringifies the video duration — `seconds` is a STRING on this wire', () => {
    expect(cometPayloadFor({ model: 'veo3-fast', prompt: 'a fox', options: {}, durationSeconds: 4 })).toEqual({
      prompt: 'a fox',
      seconds: '4',
    });
  });

  it('refuses to build an image payload with no delivery decision', () => {
    /*
     * There is no fallback on purpose: a re-derivation here has no gateway to consult, so it would
     * silently answer the KIE question on a Comet task and the file would be billed as one thing,
     * written as another and referenced as a third.
     */
    expect(() =>
      buildProviderPayload('gpt-image-1.5', { model: 'gpt-image-1.5', prompt: 'x', options: {} }, undefined, 'Comet'),
    ).toThrow(/no delivery decision/);
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
  /*
   * Same reason as the wire shapes above: the path follows the delivery decision the QUOTE made, and
   * `deriveDestPath` no longer derives its own. `model: 'nano-banana-2'` because the quote has to be
   * able to price it — the extension rules under test are unchanged either way.
   */
  const pathFor = (request: {
    prompt: string;
    options: Record<string, string | number | boolean>;
    fileName?: string;
  }) => {
    // `resolution` only exists so the quote can PRICE the request; it changes no extension rule below.
    const priced = { model: 'nano-banana-2', ...request, options: { resolution: '2K', ...request.options } };

    return deriveDestPath('image', priced, 'med_abc123_x', quoteMediaRequest(priced, 'KIE').delivery);
  };

  it('derives a slugged path under public/assets/generated with a task-id suffix (photographic → jpg)', () => {
    const dest = pathFor({ prompt: 'A Neon City!! At Night', options: {} });

    /*
     * The extension MUST match the format the job was built with (`resolveImageOutputFormat`), or the
     * file is written as one type and referenced as another. Photographic prompt, unspecified → jpg.
     */
    expect(dest).toMatch(/^public\/assets\/generated\/a-neon-city-at-night-[a-z0-9_]+\.jpg$/);
  });

  it('honours jpg and video extensions, and lands a cut-out as png', () => {
    expect(pathFor({ prompt: 'sky', options: { outputFormat: 'jpg' } })).toMatch(/\.jpg$/);

    // Video needs no delivery decision at all — the extension is always mp4.
    expect(deriveDestPath('video', { model: 'm', prompt: 'sky', options: {} }, 'med_abc123_x')).toMatch(/\.mp4$/);

    /*
     * The path follows `finalFormat`, never what KIE rendered: a cut-out is rendered as jpg and
     * delivered as an RGBA png. Getting this backwards writes the file as one type and references it
     * as another.
     */
    expect(pathFor({ prompt: 'a brand logo', options: {} })).toMatch(/\.png$/);
    expect(pathFor({ prompt: 'sky', options: { transparent: true } })).toMatch(/\.png$/);
  });

  it('prefers a caller file name over the prompt slug (extension still follows the resolved format)', () => {
    /*
     * The file name drives the SLUG; the extension follows the format. "hero-bg" is photographic with no
     * explicit format, so it lands as jpg regardless of the .png the caller happened to type.
     */
    expect(pathFor({ prompt: 'whatever', options: {}, fileName: 'hero-bg.png' })).toMatch(
      /^public\/assets\/generated\/hero-bg-[a-z0-9_]+\.jpg$/,
    );
  });
});
