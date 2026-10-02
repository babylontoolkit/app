/**
 * Whole managed turns against a SCRIPTED fake session (managed-agents-engine T5–T7).
 *
 * Everything real except Anthropic: the engine, the event bridge, the in-process tool relay (a
 * simulated browser answers through `deliverClientToolResult`, exactly like `/api/agent/tool-result`),
 * the chat index, the ledger, the generation store and the billing formula — each pinned to a throwaway
 * directory, never the developer's `.data/`. `env()` falls back to `process.env` (and vitest loads
 * `.env.local`, which holds a REAL key), so every variable the engine reads is stubbed.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGeneration } from '~/lib/.server/agent/proxy';
import { deliverClientToolResult } from '~/lib/.server/agent/mcp-relay';
import { billedUsage } from '~/lib/.server/billing/gate';
import { FsGenerationStore, setGenerationStore } from '~/lib/.server/billing/generations';
import { FsLedger, setLedger } from '~/lib/.server/billing/ledger';
import { rawCostUsd } from '~/lib/.server/billing/rates';
import { FsChatIndex, getChatIndex, setChatIndex } from '~/lib/.server/projects/chat-index';
import { setPromptStore, type PromptStore } from '~/lib/.server/prompt/store';
import type { AuthUser } from '~/lib/.server/supabase/auth';
import { describeTurnOutcome } from '~/lib/agent/turn-outcome';
import type { FileMap } from '~/lib/.server/llm/constants';
import { setManagedClientForTests } from './config';
import { runManagedGeneration } from './engine';
import { createFakeManagedClient, type FakeClient, type Script } from './fake-session.testkit';
import type { ManagedAgentRecord } from './record';
import { settleManagedTurn } from './settle';
import { SUPERSEDED_RESULT } from './session-health';

const MODEL = 'claude-sonnet-5-5';
const USER: AuthUser = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'dev@example.com',
  emailVerified: true,
  displayName: 'Dev',
  isAdmin: false,
} as AuthUser;
const PROJECT = 'prj_managed_test';

const RECORD: ManagedAgentRecord = {
  key: `${MODEL}:medium`,
  agentId: 'agent_1',
  agentVersion: 3,
  hash: 'h',
  agentHash: 'ah',
  environmentId: 'env_1',
  model: MODEL,
  effort: 'medium',
  referenceSha: 'abc',
  referenceFiles: [{ rel: 'reference.md', fileId: 'file_ref' }],
  skills: [],
  provisionedAt: '2026-10-01T00:00:00Z',
};

const FILES = {
  '/home/project/src/main.ts': { type: 'file', content: 'console.log(1);\n', isBinary: false },
  '/home/project/package.json': { type: 'file', content: '{}', isBinary: false },
} as unknown as FileMap;

const USAGE_1 = {
  input_tokens: 1200,
  output_tokens: 800,
  cache_read_input_tokens: 50_000,
  cache_creation_input_tokens: 9000,
};
const USAGE_3 = {
  input_tokens: 10,
  output_tokens: 2000,
  cache_read_input_tokens: 70_000,
  cache_creation_input_tokens: 0,
};
const USAGE_2 = {
  input_tokens: 300,
  output_tokens: 1500,
  cache_read_input_tokens: 61_000,
  cache_creation_input_tokens: 0,
};

let tmp: string;
let fake: FakeClient;
let ledger: FsLedger;
let chatId: string;

beforeEach(async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-real');
  vi.stubEnv('LLM_MODEL', MODEL);
  vi.stubEnv('MANAGED_AGENT_EFFORT', 'medium');
  vi.stubEnv('MANAGED_SESSION_HOUR_USD', '0.08');
  vi.stubEnv('BILLING_ENFORCED', 'false');
  vi.stubEnv('CREDIT_UNIT_COST_USD', '0.01');
  vi.stubEnv('CREDIT_MARGIN', '4');
  vi.stubEnv('AGENT_TURN_MAX_CREDITS', '1000');
  vi.stubEnv('LLM_PROVIDER', 'Anthropic');
  vi.stubEnv('MANAGED_SUPERSEDE_WAIT_MS', '50');

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-turn-'));
  ledger = new FsLedger(path.join(tmp, 'ledger'));
  setLedger(ledger);
  setGenerationStore(new FsGenerationStore(path.join(tmp, 'generations')));
  setChatIndex(new FsChatIndex(path.join(tmp, 'chats')));
  setPromptStore({
    getActive: async () => ({ id: 'pv_test', managedAgents: { [RECORD.key]: RECORD } }),
    list: async () => [],
  } as unknown as PromptStore);

  fake = createFakeManagedClient();
  setManagedClientForTests(fake.client);
  chatId = randomUUID();
});

afterEach(async () => {
  /* A detached turn's script waits forever on its unanswered call — by design; it is simply dropped. */
  setManagedClientForTests(undefined);
  setLedger(undefined);
  setGenerationStore(undefined);
  setChatIndex(undefined);
  setPromptStore(undefined);
  vi.unstubAllEnvs();
  await fs.rm(tmp, { recursive: true, force: true });
});

/** The ledger, oldest first (`list` returns newest first). */
const rows = async () => (await ledger.list(USER.id)).reverse();

const userMessage = (text: string) => ({
  id: `u${Math.random()}`,
  role: 'user' as const,
  content: `[Model: x]\n\n[Provider: y]\n\n${text}`,
});

/** The expected charge, computed from the reported usage through the documented formula. */
function expectedCredits(
  usage: { promptTokens: number; completionTokens: number; cacheReadTokens: number; cacheCreationTokens: number },
  extraUsd: number,
) {
  const tokenCost = rawCostUsd(billedUsage(usage), MODEL, 'Anthropic');

  return Math.max(1, Math.ceil(((tokenCost + extraUsd) / 0.01) * 4));
}

interface Drive {
  text: string;
  reasoning: string;
  error?: Error;
  generation: AgentGeneration;
  workspaceCalls: Array<{ toolCallId: string; op: string; params: unknown }>;
}

/**
 * Consume a generation the way the route does, with a simulated browser answering every workspace call
 * — unless `onCall` returns false (the tab closed instead).
 */
async function drive(
  generation: AgentGeneration,
  onCall: (call: { toolCallId: string; op: string }) => boolean | void = () => true,
): Promise<Drive> {
  const out: Drive = { text: '', reasoning: '', generation, workspaceCalls: [] };

  generation.onWorkspaceToolCall((event) => {
    out.workspaceCalls.push(event);

    if (onCall(event) !== false) {
      queueMicrotask(() =>
        deliverClientToolResult({
          generationId: generation.generationId,
          toolCallId: event.toolCallId,
          userId: USER.id,
          result:
            event.op === 'check'
              ? { ok: true, typecheck: { ok: true, errors: [] }, home: { errors: [] }, play: null }
              : { ok: true },
        }),
      );
    }
  });

  try {
    for await (const chunk of generation.textStream) {
      if (chunk.type === 'text') {
        out.text += chunk.value;
      } else {
        out.reasoning += chunk.value;
      }
    }
  } catch (error) {
    out.error = error as Error;
  }

  return out;
}

const turn = (overrides: Partial<Parameters<typeof runManagedGeneration>[0]> = {}) =>
  runManagedGeneration({
    messages: [userMessage('make the kart drift')],
    files: FILES,
    chatId,
    projectId: PROJECT,
    user: USER,
    context: {},
    ...overrides,
  });

describe('a whole managed turn', () => {
  it('streams narration, relays a write through the real relay, answers the session, and settles the reported usage', async () => {
    let writeId = '';

    fake.script = (async (api) => {
      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Adding drift.' }] });
      api.modelRequest(USAGE_1);

      const result = await api.callTool('project_write', {
        path: 'src/scripts/Drift.ts',
        content: 'export const drift = 1;',
      });
      writeId = result.custom_tool_use_id as string;

      api.modelRequest(USAGE_2);
      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Done.' }] });
      api.addActiveSeconds(1800);
      api.endTurn();
    }) satisfies Script;

    const run = await drive(await turn());

    expect(run.error).toBeUndefined();
    expect(run.text).toBe('Adding drift.\n\nDone.');

    /* The relay carried the write with the SESSION EVENT id, and the session got the result back. */
    expect(run.workspaceCalls).toEqual([
      {
        toolCallId: writeId,
        op: 'write',
        params: { path: 'src/scripts/Drift.ts', content: 'export const drift = 1;' },
      },
    ]);

    const results = fake.sends.flatMap((s) => s.events).filter((e) => e.type === 'user.custom_tool_result');

    expect(results).toEqual([
      {
        type: 'user.custom_tool_result',
        custom_tool_use_id: writeId,
        content: [{ type: 'text', text: expect.stringContaining('Wrote src/scripts/Drift.ts') }],
      },
    ]);

    /* The first message of a NEW session carries the manifest (paths only) and the user's words, unwrapped. */
    const first = fake.sends[0].events[0] as { content: Array<{ text: string }> };

    expect(first.content[0].text).toContain('src/main.ts\n');
    expect(first.content[0].text).toMatch(/make the kart drift$/);
    expect(first.content[0].text).not.toContain('[Model:');

    /* The session mounts the Agent Reference and starts with this turn's budget (1000 credits = $2.50). */
    const session = fake.sessions.get('sesn_1')!;

    expect(session.createParams).toMatchObject({
      agent: { type: 'agent', id: 'agent_1', version: 3 },
      environment_id: 'env_1',
      resources: [{ type: 'file', file_id: 'file_ref', mount_path: '/workspace/agent/reference.md' }],
      budget: { type: 'limit', max_list_cost: { amount: '250', currency: 'USD' } },
    });

    const usage = await run.generation.usage;
    const total = {
      promptTokens: USAGE_1.input_tokens + USAGE_2.input_tokens,
      completionTokens: USAGE_1.output_tokens + USAGE_2.output_tokens,
      cacheReadTokens: USAGE_1.cache_read_input_tokens + USAGE_2.cache_read_input_tokens,
      cacheCreationTokens: USAGE_1.cache_creation_input_tokens + USAGE_2.cache_creation_input_tokens,
    };

    expect(usage).toMatchObject(total);

    const settlement = await run.generation.settlement;
    const credits = expectedCredits(total, 0.04);

    expect(settlement?.creditsCharged).toBe(credits);
    expect((await rows()).map((e) => [e.reason, e.delta])).toEqual([['generation', -credits]]);

    /* A write with no passing check after it: built, not verified. */
    expect(describeTurnOutcome(await run.generation.outcome).state).toBe('unverified');
    expect(await run.generation.workspaceSummary).toMatchObject({ writes: ['src/scripts/Drift.ts'] });
  });

  it('a verified turn is "finished" and its checklist is completed; the next turn sets the session budget', async () => {
    fake.script = (async (api) => {
      api.modelRequest(USAGE_1);
      await api.callTool('update_todos', { items: [{ content: 'Write it', status: 'in_progress' }] });
      await api.callTool('project_write', { path: 'src/x.ts', content: 'x' });
      await api.callTool('check_game', {});
      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Verified.' }] });
      api.endTurn();
    }) satisfies Script;

    const todos: unknown[] = [];
    const generation = await turn();

    generation.onAgentTodos((items) => todos.push(items));

    const run = await drive(generation);

    expect(describeTurnOutcome(await run.generation.outcome).state).toBe('finished');
    expect(todos.at(-1)).toEqual([{ content: 'Write it', status: 'completed' }]);

    /* Turn two on the same chat: the session's spend so far + this turn's ceiling. */
    fake.sessions.get('sesn_1')!.listCostCents = 100;
    fake.script = (async (api) => {
      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'ok' }] });
      api.endTurn();
    }) satisfies Script;

    const second = await drive(await turn({ messages: [userMessage('thanks')] }));

    expect(second.error).toBeUndefined();
    expect(fake.updates).toEqual([
      { sessionId: 'sesn_1', params: { budget: { type: 'limit', max_list_cost: { amount: '350', currency: 'USD' } } } },
    ]);

    /* No manifest on an existing session. */
    expect((fake.sends.at(-1)!.events[0] as { content: Array<{ text: string }> }).content[0].text).toBe('thanks');
  });
});

describe('settlement is by cursor (T7)', () => {
  it('a second settlement with no new usage charges 0 and writes no ledger row; new usage is charged once', async () => {
    fake.script = (async (api) => {
      api.modelRequest(USAGE_1);
      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'hi' }] });
      api.endTurn();
    }) satisfies Script;

    await drive(await turn());

    const rowsAfterTurn = (await rows()).length;
    const settle = (generationId: string) =>
      settleManagedTurn({
        client: fake.client,
        sessionId: 'sesn_1',
        projectId: PROJECT,
        chatId,
        userId: USER.id,
        generationId,
        model: MODEL,
        statusKind: 'edit',
        sessionHourUsd: 0.08,
        context: {},
      });

    const again = await settle('gen_again');

    expect(again.settlement?.creditsCharged).toBe(0);
    expect(again.requests).toBe(0);
    expect((await rows()).length).toBe(rowsAfterTurn);

    /* CONTROL: usage that arrives later (a Stop's tail) IS charged — once. */
    fake.sessions.get('sesn_1')!.events.push({
      type: 'span.model_request_end',
      id: 'tail',
      processed_at: '2026-10-01T05:00:00.000Z',
      created_at: '2026-10-01T05:00:00.000Z',
      model_usage: USAGE_2,
    });

    const tail = await settle('gen_tail');

    expect(tail.requests).toBe(1);
    expect(tail.settlement?.creditsCharged).toBe(
      expectedCredits(
        {
          promptTokens: USAGE_2.input_tokens,
          completionTokens: USAGE_2.output_tokens,
          cacheReadTokens: USAGE_2.cache_read_input_tokens,
          cacheCreationTokens: 0,
        },
        0,
      ),
    );
    expect((await settle('gen_tail2')).settlement?.creditsCharged).toBe(0);
  });
});

describe('detach and resume (T6)', () => {
  /*
   * The turn: a narration, one write answered by the first tab, then a second write that is in flight
   * when the tab closes. The reopened tab must answer ONLY the second.
   */
  const script: Script = async (api) => {
    api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Starting.' }] });
    api.modelRequest(USAGE_1);
    await api.callTool('project_write', { path: 'src/a.ts', content: 'a' });
    api.modelRequest(USAGE_2);
    await api.callTool('project_write', { path: 'src/b.ts', content: 'b' });
    api.modelRequest(USAGE_3);
    api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Finished.' }] });
    api.endTurn();
  };

  it('a closed tab sends no tool result and no interrupt, bills what was consumed, and is not refunded', async () => {
    fake.script = script;

    const controller = new AbortController();
    const run = await drive(await turn({ abortSignal: controller.signal }), (call) => {
      const params = (call as unknown as { params: { path: string } }).params;

      if (params.path === 'src/b.ts') {
        controller.abort();
        return false;
      }

      return true;
    });

    expect(run.error).toBeUndefined();

    const sent = fake.sends.flatMap((s) => s.events).map((e) => e.type);

    expect(sent.filter((t) => t === 'user.custom_tool_result')).toHaveLength(1); // only src/a.ts
    expect(sent).not.toContain('user.interrupt');
    expect((await run.generation.outcome).aborted).toBe(true);

    const settlement = await run.generation.settlement;

    expect(settlement?.creditsCharged).toBeGreaterThan(0);
    expect((await rows()).map((e) => e.reason)).toEqual(['generation']);
  });

  it('a resume replays the turn, re-dispatches ONLY the unanswered call, finishes, and bills only the rest', async () => {
    fake.script = script;

    const controller = new AbortController();

    await drive(await turn({ abortSignal: controller.signal }), (call) => {
      if ((call as unknown as { params: { path: string } }).params.path === 'src/b.ts') {
        controller.abort();
        return false;
      }

      return true;
    });

    const chargedBefore = (await rows()).reduce((sum, e) => sum - e.delta, 0);
    const sendsBefore = fake.sends.length;

    const resumed = await drive(await turn({ resume: true, messages: [userMessage('make the kart drift')] }));

    expect(resumed.error).toBeUndefined();
    expect(resumed.text).toBe('Starting.\n\nFinished.');

    /* Only src/b.ts went to the browser again — src/a.ts was already answered. */
    expect(resumed.workspaceCalls.map((c) => (c.params as { path: string }).path)).toEqual(['src/b.ts']);

    /* No second user.message: a resume never re-sends the turn. */
    const newSends = fake.sends.slice(sendsBefore).flatMap((s) => s.events);

    expect(newSends.map((e) => e.type)).toEqual(['user.custom_tool_result']);

    /*
     * Billing across both requests = all the usage, ONCE: the detached request charged the two requests
     * made before the tab closed; the resume charges only the one made after.
     */
    const resumeCredits = expectedCredits(
      {
        promptTokens: USAGE_3.input_tokens,
        completionTokens: USAGE_3.output_tokens,
        cacheReadTokens: USAGE_3.cache_read_input_tokens,
        cacheCreationTokens: 0,
      },
      0,
    );

    expect((await resumed.generation.settlement)?.creditsCharged).toBe(resumeCredits);
    expect((await rows()).reduce((sum, e) => sum - e.delta, 0)).toBe(chargedBefore + resumeCredits);
    expect(describeTurnOutcome(await resumed.generation.outcome).state).toBe('unverified');
  });
});

describe('failures and the budget (T7)', () => {
  it('an error before any model request REFUNDS (session time charged, then handed back)', async () => {
    fake.script = (async (api) => {
      api.addActiveSeconds(3600);
      api.emit({
        type: 'session.error',
        error: { type: 'billing_error', message: 'org over limit', retry_status: { type: 'terminal' } },
      });
    }) satisfies Script;

    const run = await drive(await turn());

    expect(run.error?.message).toBe('org over limit');
    expect((await run.generation.settlement)?.creditsCharged).toBe(0);
    expect((await rows()).map((e) => [e.reason, e.delta])).toEqual([
      ['generation', -32],
      ['refund', 32],
    ]);
  });

  it('a failure AFTER writing files is billed and never refunded', async () => {
    fake.script = (async (api) => {
      api.modelRequest(USAGE_1);
      await api.callTool('project_write', { path: 'src/a.ts', content: 'a' });
      api.emit({ type: 'session.status_terminated' });
    }) satisfies Script;

    const run = await drive(await turn());

    expect(run.error).toBeDefined();
    expect((await run.generation.settlement)?.creditsCharged).toBeGreaterThan(0);
    expect((await rows()).map((e) => e.reason)).toEqual(['generation']);
  });

  it('a budget stop is a PAUSE with Keep building, billed, and never refunded', async () => {
    fake.script = (async (api) => {
      api.modelRequest(USAGE_1);
      api.emit({ type: 'session.status_idle', stop_reason: { type: 'budget_reached' }, stop_details: null });
    }) satisfies Script;

    const run = await drive(await turn());
    const outcome = describeTurnOutcome(await run.generation.outcome);

    expect(run.error).toBeUndefined();
    expect(outcome.state).toBe('paused');
    expect(outcome.actionLabel).toBe('Keep building');
    expect((await run.generation.settlement)?.creditsCharged).toBeGreaterThan(0);
    expect((await rows()).map((e) => e.reason)).toEqual(['generation']);
  });

  it('a turn that ends with nothing said and nothing done is an empty response, refunded', async () => {
    fake.script = (async (api) => {
      api.modelRequest(USAGE_1);
      api.endTurn();
    }) satisfies Script;

    const run = await drive(await turn());

    expect(run.error?.message).toMatch(/empty response/);
    expect((await rows()).map((e) => e.reason)).toEqual(['generation', 'refund']);
  });

  it('never provisioned → NotConfiguredError naming the admin button, and no session is created', async () => {
    setPromptStore({ getActive: async () => ({ id: 'pv_x' }), list: async () => [] } as unknown as PromptStore);

    const error = await turn().catch((e) => e);

    expect(error.message).toContain('Provision managed agent');
    expect(fake.sessions.size).toBe(0);
  });
});

/** Bind the test chat to an existing session id, as an earlier turn would have. */
async function bindChat(sessionId: string) {
  await getChatIndex().claimManagedSession({
    id: chatId,
    projectId: PROJECT,
    sessionId,
    now: new Date().toISOString(),
  });
}

const sentTo = (sessionId: string) => fake.sends.filter((s) => s.sessionId === sessionId).flatMap((s) => s.events);

describe('a dead session is REBOUND', () => {
  const answer: Script = async (api) => {
    api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Fresh session.' }] });
    api.endTurn();
  };

  it('terminated: settles the old tail under its own id, never sends to it, and creates + stores a fresh session', async () => {
    fake.script = answer;

    const dead = fake.seed('sesn_dead', [
      { type: 'user.message', content: [] },
      { type: 'span.model_request_end', model_usage: USAGE_1 },
    ]);

    dead.status = 'terminated';
    await bindChat('sesn_dead');

    const run = await drive(await turn());

    expect(run.error).toBeUndefined();
    expect(run.text).toBe('Fresh session.');
    expect(sentTo('sesn_dead')).toEqual([]);

    const fresh = (await getChatIndex().get(chatId))?.managedSessionId;

    expect(fresh).toBeDefined();
    expect(fresh).not.toBe('sesn_dead');
    expect(fake.sessions.get(fresh!)!.createParams).toMatchObject({ agent: { id: 'agent_1' } });

    /* A new session's first message carries the manifest again. */
    expect((sentTo(fresh!)[0] as { content: Array<{ text: string }> }).content[0].text).toContain('src/main.ts\n');

    /* The old tail was billed once, under `<generation>_prior`. */
    const prior = (await rows()).filter((e) => String(e.generationId).endsWith('_prior'));

    expect(prior).toHaveLength(1);
    expect(prior[0].delta).toBeLessThan(0);
  });

  it('missing (404): a fresh session, nothing to settle for the old one', async () => {
    fake.script = answer;
    await bindChat('sesn_gone');

    const run = await drive(await turn());

    expect(run.error).toBeUndefined();
    expect((await getChatIndex().get(chatId))?.managedSessionId).not.toBe('sesn_gone');
    expect((await rows()).some((e) => String(e.generationId).endsWith('_prior'))).toBe(false);
  });

  it('CONTROL: a live session is REUSED — no new session, no interrupt', async () => {
    fake.script = answer;
    fake.seed('sesn_live', [
      { type: 'user.message', content: [] },
      { type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
    ]);
    await bindChat('sesn_live');

    await drive(await turn());

    expect((await getChatIndex().get(chatId))?.managedSessionId).toBe('sesn_live');
    expect(fake.sessions.size).toBe(1);
    expect(sentTo('sesn_live').map((e) => e.type)).toEqual(['user.message']);
  });

  it('a RESUME of a dead session is refused (409) and rebinds nothing — there is no turn to resume', async () => {
    await bindChat('sesn_gone');

    const error = await turn({ resume: true }).catch((e) => e);

    expect(error.statusCode).toBe(409);
    expect((await getChatIndex().get(chatId))?.managedSessionId).toBe('sesn_gone');
    expect(fake.sessions.size).toBe(0);
  });

  it('the release is compare-and-clear: a stale id cannot wipe a session another request already bound', async () => {
    await bindChat('sesn_new');

    expect(await getChatIndex().releaseManagedSession({ id: chatId, projectId: PROJECT, sessionId: 'sesn_old' })).toBe(
      false,
    );
    expect((await getChatIndex().get(chatId))?.managedSessionId).toBe('sesn_new');
    expect(await getChatIndex().releaseManagedSession({ id: chatId, projectId: PROJECT, sessionId: 'sesn_new' })).toBe(
      true,
    );
    expect((await getChatIndex().get(chatId))?.managedSessionId).toBeUndefined();
  });
});

describe('a new message SUPERSEDES a turn left waiting on tool results', () => {
  /* Turn one: a write the tab never answered (it closed). */
  async function leaveACallPending() {
    fake.script = async (api) => {
      api.modelRequest(USAGE_1);
      await api.callTool('project_write', { path: 'src/a.ts', content: 'a' });
      api.endTurn();
    };

    const controller = new AbortController();

    await drive(await turn({ abortSignal: controller.signal }), () => {
      controller.abort();
      return false;
    });

    fake.script = async (api) => {
      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'New request handled.' }] });
      api.endTurn();
    };
  }

  it('interrupts first (the API answers the pending call itself), THEN sends the new message', async () => {
    await leaveACallPending();

    const before = sentTo('sesn_1').length;
    const run = await drive(await turn({ messages: [userMessage('do something else')] }));

    expect(run.error).toBeUndefined();
    expect(run.text).toBe('New request handled.');
    expect(
      sentTo('sesn_1')
        .slice(before)
        .map((e) => e.type),
    ).toEqual(['user.interrupt', 'user.message']);
  });

  it('when the interrupt leaves the call pending, it is answered with an error before the new message', async () => {
    await leaveACallPending();
    fake.interruptAnswersCalls = false;

    const before = sentTo('sesn_1').length;
    const run = await drive(await turn({ messages: [userMessage('do something else')] }));
    const sent = sentTo('sesn_1').slice(before);

    expect(run.error).toBeUndefined();
    expect(sent.map((e) => e.type)).toEqual([
      'user.interrupt',
      'user.custom_tool_result',
      'user.interrupt',
      'user.message',
    ]);
    expect(sent[1]).toMatchObject({ is_error: true, content: [{ type: 'text', text: SUPERSEDED_RESULT }] });
  });

  it('CONTROL: a resume does NOT supersede — it answers the pending call', async () => {
    await leaveACallPending();

    const before = sentTo('sesn_1').length;

    await drive(await turn({ resume: true }));

    expect(
      sentTo('sesn_1')
        .slice(before)
        .map((e) => e.type),
    ).toEqual(['user.custom_tool_result']);
  });
});
