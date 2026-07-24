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
const MONEY_ENV = ['BILLING_ENFORCED', 'CREDIT_UNIT_COST_USD', 'CREDIT_MARGIN'] as const;

beforeEach(async () => {
  for (const key of MONEY_ENV) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  invalidateMarketPricesCache();
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

  it('keeps png for transparency-needing art and honours an explicit choice', () => {
    // A logo prompt with no explicit format falls back to png (alpha safety).
    expect(
      buildProviderPayload('nano-banana-2', { model: 'nano-banana-2', prompt: 'a team logo', options: {} }),
    ).toMatchObject({ output_format: 'png' });

    // An explicit choice always wins, even for photographic art.
    expect(
      buildProviderPayload('nano-banana-2', {
        model: 'nano-banana-2',
        prompt: 'a photographic sunset',
        options: { outputFormat: 'png' },
      }),
    ).toMatchObject({ output_format: 'png' });
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

  it('honours jpg and video extensions, and png for transparency art', () => {
    expect(
      deriveDestPath('image', { model: 'm', prompt: 'sky', options: { outputFormat: 'jpg' } }, 'med_abc123_x'),
    ).toMatch(/\.jpg$/);
    expect(deriveDestPath('video', { model: 'm', prompt: 'sky', options: {} }, 'med_abc123_x')).toMatch(/\.mp4$/);

    // A logo needs alpha, so an unspecified format resolves to png and the path agrees.
    expect(deriveDestPath('image', { model: 'm', prompt: 'a brand logo', options: {} }, 'med_abc123_x')).toMatch(
      /\.png$/,
    );
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
