/**
 * The managed agent engine's configuration (`_specs/managed-agents-engine_plan.md` D9, D10, D7).
 *
 * `AGENT_ENGINE` picks who runs the agent loop: `managed` (Anthropic's hosted Managed Agents loop, this
 * directory — THE DEFAULT since T12) or `legacy` (our own `streamText` tool loop, `proxy.ts`, kept as the
 * kill switch). It is read per DEPLOY and never switched per turn automatically — a session lives on
 * Anthropic's side, so changing engines mid-chat would lose it (D9).
 *
 * Every value here is config, never a constant in code (CLAUDE.md "rates are config"). An absent
 * Anthropic key is a describable "not configured" state, never a crash (§1.3 principle 0).
 */
import Anthropic from '@anthropic-ai/sdk';
import { env, envNumber, NotConfiguredError } from '~/lib/.server/env';
import { DEFAULT_EFFORT, type EffortLevel, parseEffort } from '~/lib/modules/llm/capabilities';

export type AgentEngine = 'managed' | 'legacy';

/** Unrecognised `AGENT_ENGINE` values already warned about — one warning per value per process. */
const warnedEngineValues = new Set<string>();

/**
 * The engine a deploy runs. `managed` is the default (plan T12 — the T11 eval had it faster and cheaper on
 * builds with success tied); only the exact value `legacy` (trimmed) selects the kill switch.
 *
 * Unset, empty and `managed` resolve to `managed` silently. Any OTHER non-empty value also resolves to
 * `managed` but warns ONCE per process: a typo in the kill switch (`legasy`) must not look like it worked,
 * and the warning is the only place that typo can surface — the turn itself runs fine on the default.
 */
export function resolveAgentEngine(context: unknown): AgentEngine {
  const raw = env(context, 'AGENT_ENGINE')?.trim();

  if (raw === 'legacy') {
    return 'legacy';
  }

  if (raw && raw !== 'managed' && !warnedEngineValues.has(raw)) {
    warnedEngineValues.add(raw);
    console.warn(
      `[agent-engine] AGENT_ENGINE=${JSON.stringify(raw)} is not "managed" or "legacy"; running the managed engine (the default). Set AGENT_ENGINE=legacy to use the built-in agent loop.`,
    );
  }

  return 'managed';
}

export interface ManagedEngineConfig {
  apiKey: string;

  /** The agent's model (D10) — `LLM_MODEL`, else Sonnet 5.5. */
  model: string;

  /**
   * Thinking effort the agent is provisioned at (D10) — the OPERATOR default (`MANAGED_AGENT_EFFORT`), used
   * when no user choice arrives (`_specs/effort-selector_plan.md` D8). Any `EffortLevel`; `max` is allowed
   * here even when `ENABLE_MAX_EFFORT` is off — that switch governs only what a USER may pick.
   */
  effort: EffortLevel;

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

  /*
   * Parsed by the OPERATOR rule (`parseEffort`): `low` clamps to `medium` with a warning, a typo warns and
   * falls back to the default. It used to be `=== 'high' ? 'high' : 'medium'`, which silently turned an
   * operator's `xhigh`/`max` into `medium`.
   */
  const effort = parseEffort(env(context, 'MANAGED_AGENT_EFFORT'), 'MANAGED_AGENT_EFFORT') ?? DEFAULT_EFFORT;

  return {
    apiKey,
    model: env(context, 'LLM_MODEL')?.trim() || DEFAULT_MANAGED_MODEL,
    effort,
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

  /*
   * THE TEST NETWORK WALL. Vitest loads `.env.local`, which holds a REAL `ANTHROPIC_API_KEY`, and `env()`
   * falls back to `process.env` — so with `managed` as the default engine, a spec that drives the agent
   * route without pinning `AGENT_ENGINE` would otherwise construct a live client and spend real money.
   * A spec must inject a fake; reaching here under vitest is always a bug in the spec.
   */
  if (process.env.VITEST) {
    throw new Error(
      'A spec reached the real Managed Agents client — inject a fake with setManagedClientForTests (or pin AGENT_ENGINE=legacy).',
    );
  }

  return new Anthropic({ apiKey: getManagedEngineConfig(context).apiKey });
}

export function setManagedClientForTests(client: Anthropic | undefined): void {
  testClient = client;
}
