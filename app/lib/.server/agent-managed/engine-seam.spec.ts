/**
 * The engine seam (managed-agents-engine plan T2).
 *
 * Two halves, complements of each other:
 *
 *   1. A SOURCE SCAN: the route runs the two walls, the attachment caps and the in-flight claim before
 *      it dispatches to EITHER engine, and each engine runs the credit gate before anything that can
 *      spend. A new engine (or a reordering) that puts a provider call ahead of the gate costs money with
 *      nothing throwing — the scan is what fails. Every scan carries a CONTROL proving the scanner can
 *      fail, because a scanner that silently matches nothing reports a clean bill of health forever.
 *   2. BEHAVIOUR: `runManagedGeneration` refuses unconfigured, refuses on the gate exactly the way the
 *      legacy engine does, and never touches the Managed Agents client before the gate allows the turn.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkCreditGate } from '~/lib/.server/billing/gate';
import { FsLedger, setLedger } from '~/lib/.server/billing/ledger';
import { NotConfiguredError } from '~/lib/.server/env';
import { setPromptStore, type PromptStore } from '~/lib/.server/prompt/store';
import type { AuthUser } from '~/lib/.server/supabase/auth';
import { setManagedClientForTests } from './config';
import { runManagedGeneration } from './engine';

vi.mock('~/lib/.server/billing/gate', async (importOriginal) => {
  const original = await importOriginal<typeof import('~/lib/.server/billing/gate')>();
  return { ...original, checkCreditGate: vi.fn(original.checkCreditGate) };
});

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/*
 * ---------------------------------------------------------------------------------------------
 * The scanner
 * ---------------------------------------------------------------------------------------------
 */

/** Comments name these functions in prose all the time; only CODE counts. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** From `signature` to the closing brace at column 0 — the top-level function's body. */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);

  if (start < 0) {
    throw new Error(`"${signature}" not found`);
  }

  const end = source.indexOf('\n}\n', start);

  return source.slice(start, end < 0 ? undefined : end + 2);
}

/**
 * Violations of "every `before` token appears, and appears before every occurrence of every `after`
 * token". `requireAfter` additionally demands at least one `after` token exists — without it a scan
 * over code that no longer calls anything passes vacuously.
 */
function orderViolations(
  source: string,
  before: string[],
  after: string[],
  options: { requireAfter: 'all' | 'any' | 'none' },
): string[] {
  const code = stripComments(source);
  const violations: string[] = [];

  const firstOf = (token: string) => code.indexOf(token);
  const present = after.filter((token) => firstOf(token) >= 0);

  for (const token of before) {
    if (firstOf(token) < 0) {
      violations.push(`missing ${token}`);
    }
  }

  if (options.requireAfter === 'all') {
    for (const token of after) {
      if (firstOf(token) < 0) {
        violations.push(`missing ${token}`);
      }
    }
  } else if (options.requireAfter === 'any' && present.length === 0) {
    violations.push(`none of ${after.join(', ')} present`);
  }

  for (const b of before) {
    const at = firstOf(b);

    for (const a of present) {
      if (at >= 0 && firstOf(a) < at) {
        violations.push(`${a} runs before ${b}`);
      }
    }
  }

  return violations;
}

const WALLS = ['requireVerifiedUser(', 'requireOwnedProject(', 'validateAttachments(', 'claimProject('];
const DISPATCH = ['runManagedGeneration(', 'runAgentGeneration('];

/** Anything in the legacy engine that reaches a provider. */
const LEGACY_SPEND = ['getModelInstance(', '_streamText(', 'runToolLoopSegments('];

/** Anything in the managed engine that reaches Anthropic or creates a session. */
const MANAGED_SPEND = [
  'getManagedClient(',
  'getOrCreateManagedSession(',
  '.sessions.',
  '.events.',
  '.agents.',
  '.environments.',
];

describe('source scan — the walls and the gate run before either engine', () => {
  const route = read('app/routes/api.agent.ts');
  const action = functionBody(route, 'async function agentAction(');

  it('the route runs both walls, the attachment caps and the claim before dispatching to the managed engine', () => {
    /* Anthropic Managed Agents is the only engine since 2026-10-03 (`_specs/anthropic-only_plan.md`). */
    expect(orderViolations(action, WALLS, ['runManagedGeneration('], { requireAfter: 'all' })).toEqual([]);
  });

  it('the legacy engine runs the credit gate before any provider call', () => {
    const body = functionBody(read('app/lib/.server/agent/proxy.ts'), 'export async function runAgentGeneration(');
    expect(orderViolations(body, ['checkCreditGate('], LEGACY_SPEND, { requireAfter: 'any' })).toEqual([]);
  });

  it('the managed engine runs the credit gate before any session / client call', () => {
    const body = functionBody(
      read('app/lib/.server/agent-managed/engine.ts'),
      'export async function runManagedGeneration(',
    );
    expect(orderViolations(body, ['checkCreditGate('], MANAGED_SPEND, { requireAfter: 'none' })).toEqual([]);
  });

  describe('CONTROLS — the scanner can fail', () => {
    it('a dispatch ahead of the ownership wall is caught', () => {
      const reordered = `
        const user = await requireVerifiedUser(request, context);
        const generation = await runAgentGeneration(req);
        const project = await requireOwnedProject(user, id, context);
        validateAttachments(body.messages, context);
        release = claimProject(id, user.id, signal);
        const other = await runManagedGeneration(req);
      `;

      expect(orderViolations(reordered, WALLS, DISPATCH, { requireAfter: 'all' })).toEqual(
        expect.arrayContaining(['runAgentGeneration( runs before requireOwnedProject(']),
      );
    });

    it('a missing wall is caught, and a wall that only appears in a COMMENT does not count', () => {
      const commentedOut = `
        const user = await requireVerifiedUser(request, context);
        /* const project = await requireOwnedProject(user, id, context); */
        // validateAttachments(body.messages, context);
        release = claimProject(id, user.id, signal);
        await runAgentGeneration(req); await runManagedGeneration(req);
      `;

      expect(orderViolations(commentedOut, WALLS, DISPATCH, { requireAfter: 'all' })).toEqual(
        expect.arrayContaining(['missing requireOwnedProject(', 'missing validateAttachments(']),
      );
    });

    it('a session created before the gate is caught', () => {
      const reordered = `export async function runManagedGeneration(request) {
  getManagedEngineConfig(request.context);
  const client = getManagedClient(request.context);
  const gate = await checkCreditGate({ userId, byok: false });
}
`;
      expect(orderViolations(reordered, ['checkCreditGate('], MANAGED_SPEND, { requireAfter: 'none' })).toEqual([
        'getManagedClient( runs before checkCreditGate(',
      ]);
    });

    it('a body with no provider call at all fails the legacy scan (it cannot pass vacuously)', () => {
      expect(
        orderViolations('checkCreditGate({});', ['checkCreditGate('], LEGACY_SPEND, { requireAfter: 'any' }),
      ).toEqual([`none of ${LEGACY_SPEND.join(', ')} present`]);
    });

    it('a gate removed from the managed engine is caught', () => {
      expect(
        orderViolations('getManagedClient(ctx).beta.sessions.create({});', ['checkCreditGate('], MANAGED_SPEND, {
          requireAfter: 'none',
        }),
      ).toContain('missing checkCreditGate(');
    });
  });
});

/*
 * ---------------------------------------------------------------------------------------------
 * Behaviour
 * ---------------------------------------------------------------------------------------------
 */

const USER: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'dev@example.com',
  emailVerified: true,
  displayName: 'Dev',
  isAdmin: false,
} as AuthUser;

/** A client that records ANY use. The gate must allow the turn before anything touches it. */
function recordingClient(touched: string[]): Anthropic {
  const handler: ProxyHandler<object> = {
    get(_target, key) {
      touched.push(String(key));
      return new Proxy(() => undefined, handler);
    },
    apply() {
      touched.push('call');
      return new Proxy(() => undefined, handler);
    },
  };

  return new Proxy(() => undefined, handler) as unknown as Anthropic;
}

describe('runManagedGeneration — config and gate', () => {
  let tmp: string;
  let touched: string[];

  beforeEach(async () => {
    /*
     * ⚠️ `env()` falls back to `process.env`, and vitest loads `.env.local`, which holds a REAL key.
     * Every case states its own env; nothing here may reach Anthropic or the developer's ledger.
     */
    vi.stubEnv('ANTHROPIC_API_KEY', undefined as unknown as string);
    vi.stubEnv('BILLING_ENFORCED', undefined as unknown as string);
    vi.stubEnv('LLM_MODEL', undefined as unknown as string);
    vi.stubEnv('MANAGED_AGENT_EFFORT', undefined as unknown as string);
    vi.stubEnv('MANAGED_SESSION_HOUR_USD', undefined as unknown as string);

    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'managed-engine-'));
    setLedger(new FsLedger(tmp));

    touched = [];
    setManagedClientForTests(recordingClient(touched));

    /* Never the developer's real prompt store (it may hold a provisioned agent): an empty one. */
    setPromptStore({ getActive: async () => null, list: async () => [] } as unknown as PromptStore);
    vi.mocked(checkCreditGate).mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    setLedger(undefined);
    setManagedClientForTests(undefined);
    setPromptStore(undefined);
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('no Anthropic key → NotConfiguredError naming it, before the gate runs', async () => {
    const error = await runManagedGeneration({ messages: [], user: USER, context: {} }).catch((e) => e);

    expect(error).toBeInstanceOf(NotConfiguredError);
    expect(error.message).toContain('ANTHROPIC_API_KEY');
    expect(checkCreditGate).not.toHaveBeenCalled();
    expect(touched).toEqual([]);
  });

  it('an empty balance with billing enforced is refused the legacy way: 402, not retryable, the gate sentence', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-real');
    vi.stubEnv('BILLING_ENFORCED', 'true');

    const error = await runManagedGeneration({ messages: [], user: USER, context: {} }).catch((e) => e);

    expect(error).not.toBeInstanceOf(NotConfiguredError);
    expect(error.statusCode).toBe(402);
    expect(error.isRetryable).toBe(false);
    expect(error.message).toBe('You are out of credits. Add more to keep building.');
    expect(checkCreditGate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(checkCreditGate).mock.calls[0][0]).toMatchObject({ userId: USER.id, byok: false });
    expect(touched).toEqual([]);
  });

  it('CONTROL: an allowed turn passes the gate and reaches the next step (no provisioned agent) — still no client call', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-real');
    vi.stubEnv('BILLING_ENFORCED', 'false');

    const error = await runManagedGeneration({ messages: [], user: USER, context: {} }).catch((e) => e);

    expect(error).toBeInstanceOf(NotConfiguredError);
    expect(error.message).toContain('Provision managed agent');
    expect(checkCreditGate).toHaveBeenCalledTimes(1);
    expect(touched).toEqual([]);
  });
});
