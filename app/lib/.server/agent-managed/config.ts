/**
 * The managed agent engine's configuration (`_specs/managed-agents-engine_plan.md` D9, D10, D7).
 *
 * `AGENT_ENGINE` picks who runs the agent loop: `legacy` (our own `streamText` tool loop, `proxy.ts`)
 * or `managed` (Anthropic's hosted Managed Agents loop, this directory). It is read per DEPLOY and
 * never switched per turn automatically — a session lives on Anthropic's side, so changing engines
 * mid-chat would lose it (D9).
 *
 * Every value here is config, never a constant in code (CLAUDE.md "rates are config"). An absent
 * Anthropic key is a describable "not configured" state, never a crash (§1.3 principle 0).
 */
import Anthropic from '@anthropic-ai/sdk';
import { env, envNumber, NotConfiguredError } from '~/lib/.server/env';

export type AgentEngine = 'managed' | 'legacy';

/** The engine a deploy runs. Only the exact value `managed` selects it — anything else is `legacy`. */
export function resolveAgentEngine(context: unknown): AgentEngine {
  return env(context, 'AGENT_ENGINE')?.trim() === 'managed' ? 'managed' : 'legacy';
}

export interface ManagedEngineConfig {
  apiKey: string;

  /** The agent's model (D10) — `LLM_MODEL`, else Sonnet 5.5. */
  model: string;

  /** Thinking effort the agent is provisioned at (D10). */
  effort: 'medium' | 'high';

  /** Price of one active session-hour in USD (D7). Anthropic list price at the time of writing: 0.08. */
  sessionHourUsd: number;

  /**
   * A pre-made cloud environment id to reuse. Optional: when unset, provisioning creates one and
   * records it (`provision.ts`).
   */
  environmentId?: string;
}

export const DEFAULT_MANAGED_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_SESSION_HOUR_USD = 0.08;

/**
 * The managed engine's config. Throws `NotConfiguredError` (a 503 with a sentence, at the route) when
 * the Anthropic key is missing — Managed Agents runs only on Anthropic's platform (D8).
 */
export function getManagedEngineConfig(context: unknown): ManagedEngineConfig {
  const apiKey = env(context, 'ANTHROPIC_API_KEY');

  if (!apiKey) {
    throw new NotConfiguredError(
      'The managed agent engine (ANTHROPIC_API_KEY)',
      'Set ANTHROPIC_API_KEY, or set AGENT_ENGINE=legacy to use the built-in agent loop.',
    );
  }

  const effortRaw = env(context, 'MANAGED_AGENT_EFFORT')?.trim();

  return {
    apiKey,
    model: env(context, 'LLM_MODEL')?.trim() || DEFAULT_MANAGED_MODEL,
    effort: effortRaw === 'high' ? 'high' : 'medium',
    sessionHourUsd: Math.max(0, envNumber(context, 'MANAGED_SESSION_HOUR_USD', DEFAULT_SESSION_HOUR_USD)),
    environmentId: env(context, 'MANAGED_AGENTS_ENVIRONMENT_ID')?.trim() || undefined,
  };
}

/**
 * The Managed Agents client. Injectable so specs never reach Anthropic: a spec sets a fake with
 * `setManagedClientForTests` and every module in this directory goes through `getManagedClient`.
 */
let testClient: Anthropic | undefined;

export function getManagedClient(context: unknown): Anthropic {
  if (testClient) {
    return testClient;
  }

  return new Anthropic({ apiKey: getManagedEngineConfig(context).apiKey });
}

export function setManagedClientForTests(client: Anthropic | undefined): void {
  testClient = client;
}
