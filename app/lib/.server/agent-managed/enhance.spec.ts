/**
 * The prompt enhancer on Managed Agents (`enhance.ts`, `_specs/managed-only_plan.md` D8–D10).
 *
 * Everything real except Anthropic (a scripted fake session): the credit gate, the ledger, the generation
 * store and the billing formula — each pinned to a throwaway directory. `env()` falls back to `process.env`
 * (vitest loads `.env.local`, which holds a REAL key), so every variable read is stubbed.
 *
 * The money properties, each silent when wrong: no session before the gate allows; a `running` row naming
 * the session before the first message; the whole session billed once at the documented formula; a failure
 * refunded; the session archived only once it is settled.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsGenerationStore, getGenerationStore, setGenerationStore } from '~/lib/.server/billing/generations';
import { FsLedger, setLedger } from '~/lib/.server/billing/ledger';
import { setPromptStore, type PromptStore } from '~/lib/.server/prompt/store';
import type { AuthUser } from '~/lib/.server/supabase/auth';
import { setManagedClientForTests } from './config';
import { ENHANCER_SYSTEM, runManagedEnhancement } from './enhance';
import { createFakeManagedClient, type FakeClient, type Script } from './fake-session.testkit';
import type { ManagedAgentRecord } from './record';

const MODEL = 'claude-sonnet-5-5';
const ENHANCER_MODEL = 'claude-haiku-4-5';
const USER: AuthUser = {
  id: '33333333-3333-4333-8333-333333333333',
  email: 'dev@example.com',
  emailVerified: true,
  displayName: 'Dev',
  isAdmin: false,
} as AuthUser;

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
  skills: [{ name: 'bt-design', skillId: 'skill_1', version: 'v1', contentHash: 'c' }],
  provisionedAt: '2026-10-01T00:00:00Z',
};

let tmp: string;
let fake: FakeClient;
let ledger: FsLedger;

beforeEach(async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-real');
  vi.stubEnv('LLM_MODEL', MODEL);
  vi.stubEnv('ENHANCE_PROMPT_MODEL', ENHANCER_MODEL);
  vi.stubEnv('ANTHROPIC_ENHANCE_PROMPT_MODEL', '');
  vi.stubEnv('MANAGED_AGENT_EFFORT', 'medium');
  vi.stubEnv('MANAGED_SESSION_HOUR_USD', '0.08');
  vi.stubEnv('BILLING_ENFORCED', 'false');
  vi.stubEnv('CREDIT_UNIT_COST_USD', '0.01');
  vi.stubEnv('CREDIT_MARGIN', '4');
  vi.stubEnv('AGENT_TURN_MAX_CREDITS', '1000');
  vi.stubEnv('LLM_PROVIDER', 'Anthropic');
  vi.stubEnv('AUTO_MODEL_SELECT', 'false');

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-enhance-'));
  ledger = new FsLedger(path.join(tmp, 'ledger'));
  setLedger(ledger);
  setGenerationStore(new FsGenerationStore(path.join(tmp, 'generations')));
  setPromptStore({
    getActive: async () => ({ id: 'pv_test', managedAgents: { [RECORD.key]: RECORD } }),
    list: async () => [],
  } as unknown as PromptStore);

  fake = createFakeManagedClient();

  /* The session reports the model it RUNS — the enhancer override — so settlement prices it at Haiku's rates. */
  fake.agentModels = { agent_1: ENHANCER_MODEL };
  setManagedClientForTests(fake.client);
});

afterEach(async () => {
  setManagedClientForTests(undefined);
  setLedger(undefined);
  setGenerationStore(undefined);
  setPromptStore(undefined);
  vi.unstubAllEnvs();
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Read the whole response stream; a stream error is reported, not thrown. */
async function readAll(stream: ReadableStream<string>): Promise<{ text: string; error?: Error }> {
  const reader = stream.getReader();
  let text = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();

      if (done) {
        return { text };
      }

      text += value;
    }
  } catch (error) {
    return { text, error: error as Error };
  }
}

const rows = async () => (await ledger.list(USER.id)).reverse();

describe('the prompt enhancer on Managed Agents', () => {
  it('runs a one-shot session with the enhancer overrides, streams the text, bills the session once, archives it', async () => {
    let runningRowAtSend: { status?: string; managedSessionId?: string } | undefined;

    fake.script = (async (api) => {
      const all = await getGenerationStore().listByIds(
        (await fs.readdir(path.join(tmp, 'generations')).catch(() => [])).map((f) => f.replace(/\.json$/, '')),
      );
      runningRowAtSend = all[0];

      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Build a kart racer with drifting.' }] });
      api.modelRequest({ input_tokens: 20_000, output_tokens: 10_000 });
      api.endTurn();
    }) satisfies Script;

    const result = await readAll(
      await runManagedEnhancement({ user: USER, message: 'kart game', usageReadDelayMs: 1 }),
    );

    expect(result.error).toBeUndefined();
    expect(result.text).toBe('Build a kart racer with drifting.');

    /* The session: the Standard agent with the enhancer's overrides — its own prompt, no tools, no skills, no mounts. */
    const session = fake.sessions.get('sesn_1')!;

    expect(session.createParams).toMatchObject({
      agent: {
        type: 'agent_with_overrides',
        id: 'agent_1',
        version: 3,
        model: { id: ENHANCER_MODEL },
        system: ENHANCER_SYSTEM,
        tools: [],
        skills: [],
      },
      environment_id: 'env_1',
    });
    expect(session.createParams.resources).toBeUndefined();

    /* Haiku takes no effort setting — sending one would be refused. */
    expect((session.createParams.agent as { model: Record<string, unknown> }).model.effort).toBeUndefined();

    /* The user's prompt rode in the one message, inside the legacy instructions. */
    const sent = fake.sends[0].events[0] as { content: Array<{ text: string }> };

    expect(sent.content[0].text).toContain('<original_prompt>\nkart game\n</original_prompt>');

    /* The running row existed, naming the session, BEFORE the first message (D9 / no-unbilled-usage D2). */
    expect(runningRowAtSend).toMatchObject({ status: 'running', managedSessionId: 'sesn_1' });

    /*
     * Billed once, at Haiku's rates ($1 in / $5 out per MTok), through the documented formula
     * `ceil(cost / unit × margin)` — computed the way the platform computes it (`creditsForRawCost`), float
     * and all: ($0.02 + $0.05) / $0.01 × 4 is 28.000000000000004 in IEEE doubles, so it bills 29.
     */
    const expected = Math.max(1, Math.ceil(((20_000 * 1 + 10_000 * 5) / 1_000_000 / 0.01) * 4));
    const ledgerRows = await rows();

    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]).toMatchObject({ delta: -expected, reason: 'generation' });

    const [row] = await getGenerationStore().listByIds([ledgerRows[0].generationId!]);

    expect(row).toMatchObject({
      status: 'completed',
      statusKind: 'enhance',
      provider: 'Anthropic',
      model: ENHANCER_MODEL,
    });
    expect(fake.archived).toEqual(['sesn_1']);
  });

  it('a finish with NO text is a failure: the stream errors (the browser restores the prompt) and the charge is refunded', async () => {
    fake.script = (async (api) => {
      api.modelRequest({ input_tokens: 20_000, output_tokens: 0 });
      api.endTurn();
    }) satisfies Script;

    const result = await readAll(
      await runManagedEnhancement({ user: USER, message: 'kart game', usageReadDelayMs: 1 }),
    );

    expect(result.error?.message).toMatch(/refunded/);

    const ledgerRows = await rows();

    expect(ledgerRows.map((r) => r.reason)).toEqual(['generation', 'refund']);
    expect(ledgerRows.reduce((sum, r) => sum + r.delta, 0)).toBe(0);

    const [row] = await getGenerationStore().listByIds([ledgerRows[0].generationId!]);

    expect(row?.status).toBe('failed');
    expect(fake.archived).toEqual(['sesn_1']);
  });

  it('the credit gate refuses BEFORE any session exists (402, nothing created, nothing written)', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'true');

    await expect(runManagedEnhancement({ user: USER, message: 'kart game' })).rejects.toMatchObject({
      statusCode: 402,
    });
    expect(fake.sessions.size).toBe(0);
    expect(await rows()).toEqual([]);
  });

  it('never provisioned is "not configured" (503) — and no session is created', async () => {
    setPromptStore({ getActive: async () => ({ id: 'pv_test', managedAgents: {} }), list: async () => [] } as never);

    await expect(runManagedEnhancement({ user: USER, message: 'kart game' })).rejects.toMatchObject({
      name: 'NotConfiguredError',
      statusCode: 503,
    });
    expect(fake.sessions.size).toBe(0);
  });

  it('CONTROL: an effort-capable enhancer model is sent with effort medium', async () => {
    vi.stubEnv('ENHANCE_PROMPT_MODEL', MODEL);
    fake.agentModels = { agent_1: MODEL };
    fake.script = (async (api) => {
      api.emit({ type: 'agent.message', content: [{ type: 'text', text: 'ok' }] });
      api.modelRequest({ input_tokens: 10, output_tokens: 10 });
      api.endTurn();
    }) satisfies Script;

    await readAll(await runManagedEnhancement({ user: USER, message: 'kart game', usageReadDelayMs: 1 }));

    expect((fake.sessions.get('sesn_1')!.createParams.agent as { model: unknown }).model).toEqual({
      id: MODEL,
      effort: 'medium',
    });
  });
});
