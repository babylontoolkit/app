/**
 * The user's effort on the managed engine (`_specs/effort-selector_plan.md` T4, D1–D4, D11).
 *
 * Effort is pinned on a session at create (`agent_with_overrides` + `model.effort`) and cannot change for
 * the session's life, so a mid-chat effort change MOVES the chat to a new session exactly like a tier
 * change: the old session archived, the new session's first message recapping the conversation. A RESUME
 * never switches. This shipped broken once already — `ManagedTurnRequest.effort` was declared and nothing
 * read it, so every build turn ran at the deploy-wide `MANAGED_AGENT_EFFORT` whatever the user picked —
 * and the failure is silent (the turn runs, just at the wrong effort), which is why each case is pinned.
 *
 * Everything real except Anthropic (a scripted fake session), with every store pinned to a throwaway
 * directory and every env var the engine reads stubbed (`env()` falls back to `.env.local`).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGeneration } from '~/lib/.server/agent/proxy';
import { FsGenerationStore, getGenerationStore, setGenerationStore } from '~/lib/.server/billing/generations';
import { FsLedger, setLedger } from '~/lib/.server/billing/ledger';
import { FsChatIndex, setChatIndex } from '~/lib/.server/projects/chat-index';
import { setPromptStore, type PromptStore } from '~/lib/.server/prompt/store';
import { setSkillStore, type SkillStore } from '~/lib/.server/skills/store';
import { setObjectStore, type ObjectStore } from '~/lib/.server/storage';
import type { AuthUser } from '~/lib/.server/supabase/auth';
import type { FileMap } from '~/lib/.server/llm/constants';
import { setManagedClientForTests } from './config';
import { runManagedGeneration, sessionSwitchReason } from './engine';
import { createFakeManagedClient, type FakeClient } from './fake-session.testkit';
import type { ManagedAgentRecord } from './record';

const STANDARD = 'claude-sonnet-5-5';
const PREMIUM = 'claude-opus-5-5';
const PLATINUM = 'claude-fable-5-1';

const USER: AuthUser = {
  id: '33333333-3333-4333-8333-333333333333',
  email: 'dev@example.com',
  emailVerified: true,
  displayName: 'Dev',
  isAdmin: false,
} as AuthUser;
const PROJECT = 'prj_managed_effort';

const record = (model: string, agentId: string): ManagedAgentRecord => ({
  key: `${model}:medium`,
  agentId,
  agentVersion: 1,
  hash: `h_${agentId}`,
  agentHash: `ah_${agentId}`,
  environmentId: 'env_1',
  model,
  effort: 'medium',
  referenceSha: 'abc',
  referenceFiles: [{ rel: 'reference.md', fileId: 'file_ref' }],
  skills: [],
  provisionedAt: '2026-10-01T00:00:00Z',
});

const AGENTS = {
  [STANDARD]: record(STANDARD, 'agent_standard'),
  [PREMIUM]: record(PREMIUM, 'agent_premium'),
  [PLATINUM]: record(PLATINUM, 'agent_platinum'),
};

const FILES = {
  '/home/project/src/main.ts': { type: 'file', content: 'console.log(1);\n', isBinary: false },
} as unknown as FileMap;

let tmp: string;
let fake: FakeClient;
let ledger: FsLedger;
let chatId: string;
let provisioned: Record<string, ManagedAgentRecord>;

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
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-real');
  vi.stubEnv('LLM_MODEL', STANDARD);
  vi.stubEnv('PREMIUM_MODEL', PREMIUM);
  vi.stubEnv('PLATINUM_MODEL', PLATINUM);
  vi.stubEnv('ENABLE_EXTENDED_MODELS', 'true');
  vi.stubEnv('ENABLE_PLATINUM_MODEL', 'true');
  vi.stubEnv('PREMIUM_MINIMUM_CREDITS', '100');
  vi.stubEnv('PLATINUM_MINIMUM_CREDITS', '100');
  vi.stubEnv('MANAGED_AGENT_EFFORT', 'medium');
  vi.stubEnv('MANAGED_SESSION_HOUR_USD', '0');
  vi.stubEnv('BILLING_ENFORCED', 'false');
  vi.stubEnv('CREDIT_UNIT_COST_USD', '0.01');
  vi.stubEnv('CREDIT_MARGIN', '4');
  vi.stubEnv('AGENT_TURN_MAX_CREDITS', '1000');
  vi.stubEnv('LLM_PROVIDER', 'Anthropic');
  vi.stubEnv('MANAGED_SUPERSEDE_WAIT_MS', '50');
  vi.stubEnv('ENABLE_MAX_EFFORT', 'false');

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-effort-'));
  ledger = new FsLedger(path.join(tmp, 'ledger'));
  setLedger(ledger);
  setGenerationStore(new FsGenerationStore(path.join(tmp, 'generations')));
  setChatIndex(new FsChatIndex(path.join(tmp, 'chats')));
  setObjectStore(memoryStore());

  /* No skills: an on-demand provisioning must never read the developer's real skill store. */
  setSkillStore({ listActive: async () => [], readResource: async () => null } as unknown as SkillStore);

  provisioned = {
    [AGENTS[STANDARD].key]: AGENTS[STANDARD],
    [AGENTS[PREMIUM].key]: AGENTS[PREMIUM],
    [AGENTS[PLATINUM].key]: AGENTS[PLATINUM],
  };
  setPromptStore({
    getActive: async () => ({ id: 'pv_test', sourceCommitSha: 'abc', managedAgents: provisioned }),
    list: async () => [],
    recordManagedAgent: async () => undefined,
  } as unknown as PromptStore);

  fake = createFakeManagedClient(async (api) => {
    api.modelRequest({ input_tokens: 1000, output_tokens: 1000 });
    api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Done.' }] });
    api.endTurn();
  });
  fake.agentModels = { agent_standard: STANDARD, agent_premium: PREMIUM, agent_platinum: PLATINUM };
  setManagedClientForTests(fake.client);
  chatId = randomUUID();

  /* Enough credits to clear the paid rungs' 100-credit threshold. */
  await ledger.append({ userId: USER.id, delta: 5000, reason: 'adjustment', note: 'test' });
});

afterEach(async () => {
  setManagedClientForTests(undefined);
  setLedger(undefined);
  setGenerationStore(undefined);
  setChatIndex(undefined);
  setPromptStore(undefined);
  setSkillStore(undefined);
  setObjectStore(undefined);
  vi.unstubAllEnvs();
  await fs.rm(tmp, { recursive: true, force: true });
});

const user = (text: string) => ({ id: `u${Math.random()}`, role: 'user' as const, content: text });

async function drain(generation: AgentGeneration): Promise<Error | undefined> {
  try {
    let chunks = 0;

    for await (const chunk of generation.textStream) {
      chunks += chunk ? 1 : 0;
    }

    void chunks;
  } catch (error) {
    return error as Error;
  }

  return undefined;
}

const turn = async (effort: string | undefined, messages = [user('make the kart drift')]) => {
  const generation = await runManagedGeneration({
    messages,
    files: FILES,
    chatId,
    projectId: PROJECT,
    user: USER,
    context: {},
    tier: 'standard',
    effort,
  });
  const error = await drain(generation);
  await fake.idle();

  return { generation, error };
};

type AgentParams = { type: string; id: string; version: number; model?: { id: string; effort: string } };

const agentOf = (sessionId: string) => fake.sessions.get(sessionId)?.createParams.agent as AgentParams;
const sessionIds = () => [...fake.sessions.keys()];

describe('a new session is created at the user’s effort', () => {
  it('uses agent_with_overrides with model.id + model.effort, and keeps the budget ON CREATE', async () => {
    const { generation, error } = await turn('xhigh');

    expect(error).toBeUndefined();

    const [id] = sessionIds();
    const agent = agentOf(id);

    expect(agent.type).toBe('agent_with_overrides');
    expect(agent.id).toBe('agent_standard');
    expect(agent.version).toBe(1);
    expect(agent.model).toEqual({ id: STANDARD, effort: 'xhigh' });

    /* T1 Finding: a session created without a budget can never gain one. */
    expect(fake.sessions.get(id)?.createParams.budget).toBeTruthy();

    expect(generation.effort).toBe('xhigh');
  });

  it('records the served effort on the generation row', async () => {
    await turn('high');

    const [row] = await getGenerationStore().list();

    expect(row?.effort).toBe('high');
  });

  it.each([
    ['low', 'medium'],
    ['HIGHH', 'medium'],
    [undefined, 'medium'],
    ['max', 'medium'],
  ])('effort %s (Max switched off) serves the operator default (%s)', async (requested, served) => {
    await turn(requested);

    expect(agentOf(sessionIds()[0]).model?.effort).toBe(served);
  });

  it('the operator default is MANAGED_AGENT_EFFORT when the user chose nothing', async () => {
    vi.stubEnv('MANAGED_AGENT_EFFORT', 'high');

    /* The operator default is also the provisioned agent's effort (records are keyed `${model}:${effort}`). */
    provisioned[`${STANDARD}:high`] = {
      ...AGENTS[STANDARD],
      key: `${STANDARD}:high`,
      agentId: 'agent_standard_high',
      effort: 'high',
    };
    fake.agentModels.agent_standard_high = STANDARD;

    await turn(undefined);

    expect(agentOf(sessionIds()[0]).model?.effort).toBe('high');
  });

  it('max is served only when ENABLE_MAX_EFFORT=true', async () => {
    vi.stubEnv('ENABLE_MAX_EFFORT', 'true');

    const { generation } = await turn('max');

    expect(agentOf(sessionIds()[0]).model?.effort).toBe('max');
    expect(generation.effort).toBe('max');
  });
});

describe('changing effort mid-chat moves the chat to a new session', () => {
  it('a new session at the new effort, the old one archived, the conversation recapped', async () => {
    await turn('medium', [user('FIRST_ASK make a racer')]);

    const [first] = sessionIds();

    const second = await turn('high', [
      user('FIRST_ASK make a racer'),
      { id: 'a1', role: 'assistant' as const, content: 'FIRST_REPLY built it' } as never,
      user('SECOND_ASK add drifting'),
    ]);

    expect(second.error).toBeUndefined();

    const sessions = sessionIds();
    expect(sessions).toHaveLength(2);
    expect(agentOf(sessions[1]).model?.effort).toBe('high');
    expect(fake.archived).toEqual([first]);
    expect(second.generation.effort).toBe('high');

    const sent = fake.sends.filter((s) => s.sessionId === sessions[1]).flatMap((s) => s.events);
    const text = JSON.stringify(sent.find((e) => e.type === 'user.message'));
    expect(text).toContain('FIRST_ASK');
    expect(text).toContain('FIRST_REPLY');
    expect(text).toContain('SECOND_ASK');
  });

  it('CONTROL: the same effort again reuses the chat’s session', async () => {
    await turn('xhigh');
    await turn('xhigh');

    expect(fake.sessions.size).toBe(1);
    expect(fake.archived).toEqual([]);
  });

  it('CONTROL: low / garbage serve the default and do not move a medium session', async () => {
    await turn('medium');
    await turn('low');
    await turn('nonsense');
    await turn(undefined);

    expect(fake.sessions.size).toBe(1);
    expect(fake.archived).toEqual([]);
  });

  it('a session created before overrides (plain `agent`) runs at its agent’s effort — medium stays, high moves', async () => {
    await turn('medium');

    /* Rewrite the session as an old one: plain `agent`, no override — it reads back its agent's effort. */
    const [old] = sessionIds();
    fake.sessions.get(old)!.createParams.agent = { type: 'agent', id: 'agent_standard', version: 1 };

    await turn('medium');
    expect(fake.archived).toEqual([]);

    await turn('high');
    expect(fake.archived).toEqual([old]);
    expect(agentOf(sessionIds()[1]).model?.effort).toBe('high');
  });

  it('a RESUME never switches — it re-attaches at the session’s own effort', async () => {
    fake.script = async (api) => {
      api.modelRequest({ input_tokens: 10, output_tokens: 10 });
      await api.callTool('project_list', {});
      api.endTurn();
    };

    const controller = new AbortController();
    const generation = await runManagedGeneration({
      messages: [user('make it')],
      files: FILES,
      chatId,
      projectId: PROJECT,
      user: USER,
      context: {},
      tier: 'standard',
      effort: 'medium',
      abortSignal: controller.signal,
    });
    generation.onWorkspaceToolCall(() => controller.abort());
    await drain(generation);

    const resumed = await runManagedGeneration({
      messages: [user('make it')],
      files: FILES,
      chatId,
      projectId: PROJECT,
      user: USER,
      context: {},
      tier: 'standard',
      effort: 'xhigh',
      resume: true,
      abortSignal: AbortSignal.timeout(500),
    });

    expect(fake.sessions.size).toBe(1);
    expect(fake.archived).toEqual([]);
    expect(resumed.effort).toBe('medium');
    await drain(resumed);
  });
});

describe('sessionSwitchReason', () => {
  const agent = { model: STANDARD, effort: 'medium' as const };

  it('null for the same model and effort; null for a dead inspection', () => {
    expect(sessionSwitchReason({ kind: 'live', model: STANDARD, effort: 'medium' }, agent, 'medium')).toBeNull();
    expect(sessionSwitchReason({ kind: 'dead' }, agent, 'high')).toBeNull();
  });

  it('names a model change and an effort change', () => {
    expect(sessionSwitchReason({ kind: 'live', model: PREMIUM, effort: 'medium' }, agent, 'medium')).toContain('model');
    expect(sessionSwitchReason({ kind: 'live', model: STANDARD, effort: 'medium' }, agent, 'max')).toContain(
      'effort medium → max',
    );
  });

  it('an unreported effort compares at the agent’s provisioned effort', () => {
    expect(sessionSwitchReason({ kind: 'live', model: STANDARD }, agent, 'medium')).toBeNull();
    expect(sessionSwitchReason({ kind: 'live', model: STANDARD }, agent, 'high')).toContain('effort');
  });
});
