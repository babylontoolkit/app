/**
 * Which engine runs THIS turn (`_specs/managed-agents-engine_plan.md` D9, scope).
 *
 * The deploy picks an engine (`resolveAgentEngine`), but not every turn may run on the managed one:
 *
 *   - **Plan mode stays legacy.** A Plan turn is read-only by three guarantees that live in the legacy
 *     pipeline (`toolset:'skills-only'`, the `NO_REPLAY` mark, the `_specs/` write door). None of them
 *     exist on the managed engine yet, so routing a Plan turn there would hand a "read-only" turn a
 *     `project_write` tool.
 *   - **MCP turns stay legacy.** The §4.14 relay is wired into the legacy tool loop only; on the managed
 *     engine the project's MCP tools would silently vanish from a turn whose user expects them.
 *
 * Pure, so the rule is ONE function every caller shares (the route today; T6's reconnect later) — two
 * copies of "which engine?" that disagree send one chat's turns to two different loops, and a session
 * lives on only one of them.
 *
 * The safe direction is legacy: anything not explicitly a managed build turn resolves to the engine
 * that has always run.
 */
import type { AgentEngine } from './config';
import { env } from '~/lib/.server/env';

export interface EngineSelectInput {
  /** The deploy's engine (`resolveAgentEngine`). */
  engine: AgentEngine;

  /** The chat's Build/Plan toggle as the browser sent it. Untrusted; only `'discuss'` is special. */
  chatMode?: string;

  /** Does the request carry live MCP tools (`body.mcpTools`)? */
  hasMcpTools: boolean;
}

export function selectEngineForTurn(input: EngineSelectInput): AgentEngine {
  if (input.engine !== 'managed') {
    return 'legacy';
  }

  if (input.chatMode === 'discuss') {
    return 'legacy';
  }

  if (input.hasMcpTools) {
    return 'legacy';
  }

  return 'managed';
}

/**
 * The deploy's engine, or — for the engine eval harness ONLY (`scripts/engine-eval.mjs`, plan T11) — the
 * engine the request body names.
 *
 * `AGENT_ENGINE` is per deploy (D9), so measuring both engines through the same route would otherwise
 * need a server restart between every run. The override exists to make that comparison cheap, and it is
 * honoured only when BOTH hold:
 *
 *   - `NODE_ENV` is not `production` — a production deploy can never be steered by a browser value;
 *   - `AGENT_ENGINE_EVAL_OVERRIDE` is exactly `'true'` — a dev server ignores it unless it was started
 *     for an eval.
 *
 * Anything else (absent, a typo, a non-string) resolves to the deploy's engine. The result still goes
 * through `selectEngineForTurn`, so an override can never put a Plan or MCP turn on the managed engine.
 */
export function resolveEngineForRequest(input: {
  deployEngine: AgentEngine;
  override: unknown;
  context: unknown;
}): AgentEngine {
  const { deployEngine, override, context } = input;

  if (override !== 'managed' && override !== 'legacy') {
    return deployEngine;
  }

  const isProduction = (env(context, 'NODE_ENV') ?? process.env.NODE_ENV) === 'production';

  if (isProduction || env(context, 'AGENT_ENGINE_EVAL_OVERRIDE')?.trim() !== 'true') {
    return deployEngine;
  }

  return override;
}
