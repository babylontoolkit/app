/**
 * Delete settles first (`_specs/no-unbilled-usage_plan.md` D4, T4).
 *
 * Deleting a chat, a project or an account used to drop the chat's index row — the only record of its
 * managed session and its cost cursor — while the session kept running, unsettled and unarchived. A
 * pending tail then found the session unbound and charged nothing. Now the delete interrupts each live
 * session, waits (bounded), settles it, archives it and settles any orphaned legacy row — THEN deletes;
 * and a settlement that fails leaves a durable orphan record the sweep bills later.
 *
 * Everything real except Anthropic; every store pinned to a throwaway directory, billing env stubbed.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsGenerationStore, setGenerationStore } from '~/lib/.server/billing/generations';
import { resetInFlightForTests, trackGeneration } from '~/lib/.server/billing/in-flight';
import { FsLedger, setLedger } from '~/lib/.server/billing/ledger';
import { createUsageCheckpointer, openRunningGeneration } from '~/lib/.server/billing/running-generation';
import { runBillingSweep } from '~/lib/.server/billing/sweep';
import { FsChatIndex, getChatIndex, setChatIndex } from '~/lib/.server/projects/chat-index';
import { deleteChat } from '~/lib/.server/projects/message-store';
import { FsProjectStore, setProjectStore } from '~/lib/.server/projects/store';
import { setObjectStore, type ObjectStore } from '~/lib/.server/storage';
import { setManagedClientForTests } from './config';
import { settleBeforeDelete } from './delete-settle';
import { createFakeManagedClient, type FakeClient } from './fake-session.testkit';
import { FsManagedOrphanStore, getManagedOrphanStore, setManagedOrphanStore } from './orphans';

const USER = '44444444-4444-4444-8444-444444444444';
const MODEL = 'claude-sonnet-5';

let tmp: string;
let ledger: FsLedger;
let store: FsGenerationStore;
let fake: FakeClient;
let projectId: string;

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
  } as ObjectStore;
}

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
  vi.stubEnv('MANAGED_SUPERSEDE_WAIT_MS', '200');

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'delete-settle-'));
  ledger = new FsLedger(path.join(tmp, 'ledger'));
  store = new FsGenerationStore(path.join(tmp, 'generations'));
  setLedger(ledger);
  setGenerationStore(store);
  setChatIndex(new FsChatIndex(path.join(tmp, 'chats')));
  setObjectStore(memoryStore());
  setManagedOrphanStore(new FsManagedOrphanStore(path.join(tmp, 'orphans')));

  const projects = new FsProjectStore(path.join(tmp, 'projects'));
  setProjectStore(projects);
  projectId = (await projects.create({ userId: USER, name: 'Game', templateId: 'blank' } as never)).id;

  await ledger.append({ userId: USER, delta: 10_000, reason: 'grant' });

  fake = createFakeManagedClient();
  setManagedClientForTests(fake.client);
  resetInFlightForTests();
});

afterEach(async () => {
  setManagedClientForTests(undefined);
  setLedger(undefined);
  setGenerationStore(undefined);
  setChatIndex(undefined);
  setObjectStore(undefined);
  setProjectStore(undefined);
  setManagedOrphanStore(undefined);
  resetInFlightForTests();
  vi.unstubAllEnvs();
  await fs.rm(tmp, { recursive: true, force: true });
});

const debits = async () => (await ledger.list(USER)).filter((e) => e.reason === 'generation');

async function liveChat(status: 'running' | 'idle' = 'running') {
  const chatId = randomUUID();
  const sessionId = `sesn_${chatId.slice(0, 8)}`;
  const session = fake.seed(sessionId, [
    {
      type: 'span.model_request_end',
      model_usage: {
        input_tokens: 2000,
        output_tokens: 1500,
        cache_read_input_tokens: 30_000,
        cache_creation_input_tokens: 4000,
      },
    },
  ]);

  session.status = status;
  await getChatIndex().claimManagedSession({ id: chatId, projectId, sessionId, now: new Date().toISOString() });

  return { chatId, sessionId };
}

describe('a delete during a live managed turn', () => {
  it('interrupts, settles and archives the session BEFORE the rows go', async () => {
    const { chatId, sessionId } = await liveChat('running');

    await settleBeforeDelete({ userId: USER, projectId, chatIds: [chatId], pollMs: 5 });

    expect(fake.sends.some((s) => s.sessionId === sessionId && s.events.some((e) => e.type === 'user.interrupt'))).toBe(
      true,
    );
    expect(fake.archived).toContain(sessionId);

    const charged = await debits();
    expect(charged).toHaveLength(1);
    expect(charged[0].generationId).toMatch(new RegExp(`^${chatId}_delete_`));
    expect(await getManagedOrphanStore().listOpen()).toEqual([]);

    await deleteChat(projectId, chatId);
    expect(await getChatIndex().get(chatId)).toBeNull();

    await runBillingSweep(undefined, { now: Date.now() + 60_000 });
    expect(await debits(), 'nothing is billed twice').toHaveLength(1);
  });

  it('settles every managed chat of a project when no chat ids are given (project / account delete)', async () => {
    await liveChat('idle');
    await liveChat('running');

    await settleBeforeDelete({ userId: USER, projectId, pollMs: 5 });

    expect(await debits()).toHaveLength(2);
    expect(fake.archived).toHaveLength(2);
  });
});

describe('a settlement that fails during a delete', () => {
  it('leaves a durable orphan record that the sweep bills after the rows are gone', async () => {
    const { chatId, sessionId } = await liveChat('idle');
    const retrieve = fake.client.beta.sessions.retrieve.bind(fake.client.beta.sessions);
    const sessions = fake.client.beta.sessions as unknown as { retrieve: (id: string) => Promise<unknown> };

    sessions.retrieve = async () => {
      throw new Error('anthropic is down');
    };

    await expect(settleBeforeDelete({ userId: USER, projectId, chatIds: [chatId], pollMs: 5 })).resolves.toBeDefined();
    expect(await debits()).toEqual([]);

    const open = await getManagedOrphanStore().listOpen();
    expect(open).toEqual([expect.objectContaining({ sessionId, chatId, userId: USER, projectId })]);

    await deleteChat(projectId, chatId);
    sessions.retrieve = retrieve;

    await runBillingSweep(undefined, { now: Date.now() + 60_000 });

    expect(await debits()).toHaveLength(1);
    expect(await getManagedOrphanStore().listOpen()).toEqual([]);
  });
});

describe('legacy rows of the deleted chats', () => {
  it('settles a running row whose turn is not in flight, regardless of staleness', async () => {
    const chatId = randomUUID();

    await openRunningGeneration({
      id: 'gen_orphan_legacy',
      userId: USER,
      model: MODEL,
      provider: 'Anthropic',
      engine: 'legacy',
      projectId,
      chatId,
    });

    const checkpointer = createUsageCheckpointer({ id: 'gen_orphan_legacy' });
    checkpointer.checkpoint({
      promptTokens: 1000,
      completionTokens: 2000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 3000,
    });
    await checkpointer.flush();

    await settleBeforeDelete({ userId: USER, projectId, chatIds: [chatId], pollMs: 5 });

    expect((await store.listByIds(['gen_orphan_legacy']))[0].status).toBe('interrupted');
    expect(await debits()).toHaveLength(1);
  });

  it('CONTROL — a running row whose turn IS in flight is left to that turn', async () => {
    const chatId = randomUUID();

    await openRunningGeneration({
      id: 'gen_live_legacy',
      userId: USER,
      model: MODEL,
      provider: 'Anthropic',
      engine: 'legacy',
      projectId,
      chatId,
    });

    const release = trackGeneration('gen_live_legacy');

    await settleBeforeDelete({ userId: USER, projectId, chatIds: [chatId], pollMs: 5 });

    expect((await store.listByIds(['gen_live_legacy']))[0].status).toBe('running');
    release();
  });
});

describe('every delete path settles first (source scan, with controls)', () => {
  const read = (p: string) =>
    readFileSync(join(process.cwd(), p), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');

  it('project purge (and so account delete) settles before deleting the conversation', () => {
    const source = read('app/lib/.server/projects/purge.ts');
    const settle = source.indexOf('settleBeforeDelete(');

    expect(settle).toBeGreaterThan(-1);
    expect(settle).toBeLessThan(source.indexOf('deleteMessages('));
    expect(settle).toBeLessThan(source.indexOf('getProjectStore(context).delete('));
  });

  it('account delete goes through the purge', () => {
    expect(read('app/lib/.server/account/delete-account.ts')).toContain('purgeProject(');
  });

  it('chat delete settles before deleting the chat', () => {
    const source = read('app/routes/api.projects.$projectId.messages.$chatId.ts');
    const settle = source.indexOf('settleBeforeDelete(');

    expect(settle).toBeGreaterThan(-1);
    expect(settle).toBeLessThan(source.indexOf('deleteChat('));
  });

  it('CONTROL — the scanner reads the real files', () => {
    expect(read('app/lib/.server/projects/purge.ts')).toContain('export async function purgeProject(');
    expect(read('app/routes/api.projects.$projectId.messages.$chatId.ts')).toContain('deleteChat(');
  });
});

/*
 * Verifier defect A: a session still running after the delete's bounded wait is settled (charging X and
 * advancing the cursor) AND kept as an orphan — the orphan must carry the cursor that settlement WROTE, or
 * the sweep re-bills X.
 */
describe('a session that keeps running past the delete wait', () => {
  it('the delete charges X once; the sweep later charges ONLY the post-delete tail', async () => {
    vi.stubEnv('MANAGED_SUPERSEDE_WAIT_MS', '30');

    const chatId = randomUUID();
    const sessionId = `sesn_${chatId.slice(0, 8)}`;
    const session = fake.seed(sessionId, [
      {
        type: 'span.model_request_end',
        model_usage: {
          input_tokens: 50_000,
          output_tokens: 40_000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ]);

    session.status = 'running';
    await getChatIndex().claimManagedSession({ id: chatId, projectId, sessionId, now: new Date().toISOString() });

    /* The interrupt is ignored: the session is still running when the wait runs out. */
    const sessions = fake.client.beta.sessions as unknown as {
      events: { send: (id: string, params: { events: Array<{ type: string }> }) => Promise<unknown> };
    };
    const send = sessions.events.send.bind(sessions.events);
    sessions.events.send = async (id, params) =>
      params.events.some((e) => e.type === 'user.interrupt') ? { data: [] } : send(id, params);

    await settleBeforeDelete({ userId: USER, projectId, chatIds: [chatId], pollMs: 5 });
    await deleteChat(projectId, chatId);

    const atDelete = await debits();
    expect(atDelete).toHaveLength(1);

    const x = -atDelete[0].delta;
    expect(await getManagedOrphanStore().listOpen()).toHaveLength(1);

    /* The session's post-delete tail: one small request, then it stops. */
    session.events.push({
      type: 'span.model_request_end',
      id: 'sevt_tail',
      processed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      model_usage: {
        input_tokens: 100,
        output_tokens: 100,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
    session.status = 'idle';

    await runBillingSweep(undefined, { now: Date.now() + 60_000 });

    const all = await debits();
    expect(all).toHaveLength(2);

    const tail = -all[0].delta;
    expect(tail, `the sweep re-billed the delete's ${x} credits`).toBeLessThan(x / 2);
    expect(await getManagedOrphanStore().listOpen()).toEqual([]);
  });
});
