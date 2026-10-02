/**
 * The model tier ladder on the managed engine (§4.6.1a): Standard / Premium / Platinum are three
 * provisioned agents, and the user's pick decides which one a turn runs.
 *
 * A session's model is fixed for its life (only `tools`/`mcp_servers` are updatable on a live session),
 * so a mid-chat tier change MOVES the chat to a new session on the new tier's agent: the old turn's tail
 * is billed at the OLD model, the old session archived, and the new session's first message recaps the
 * conversation. Every failure here is silent — the turn runs, just on the wrong model or at the wrong
 * price — which is why each is pinned.
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
import { runManagedGeneration } from './engine';
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
const PROJECT = 'prj_managed_tier';

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

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-tier-'));
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

const turn = async (tier: string | undefined, messages = [user('make the kart drift')], resume = false) => {
  const generation = await runManagedGeneration({
    messages,
    files: FILES,
    chatId,
    projectId: PROJECT,
    user: USER,
    context: {},
    tier,
    resume,
  });
  const error = await drain(generation);
  await fake.idle();

  return { generation, error };
};

const agentOf = (sessionId: string) => (fake.sessions.get(sessionId)?.createParams.agent as { id: string }).id;

describe('the managed engine honours the model tier', () => {
  it.each([
    [undefined, 'standard', STANDARD, 'agent_standard'],
    ['standard', 'standard', STANDARD, 'agent_standard'],
    ['premium', 'premium', PREMIUM, 'agent_premium'],
    ['platinum', 'platinum', PLATINUM, 'agent_platinum'],
  ])('tier %s → runs the %s agent (%s)', async (requested, tier, model, agentId) => {
    const { generation, error } = await turn(requested);

    expect(error).toBeUndefined();
    expect(generation.tier).toBe(tier);
    expect(generation.model).toBe(model);
    expect(agentOf([...fake.sessions.keys()][0])).toBe(agentId);

    /* Billed at the rung that RAN — never at LLM_MODEL. */
    const generations = await getGenerationStore().list();
    expect(generations[0]?.model).toBe(model);
  });

  it('a paid rung the balance cannot reach runs Standard and says why', async () => {
    vi.stubEnv('PREMIUM_MINIMUM_CREDITS', '999999');

    const { generation } = await turn('premium');

    expect(generation.tier).toBe('standard');
    expect(generation.tierReason).toBe('below_minimum');
    expect(generation.model).toBe(STANDARD);
    expect(generation.notice).toContain('credits');
  });

  it('a rung switched off by its flag resolves down to Standard (never an error)', async () => {
    vi.stubEnv('ENABLE_PLATINUM_MODEL', 'false');

    const { generation, error } = await turn('platinum');

    expect(error).toBeUndefined();
    expect(generation.tier).toBe('standard');
    expect(agentOf([...fake.sessions.keys()][0])).toBe('agent_standard');
  });

  it('a paid rung that cannot be provisioned runs Standard with a notice — never a failed turn', async () => {
    delete provisioned[AGENTS[PREMIUM].key];

    /* The fake has no `agents`/`environments` API, so on-demand provisioning fails — the real outage shape. */
    const { generation, error } = await turn('premium');

    expect(error).toBeUndefined();
    expect(generation.tier).toBe('standard');
    expect(generation.tierReason).toBe('unavailable');
    expect(generation.notice).toContain('not available');
    expect(agentOf([...fake.sessions.keys()][0])).toBe('agent_standard');
  });
});

describe('changing tier mid-chat moves the chat to that tier’s agent', () => {
  it('a new session on the new agent, the old one archived, the conversation recapped', async () => {
    await turn('standard', [user('FIRST_ASK make a racer')]);

    const [first] = [...fake.sessions.keys()];

    const second = await turn('premium', [
      user('FIRST_ASK make a racer'),
      { id: 'a1', role: 'assistant' as const, content: 'FIRST_REPLY built it' } as never,
      user('SECOND_ASK add drifting'),
    ]);

    expect(second.error).toBeUndefined();
    expect(second.generation.tier).toBe('premium');

    const sessions = [...fake.sessions.keys()];
    expect(sessions).toHaveLength(2);
    expect(agentOf(sessions[1])).toBe('agent_premium');
    expect(fake.archived).toEqual([first]);

    const sent = fake.sends.filter((s) => s.sessionId === sessions[1]).flatMap((s) => s.events);
    const text = JSON.stringify(sent.find((e) => e.type === 'user.message'));
    expect(text).toContain('FIRST_ASK');
    expect(text).toContain('FIRST_REPLY');
    expect(text).toContain('SECOND_ASK');
  });

  it('each part of the chat is billed at the model that ran it', async () => {
    await turn('standard');
    await turn('platinum');

    const models = (await getGenerationStore().list()).map((row) => row.model).sort();

    expect(models).toEqual([PLATINUM, STANDARD].sort());
  });

  it('CONTROL: the same tier again reuses the chat’s session', async () => {
    await turn('premium');
    await turn('premium');

    expect(fake.sessions.size).toBe(1);
    expect(fake.archived).toEqual([]);
  });

  it('a RESUME never switches — it re-attaches to the waiting turn on its own model', async () => {
    fake.script = async (api) => {
      api.modelRequest({ input_tokens: 10, output_tokens: 10 });
      await api.callTool('project_list', {});
      api.endTurn();
    };

    /* The tab closes mid-turn: the call stays unanswered at `requires_action`. */
    const controller = new AbortController();
    const generation = await runManagedGeneration({
      messages: [user('make it')],
      files: FILES,
      chatId,
      projectId: PROJECT,
      user: USER,
      context: {},
      tier: 'standard',
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
      tier: 'premium',
      resume: true,
      abortSignal: AbortSignal.timeout(500),
    });

    expect(fake.sessions.size).toBe(1);
    expect(fake.archived).toEqual([]);
    expect(resumed.model).toBe(STANDARD);
    await drain(resumed);
  });
});
