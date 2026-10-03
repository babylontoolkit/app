/**
 * The billing sweep (`_specs/no-unbilled-usage_plan.md` D3, T3) — what bills the usage a dead process, a
 * closed tab nobody reopened, or a lost in-memory timer left behind.
 *
 * Everything real except Anthropic (the scripted fake session): the generation store, the ledger, the chat
 * index, the project store and the billing formula, each pinned to a throwaway directory (the `.data` trap),
 * and every billing variable stubbed (`env()` falls back to `process.env`; vitest loads `.env.local`).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setManagedClientForTests } from '~/lib/.server/agent-managed/config';
import { createFakeManagedClient, type FakeClient } from '~/lib/.server/agent-managed/fake-session.testkit';
import {
  getManagedOrphanStore,
  setManagedOrphanStore,
  FsManagedOrphanStore,
} from '~/lib/.server/agent-managed/orphans';
import { FsChatIndex, getChatIndex, setChatIndex } from '~/lib/.server/projects/chat-index';
import { FsProjectStore, setProjectStore } from '~/lib/.server/projects/store';
import { FsGenerationStore, setGenerationStore } from './generations';
import { settleGeneration } from './gate';
import { settleBeforeDelete } from '~/lib/.server/agent-managed/delete-settle';
import { resetInFlightForTests, trackGeneration, trackManagedTurn } from './in-flight';
import { FsLedger, setLedger } from './ledger';
import { createUsageCheckpointer, openRunningGeneration } from './running-generation';
import { runBillingSweep } from './sweep';

const USER = '33333333-3333-4333-8333-333333333333';
const MODEL = 'claude-sonnet-5';
const MINUTE = 60_000;

let tmp: string;
let store: FsGenerationStore;
let ledger: FsLedger;
let fake: FakeClient;
let projectId: string;

beforeEach(async () => {
  for (const key of ['BILLING_ENFORCED', 'CREDIT_UNIT_COST_USD', 'CREDIT_MARGIN', 'CREATION_FLAT_CREDITS']) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  vi.stubEnv('BILLING_ENFORCED', 'false');
  vi.stubEnv('CREDIT_UNIT_COST_USD', '0.01');
  vi.stubEnv('CREDIT_MARGIN', '4');
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-real');
  vi.stubEnv('LLM_PROVIDER', 'Anthropic');
  vi.stubEnv('LLM_MODEL', MODEL);
  vi.stubEnv('AGENT_ENGINE', 'managed');
  vi.stubEnv('MANAGED_SESSION_HOUR_USD', '0');
  vi.stubEnv('BILLING_SWEEP_STALE_MS', String(15 * MINUTE));

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-sweep-'));
  store = new FsGenerationStore(path.join(tmp, 'generations'));
  ledger = new FsLedger(path.join(tmp, 'ledger'));
  setGenerationStore(store);
  setLedger(ledger);
  setChatIndex(new FsChatIndex(path.join(tmp, 'chats')));

  const projects = new FsProjectStore(path.join(tmp, 'projects'));
  setProjectStore(projects);
  projectId = (await projects.create({ userId: USER, name: 'Game', templateId: 'blank' } as never)).id;

  setManagedOrphanStore(new FsManagedOrphanStore(path.join(tmp, 'orphans')));
  await ledger.append({ userId: USER, delta: 10_000, reason: 'grant' });

  fake = createFakeManagedClient();
  setManagedClientForTests(fake.client);
  resetInFlightForTests();
});

afterEach(async () => {
  setManagedClientForTests(undefined);
  setGenerationStore(undefined);
  setLedger(undefined);
  setChatIndex(undefined);
  setProjectStore(undefined);
  setManagedOrphanStore(undefined);
  resetInFlightForTests();
  vi.unstubAllEnvs();
  await fs.rm(tmp, { recursive: true, force: true });
});

const later = (minutes: number) => Date.now() + minutes * MINUTE;
const debits = async () => (await ledger.list(USER)).filter((e) => e.reason === 'generation');
const refunds = async () => (await ledger.list(USER)).filter((e) => e.reason === 'refund');
const row = async (id: string) => (await store.listByIds([id]))[0];

const USAGE = {
  promptTokens: 3000,
  completionTokens: 4000,
  cacheReadTokens: 50_000,
  cacheCreationTokens: 8000,
  totalTokens: 7000,
};

async function staleLegacyRow(id: string, usage: typeof USAGE | null = USAGE) {
  await openRunningGeneration({
    id,
    userId: USER,
    model: MODEL,
    provider: 'Anthropic',
    engine: 'legacy',
    projectId,
    chatId: 'c1',
  });

  if (usage) {
    const checkpointer = createUsageCheckpointer({ id });
    checkpointer.checkpoint(usage);
    await checkpointer.flush();
  }
}

/** A chat bound to a fake session that has cost `requests` model requests. */
async function managedChat(requests = 1, status: 'idle' | 'running' = 'idle') {
  const chatId = randomUUID();
  const sessionId = `sesn_${chatId.slice(0, 8)}`;
  const session = fake.seed(
    sessionId,
    Array.from({ length: requests }, () => ({
      type: 'span.model_request_end',
      model_usage: {
        input_tokens: 1200,
        output_tokens: 900,
        cache_read_input_tokens: 40_000,
        cache_creation_input_tokens: 6000,
      },
    })),
  );

  session.status = status;
  await getChatIndex().claimManagedSession({ id: chatId, projectId, sessionId, now: new Date().toISOString() });

  return { chatId, sessionId, session };
}

describe('(a) stale running legacy / enhancer rows', () => {
  it('bills a stale row from its last checkpoint, marks it interrupted, and never refunds', async () => {
    await staleLegacyRow('gen_dead_1');

    await runBillingSweep(undefined, { now: later(16) });

    const charged = await debits();
    expect(charged).toHaveLength(1);
    expect(charged[0].generationId).toBe('gen_dead_1');
    expect(charged[0].delta).toBeLessThan(0);
    expect(await refunds()).toEqual([]);
    expect(await row('gen_dead_1')).toMatchObject({
      status: 'interrupted',
      completionTokens: USAGE.completionTokens,
      creditsCharged: -charged[0].delta,
    });
  });

  it('a stale row with zero usage is marked interrupted and writes no ledger row', async () => {
    await staleLegacyRow('gen_dead_zero', null);

    await runBillingSweep(undefined, { now: later(16) });

    expect(await debits()).toEqual([]);
    expect((await row('gen_dead_zero')).status).toBe('interrupted');
  });

  it('leaves a row that is not yet stale alone', async () => {
    await staleLegacyRow('gen_fresh');

    await runBillingSweep(undefined, { now: later(5) });

    expect(await debits()).toEqual([]);
    expect((await row('gen_fresh')).status).toBe('running');
  });

  it('CONTROL — a stale row whose turn is still in flight in this process is skipped', async () => {
    await staleLegacyRow('gen_live');

    const release = trackGeneration('gen_live');

    await runBillingSweep(undefined, { now: later(16) });
    expect(await debits()).toEqual([]);
    expect((await row('gen_live')).status).toBe('running');

    release();
    await runBillingSweep(undefined, { now: later(16) });
    expect(await debits()).toHaveLength(1);
  });

  it('a second sweep charges nothing more', async () => {
    await staleLegacyRow('gen_twice');

    await runBillingSweep(undefined, { now: later(16) });
    await runBillingSweep(undefined, { now: later(32) });

    expect(await debits()).toHaveLength(1);
  });

  it('never touches a media row (debited up front, no engine)', async () => {
    await store.upsert({ id: 'med_1', userId: USER, model: 'nano-banana-2', status: 'running', creditsCharged: 10 });

    await runBillingSweep(undefined, { now: later(60 * 24) });

    expect((await row('med_1')).status).toBe('running');
    expect(await debits()).toEqual([]);
  });
});

describe('(b) managed chats', () => {
  it('bills a chat whose session cost is above its cursor and has no turn in flight — once', async () => {
    const { chatId } = await managedChat(2);

    await runBillingSweep(undefined, { now: later(1) });

    const first = await debits();
    expect(first).toHaveLength(1);
    expect(first[0].generationId).toMatch(new RegExp(`^${chatId}_sweep_`));

    await runBillingSweep(undefined, { now: later(20) });
    expect(await debits(), 'the cursor makes a second sweep charge nothing').toHaveLength(1);
  });

  it('CONTROL — a chat with a managed turn in flight in this process is skipped', async () => {
    const { chatId } = await managedChat(1);
    const release = trackManagedTurn(chatId);

    await runBillingSweep(undefined, { now: later(1) });
    expect(await debits()).toEqual([]);

    release();
    await runBillingSweep(undefined, { now: later(2) });
    expect(await debits()).toHaveLength(1);
  });

  it('skips a session that is still running (it settles when it stops)', async () => {
    await managedChat(1, 'running');

    await runBillingSweep(undefined, { now: later(1) });

    expect(await debits()).toEqual([]);
  });

  it('a throwing session read never throws out of the sweep, and other chats still settle', async () => {
    const broken = await managedChat(1);
    await managedChat(1);

    const retrieve = fake.client.beta.sessions.retrieve.bind(fake.client.beta.sessions);

    (fake.client.beta.sessions as unknown as { retrieve: (id: string) => Promise<unknown> }).retrieve = async (
      id: string,
    ) => {
      if (id === broken.sessionId) {
        throw new Error('anthropic is down');
      }

      return retrieve(id);
    };

    await expect(runBillingSweep(undefined, { now: later(1) })).resolves.toBeDefined();
    expect(await debits()).toHaveLength(1);
  });

  it('never runs two sweeps at once', async () => {
    await managedChat(1);

    const [a, b] = await Promise.all([
      runBillingSweep(undefined, { now: later(1) }),
      runBillingSweep(undefined, { now: later(1) }),
    ]);

    expect([a.skipped, b.skipped].filter(Boolean)).toEqual(['already-running']);
    expect(await debits()).toHaveLength(1);
  });
});

describe('orphans left by a delete whose settlement failed (D4)', () => {
  it('settles the orphan from its recorded cursor and resolves it', async () => {
    const sessionId = 'sesn_orphan';
    fake.seed(sessionId, [
      {
        type: 'span.model_request_end',
        model_usage: {
          input_tokens: 500,
          output_tokens: 700,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ]);

    await getManagedOrphanStore().record({
      userId: USER,
      projectId,
      chatId: randomUUID(),
      sessionId,
      cursor: null,
      model: MODEL,
      reason: 'test',
    });

    await runBillingSweep(undefined, { now: later(1) });

    expect(await debits()).toHaveLength(1);
    expect(await getManagedOrphanStore().listOpen()).toEqual([]);

    await runBillingSweep(undefined, { now: later(20) });
    expect(await debits()).toHaveLength(1);
  });
});

/*
 * Verifier defect B, layer 1: a sweep settles a row only after CLAIMING it (`markStatus(id, 'interrupted')`,
 * guarded on `running`), so two settlers racing for one row, or a sweep racing the turn's own settlement,
 * bill it exactly once.
 */
describe('a running row is billed exactly once, whoever races for it', () => {
  it('sweep (a) and a delete settling the same stale row concurrently → one debit', async () => {
    await staleLegacyRow('gen_race_1');

    await Promise.all([
      runBillingSweep(undefined, { now: later(16) }),
      settleBeforeDelete({ userId: USER, projectId, chatIds: ['c1'] }),
    ]);

    expect((await debits()).filter((e) => e.generationId === 'gen_race_1')).toHaveLength(1);
    expect((await row('gen_race_1')).status).toBe('interrupted');
  });

  it('the turn settles (and releases its mark) after the sweep listed the row → the sweep bills nothing', async () => {
    await staleLegacyRow('gen_race_2');

    const listRunning = store.listRunning.bind(store);

    store.listRunning = async (filter) => {
      const rows = await listRunning(filter);

      /* Between the list and the claim: the live turn finishes and settles its own row. */
      await settleGeneration({
        userId: USER,
        generationId: 'gen_race_2',
        model: MODEL,
        provider: 'Anthropic',
        usage: {
          promptTokens: USAGE.promptTokens,
          completionTokens: USAGE.completionTokens + 500,
          cacheReadTokens: USAGE.cacheReadTokens,
          cacheCreationTokens: USAGE.cacheCreationTokens,
        },
      });

      return rows;
    };

    await runBillingSweep(undefined, { now: later(16) });

    const mine = (await debits()).filter((e) => e.generationId === 'gen_race_2');
    expect(mine).toHaveLength(1);
    expect(await row('gen_race_2'), "the turn's own (larger) settlement is never overwritten").toMatchObject({
      status: 'completed',
      completionTokens: USAGE.completionTokens + 500,
    });
  });

  it('a live managed turn older than the stale threshold is never flipped to interrupted (slip 1)', async () => {
    await openRunningGeneration({
      id: 'gen_managed_live',
      userId: USER,
      model: MODEL,
      provider: 'Anthropic',
      engine: 'managed',
      chatId: 'c2',
    });

    const release = trackGeneration('gen_managed_live');

    await runBillingSweep(undefined, { now: later(30) });
    expect((await row('gen_managed_live')).status).toBe('running');
    release();
  });
});
