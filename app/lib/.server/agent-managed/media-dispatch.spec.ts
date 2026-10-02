/**
 * Media tools on the managed engine (managed-agents-engine T8): `generate_image` / `generate_video` /
 * `generate_sound` are answered by the SERVER through today's `createMediaTools` → `startMediaTask` —
 * debit, task, path — and the started task reaches the route's `media-task` part through `emit`.
 *
 * Real ledger (throwaway dir), real generation store (throwaway), real price list (baked, via an
 * in-memory object store); only the media PROVIDER is fake. ⚠️ `startMediaTask`'s ledger/store seams
 * fall back to the developer's `.data` when unset — every one is pinned here.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaTaskEvent } from '~/lib/.server/agent/media-tools';
import { newWorkspaceTurnState, WorkspaceOverlay } from '~/lib/.server/agent/workspace-tools';
import { FsLedger, setLedger } from '~/lib/.server/billing/ledger';
import { FsGenerationStore, setGenerationStore } from '~/lib/.server/billing/generations';
import { invalidateMarketPricesCache } from '~/lib/.server/billing/market-price-store';
import type { FileMap } from '~/lib/.server/llm/constants';
import { setMediaDispatcher } from '~/lib/.server/media/dispatch';
import type { CreateMediaTaskInput, MediaProvider, MediaProviderName } from '~/lib/.server/media/provider';
import { setObjectStore, type ObjectStore } from '~/lib/.server/storage';
import { createManagedDispatcher, MEDIA_TOOLS } from './dispatch';
import { MANAGED_CUSTOM_TOOL_NAMES } from './tools';

const USER = 'user-media';
const PROJECT = 'prj_media';

let tmp: string;
let ledger: FsLedger;
let store: ObjectStore;

function memoryStore(): ObjectStore {
  const objects = new Map<string, Uint8Array>();

  return {
    backend: 'filesystem',
    put: async (key, bytes) => {
      objects.set(key, bytes);
    },
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => {
      objects.delete(key);
    },
    list: async (prefix) =>
      [...objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, b]) => ({ key, size: b.byteLength })),
  };
}

beforeEach(async () => {
  vi.stubEnv('BILLING_ENFORCED', 'true');
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-media-'));
  ledger = new FsLedger(path.join(tmp, 'ledger'));
  setLedger(ledger);
  setGenerationStore(new FsGenerationStore(path.join(tmp, 'generations')));
  store = memoryStore();
  setObjectStore(store);
  invalidateMarketPricesCache();

  /* The real queue sleeps on real timers; a pass-through measures the tool, not the queue. */
  setMediaDispatcher((_label, create) => create());
});

afterEach(async () => {
  setLedger(undefined);
  setGenerationStore(undefined);
  setObjectStore(undefined);
  setMediaDispatcher(undefined);
  invalidateMarketPricesCache();
  vi.unstubAllEnvs();
  await fs.rm(tmp, { recursive: true, force: true });
});

const fund = (credits: number) => ledger.append({ userId: USER, delta: credits, reason: 'adjustment', note: 'spec' });
const balance = async () => (await ledger.list(USER))[0]?.balanceAfter ?? 0;
const reasons = async () => (await ledger.list(USER)).reverse().map((e) => [e.reason, e.delta]);

function fakeProvider(name: MediaProviderName, behaviour: 'ok' | 'refuse' = 'ok') {
  const created: CreateMediaTaskInput[] = [];
  const provider: MediaProvider = {
    name,
    create: async (input) => {
      created.push(input);

      if (behaviour === 'refuse') {
        throw new Error('upstream said no');
      }

      return `task_${created.length}`;
    },
    query: async () => ({ state: 'pending' }) as never,
    download: async () => new Response(''),
  };

  return { provider, created };
}

function dispatcherWith(media: { provider: MediaProvider } | null) {
  const tasks: MediaTaskEvent[] = [];
  const dispatcher = createManagedDispatcher({
    generationId: 'gen_media_spec',
    userId: USER,
    files: {} as FileMap,
    overlay: new WorkspaceOverlay({}),
    state: newWorkspaceTurnState(),
    emitWorkspace: () => undefined,
    emitPreview: () => undefined,
    emitTodos: () => undefined,
    media: media
      ? { userId: USER, projectId: PROJECT, provider: media.provider, objectStore: store, emit: (e) => tasks.push(e) }
      : null,
  });

  return { dispatcher, tasks };
}

const call = (name: string, input: Record<string, unknown>) => ({ id: `sevt_${name}`, name, input });
const textOf = (answer: { content: Array<{ type: string; text?: string }> } | null) =>
  answer?.content.map((b) => b.text ?? '').join('') ?? '';

describe('managed media tools — the server answers them (T8)', () => {
  it('every media tool the agent is defined with is one the dispatcher routes', () => {
    expect(MEDIA_TOOLS.every((name) => MANAGED_CUSTOM_TOOL_NAMES.includes(name))).toBe(true);
  });

  it('generate_image: debits BEFORE the provider, starts the task, emits media-task, returns the path', async () => {
    await fund(1000);

    const { provider, created } = fakeProvider('KIE');
    const { dispatcher, tasks } = dispatcherWith({ provider });
    const answer = await dispatcher.dispatch(call('generate_image', { prompt: 'a neon kart track hero' }));

    expect(answer?.isError).toBe(false);
    expect(created).toHaveLength(1);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ projectId: PROJECT, kind: 'image' });
    expect(tasks[0].destPath).toMatch(/^public\/assets\/generated\//);
    expect(textOf(answer)).toContain(tasks[0].destPath);

    /* One media debit, of exactly the quoted credits. */
    expect(await reasons()).toEqual([
      ['adjustment', 1000],
      ['media', -tasks[0].credits],
    ]);
    expect(await balance()).toBe(1000 - tasks[0].credits);
  });

  it('a provider that refuses the task REFUNDS the debit, and the agent is told (an error result)', async () => {
    await fund(1000);

    const { provider, created } = fakeProvider('KIE', 'refuse');
    const { dispatcher, tasks } = dispatcherWith({ provider });
    const answer = await dispatcher.dispatch(call('generate_image', { prompt: 'a logo' }));

    expect(created.length).toBeGreaterThan(0);
    expect(tasks).toHaveLength(0);
    expect(answer?.isError).toBe(true);
    expect(textOf(answer)).toMatch(/refused/i);

    const rows = await reasons();

    expect(rows.map(([reason]) => reason)).toEqual(['adjustment', 'media', 'refund']);
    expect(rows[1][1]).toBe(-(rows[2][1] as number));
    expect(await balance()).toBe(1000);
  });

  it('refused BEFORE spend: an unfunded user with billing enforced never reaches the provider', async () => {
    const { provider, created } = fakeProvider('KIE');
    const { dispatcher, tasks } = dispatcherWith({ provider });
    const answer = await dispatcher.dispatch(call('generate_image', { prompt: 'a hero' }));

    expect(created).toHaveLength(0);
    expect(tasks).toHaveLength(0);
    expect(answer?.isError).toBe(true);
    expect(textOf(answer)).toMatch(/not enough credits/i);
    expect(await reasons()).toEqual([]);
  });

  it('generate_sound on a gateway with NO audio (fal, until T6): "not available on FAL", no debit, no task', async () => {
    await fund(1000);

    const { provider, created } = fakeProvider('FAL');
    const { dispatcher, tasks } = dispatcherWith({ provider });
    const answer = await dispatcher.dispatch(call('generate_sound', { prompt: 'a coin pickup chime' }));

    expect(answer?.isError).toBe(true);
    expect(textOf(answer)).toContain('not available on FAL');
    expect(created).toHaveLength(0);
    expect(tasks).toHaveLength(0);
    expect(await reasons()).toEqual([['adjustment', 1000]]);
  });

  it('CONTROL: generate_sound on KIE (which serves audio) does debit and start a task', async () => {
    await fund(1000);

    const { provider, created } = fakeProvider('KIE');
    const { dispatcher, tasks } = dispatcherWith({ provider });
    const answer = await dispatcher.dispatch(call('generate_sound', { prompt: 'a coin pickup chime' }));

    expect(answer?.isError).toBe(false);
    expect(created).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: 'audio' });
  });

  it('no media provider configured: every media tool answers "not available", nothing is debited', async () => {
    await fund(1000);

    const { dispatcher } = dispatcherWith(null);

    for (const name of MEDIA_TOOLS) {
      const answer = await dispatcher.dispatch(call(name, { prompt: 'x' }));

      expect(answer?.isError, name).toBe(true);
      expect(textOf(answer), name).toContain('not available on this server');
    }

    expect(await reasons()).toEqual([['adjustment', 1000]]);
  });

  it('a missing prompt is a correctable error result, never a debit', async () => {
    await fund(1000);

    const { provider, created } = fakeProvider('KIE');
    const { dispatcher } = dispatcherWith({ provider });
    const answer = await dispatcher.dispatch(call('generate_image', {}));

    expect(answer?.isError).toBe(true);
    expect(created).toHaveLength(0);
    expect(await reasons()).toEqual([['adjustment', 1000]]);
  });
});
