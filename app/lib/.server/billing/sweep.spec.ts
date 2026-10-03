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
import { settleManagedTurn } from '~/lib/.server/agent-managed/settle';
import { parseCostCursor, serializeCostCursor, EMPTY_COST_CURSOR } from '~/lib/.server/agent-managed/session-cost';
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

/*
 * no-unbilled-usage D6 (G6): the managed cursor carries its charge as a PENDING DEBIT in the same write that
 * advances it, cleared once the debit lands. A settlement interrupted between the two — a crash, a ledger
 * outage — leaves the intent, and the next settlement or the sweep debits it, exactly once.
 */
describe('(c) pending debit intents (D6)', () => {
  const cursorOf = async (chatId: string) => parseCostCursor((await getChatIndex().get(chatId))?.managedSettledAt);

  /** Make the next `generation` debit fail the way a ledger outage does (settleGeneration returns null). */
  function failNextDebit() {
    const append = ledger.append.bind(ledger);

    ledger.append = async (entry) => {
      if (entry.reason === 'generation') {
        ledger.append = append;
        throw new Error('ledger is down');
      }

      return append(entry);
    };
  }

  const settleChat = (chatId: string, sessionId: string, generationId: string) =>
    settleManagedTurn({
      client: fake.client,
      sessionId,
      projectId,
      chatId,
      userId: USER,
      generationId,
      model: MODEL,
      statusKind: 'edit',
      sessionHourUsd: 0,
    });

  it('a debit that did not land stays on the cursor, and the sweep debits it exactly once', async () => {
    const { chatId, sessionId } = await managedChat(1);

    failNextDebit();

    const settled = await settleChat(chatId, sessionId, 'gen_d6_lost');

    expect(settled.settlement).toBeNull();
    expect(settled.complete, 'an undebited charge is not accounted for').toBe(false);
    expect(await debits()).toEqual([]);
    expect((await cursorOf(chatId))?.pending?.map((p) => p.generationId)).toEqual(['gen_d6_lost']);

    await runBillingSweep(undefined, { now: later(1) });
    await runBillingSweep(undefined, { now: later(20) });

    const charged = await debits();

    expect(charged.map((e) => e.generationId)).toEqual(['gen_d6_lost']);
    expect((await cursorOf(chatId))?.pending ?? []).toEqual([]);
  });

  it('a crash between the cursor write and the debit (intent on the cursor, no ledger row) → the sweep debits it once', async () => {
    /* Running, so the chat pass (b) skips it: only the intent pass (c) can bill this. */
    const { chatId } = await managedChat(1, 'running');
    const intent = {
      generationId: 'gen_d6_crash',
      credits: 42,
      rawCostUsd: 0.07,
      model: MODEL,
      userId: USER,
      projectId,
      chatId,
      statusKind: 'edit',
      usage: {
        promptTokens: 1200,
        completionTokens: 900,
        totalTokens: 2100,
        cacheReadTokens: 40_000,
        cacheCreationTokens: 6000,
      },
    };

    await getChatIndex().setManagedSettledAt({
      id: chatId,
      projectId,
      settledAt: serializeCostCursor({ ...EMPTY_COST_CURSOR, credits: 42, pending: [intent] }),
    });

    const first = await runBillingSweep(undefined, { now: later(1) });

    expect(first.pendingDebits).toBe(1);
    expect((await debits()).map((e) => [e.generationId, -e.delta])).toEqual([['gen_d6_crash', 42]]);
    expect((await cursorOf(chatId))?.pending ?? []).toEqual([]);
    expect((await cursorOf(chatId))?.credits, 'the rest of the cursor is untouched').toBe(42);

    await runBillingSweep(undefined, { now: later(20) });
    expect(await debits()).toHaveLength(1);
  });

  it('an intent whose debit DID land (only its clear was lost) charges nothing more and is cleared', async () => {
    const { chatId } = await managedChat(1, 'running');
    const intent = {
      generationId: 'gen_d6_landed',
      credits: 17,
      rawCostUsd: 0.03,
      model: MODEL,
      userId: USER,
      projectId,
      chatId,
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
    };

    await settleGeneration({
      userId: USER,
      generationId: 'gen_d6_landed',
      model: MODEL,
      provider: 'Anthropic',
      usage: intent.usage,
      flatCredits: 17,
    });
    await getChatIndex().setManagedSettledAt({
      id: chatId,
      projectId,
      settledAt: serializeCostCursor({ ...EMPTY_COST_CURSOR, credits: 17, pending: [intent] }),
    });

    await runBillingSweep(undefined, { now: later(1) });

    expect((await debits()).map((e) => e.generationId)).toEqual(['gen_d6_landed']);
    expect((await cursorOf(chatId))?.pending ?? []).toEqual([]);
  });

  it("an orphan's cursor intent is debited too", async () => {
    fake.seed('sesn_orphan_d6', []).status = 'running';

    const chatId = randomUUID();

    await getManagedOrphanStore().record({
      userId: USER,
      projectId,
      chatId,
      sessionId: 'sesn_orphan_d6',
      cursor: serializeCostCursor({
        ...EMPTY_COST_CURSOR,
        credits: 9,
        pending: [
          {
            generationId: 'gen_d6_orphan',
            credits: 9,
            rawCostUsd: 0.01,
            model: MODEL,
            userId: USER,
            projectId,
            chatId,
            usage: {
              promptTokens: 5,
              completionTokens: 5,
              totalTokens: 10,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
            },
          },
        ],
      }),
      model: MODEL,
    });

    await runBillingSweep(undefined, { now: later(1) });

    expect((await debits()).map((e) => e.generationId)).toEqual(['gen_d6_orphan']);
    expect(parseCostCursor((await getManagedOrphanStore().listOpen())[0]?.cursor)?.pending ?? []).toEqual([]);
  });

  it('CONTROL: an ordinary settlement leaves no intent on the cursor', async () => {
    const { chatId, sessionId } = await managedChat(1);

    const settled = await settleChat(chatId, sessionId, 'gen_d6_ok');

    expect(settled.complete).toBe(true);
    expect(await debits()).toHaveLength(1);
    expect((await getChatIndex().get(chatId))?.managedSettledAt).not.toContain('pending');
  });

  it('a cursor written before D6 (no pending field) parses and settles as before', async () => {
    const { chatId } = await managedChat(1);

    await getChatIndex().setManagedSettledAt({
      id: chatId,
      projectId,
      settledAt: JSON.stringify({ v: 2, tokens: {}, trueCostUsd: 0, warmBasisUsd: 0, credits: 0 }),
    });

    await runBillingSweep(undefined, { now: later(1) });

    expect(await debits()).toHaveLength(1);
    expect((await cursorOf(chatId))?.pending ?? []).toEqual([]);
  });
});

/*
 * Verifier money defect 1: an intent is a DECIDED charge and needs no session. An orphan whose session is
 * gone (404) must still have its intents debited before it is resolved — and kept open when that fails.
 */
describe('(c) an intent survives its session (verifier money defect 1)', () => {
  const intentFor = (chatId: string, generationId: string, credits: number) => ({
    generationId,
    credits,
    rawCostUsd: 0.02,
    model: MODEL,
    userId: USER,
    projectId,
    chatId,
    usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 },
  });

  async function orphanWithIntent(generationId: string, credits: number) {
    const chatId = randomUUID();

    /* `sesn_vanished` is never seeded: every read of it is a 404. */
    await getManagedOrphanStore().record({
      userId: USER,
      projectId,
      chatId,
      sessionId: 'sesn_vanished',
      cursor: serializeCostCursor({
        ...EMPTY_COST_CURSOR,
        credits,
        pending: [intentFor(chatId, generationId, credits)],
      }),
      model: MODEL,
    });
  }

  it('an orphan whose session is gone (404) has its intent debited once, then is resolved', async () => {
    await orphanWithIntent('gen_gone_intent', 11);

    await runBillingSweep(undefined, { now: later(1) });

    expect((await debits()).map((e) => [e.generationId, -e.delta])).toEqual([['gen_gone_intent', 11]]);
    expect(await getManagedOrphanStore().listOpen()).toEqual([]);

    await runBillingSweep(undefined, { now: later(20) });
    expect(await debits()).toHaveLength(1);
  });

  it('a transient debit failure keeps the 404 orphan OPEN, and the next sweep debits it', async () => {
    await orphanWithIntent('gen_gone_retry', 6);

    const append = ledger.append.bind(ledger);
    let failing = true;

    ledger.append = async (entry) => {
      if (failing && entry.reason === 'generation') {
        throw new Error('ledger is down');
      }

      return append(entry);
    };

    await runBillingSweep(undefined, { now: later(1) });

    expect(await debits()).toEqual([]);
    expect(await getManagedOrphanStore().listOpen(), 'kept for the retry').toHaveLength(1);

    failing = false;
    await runBillingSweep(undefined, { now: later(20) });

    expect((await debits()).map((e) => e.generationId)).toEqual(['gen_gone_retry']);
    expect(await getManagedOrphanStore().listOpen()).toEqual([]);
  });

  it('recovering an intent whose debit already landed never rewrites the row and never alerts', async () => {
    const { chatId } = await managedChat(1, 'running');

    await store.upsert({ id: 'gen_landed_failed', userId: USER, model: MODEL, status: 'failed', creditsCharged: 8 });
    await ledger.append({ userId: USER, delta: -8, reason: 'generation', generationId: 'gen_landed_failed' });
    await getChatIndex().setManagedSettledAt({
      id: chatId,
      projectId,
      settledAt: serializeCostCursor({
        ...EMPTY_COST_CURSOR,
        credits: 8,
        pending: [intentFor(chatId, 'gen_landed_failed', 8)],
      }),
    });

    await runBillingSweep(undefined, { now: later(1) });

    expect((await debits()).filter((e) => e.generationId === 'gen_landed_failed')).toHaveLength(1);
    expect((await row('gen_landed_failed')).status, 'a failed row stays failed').toBe('failed');
    expect(parseCostCursor((await getChatIndex().get(chatId))?.managedSettledAt)?.pending ?? []).toEqual([]);
  });
});
