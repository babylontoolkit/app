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
import { parseSunoTaskState, parseTaskState } from './kie-client';
import { SOUND_MODELS } from '~/lib/media/provider-defaults';
import { createMediaTools } from '~/lib/.server/agent/media-tools';
import { getMediaTask, putMediaTask } from './store';
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

  /*
   * ⚠️ The same trap, FIFTH occurrence, and this one is self-inflicted: these two decide whether a
   * MUSIC request can resolve a callback URL, and a developer running the live music test has a real
   * tunnel in `.env.local`. Unstubbed, "music with no reachable callback is refused" passes on CI and
   * fails only for the person who set the feature up — which is precisely the shape the earlier four
   * took. `APP_URL` is listed because it is the FALLBACK half of the same decision; stubbing one and
   * not the other leaves the chain half-scrubbed, which is how the KIE_ENV list went wrong.
   */
  'MEDIA_CALLBACK_URL',
  'APP_URL',
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
 * COMET IS NO LONGER A MEDIA GATEWAY (owner, 2026-10-01: a security issue) — but its task records are
 * still in storage, stamped `Comet`, some of them pending and already debited.
 *
 * 🔴 Two properties, both silent when wrong: the task is NEVER sent anywhere (not to Comet, and not to
 * KIE as the unknown-name fallback, which would be asked about a task id it never issued), and the
 * user gets their credits back EXACTLY once — the ordinary refund latch, not a second mechanism.
 */
describe('a stored Comet task', () => {
  async function storedCometTask(objectStore: ObjectStore, credits = 24) {
    const id = 'med_comet_legacy';
    const now = new Date().toISOString();

    // The debit `startMediaTask` took when Comet was still a gateway.
    await ledger.append({ userId: USER, delta: -credits, reason: 'media', generationId: id });
    await putMediaTask(objectStore, {
      id,
      projectId: PROJECT,
      userId: USER,
      kind: 'image',
      provider: 'Comet',
      endpoint: 'comet-image',
      model: 'gpt-image-1.5',
      prompt: 'a hero',
      options: {},
      destPath: 'public/assets/generated/a-hero-comet.png',
      usd: 0.06,
      credits,
      status: 'pending',
      kieTaskId: 'comet-upstream-1',
      createdAt: now,
      updatedAt: now,
    });

    return id;
  }

  it('a stored Comet task fails and refunds exactly once, and nothing contacts Comet', async () => {
    await grant(100);

    const objectStore = memoryStore();
    const taskId = await storedCometTask(objectStore);
    expect(await ledger.balance(USER), 'the fixture must start debited').toBe(76);

    const resolved: MediaProviderName[] = [];
    const stand = new FakeProvider('KIE');
    const resolveProvider = (name: MediaProviderName) => {
      resolved.push(name);
      return stand;
    };

    const first = await pollMediaTask({ projectId: PROJECT, taskId, resolveProvider, objectStore });
    const second = await pollMediaTask({ projectId: PROJECT, taskId, resolveProvider, objectStore });

    expect(first).toMatchObject({
      status: 'failed',
      error: 'Comet is no longer a media gateway; this render was refunded.',
      refunded: true,
    });
    expect(second?.status).toBe('failed');

    // Nothing was contacted: no client resolved, no query, no create, no download.
    expect(resolved, 'a client was resolved for a Comet task').toEqual([]);
    expect(stand.queries).toBe(0);
    expect(stand.created).toEqual([]);
    expect(stand.downloaded).toEqual([]);

    // Back in full, by ONE refund row, after two polls.
    expect(await ledger.balance(USER)).toBe(100);
    expect((await ledger.list(USER)).filter((e) => e.reason === 'refund')).toHaveLength(1);
  });

  it('refunds exactly once when two polls race', async () => {
    await grant(100);

    const objectStore = memoryStore();
    const taskId = await storedCometTask(objectStore);
    const resolveProvider = () => new FakeProvider('KIE');

    await Promise.all([
      pollMediaTask({ projectId: PROJECT, taskId, resolveProvider, objectStore }),
      pollMediaTask({ projectId: PROJECT, taskId, resolveProvider, objectStore }),
    ]);

    expect(await ledger.balance(USER)).toBe(100);
    expect((await ledger.list(USER)).filter((e) => e.reason === 'refund')).toHaveLength(1);
  });

  it('CONTROL — a KIE task under the same harness IS queried and is not failed', async () => {
    // Without this, the test above passes for a poll that fails and refunds EVERY task unasked.
    await grant(100);

    const objectStore = memoryStore();
    const provider = new FakeProvider('KIE');
    const started = await startMediaTask(imageInput({ provider, objectStore }));

    const task = await pollMediaTask({
      projectId: PROJECT,
      taskId: started.taskId,
      resolveProvider: () => provider,
      objectStore,
    });

    expect(provider.queries).toBe(1);
    expect(task?.status).toBe('pending');
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
   * would answer the KIE question on a fal task). Routing these through `quoteMediaRequest` makes
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

  it('refuses to build an image payload with no delivery decision', () => {
    /*
     * There is no fallback on purpose: a re-derivation here has no gateway to consult, so it would
     * silently answer the KIE question on a fal task and the file would be billed as one thing,
     * written as another and referenced as a third.
     */
    expect(() =>
      buildProviderPayload(
        'fal-ai/nano-banana-2',
        { model: 'fal-ai/nano-banana-2', prompt: 'x', options: {} },
        undefined,
        'FAL',
      ),
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

/**
 * Sound (§4.16 `generate_sound`) — the audio kind end to end: quote, debit, wire shape, poll, refund.
 *
 * Audio is the first kind whose price is a RATE (speech, per 1,000 characters) and the first that
 * reaches a KIE route other than jobs/veo. Both are places a wrong answer is silent: a mis-routed
 * endpoint is unpollable forever, and a mis-scaled rate bills a one-line voice clip as a full
 * thousand characters.
 */
describe('sound', () => {
  function soundInput(overrides: Partial<Parameters<typeof startMediaTask>[0]> = {}) {
    return {
      model: SOUND_MODELS.effect,
      prompt: 'arcade coin pickup chime',
      options: {},
      userId: USER,
      projectId: PROJECT,
      provider: new FakeProvider(),
      objectStore: memoryStore(),
      ...overrides,
    };
  }

  describe('quoting', () => {
    it('prices a sound effect as audio, not video — $0.0125 → 5 credits', () => {
      const quote = quoteMediaRequest({ model: SOUND_MODELS.effect, prompt: 'coin chime', options: {} }, 'KIE');

      expect(quote).toMatchObject({ model: SOUND_MODELS.effect, kind: 'audio', usd: 0.0125, credits: 5 });
    });

    /*
     * The audio branch sits AHEAD of the `kind !== 'image'` video fallthrough. Without it a sound row
     * is priced correctly and labelled `video`, which writes MP3 bytes to an `.mp4` path.
     */
    it('CONTROL: a video model is still quoted as video', () => {
      expect(
        quoteMediaRequest(
          { model: 'kling-3.0/video', prompt: 'x', options: { mode: 'std', sound: false }, durationSeconds: 5 },
          'KIE',
        ).kind,
      ).toBe('video');
    });

    it('scales a speech quote with the length of the text it will speak', () => {
      const short = quoteMediaRequest({ model: SOUND_MODELS.speech, prompt: 'Go!', options: {} }, 'KIE');
      const long = quoteMediaRequest({ model: SOUND_MODELS.speech, prompt: 'x'.repeat(1000), options: {} }, 'KIE');

      expect(long.usd).toBeGreaterThan(short.usd);
      expect(long.usd).toBeCloseTo(0.06, 9); // 1,000 chars at $0.06/1k
      expect(long.credits).toBe(24);
    });
  });

  describe('starting', () => {
    beforeEach(() => vi.stubEnv('BILLING_ENFORCED', 'true'));

    it('debits once, creates on the suno-sounds route, and lands as .mp3', async () => {
      await grant(100);

      const provider = new FakeProvider();
      const started = await startMediaTask(soundInput({ provider }));

      expect(started.kind).toBe('audio');
      expect(started.credits).toBe(5);
      expect(started.destPath).toMatch(/^public\/assets\/generated\/.+\.mp3$/);

      expect(provider.created).toHaveLength(1);
      expect(provider.created[0].endpoint).toBe('suno-sounds');
      expect(provider.created[0].payload).toMatchObject({
        prompt: 'arcade coin pickup chime',

        // The Suno VERSION, not the priced model id — the wire wants one, the ledger the other.
        model: 'V5',
        soundLoop: false,
      });

      expect(await ledger.balance(USER)).toBe(95);
    });

    it('routes ElevenLabs speech to the jobs endpoint with the text as input', async () => {
      await grant(100);

      const provider = new FakeProvider();
      await startMediaTask(soundInput({ provider, model: SOUND_MODELS.speech, prompt: 'Lap record!' }));

      expect(provider.created[0].endpoint).toBe('jobs');
      expect(provider.created[0].payload).toMatchObject({ text: 'Lap record!' });
    });

    it('sends a callback URL and instrumental:true on a music request', async () => {
      vi.stubEnv('MEDIA_CALLBACK_URL', 'https://example.test/api/media/kie-callback');
      await grant(100);

      const provider = new FakeProvider();
      await startMediaTask(soundInput({ provider, model: SOUND_MODELS.music, prompt: 'driving synthwave' }));

      expect(provider.created[0].endpoint).toBe('suno-music');
      expect(provider.created[0].payload).toMatchObject({
        callBackUrl: 'https://example.test/api/media/kie-callback',
        instrumental: true,
        customMode: false,
      });
    });

    /*
     * 🔴 REFUSED BEFORE THE DEBIT. KIE rejects a music create with no callBackUrl, so a request we
     * cannot address is one we must not pay for — zero ledger rows is the assertion that matters.
     */
    it('refuses music with no resolvable callback and spends nothing', async () => {
      await grant(100);

      await expect(startMediaTask(soundInput({ model: SOUND_MODELS.music, prompt: 'synthwave' }))).rejects.toThrow(
        /callback/i,
      );
      expect(await ledger.balance(USER)).toBe(100);
    });

    /*
     * A localhost URL PARSES as valid http, so a parse-only check would accept it and then debit for a
     * request KIE can never deliver a callback to. Refusing is free; charging is not.
     */
    it('refuses a loopback or private callback address', async () => {
      await grant(100);

      for (const url of ['http://localhost:5173/api/media/kie-callback', 'http://192.168.1.10/cb']) {
        vi.stubEnv('MEDIA_CALLBACK_URL', url);
        await expect(startMediaTask(soundInput({ model: SOUND_MODELS.music, prompt: 'synthwave' }))).rejects.toThrow(
          /callback/i,
        );
      }

      expect(await ledger.balance(USER)).toBe(100);
    });

    it('effects and speech never carry a callback, even when one is configured', async () => {
      vi.stubEnv('MEDIA_CALLBACK_URL', 'https://example.test/api/media/kie-callback');
      await grant(100);

      const provider = new FakeProvider();
      await startMediaTask(soundInput({ provider }));
      await startMediaTask(soundInput({ provider, model: SOUND_MODELS.speech, prompt: 'Go' }));

      expect(provider.created[0].payload).not.toHaveProperty('callBackUrl');
      expect(provider.created[1].payload).not.toHaveProperty('callBackUrl');
    });
  });

  describe('Suno task state', () => {
    it('reads the audio URL out of response.sunoData on SUCCESS', () => {
      expect(
        parseSunoTaskState({ status: 'SUCCESS', response: { sunoData: [{ audio_url: 'https://cdn.test/a.mp3' }] } }),
      ).toEqual({ state: 'succeeded', resultUrl: 'https://cdn.test/a.mp3' });
    });

    it('tolerates the older camelCase audioUrl', () => {
      expect(
        parseSunoTaskState({ status: 'SUCCESS', response: { sunoData: [{ audioUrl: 'https://cdn.test/b.mp3' }] } }),
      ).toMatchObject({ state: 'succeeded', resultUrl: 'https://cdn.test/b.mp3' });
    });

    /*
     * 🔴 These two READ like success and are not. Treating them as terminal would refund a render that
     * is still going — the user's money back for art they are about to receive, billed to us anyway.
     */
    it('treats TEXT_SUCCESS and FIRST_SUCCESS as still pending', () => {
      for (const status of ['PENDING', 'TEXT_SUCCESS', 'FIRST_SUCCESS']) {
        expect(parseSunoTaskState({ status }), status).toEqual({ state: 'pending' });
      }
    });

    it('fails with the provider message on any other state', () => {
      expect(parseSunoTaskState({ status: 'CREATE_TASK_FAILED', failMsg: 'prompt rejected' })).toEqual({
        state: 'failed',
        error: 'prompt rejected',
      });
    });

    it('a SUCCESS with no track is a failure, not a success with no bytes', () => {
      expect(parseSunoTaskState({ status: 'SUCCESS', response: { sunoData: [] } }).state).toBe('failed');
    });

    /* CONTROL: the jobs parser is unchanged and still cannot read Suno's shape — hence two parsers. */
    it('CONTROL: the jobs parser does not understand an uppercase SUCCESS', () => {
      expect(parseTaskState({ status: 'SUCCESS', response: { sunoData: [{ audio_url: 'x' }] } }).state).toBe('pending');
    });

    it('reads ElevenLabs speech results from resultJson.resultUrls', () => {
      expect(
        parseTaskState({ state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://cdn.test/v.mp3'] }) }),
      ).toEqual({ state: 'succeeded', resultUrl: 'https://cdn.test/v.mp3' });
    });
  });

  describe('failure', () => {
    beforeEach(() => vi.stubEnv('BILLING_ENFORCED', 'true'));

    it('refunds a failed sound exactly once', async () => {
      await grant(100);

      const provider = new FakeProvider();
      const objectStore = memoryStore();
      const started = await startMediaTask(soundInput({ provider, objectStore }));
      expect(await ledger.balance(USER)).toBe(95);

      provider.state = { state: 'failed', error: 'Suno refused the prompt' };

      const poll = () =>
        pollMediaTask({ projectId: PROJECT, taskId: started.taskId, resolveProvider: () => provider, objectStore });
      await poll();
      await poll();

      expect(await ledger.balance(USER)).toBe(100);
      expect((await getMediaTask(objectStore, PROJECT, started.taskId))?.refunded).toBe(true);
    });
  });
});

/**
 * fal.ai (`_specs/media-gateways_plan.md` T3 + T4) — the same money rules on the third gateway.
 *
 * Driven through a `FakeProvider` named `'FAL'`, so what is under test is the SERVICE: that a fal
 * render is priced from fal's OWN list, debited once before the provider is called, created on
 * `fal-queue`, polled by the gateway stamped on the record, and refunded exactly once on failure — and
 * that a transparent fal image is ONE task, ONE debit, TWO stages, with Bria as stage 2.
 *
 * Prices are fal's baked list: Nano Banana 2 at 2K is $0.12 → 48 credits; plus Bria's $0.018 is
 * $0.138 → 56 credits (`ceil(0.138 / 0.01 * 4)`).
 */
describe('fal.ai — images and video (T3)', () => {
  beforeEach(() => vi.stubEnv('BILLING_ENFORCED', 'true'));

  function falImage(provider: FakeProvider, objectStore: ObjectStore, options: Record<string, string | boolean> = {}) {
    return imageInput({
      model: 'fal-ai/nano-banana-2',
      options: { resolution: '2K', aspectRatio: '16:9', ...options },
      provider,
      objectStore,
    });
  }

  it('quotes, debits and creates a fal image, then delivers it', async () => {
    expect(
      quoteMediaRequest({ model: 'fal-ai/nano-banana-2', prompt: 'x', options: { resolution: '2K' } }, 'FAL'),
    ).toMatchObject({ model: 'fal-ai/nano-banana-2', kind: 'image', usd: 0.12, credits: 48 });

    await grant(100);

    const provider = new FakeProvider('FAL');
    const objectStore = memoryStore();
    const started = await startMediaTask(falImage(provider, objectStore));

    expect(started).toMatchObject({ credits: 48, model: 'fal-ai/nano-banana-2', kind: 'image' });
    expect(await ledger.balance(USER)).toBe(52);
    expect(started.destPath).toMatch(/\.jpg$/);

    expect(provider.created).toHaveLength(1);
    expect(provider.created[0]).toMatchObject({ endpoint: 'fal-queue', model: 'fal-ai/nano-banana-2' });

    // The documented Nano Banana input — and the format AGREES with the `.jpg` the file is given.
    expect(provider.created[0].payload).toEqual({
      prompt: 'a neon city skyline',
      num_images: 1,
      aspect_ratio: '16:9',
      resolution: '2K',
      output_format: 'jpeg',
    });
    expect(provider.created[0].payload).not.toHaveProperty('sync_mode');

    expect(await getMediaTask(objectStore, PROJECT, started.taskId)).toMatchObject({
      provider: 'FAL',
      endpoint: 'fal-queue',
    });

    provider.state = { state: 'succeeded', resultUrl: 'https://v3.fal.media/files/hero.jpg' };

    const done = await pollMediaTask({
      projectId: PROJECT,
      taskId: started.taskId,
      resolveProvider: () => provider,
      objectStore,
    });

    expect(done).toMatchObject({ status: 'succeeded', resultUrl: 'https://v3.fal.media/files/hero.jpg' });
    expect(provider.created, 'an opaque image is single-stage').toHaveLength(1);
    expect(await ledger.balance(USER), 'a delivered render keeps its charge').toBe(52);
  });

  it('prices against FAL rows, never KIE ones (the lists are separate)', () => {
    // KIE prices `nano-banana-2`; fal does not — and vice versa. Each refusal names the gateway's own list.
    expect(() => quoteMediaRequest({ model: 'nano-banana-2', prompt: 'x', options: {} }, 'FAL')).toThrow(
      /not in the Marketplace/,
    );
    expect(() => quoteMediaRequest({ model: 'fal-ai/nano-banana-2', prompt: 'x', options: {} }, 'KIE')).toThrow(
      /not in the Marketplace/,
    );
  });

  it('generate_video with no model on FAL uses kling, never veo', async () => {
    await grant(10_000);

    const provider = new FakeProvider('FAL');
    const tools = createMediaTools({
      userId: USER,
      projectId: PROJECT,
      provider,
      objectStore: memoryStore(),
      emit: () => undefined,
    });

    const generate = (tools as unknown as Record<string, { execute: (a: unknown, o: unknown) => Promise<string> }>)
      .generate_video;
    const result = await generate.execute({ prompt: 'a kart drifts' }, { toolCallId: 'c1', messages: [] });

    expect(result).toMatch(/^Started/);
    expect(provider.created).toHaveLength(1);
    expect(provider.created[0].model).toBe('fal-ai/kling-video/v3/standard/text-to-video');
    expect(provider.created[0].model).not.toMatch(/veo/);

    /*
     * Kling's duration is a STRING on fal's wire, and audio is STATED false — fal defaults it to true,
     * which would render (and bill fal for) audio the user was not charged for.
     */
    expect(provider.created[0].payload).toEqual({
      prompt: 'a kart drifts',
      aspect_ratio: '16:9',
      duration: '5',
      generate_audio: false,
    });

    // $0.084/s x 5s = $0.42 → 168 credits: the audio-OFF row, matching the payload.
    expect(await ledger.balance(USER)).toBe(10_000 - 168);
  });

  it('CONTROL — a Veo id named on generate_video is refused on FAL too, with nothing spent', async () => {
    await grant(10_000);

    const provider = new FakeProvider('FAL');
    const tools = createMediaTools({
      userId: USER,
      projectId: PROJECT,
      provider,
      objectStore: memoryStore(),
      emit: () => undefined,
    });

    const generate = (tools as unknown as Record<string, { execute: (a: unknown, o: unknown) => Promise<string> }>)
      .generate_video;
    const result = await generate.execute(
      { prompt: 'a kart drifts', model: 'fal-ai/veo3/fast' },
      { toolCallId: 'c2', messages: [] },
    );

    expect(result).toMatch(/Google Veo model/);
    expect(provider.created).toEqual([]);
    expect(await ledger.balance(USER)).toBe(10_000);
  });

  it('prices audio ON from the audio-on row, and sends exactly that', async () => {
    await grant(10_000);

    const provider = new FakeProvider('FAL');
    await startMediaTask(
      imageInput({
        provider,
        model: 'fal-ai/veo3/fast',
        prompt: 'rain on neon',
        options: { sound: true, resolution: '1080p' },
        durationSeconds: 6,
      }),
    );

    expect(provider.created[0].payload).toEqual({
      prompt: 'rain on neon',
      aspect_ratio: '16:9',
      duration: '6s',
      generate_audio: true,
      resolution: '1080p',
    });

    // $0.15/s x 6s = $0.90 → 360 credits.
    expect(await ledger.balance(USER)).toBe(10_000 - 360);
  });

  it('sends Grok an INTEGER duration and the resolution it was priced at', async () => {
    await grant(10_000);

    const provider = new FakeProvider('FAL');
    await startMediaTask(
      imageInput({
        provider,
        model: 'xai/grok-imagine-video/text-to-video',
        prompt: 'a kart',
        options: { sound: false },
        durationSeconds: 5,
      }),
    );

    expect(provider.created[0].payload).toEqual({
      prompt: 'a kart',
      aspect_ratio: '16:9',
      duration: 5,
      resolution: '720p',
    });

    // Unstated resolution is fal's default 720p — $0.07/s x 5s = $0.35 → 140 credits.
    expect(await ledger.balance(USER)).toBe(10_000 - 140);
  });

  it('refuses a clip length the family cannot render exactly, with ZERO ledger rows', async () => {
    await grant(10_000);

    const provider = new FakeProvider('FAL');
    const before = (await ledger.list(USER)).length;

    await expect(
      startMediaTask(imageInput({ provider, model: 'fal-ai/veo3/fast', prompt: 'x', options: {}, durationSeconds: 5 })),
    ).rejects.toThrow(/4, 6, 8 seconds only/);

    expect(provider.created).toEqual([]);
    expect((await ledger.list(USER)).length).toBe(before);
  });

  it('sends Seedream an explicit image_size at or above its pixel floor, and names the file .png', async () => {
    await grant(100);

    const provider = new FakeProvider('FAL');
    const started = await startMediaTask(
      imageInput({
        provider,
        model: 'fal-ai/bytedance/seedream/v4.5/text-to-image',
        options: { aspectRatio: '16:9' },
      }),
    );

    expect(provider.created[0].payload).toEqual({
      prompt: 'a neon city skyline',
      num_images: 1,
      image_size: { width: 2560, height: 1440 },
    });

    // Seedream takes no output_format and renders PNG — the file must be named for those bytes.
    expect(started.destPath).toMatch(/\.png$/);
  });

  it('a failed fal render refunds exactly once', async () => {
    await grant(100);

    const provider = new FakeProvider('FAL');
    const objectStore = memoryStore();
    const started = await startMediaTask(falImage(provider, objectStore));

    expect(await ledger.balance(USER)).toBe(52);

    provider.state = { state: 'failed', error: 'fal: Content policy violation (content_policy)' };

    let release!: () => void;
    provider.gate = new Promise((resolve) => (release = resolve));

    const polls = Promise.all([
      pollMediaTask({ projectId: PROJECT, taskId: started.taskId, resolveProvider: () => provider, objectStore }),
      pollMediaTask({ projectId: PROJECT, taskId: started.taskId, resolveProvider: () => provider, objectStore }),
    ]);

    release();
    await polls;
    await pollMediaTask({ projectId: PROJECT, taskId: started.taskId, resolveProvider: () => provider, objectStore });

    expect(await ledger.balance(USER), 'refunded ONCE').toBe(100);
    expect((await ledger.list(USER)).filter((e) => e.reason === 'refund')).toHaveLength(1);
  });

  it('refunds at once when fal refuses the submit (the exhausted-balance 403)', async () => {
    await grant(100);

    const provider = new FakeProvider('FAL');
    provider.createError = new Error('fal refused the request (HTTP 403): User is locked. Reason: Exhausted balance.');

    await expect(startMediaTask(falImage(provider, memoryStore()))).rejects.toThrow(/Exhausted balance/);
    expect(await ledger.balance(USER)).toBe(100);
  });
});

describe('fal.ai — transparent images, the cut-out pass per gateway (T4)', () => {
  beforeEach(() => vi.stubEnv('BILLING_ENFORCED', 'true'));

  const RENDER_URL = 'https://v3.fal.media/files/render.jpg';
  const CUTOUT_URL = 'https://v3.fal.media/files/cutout.png';

  async function startTransparent(provider: FakeProvider, objectStore: ObjectStore) {
    await grant(100);

    return startMediaTask(
      imageInput({
        model: 'fal-ai/nano-banana-2',
        provider,
        objectStore,
        prompt: 'a wordmark',
        options: { resolution: '2K', transparent: true },
      }),
    );
  }

  it('a transparent fal image quotes render + cut-out together, debits once, chains bria on the poll and delivers the cut-out', async () => {
    const quote = quoteMediaRequest(
      { model: 'fal-ai/nano-banana-2', prompt: 'a wordmark', options: { resolution: '2K', transparent: true } },
      'FAL',
    );

    expect(quote).toMatchObject({ credits: 56, cutoutUsd: 0.018 });
    expect(quote.usd).toBeCloseTo(0.138, 10);
    expect(quote.delivery).toMatchObject({ cutout: true, renderFormat: 'jpg', finalFormat: 'png' });

    const provider = new FakeProvider('FAL');
    const objectStore = memoryStore();
    const started = await startTransparent(provider, objectStore);

    expect(started.credits).toBe(56);
    expect(started.destPath).toMatch(/\.png$/);
    expect(
      (await ledger.list(USER)).filter((e) => e.reason === 'media'),
      'ONE debit',
    ).toHaveLength(1);
    expect(await ledger.balance(USER)).toBe(44);

    // Stage 1 renders jpeg with the flat-backdrop directive — the alpha comes from stage 2.
    expect(provider.created[0].payload).toMatchObject({ output_format: 'jpeg' });
    expect(String(provider.created[0].payload.prompt)).not.toBe('a wordmark');
    expect(String(provider.created[0].payload.prompt)).toContain('a wordmark');

    provider.state = { state: 'succeeded', resultUrl: RENDER_URL };

    const mid = await pollMediaTask({
      projectId: PROJECT,
      taskId: started.taskId,
      resolveProvider: () => provider,
      objectStore,
    });

    expect(mid).toMatchObject({ status: 'pending', stage: 'cutout', renderUrl: RENDER_URL });
    expect(mid?.resultUrl, 'the opaque render is never the deliverable').toBeUndefined();

    expect(provider.created[1]).toEqual({
      endpoint: 'fal-queue',
      model: 'fal-ai/bria/background/remove',
      payload: { image_url: RENDER_URL },
    });

    provider.state = { state: 'succeeded', resultUrl: CUTOUT_URL };

    const done = await pollMediaTask({
      projectId: PROJECT,
      taskId: started.taskId,
      resolveProvider: () => provider,
      objectStore,
    });

    expect(done).toMatchObject({ status: 'succeeded', resultUrl: CUTOUT_URL });
    expect(await ledger.balance(USER)).toBe(44);
  });

  it('a fal cut-out that cannot start fails and refunds in full', async () => {
    const provider = new FakeProvider('FAL');
    const objectStore = memoryStore();
    const started = await startTransparent(provider, objectStore);

    provider.state = { state: 'succeeded', resultUrl: RENDER_URL };
    provider.createError = new Error('fal refused the request (HTTP 503): bria unavailable');

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
  });

  it('refuses the fal cut-out as a primary model before any debit', () => {
    expect(() =>
      quoteMediaRequest({ model: 'fal-ai/bria/background/remove', prompt: 'x', options: {} }, 'FAL'),
    ).toThrow(/automatic cut-out pass/);
  });

  it("KIE's cut-out payload is unchanged", async () => {
    // CONTROL: the per-gateway table must leave KIE's stage 2 byte-identical — `{ image }` on `jobs`.
    await grant(100);

    const provider = new FakeProvider('KIE');
    const objectStore = memoryStore();
    const started = await startMediaTask(
      imageInput({ provider, objectStore, prompt: 'a wordmark', options: { resolution: '2K', transparent: true } }),
    );

    provider.state = { state: 'succeeded', resultUrl: 'https://cdn.kie.ai/render.jpg' };
    await pollMediaTask({ projectId: PROJECT, taskId: started.taskId, resolveProvider: () => provider, objectStore });

    expect(provider.created[1]).toEqual({
      endpoint: 'jobs',
      model: 'recraft/remove-background',
      payload: { image: 'https://cdn.kie.ai/render.jpg' },
    });
  });
});
