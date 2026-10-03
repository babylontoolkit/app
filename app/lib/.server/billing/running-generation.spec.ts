/**
 * A durable `running` row BEFORE spend, and per-step usage checkpoints (`_specs/no-unbilled-usage_plan.md`
 * D2, T2).
 *
 * Until this, a `generations` row was written only at the END of a turn, so a process that died mid-stream
 * left nothing behind to bill. These pin the three properties the sweep (T3) relies on: the row exists
 * before the first provider call, each finished step leaves its cumulative usage on it, and the turn's own
 * settlement finishes THAT row exactly once — never a second row, never a second debit.
 *
 * Every store is pinned to a throwaway directory (the `.data` trap), and the billing env is stubbed (`env()`
 * falls back to `process.env`, and vitest loads `.env.local`).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settleGeneration } from './gate';
import { FsGenerationStore, setGenerationStore, type GenerationStore } from './generations';
import { DuplicateGenerationDebitError, FsLedger, setLedger } from './ledger';
import { createUsageCheckpointer, openRunningGeneration } from './running-generation';

const USER = 'user-running';
const MODEL = 'claude-sonnet-5';

let tmp: string;
let store: FsGenerationStore;
let ledger: FsLedger;

beforeEach(async () => {
  for (const key of ['BILLING_ENFORCED', 'CREDIT_UNIT_COST_USD', 'CREDIT_MARGIN', 'CREATION_FLAT_CREDITS']) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  vi.stubEnv('BILLING_ENFORCED', 'false');
  vi.stubEnv('CREDIT_UNIT_COST_USD', '0.01');
  vi.stubEnv('CREDIT_MARGIN', '4');

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'running-gen-'));
  store = new FsGenerationStore(path.join(tmp, 'generations'));
  ledger = new FsLedger(path.join(tmp, 'ledger'));
  setGenerationStore(store);
  setLedger(ledger);
  await ledger.append({ userId: USER, delta: 5000, reason: 'grant' });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  setGenerationStore(undefined);
  setLedger(undefined as never);
  await fs.rm(tmp, { recursive: true, force: true });
});

const files = async () => (await fs.readdir(path.join(tmp, 'generations'))).filter((f) => f.endsWith('.json'));

describe('openRunningGeneration — the row exists before the first provider call', () => {
  it('writes a running row naming the engine, chat, project and gateway', async () => {
    expect(
      await openRunningGeneration({
        id: 'gen_open_1',
        userId: USER,
        model: MODEL,
        provider: 'Anthropic',
        projectId: 'prj_1',
        chatId: 'chat_1',
        statusKind: 'edit',
        engine: 'legacy',
      }),
    ).toBe(true);

    const [row] = await store.listByIds(['gen_open_1']);

    expect(row).toMatchObject({
      status: 'running',
      engine: 'legacy',
      chatId: 'chat_1',
      projectId: 'prj_1',
      provider: 'Anthropic',
      statusKind: 'edit',
      promptTokens: 0,
      completionTokens: 0,
    });
    expect(row.checkpointAt).toEqual(expect.any(String));
  });

  it('never throws when the store does — the turn proceeds (end-of-turn settlement still anchors)', async () => {
    setGenerationStore({
      upsert: async () => {
        throw new Error('db down');
      },
    } as unknown as GenerationStore);

    await expect(
      openRunningGeneration({
        id: 'gen_open_2',
        userId: USER,
        model: MODEL,
        provider: 'Anthropic',
        engine: 'enhancer',
      }),
    ).resolves.toBe(false);
  });
});

describe('createUsageCheckpointer — each finished step leaves its cumulative usage on the row', () => {
  it('updates the running row after every step', async () => {
    await openRunningGeneration({
      id: 'gen_cp_1',
      userId: USER,
      model: MODEL,
      provider: 'Anthropic',
      engine: 'legacy',
    });

    const checkpointer = createUsageCheckpointer({ id: 'gen_cp_1' });

    checkpointer.checkpoint({
      promptTokens: 100,
      completionTokens: 50,
      cacheReadTokens: 1000,
      cacheCreationTokens: 200,
      totalTokens: 150,
    });
    await checkpointer.flush();
    expect((await store.listByIds(['gen_cp_1']))[0]).toMatchObject({
      status: 'running',
      promptTokens: 100,
      completionTokens: 50,
      cacheReadTokens: 1000,
      cacheCreationTokens: 200,
    });

    checkpointer.checkpoint({
      promptTokens: 160,
      completionTokens: 900,
      cacheReadTokens: 2000,
      cacheCreationTokens: 200,
      totalTokens: 1060,
    });
    await checkpointer.flush();
    expect((await store.listByIds(['gen_cp_1']))[0]).toMatchObject({ promptTokens: 160, completionTokens: 900 });
  });

  it('a checkpoint that lands AFTER settlement never reopens the row', async () => {
    await openRunningGeneration({
      id: 'gen_cp_2',
      userId: USER,
      model: MODEL,
      provider: 'Anthropic',
      engine: 'legacy',
    });

    const usage = {
      promptTokens: 10,
      completionTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 30,
    };

    await settleGeneration({ userId: USER, generationId: 'gen_cp_2', model: MODEL, provider: 'Anthropic', usage });

    const checkpointer = createUsageCheckpointer({ id: 'gen_cp_2' });
    checkpointer.checkpoint({ ...usage, completionTokens: 999 });
    await checkpointer.flush();

    expect((await store.listByIds(['gen_cp_2']))[0]).toMatchObject({ status: 'completed', completionTokens: 20 });
  });

  it('never throws when the store does', async () => {
    setGenerationStore({
      checkpoint: async () => {
        throw new Error('db down');
      },
    } as unknown as GenerationStore);

    const checkpointer = createUsageCheckpointer({ id: 'gen_cp_3' });
    checkpointer.checkpoint({
      promptTokens: 1,
      completionTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 2,
    });
    await expect(checkpointer.flush()).resolves.toBeUndefined();
  });
});

describe('settlement finishes the SAME row exactly once', () => {
  it('ends completed, one row, one debit', async () => {
    await openRunningGeneration({
      id: 'gen_once',
      userId: USER,
      model: MODEL,
      provider: 'Anthropic',
      engine: 'legacy',
    });

    const checkpointer = createUsageCheckpointer({ id: 'gen_once' });
    const usage = {
      promptTokens: 2000,
      completionTokens: 3000,
      cacheReadTokens: 40_000,
      cacheCreationTokens: 5000,
      totalTokens: 5000,
    };

    checkpointer.checkpoint(usage);
    await checkpointer.flush();

    const settlement = await settleGeneration({
      userId: USER,
      generationId: 'gen_once',
      model: MODEL,
      provider: 'Anthropic',
      usage,
    });

    expect(settlement?.creditsCharged).toBeGreaterThan(0);
    expect(await files()).toEqual(['gen_once.json']);

    const [row] = await store.listByIds(['gen_once']);
    expect(row).toMatchObject({ status: 'completed', engine: 'legacy', creditsCharged: settlement!.creditsCharged });

    const debits = (await ledger.list(USER)).filter((e) => e.generationId === 'gen_once');
    expect(debits).toHaveLength(1);
    expect(debits[0]).toMatchObject({ reason: 'generation', delta: -settlement!.creditsCharged });
  });
});

describe('a generation is debited at most once (verifier defect B, layer 2)', () => {
  it('the FS ledger refuses a second generation debit naming the same id, like migration 0029', async () => {
    await ledger.append({ userId: USER, delta: -10, reason: 'generation', generationId: 'gen_dup' });

    await expect(
      ledger.append({ userId: USER, delta: -10, reason: 'generation', generationId: 'gen_dup' }),
    ).rejects.toBeInstanceOf(DuplicateGenerationDebitError);

    /* CONTROL — a refund of it, and another generation, are not duplicates. */
    await ledger.append({ userId: USER, delta: 10, reason: 'refund', generationId: 'gen_dup' });
    await ledger.append({ userId: USER, delta: -10, reason: 'generation', generationId: 'gen_other' });
  });

  it('a duplicate settlement never throws, never debits twice, and reports nothing charged', async () => {
    const usage = {
      promptTokens: 1000,
      completionTokens: 1000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 2000,
    };

    const first = await settleGeneration({
      userId: USER,
      generationId: 'gen_twice',
      model: MODEL,
      provider: 'Anthropic',
      usage,
    });
    const second = await settleGeneration({
      userId: USER,
      generationId: 'gen_twice',
      model: MODEL,
      provider: 'Anthropic',
      usage,
    });

    expect(first?.creditsCharged).toBeGreaterThan(0);
    expect(second?.creditsCharged, 'already billed — nothing for a caller to refund').toBe(0);
    expect((await ledger.list(USER)).filter((e) => e.generationId === 'gen_twice')).toHaveLength(1);
  });
});

describe('flush is bounded (verifier slip 4)', () => {
  it('resolves after the timeout even when a checkpoint write never returns', async () => {
    setGenerationStore({ checkpoint: () => new Promise(() => undefined) } as unknown as GenerationStore);

    const checkpointer = createUsageCheckpointer({ id: 'gen_hang' });
    checkpointer.checkpoint({
      promptTokens: 1,
      completionTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 2,
    });

    const started = Date.now();
    await checkpointer.flush(50);

    expect(Date.now() - started).toBeLessThan(2000);
  });
});
