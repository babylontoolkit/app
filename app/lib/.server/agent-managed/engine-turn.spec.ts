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
import { FsGenerationStore, getGenerationStore, setGenerationStore } from '~/lib/.server/billing/generations';
import { isGenerationInFlight, isManagedTurnInFlight } from '~/lib/.server/billing/in-flight';
import { FsLedger, setLedger } from '~/lib/.server/billing/ledger';
import { rawCostUsd } from '~/lib/.server/billing/rates';
import { FsChatIndex, getChatIndex, setChatIndex } from '~/lib/.server/projects/chat-index';
import { getChat } from '~/lib/.server/projects/message-store';
import { setObjectStore, type ObjectStore } from '~/lib/.server/storage';
import { MANAGED_BUILD_OPEN } from '~/lib/agent/creation-plan';
import { interruptManagedTurn } from './control';
import { createManagedDispatcher } from './dispatch';
import { newWorkspaceTurnState, WorkspaceOverlay } from '~/lib/.server/agent/workspace-tools';
import { WORKSPACE_CHECK_TIMEOUT_MS } from '~/lib/agent/workspace-protocol-types';
import { setPromptStore, type PromptStore } from '~/lib/.server/prompt/store';
import type { AuthUser } from '~/lib/.server/supabase/auth';
import { describeTurnOutcome } from '~/lib/agent/turn-outcome';
import type { FileMap } from '~/lib/.server/llm/constants';
import { setManagedClientForTests } from './config';
import { runManagedGeneration } from './engine';
import { createFakeManagedClient, type FakeClient, type Script } from './fake-session.testkit';
import type { ManagedAgentRecord } from './record';
import { flushDetachedTail, settleManagedTurn, waitForDetachTails } from './settle';
import { releaseManagedSession } from './sessions';
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

  /* D2's background tail settlement: short here so a detached turn's tail never outlives its test. */
  vi.stubEnv('MANAGED_DETACH_SETTLE_WAIT_MS', '200');
  vi.stubEnv('MANAGED_DETACH_SETTLE_POLL_MS', '5');

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-turn-'));
  ledger = new FsLedger(path.join(tmp, 'ledger'));
  setLedger(ledger);
  setGenerationStore(new FsGenerationStore(path.join(tmp, 'generations')));
  setChatIndex(new FsChatIndex(path.join(tmp, 'chats')));
  setPromptStore({
    getActive: async () => ({ id: 'pv_test', managedAgents: { [RECORD.key]: RECORD } }),
    list: async () => [],
  } as unknown as PromptStore);

  /*
   * ⚠️ The engine writes the turn's transcript (T10) through `putChat`, whose object store falls back to
   * the developer's real `.data/storage` when unset — the first run of this file left seven chats there.
   */
  setObjectStore(memoryStore());

  fake = createFakeManagedClient();
  setManagedClientForTests(fake.client);
  chatId = randomUUID();
});

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

afterEach(async () => {
  /* A detached turn's background tail settlement (D2) finishes BEFORE the stores it writes are unpinned. */
  await waitForDetachTails();

  /* A detached turn's script waits forever on its unanswered call — by design; it is simply dropped. */
  setManagedClientForTests(undefined);
  setLedger(undefined);
  setGenerationStore(undefined);
  setChatIndex(undefined);
  setPromptStore(undefined);
  setObjectStore(undefined);
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
      agent: { type: 'agent_with_overrides', id: 'agent_1', version: 3, model: { effort: 'medium' } },
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

describe('the ledger note names what priced a managed charge (managed-billing-visibility D3)', () => {
  it('a managed settlement says "managed session", never "flat creation price"', async () => {
    fake.script = (async (api) => {
      api.modelRequest(USAGE_1);
      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'hi' }] });
      api.endTurn();
    }) satisfies Script;

    await drive(await turn());

    const debits = (await rows()).filter((e) => e.reason === 'generation');

    expect(debits).toHaveLength(1);
    expect(debits[0].note).toContain('managed session');
    expect(debits[0].note).not.toContain('flat creation price');
  });
});

describe('a detached turn settles its TAIL in the background (managed-billing-visibility D2)', () => {
  /*
   * The tab closes while the session is still RUNNING (a model request in flight). The detached request
   * settles what had accrued; the session then makes another request and idles on a tool call nobody
   * answers. Without a background tail settlement that second request is billed only if this chat is
   * ever settled again — a chat nobody reopens never pays for it.
   */
  let release: () => void;

  function scriptThatOutlivesTheTab(): Script {
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });

    return async (api) => {
      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Starting.' }] });
      api.modelRequest(USAGE_1);
      await released;
      api.modelRequest(USAGE_2);
      await api.callTool('project_write', { path: 'src/a.ts', content: 'a' });
    };
  }

  /** Run a turn and close the tab on its first narration. */
  async function detachOnFirstText() {
    const controller = new AbortController();
    const generation = await turn({ abortSignal: controller.signal });

    try {
      for await (const chunk of generation.textStream) {
        if (chunk.type === 'text') {
          controller.abort();
        }
      }
    } catch {
      // A detach may surface as the stream's abort — either way the turn settled in its finally.
    }

    await generation.settlement;

    return generation;
  }

  const charged = async () => (await rows()).filter((e) => e.reason === 'generation').map((e) => -e.delta);

  it('the usage the session runs AFTER the detach is billed once, when it idles', async () => {
    fake.script = scriptThatOutlivesTheTab();
    await detachOnFirstText();

    expect(await charged()).toEqual([creditsFor(USAGE_1)]);

    release();
    await waitForDetachTails();

    expect(await charged()).toEqual([creditsFor(USAGE_1), creditsFor(USAGE_2)]);
  });

  it('a resume that settled the tail FIRST leaves the background settlement nothing to charge', async () => {
    vi.stubEnv('MANAGED_DETACH_SETTLE_POLL_MS', '200');
    fake.script = scriptThatOutlivesTheTab();
    await detachOnFirstText();

    release();
    await new Promise((resolve) => setTimeout(resolve, 10));

    /* The reopened tab's settlement (what a resume runs at its end). */
    await settleManagedTurn({
      client: fake.client,
      sessionId: 'sesn_1',
      projectId: PROJECT,
      chatId,
      userId: USER.id,
      generationId: 'gen_resume',
      model: MODEL,
      statusKind: 'edit',
      sessionHourUsd: 0.08,
      context: {},
    });
    await waitForDetachTails();

    expect(await charged()).toEqual([creditsFor(USAGE_1), creditsFor(USAGE_2)]);
  });

  it('a session that never stops is settled at the deadline', async () => {
    vi.stubEnv('MANAGED_DETACH_SETTLE_WAIT_MS', '60');
    fake.script = (async (api) => {
      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Starting.' }] });
      api.modelRequest(USAGE_1);
      await new Promise(() => undefined);
    }) satisfies Script;
    await detachOnFirstText();

    /* Still running: a request ends after the detach, and the session never idles. */
    const session = fake.sessions.get('sesn_1')!;
    const at = new Date(Date.parse(session.events.at(-1)!.created_at!) + 500).toISOString();

    session.events.push({
      type: 'span.model_request_end',
      id: 'late',
      processed_at: at,
      created_at: at,
      model_usage: USAGE_2,
    });
    expect(session.status).toBe('running');

    await waitForDetachTails();

    expect(await charged()).toEqual([creditsFor(USAGE_1), creditsFor(USAGE_2)]);
  });

  it('a throwing retrieve never throws out of the background settlement', async () => {
    fake.script = scriptThatOutlivesTheTab();
    await detachOnFirstText();

    const sessions = fake.client.beta.sessions as unknown as { retrieve: () => Promise<never> };

    sessions.retrieve = async () => {
      throw new Error('anthropic is down');
    };
    release();

    await expect(waitForDetachTails()).resolves.toBeUndefined();
    expect(await charged()).toEqual([creditsFor(USAGE_1)]);
  });

  /*
   * Verifier finding: a tail still WAITING when the user starts a new turn on the same session would see
   * the new turn as `running`, and at its deadline bill part of the NEW turn under the old turn's id — so a
   * refund of the failed new turn refunded only its own share. A turn start flushes the pending tail first.
   */
  it('a new turn FLUSHES a pending tail: the tail bills only the old usage, the new turn only its own, and its refund is exact', async () => {
    vi.stubEnv('MANAGED_DETACH_SETTLE_POLL_MS', '60000');
    vi.stubEnv('MANAGED_DETACH_SETTLE_WAIT_MS', '1500');

    /* A balance to refund into (the ledger refuses a refund that would leave it negative). */
    await ledger.append({ userId: USER.id, delta: 10_000, reason: 'grant' });
    fake.script = scriptThatOutlivesTheTab();
    await detachOnFirstText();

    /* The old turn's post-detach request lands; the tail is asleep (long poll) and has not seen it. */
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await charged()).toEqual([creditsFor(USAGE_1)]);

    /* The new turn makes a request and then FAILS with nothing written — refund-eligible. */
    fake.script = (async (api) => {
      api.modelRequest(USAGE_3);
      api.emit({ type: 'session.status_terminated' });
    }) satisfies Script;

    const next = await drive(await turn({ messages: [userMessage('try again')] }));

    expect(next.error).toBeDefined();

    const all = await rows();
    const debits = all.filter((e) => e.reason === 'generation');
    const refunds = all.filter((e) => e.reason === 'refund');

    expect(debits.map((e) => -e.delta)).toEqual([creditsFor(USAGE_1), creditsFor(USAGE_2), creditsFor(USAGE_3)]);
    expect(debits[1].generationId).toMatch(/_tail$/);
    expect(refunds.map((e) => e.delta)).toEqual([creditsFor(USAGE_3)]);
    expect(refunds[0].generationId).toBe(debits[2].generationId);
  });

  it('CONTROL: with no pending tail a turn start flushes nothing and bills only its own usage', async () => {
    expect(await flushDetachedTail({ projectId: PROJECT, chatId })).toBe(false);

    fake.script = (async (api) => {
      api.modelRequest(USAGE_1);
      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'ok' }] });
      api.endTurn();
    }) satisfies Script;
    await drive(await turn());

    const debits = (await rows()).filter((e) => e.reason === 'generation');

    expect(debits.map((e) => -e.delta)).toEqual([creditsFor(USAGE_1)]);
    expect(debits.some((e) => e.generationId?.endsWith('_tail'))).toBe(false);
  });

  it('a flush after the tail already finished is a no-op', async () => {
    fake.script = scriptThatOutlivesTheTab();
    await detachOnFirstText();
    release();
    await waitForDetachTails();

    const before = await rows();

    expect(await flushDetachedTail({ projectId: PROJECT, chatId })).toBe(false);
    expect(await rows()).toEqual(before);
  });

  it('a chat moved to another session during the wait is never billed the old session again', async () => {
    vi.stubEnv('MANAGED_DETACH_SETTLE_POLL_MS', '200');
    fake.script = scriptThatOutlivesTheTab();
    await detachOnFirstText();

    /* A tier switch released the session (its own tail settled there) — the cursor went with it. */
    await releaseManagedSession(PROJECT, chatId, 'sesn_1', {});
    release();
    await waitForDetachTails();

    expect(await charged()).toEqual([creditsFor(USAGE_1)]);
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
  it('an error before any model request charges NOTHING (its session time is carried, never billed alone)', async () => {
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
    expect(await rows()).toEqual([]);
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

const creditsFor = (u: typeof USAGE_1) =>
  expectedCredits(
    {
      promptTokens: u.input_tokens,
      completionTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens,
      cacheCreationTokens: u.cache_creation_input_tokens,
    },
    0,
  );

describe('the transcript is written by the SERVER from the session events (T10)', () => {
  const DISTINCTIVE = 'const FILE_BODY_MARKER_90210 = "never in the transcript";';

  it('stores the narration with the route’s annotations — and never a tool input or file body', async () => {
    fake.script = (async (api) => {
      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Writing the kart.' }] });
      api.modelRequest(USAGE_1);
      await api.callTool('project_write', { path: 'src/Kart.ts', content: DISTINCTIVE });
      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Done.' }] });
      api.endTurn();
    }) satisfies Script;

    const run = await drive(await turn({ messages: [userMessage('build the kart')] }));

    expect(run.error).toBeUndefined();

    /* CONTROL: the write really carried the distinctive body to the browser… */
    expect(JSON.stringify(run.workspaceCalls)).toContain('FILE_BODY_MARKER_90210');

    const chat = await getChat(PROJECT, chatId);
    const stored = JSON.stringify(chat);
    const messages = chat!.messages as Array<{ id: string; role: string; content: string; annotations?: unknown[] }>;

    /* …and none of it reached the stored transcript. */
    expect(stored).not.toContain('FILE_BODY_MARKER_90210');
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0].content).toBe('build the kart');
    expect(messages[1].content).toBe(run.text);
    expect(messages[1].id.startsWith('managed-sevt_')).toBe(true);

    const meta = messages[1].annotations?.find((a) => (a as { type: string }).type === 'agentMeta') as {
      value: Record<string, unknown>;
    };

    expect(meta.value).toMatchObject({ engine: 'managed', generationId: run.generation.generationId });
    expect(messages[1].annotations?.map((a) => (a as { type: string }).type)).toEqual([
      'usage',
      'agentMeta',
      'agentWorkspace',
      'credits',
    ]);
  });

  it('a turn detached then RESUMED is ONE reply in the transcript — the resume replaces the partial', async () => {
    fake.script = (async (api) => {
      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Starting.' }] });
      api.modelRequest(USAGE_1);
      await api.callTool('project_write', { path: 'src/b.ts', content: 'b' });
      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Finished.' }] });
      api.endTurn();
    }) satisfies Script;

    const controller = new AbortController();

    await drive(await turn({ abortSignal: controller.signal, messages: [userMessage('go')] }), () => {
      controller.abort();
      return false;
    });

    /* Written by the DETACHED request — nobody was listening, and it is still on record. */
    const partial = (await getChat(PROJECT, chatId))!.messages as Array<{ id: string; content: string }>;

    expect(partial.at(-1)?.content).toBe('Starting.');

    /* The reopened tab re-posts with a DIFFERENT client message id; the reply id is the session's turn. */
    const resumed = await drive(await turn({ resume: true, messages: [userMessage('go')] }));

    expect(resumed.error).toBeUndefined();

    const final = (await getChat(PROJECT, chatId))!.messages as Array<{ id: string; role: string; content: string }>;

    expect(final.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(final).toHaveLength(partial.length);
    expect(final.at(-1)).toMatchObject({ id: partial.at(-1)!.id, content: 'Starting.\n\nFinished.' });
  });
});

describe('the first build is ONE managed turn (T9)', () => {
  const WORDS = 'Make me a simple 3D coin collector with a score HUD';

  it('sends the user’s words then every phase; a finished turn reports all phases completed, and engine=managed', async () => {
    fake.script = (async (api) => {
      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Built.' }] });
      api.endTurn();
    }) satisfies Script;

    const run = await drive(await turn({ owesBuild: true, messages: [userMessage(WORDS)] }));

    expect(run.error).toBeUndefined();

    const sent = (fake.sends[0].events[0] as { content: Array<{ text: string }> }).content[0].text;

    expect(sent).toContain(`${WORDS}\n\n${MANAGED_BUILD_OPEN}`);
    expect(run.generation.engine).toBe('managed');
    expect(run.generation.statusKind).toBe('creation');
    expect(await run.generation.creationPhasesCompleted).toEqual(['design', 'game', 'frontend']);
  });

  it('only the phases the ROW still owes — never the body’s creationPhase', async () => {
    fake.script = (async (api) => {
      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Built.' }] });
      api.endTurn();
    }) satisfies Script;

    const run = await drive(
      await turn({
        owesBuild: true,
        creationPlan: { v: 1, phases: ['design', 'game', 'frontend'], next: 1, done: [] },
        messages: [userMessage(WORDS)],
      }),
    );

    expect(await run.generation.creationPhasesCompleted).toEqual(['game', 'frontend']);
  });

  it('a FAILED first build reports no phases (the plan stays, Keep building continues it)', async () => {
    fake.script = (async (api) => {
      api.emit({ type: 'session.status_terminated' });
    }) satisfies Script;

    const run = await drive(await turn({ owesBuild: true, messages: [userMessage(WORDS)] }));

    expect(run.error).toBeDefined();
    expect(await run.generation.creationPhasesCompleted).toBeUndefined();
  });

  it('CONTROL: an ordinary edit carries no guidance and reports no phases', async () => {
    fake.script = (async (api) => {
      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'ok' }] });
      api.endTurn();
    }) satisfies Script;

    const run = await drive(await turn({ messages: [userMessage('faster')] }));
    const sent = (fake.sends[0].events[0] as { content: Array<{ text: string }> }).content[0].text;

    expect(sent).not.toContain(MANAGED_BUILD_OPEN);
    expect(await run.generation.creationPhasesCompleted).toBeUndefined();
  });
});

describe('Stop bills the stopped turn’s TAIL once (carried Phase B fix)', () => {
  it('a model request that ends after the detach is billed by the interrupt — and the next turn does not re-bill it', async () => {
    fake.script = (async (api) => {
      api.modelRequest(USAGE_1);
      await api.callTool('project_write', { path: 'src/a.ts', content: 'a' });
    }) satisfies Script;

    const controller = new AbortController();

    await drive(await turn({ abortSignal: controller.signal }), () => {
      controller.abort();
      return false;
    });

    expect((await rows()).map((e) => -e.delta)).toEqual([creditsFor(USAGE_1)]);

    /* The request that was running at the Stop finishes AFTER the turn's own settlement. */
    const session = fake.sessions.get('sesn_1')!;
    const at = new Date(Date.parse(session.events.at(-1)!.created_at!) + 500).toISOString();

    session.events.push({
      type: 'span.model_request_end',
      id: 'sevt_tail',
      processed_at: at,
      created_at: at,
      is_error: false,
      model_request_start_id: 'start',
      model_usage: { ...USAGE_2 },
    });

    await interruptManagedTurn({
      projectId: PROJECT,
      chatId,
      userId: USER.id,
      context: {},
      waitForSettlement: true,
      pollMs: 5,
    });

    expect((await rows()).map((e) => -e.delta)).toEqual([creditsFor(USAGE_1), creditsFor(USAGE_2)]);

    /* The next turn charges only its own usage — the cursor already covers the tail. */
    fake.script = (async (api) => {
      api.modelRequest(USAGE_3);
      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'ok' }] });
      api.endTurn();
    }) satisfies Script;

    const next = await drive(await turn({ messages: [userMessage('carry on')] }));

    expect((await next.generation.settlement)?.creditsCharged).toBe(creditsFor(USAGE_3));
    expect((await rows()).map((e) => -e.delta)).toEqual([
      creditsFor(USAGE_1),
      creditsFor(USAGE_2),
      creditsFor(USAGE_3),
    ]);
  });

  it('CONTROL: an interrupt with nothing new to bill writes no ledger row', async () => {
    fake.script = (async (api) => {
      api.modelRequest(USAGE_1);
      await api.callTool('project_write', { path: 'src/a.ts', content: 'a' });
    }) satisfies Script;

    const controller = new AbortController();

    await drive(await turn({ abortSignal: controller.signal }), () => {
      controller.abort();
      return false;
    });
    await interruptManagedTurn({
      projectId: PROJECT,
      chatId,
      userId: USER.id,
      context: {},
      waitForSettlement: true,
      pollMs: 5,
    });

    expect(await rows()).toHaveLength(1);
  });
});

describe('a browser that stops answering DETACHES the turn — never a tool failure (managed D6)', () => {
  it('relay timeout: no tool result, no interrupt, billed not refunded, outcome says resume', async () => {
    fake.script = (async (api) => {
      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Checking the game.' }] });
      api.modelRequest(USAGE_1);
      await api.callTool('check_game', {});
      api.endTurn();
    }) satisfies Script;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const generation = await turn();
      let asked = false;
      const running = drive(generation, () => {
        asked = true;
        return false;
      });

      /*
       * Advance only once the browser has been ASKED: the turn opens its durable `running` row first
       * (no-unbilled-usage D2, real file I/O), so the relay's timeout timer does not exist yet when `drive`
       * returns — advancing earlier would run the clock past a timer that was never set.
       */
      await vi.waitFor(() => expect(asked).toBe(true));
      await vi.advanceTimersByTimeAsync(WORKSPACE_CHECK_TIMEOUT_MS + 50);

      const run = await running;

      expect(run.error).toBeUndefined();

      const sent = fake.sends.flatMap((s) => s.events).map((e) => e.type);

      expect(sent).not.toContain('user.custom_tool_result');
      expect(sent).not.toContain('user.interrupt');

      const facts = await run.generation.outcome;

      expect(facts.stopReason).toBe('browser');
      expect(describeTurnOutcome(facts)).toMatchObject({ state: 'paused', resume: true });

      /* Billed for what it consumed; a detach is never refunded. */
      expect((await rows()).map((e) => e.reason)).toEqual(['generation']);

      /* The session is still waiting on the check — a live tab re-attaches to it. */
      expect(fake.sessions.get('sesn_1')!.events.at(-1)).toMatchObject({
        type: 'session.status_idle',
        stop_reason: { type: 'requires_action' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('CONTROL: a closed tab (request abort) is still the plain detach, not "browser"', async () => {
    fake.script = (async (api) => {
      api.modelRequest(USAGE_1);
      await api.callTool('check_game', {});
    }) satisfies Script;

    const controller = new AbortController();
    const run = await drive(await turn({ abortSignal: controller.signal }), () => {
      controller.abort();
      return false;
    });

    expect((await run.generation.outcome).stopReason).toBe('aborted');
    expect(describeTurnOutcome(await run.generation.outcome).resume).toBeUndefined();
  });
});

describe('MUTATING tool calls in one parallel batch run in order (T5 race)', () => {
  const TWO_LINES = {
    '/home/project/src/main.ts': { type: 'file', content: 'const a = 1;\nconst b = 2;\n', isBinary: false },
  } as unknown as FileMap;

  const editA = { path: 'src/main.ts', old_string: 'const a = 1;', new_string: 'const a = 10;' };
  const editB = { path: 'src/main.ts', old_string: 'const b = 2;', new_string: 'const b = 20;' };

  it('two project_edits on one file in one batch BOTH land, and both results are sent', async () => {
    fake.script = (async (api) => {
      /* Both calls are emitted before either is answered — one parallel batch. */
      await Promise.all([api.callTool('project_edit', editA), api.callTool('project_edit', editB)]);
      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Both edited.' }] });
      api.endTurn();
    }) satisfies Script;

    /* A SLOW browser: each write is answered 20ms later, so the second edit arrives while the first is in flight. */
    const generation = await turn({ files: TWO_LINES });
    const run = await drive(generation, (call) => {
      setTimeout(
        () =>
          deliverClientToolResult({
            generationId: generation.generationId,
            toolCallId: call.toolCallId,
            userId: USER.id,
            result: { ok: true },
          }),
        20,
      );

      return false;
    });

    expect(run.error).toBeUndefined();
    expect(run.workspaceCalls).toHaveLength(2);

    const last = run.workspaceCalls.at(-1)!.params as { content: string };

    expect(last.content).toContain('const a = 10;');
    expect(last.content).toContain('const b = 20;');

    const results = fake.sends.flatMap((s) => s.events).filter((e) => e.type === 'user.custom_tool_result');

    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.is_error)).toBe(true);
  });

  it('a mutating call still QUEUED when the turn detaches never reaches the browser', async () => {
    fake.script = (async (api) => {
      await Promise.all([api.callTool('project_edit', editA), api.callTool('project_edit', editB)]);
    }) satisfies Script;

    const controller = new AbortController();
    const run = await drive(await turn({ files: TWO_LINES, abortSignal: controller.signal }), () => {
      /* The tab closes while the FIRST edit is with the browser; the second is still queued behind it. */
      controller.abort();
      return false;
    });

    expect(run.workspaceCalls).toHaveLength(1);
    expect(fake.sends.flatMap((s) => s.events).map((e) => e.type)).not.toContain('user.custom_tool_result');
  });

  it('CONTROL: the same two edits dispatched CONCURRENTLY (the old path) lose one', async () => {
    const writes: Array<{ content: string }> = [];
    const generationId = 'gen_race_control';
    const dispatcher = createManagedDispatcher({
      generationId,
      userId: USER.id,
      files: TWO_LINES,
      overlay: new WorkspaceOverlay(TWO_LINES),
      state: newWorkspaceTurnState(),
      emitWorkspace: (event) => {
        writes.push(event.params as { content: string });
        queueMicrotask(() =>
          deliverClientToolResult({
            generationId,
            toolCallId: event.toolCallId,
            userId: USER.id,
            result: { ok: true },
          }),
        );
      },
      emitPreview: () => undefined,
      emitTodos: () => undefined,
    });

    await Promise.all([
      dispatcher.dispatch({ id: 'a', name: 'project_edit', input: editA }),
      dispatcher.dispatch({ id: 'b', name: 'project_edit', input: editB }),
    ]);

    const last = writes.at(-1)!.content;

    expect(last.includes('const a = 10;') && last.includes('const b = 20;')).toBe(false);
  });
});

describe('session-hours are never settled ALONE (verifier finding: a 1-credit Stop tail)', () => {
  it('a zero-request Stop tail writes NO row, and the next real turn charges the carried seconds', async () => {
    fake.script = (async (api) => {
      api.modelRequest(USAGE_1);
      await api.callTool('project_write', { path: 'src/a.ts', content: 'a' });
    }) satisfies Script;

    const controller = new AbortController();

    await drive(await turn({ abortSignal: controller.signal }), () => {
      controller.abort();
      return false;
    });

    const afterTurn = await rows();

    /* The Stop: the session ran a little longer, but made NO model request. */
    fake.sessions.get('sesn_1')!.activeSeconds += 180;

    const generationsBefore = (await fs.readdir(path.join(tmp, 'generations')).catch(() => [])).length;

    await interruptManagedTurn({
      projectId: PROJECT,
      chatId,
      userId: USER.id,
      context: {},
      waitForSettlement: true,
      pollMs: 5,
    });

    expect(await rows()).toEqual(afterTurn);
    expect((await fs.readdir(path.join(tmp, 'generations')).catch(() => [])).length).toBe(generationsBefore);

    /* The next turn has real usage: it charges its own tokens PLUS the 180 carried seconds. */
    fake.script = (async (api) => {
      api.modelRequest(USAGE_3);
      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'ok' }] });
      api.endTurn();
    }) satisfies Script;

    const next = await drive(await turn({ messages: [userMessage('carry on')] }));
    const carriedUsd = (180 / 3600) * 0.08;

    expect((await next.generation.settlement)?.creditsCharged).toBe(
      expectedCredits(
        {
          promptTokens: USAGE_3.input_tokens,
          completionTokens: USAGE_3.output_tokens,
          cacheReadTokens: USAGE_3.cache_read_input_tokens,
          cacheCreationTokens: 0,
        },
        carriedUsd,
      ),
    );
  });

  it('CONTROL: with model usage, session-hours settle alongside it as before', async () => {
    fake.script = (async (api) => {
      api.modelRequest(USAGE_1);
      api.addActiveSeconds(1800);
      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'ok' }] });
      api.endTurn();
    }) satisfies Script;

    const run = await drive(await turn());

    expect((await run.generation.settlement)?.creditsCharged).toBe(
      expectedCredits(
        {
          promptTokens: USAGE_1.input_tokens,
          completionTokens: USAGE_1.output_tokens,
          cacheReadTokens: USAGE_1.cache_read_input_tokens,
          cacheCreationTokens: USAGE_1.cache_creation_input_tokens,
        },
        0.04,
      ),
    );
  });
});

describe('the status panel sees the turn’s live step (owner, 2026-10-02)', () => {
  it('the generation reports each step the session is in, observed from its events', async () => {
    const seen: Array<string | undefined> = [];
    let generation: AgentGeneration | null = null;

    fake.script = (async (api) => {
      api.emit({ type: 'event_start', event: { type: 'agent.thinking', id: 'th1' } });
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(generation?.currentStep?.()?.label);
      api.emit({ type: 'agent.thinking' });
      await api.callTool('project_write', { path: 'src/scripts/Drift.ts', content: 'export const d = 1;' });

      /* The result event reaches the engine through the stream, a tick after the fake resolves the call. */
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(generation?.currentStep?.()?.label);
      api.endTurn();
    }) satisfies Script;

    generation = await turn();
    generation.onWorkspaceToolCall(() => seen.push(generation?.currentStep?.()?.label));

    const run = await drive(generation);

    expect(run.error).toBeUndefined();
    expect(seen).toEqual(['Thinking', 'Writing src/scripts/Drift.ts', 'Working out the next step']);
  });
});

describe('the status panel sees the turn’s running cost (managed-billing-visibility D1)', () => {
  it('the estimate shown during the turn is what the turn then settles — and nothing is written while it runs', async () => {
    let shown: number | null | undefined;
    let rowsWhileRunning = -1;
    let generation: AgentGeneration | null = null;

    fake.script = (async (api) => {
      api.modelRequest(USAGE_1);

      /* The session reports its cumulative usage (the live API sends `session.usage` at each idle). */
      const usage = USAGE_1;
      api.emit({
        type: 'session.usage',
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens,
          cache_creation: { ephemeral_5m_input_tokens: usage.cache_creation_input_tokens },
          active_seconds: 0,
          list_cost: { amount: '0', currency: 'USD' },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      shown = generation?.currentCreditsEstimate?.();
      rowsWhileRunning = (await rows()).length;
      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'ok' }] });
      api.endTurn();
    }) satisfies Script;

    generation = await turn();

    const run = await drive(generation);
    const settled = (await run.generation.settlement)?.creditsCharged;

    expect(rowsWhileRunning).toBe(0);
    expect(settled).toBeGreaterThan(0);
    expect(shown).toBe(settled);
  });
});

/*
 * no-unbilled-usage D2 (T2): a managed turn's `generations` row exists, `running`, BEFORE the session
 * receives the turn's message — so a process that dies mid-turn leaves a record the sweep can find — and
 * the turn's own settlement finishes THAT row exactly once.
 */
describe('the running row (no-unbilled-usage D2)', () => {
  it('exists before the first event, names the engine and session, and settles once to completed', async () => {
    let seen: Array<{ id: string; status?: string; engine?: string; managedSessionId?: string }> = [];
    let inFlightDuringTurn = false;
    let generationInFlight = false;
    let generationId = '';
    const upserts: Array<Record<string, unknown>> = [];
    const store = getGenerationStore();
    const upsert = store.upsert.bind(store);

    store.upsert = async (row) => {
      upserts.push({ ...row });
      return upsert(row);
    };

    fake.script = (async (api) => {
      generationInFlight = isGenerationInFlight(generationId);
      seen = (await getGenerationStore().list()).map((r) => ({
        id: r.id,
        status: r.status,
        engine: r.engine,
        managedSessionId: r.managedSessionId,
      }));
      inFlightDuringTurn = isManagedTurnInFlight(chatId);
      api.modelRequest(USAGE_1);
      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'ok' }] });
      api.endTurn();
    }) satisfies Script;

    const generation = await turn();
    generationId = generation.generationId;

    const run = await drive(generation);

    expect(run.error).toBeUndefined();

    /* Slip 1: the managed GENERATION is tracked too, so sweep (a) never flips its row mid-turn. */
    expect(generationInFlight).toBe(true);
    expect(isGenerationInFlight(generationId)).toBe(false);

    /* Slip 2: settlement's own write names the project and chat, so the Postgres upsert cannot erase them. */
    const settlementWrite = upserts.find(
      (u) => u.status === 'completed' && u.rawCostUsd !== undefined && u.durationMs === undefined,
    );
    expect(settlementWrite).toMatchObject({ projectId: PROJECT, chatId });

    expect(seen).toEqual([
      expect.objectContaining({ id: generation.generationId, status: 'running', engine: 'managed' }),
    ]);
    expect(seen[0].managedSessionId).toMatch(/^sesn_/);
    expect(inFlightDuringTurn).toBe(true);
    expect(isManagedTurnInFlight(chatId)).toBe(false);

    const all = await getGenerationStore().list();
    const mine = all.filter((r) => r.id === generation.generationId);

    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'completed', engine: 'managed' });

    const debits = (await rows()).filter((e) => e.generationId === generation.generationId);
    expect(debits).toHaveLength(1);
  });
});
