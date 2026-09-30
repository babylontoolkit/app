/**
 * The tool loop's configuration (tool-loop plan D2, D9, D10, D11).
 *
 * T2 shipped the config; T4 adds the segment decision (`decideNextSegment`), the compact carry
 * (`carrySummary`), the two segment prompts, the per-turn credit ceiling (`resolveTurnCeiling` +
 * `createTurnMeter`), the real output cap (`resolveMaxOutputTokens`) and the segment runner the proxy
 * drives (`runToolLoopSegments`) — extracted here so the live-relay spec can drive the SAME loop the
 * proxy runs against the real `streamText`, since `runAgentGeneration` cannot be built in a unit test.
 *
 * `AGENT_TOOL_LOOP` is a PLATFORM kill switch, resolved ONCE per request right after the credit gate.
 * Until T10 it is on only when the value is exactly `'true'`, so with it unset the proxy is byte-for-byte
 * today's code path.
 *
 * Every number is FLOORED, never trusted: `Number('0')` and `Number('-1')` parse, and a zero segment
 * budget does not build less — it ends every turn before a single write (the `budgets.ts` rule).
 */
import type { CoreMessage } from 'ai';
import { env } from '~/lib/.server/env';
import type { AgentWorkspaceSummary } from '~/lib/agent/workspace-protocol-types';
import type { ModelFamily } from '~/lib/modules/llm/model-families';
import { envModelInfo } from '~/lib/modules/llm/providers/env-models';
import type { ModelInfo } from '~/lib/modules/llm/types';
import { resolveAgentBudgets, TOOL_LOOP_BUDGET_DEFAULTS, type AgentBudgets } from './budgets';
import { accumulateStepUsage, type GenerationUsage, type UsageStep } from './step-usage';

export interface ToolLoopConfig {
  enabled: boolean; // AGENT_TOOL_LOOP
  segmentSteps: number; // AGENT_SEGMENT_STEPS      default 40      floor 5
  maxSegments: number; // AGENT_MAX_SEGMENTS       default 6       floor 1
  turnMaxCredits: number; // AGENT_TURN_MAX_CREDITS   default 2500    floor 100
  checkMaxNudges: number; // AGENT_CHECK_MAX_NUDGES   default 3       floor 0
  compactAtTokens: number; // AGENT_COMPACT_AT_TOKENS  default 300000  floor 50000
}

export const DEFAULT_TOOL_LOOP_CONFIG: ToolLoopConfig = {
  enabled: false,
  segmentSteps: 40,
  maxSegments: 6,
  turnMaxCredits: 2500,
  checkMaxNudges: 3,
  compactAtTokens: 300_000,
};

const FLOORS = {
  segmentSteps: 5,
  maxSegments: 1,
  turnMaxCredits: 100,
  checkMaxNudges: 0,
  compactAtTokens: 50_000,
} as const;

function numberSetting(context: unknown, key: string, fallback: number, floor: number): number {
  const raw = env(context, key);

  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || raw.trim() === '') {
    return fallback;
  }

  return Math.max(floor, Math.floor(parsed));
}

export function resolveToolLoopConfig(context: unknown): ToolLoopConfig {
  const d = DEFAULT_TOOL_LOOP_CONFIG;

  return {
    enabled: env(context, 'AGENT_TOOL_LOOP') === 'true',
    segmentSteps: numberSetting(context, 'AGENT_SEGMENT_STEPS', d.segmentSteps, FLOORS.segmentSteps),
    maxSegments: numberSetting(context, 'AGENT_MAX_SEGMENTS', d.maxSegments, FLOORS.maxSegments),
    turnMaxCredits: numberSetting(context, 'AGENT_TURN_MAX_CREDITS', d.turnMaxCredits, FLOORS.turnMaxCredits),
    checkMaxNudges: numberSetting(context, 'AGENT_CHECK_MAX_NUDGES', d.checkMaxNudges, FLOORS.checkMaxNudges),
    compactAtTokens: numberSetting(context, 'AGENT_COMPACT_AT_TOKENS', d.compactAtTokens, FLOORS.compactAtTokens),
  };
}

/**
 * The turn's read budgets under whichever loop is ON — the ONE resolver for every seam that needs them.
 *
 * Under the tool loop the base defaults are `TOOL_LOOP_BUDGET_DEFAULTS` (D15); otherwise the shipped
 * ones. Two callers must agree: the proxy (which ENFORCES `maxReferenceLoads` in `load_reference`) and
 * the prompt refresh (which BAKES the same number into the cached reference index). Resolving them
 * separately is how the prompt told the model "at most 3" while the tool allowed 12.
 *
 * `loopEnabled` lets the proxy pass the value it already resolved; absent, it is read from config.
 */
export function resolveTurnBudgets(
  context: unknown,
  loopEnabled: boolean = resolveToolLoopConfig(context).enabled,
): AgentBudgets {
  return resolveAgentBudgets(context, loopEnabled ? TOOL_LOOP_BUDGET_DEFAULTS : undefined);
}

/*
 * ─── the segment decision (D10, D11) ────────────────────────────────────────────────────────────────
 */

/** Why a tool-loop turn stopped short of `done` — `'none'` when it did not (D22). */
export type ToolLoopStopReason = 'none' | 'budget' | 'segments' | 'breaker' | 'aborted';

/** The two re-issue kinds a segment boundary can start (`request-fingerprint.ts` `RequestKind`). */
export type ToolLoopSegmentKind = 'tool-loop-continue' | 'tool-loop-gate';

export interface SegmentFacts {
  /** The USER stopped the turn (`request.abortSignal`) — never a budget abort. */
  aborted: boolean;

  /** The credit ceiling was crossed and the turn's controller aborted with `'budget'`. */
  budgetHit: boolean;
  finishReason: string;
  lastStepToolCalls: number;

  /** Segments already run, the one just finished included. */
  segmentsRun: number;
  wroteThisTurn: boolean;
  lastCheck: { ok: boolean; afterWriteSeq: number } | null;
  lastWriteSeq: number;
  nudgesUsed: number;
  breakerTripped: boolean;

  /** The last step's whole input: uncached + cache read + cache write. */
  lastStepInputTokens: number;
}

export type SegmentDecision =
  | { kind: 'done' }
  | { kind: 'stop'; reason: Exclude<ToolLoopStopReason, 'none'> }
  | { kind: 'continue' | 'gate'; compact: boolean };

/**
 * What happens after a segment ends. Pure, and it spends credits without the user asking (a
 * `continue` or `gate` starts another paid segment), so every branch is pinned in `tool-loop.spec.ts`.
 *
 * Evaluated IN ORDER — the order is the policy:
 *  1. a user Stop outranks everything;
 *  2. the credit ceiling outranks any further work;
 *  3. the model was cut off mid-loop (its last step really called a tool — `finishReason` alone is a
 *     provider claim, see `lastStepToolCalls` in `proxy.ts`) → continue, unless out of segments;
 *  4. it wrote files this turn that no passing `check_game` has seen since → gate, unless the
 *     breaker tripped or the nudges or segments are spent;
 *  5. otherwise it is done. Answer-only turns are never gated.
 */
export function decideNextSegment(
  f: SegmentFacts,
  cfg: Pick<ToolLoopConfig, 'maxSegments' | 'checkMaxNudges' | 'compactAtTokens'>,
): SegmentDecision {
  if (f.aborted) {
    return { kind: 'stop', reason: 'aborted' };
  }

  if (f.budgetHit) {
    return { kind: 'stop', reason: 'budget' };
  }

  const compact = f.lastStepInputTokens >= cfg.compactAtTokens;

  if (f.finishReason === 'tool-calls' && f.lastStepToolCalls > 0) {
    if (f.segmentsRun >= cfg.maxSegments) {
      return { kind: 'stop', reason: 'segments' };
    }

    return { kind: 'continue', compact };
  }

  const verified = f.lastCheck?.ok === true && f.lastCheck.afterWriteSeq === f.lastWriteSeq;

  if (f.wroteThisTurn && !verified) {
    if (f.breakerTripped || f.nudgesUsed >= cfg.checkMaxNudges) {
      return { kind: 'stop', reason: 'breaker' };
    }

    if (f.segmentsRun >= cfg.maxSegments) {
      return { kind: 'stop', reason: 'segments' };
    }

    return { kind: 'gate', compact };
  }

  return { kind: 'done' };
}

/** The done-gate's user message (D11) — verbatim from the plan. */
export const GATE_PROMPT =
  'You changed files in this project but have not verified them. Call `check_game` now (pass the ' +
  '`gameMode` of the GameMode you built). If it reports errors, fix them and call `check_game` again. ' +
  'Do not end your turn until `check_game` returns ok. If you believe an error is outside your control, ' +
  'say so in one sentence and name the file and line.';

/** The step-cap continuation's user message (D10) — verbatim from the plan. */
export const CONTINUE_PROMPT =
  'Continue working through your todo list from where you stopped. Re-read any file with `read_file` ' +
  'before editing it. When everything is built, run `check_game` and finish.';

/**
 * The compact carry (D12): what a fresh segment is told about this turn's progress when the
 * conversation so far is too big to re-send. Exact format — the model reads it.
 */
export function carrySummary(summary: AgentWorkspaceSummary): string {
  const writes = summary.writes.length > 0 ? summary.writes.join(', ') : 'none';
  const commands =
    summary.commands.length > 0 ? summary.commands.map((c) => `${c.command} (exit ${c.exitCode})`).join(', ') : 'none';
  const todos = summary.todos.map((t) => `- [${t.status === 'completed' ? 'x' : ' '}] ${t.content}`);
  const check = summary.lastCheck
    ? summary.lastCheck.ok
      ? 'passed'
      : `failed:\n${summary.lastCheck.errors.join('\n')}`
    : 'not run yet';

  return [
    '## Progress so far this turn',
    `Files written: ${writes}`,
    `Commands run: ${commands}`,
    'Todo list:',
    ...todos,
    `Last check: ${check}`,
  ].join('\n');
}

/*
 * ─── the real output cap (D14) ──────────────────────────────────────────────────────────────────────
 */

/** Used only when the model's row names no output cap. */
const FALLBACK_MAX_OUTPUT_TOKENS = 64_000;

/**
 * The model's REAL output cap: its static row, else the row `envModelInfo` synthesises for an
 * operator-configured id (the same one the provider lists), else 64,000.
 */
export function resolveMaxOutputTokens(
  staticModels: readonly ModelInfo[],
  providerName: string,
  model: string,
): number {
  const row = staticModels.find((m) => m.name === model) ?? envModelInfo(model, providerName, staticModels, []);
  const cap = row?.maxCompletionTokens;

  return typeof cap === 'number' && cap > 0 ? cap : FALLBACK_MAX_OUTPUT_TOKENS;
}

/*
 * ─── the credit ceiling (D9) ────────────────────────────────────────────────────────────────────────
 */

export type CeilingGate = { mode: 'byok' } | { mode: 'unmetered' | 'credits'; balance: number };

/**
 * The turn's credit ceiling, from the gate's mode. `null` = no ceiling: a BYOK user pays their own
 * provider and no credits are spent. A metered user's ceiling never exceeds their balance (floored at
 * 1 so a near-zero balance still gets one step's worth of work rather than an instant stop).
 */
export function resolveTurnCeiling(gate: CeilingGate, cfg: Pick<ToolLoopConfig, 'turnMaxCredits'>): number | null {
  if (gate.mode === 'byok') {
    return null;
  }

  if (gate.mode === 'unmetered') {
    return cfg.turnMaxCredits;
  }

  return Math.min(cfg.turnMaxCredits, Math.max(1, gate.balance));
}

export interface TurnMeter {
  readonly budgetHit: boolean;

  /** Fold one finished step into the turn's totals, then check the ceiling. */
  onStep(step: unknown): void;
}

/**
 * Per-STEP usage accounting for the tool loop (D9).
 *
 * The legacy `drain` accumulates only after its stream ends, so a stream that throws — which is what
 * an aborted segment does — contributed nothing and settled for nothing. Here every finished step
 * lands in `totals` the moment it finishes, and the ceiling is checked there: the abort fires between
 * steps, so the next step's request is cancelled before a token of it is spent.
 *
 * `creditsFor` returns `null` when billing is not configured (no ceiling can be enforced), and a
 * throwing cost reader is treated the same way — a meter must never be what kills a paid generation.
 */
export function createTurnMeter(input: {
  totals: GenerationUsage;
  family?: ModelFamily;
  ceiling: number | null;
  creditsFor: (usage: GenerationUsage) => number | null;
  controller: AbortController;
}): TurnMeter {
  let budgetHit = false;

  return {
    get budgetHit() {
      return budgetHit;
    },

    onStep(step: unknown) {
      accumulateStepUsage(input.totals, [step as UsageStep], input.family);

      if (input.ceiling === null || budgetHit) {
        return;
      }

      let credits: number | null;

      try {
        credits = input.creditsFor(input.totals);
      } catch {
        credits = null;
      }

      if (credits !== null && credits >= input.ceiling) {
        budgetHit = true;
        input.controller.abort('budget');
      }
    },
  };
}

/*
 * ─── the segment runner (D10) ───────────────────────────────────────────────────────────────────────
 */

/** What a started segment exposes to the runner — `streamText`'s result satisfies it. */
export interface ToolLoopSegmentRun {
  response: PromiseLike<{ messages: CoreMessage[] }>;
}

/** Mutated in place, so the proxy's `finally` sees the counts even when a segment throws. */
export interface ToolLoopTurnState {
  segmentsRun: number;
  nudgesUsed: number;
  stopReason: ToolLoopStopReason;
}

export interface RunToolLoopSegmentsInput<C, R extends ToolLoopSegmentRun> {
  cfg: Pick<ToolLoopConfig, 'maxSegments' | 'checkMaxNudges' | 'compactAtTokens'>;

  /** `[...system, ...coreMessages]` — what the first segment was sent. */
  base: CoreMessage[];

  /** The first segment, ALREADY drained by the caller (the proxy keeps its provider-retry ladder there). */
  first: R;
  state: ToolLoopTurnState;

  /** The live facts after a segment; the runner supplies `segmentsRun` and `nudgesUsed`. */
  readFacts: () => Omit<SegmentFacts, 'segmentsRun' | 'nudgesUsed'>;
  summary: () => AgentWorkspaceSummary;
  start: (kind: ToolLoopSegmentKind, messages: CoreMessage[]) => R;

  /** Forward a segment's output. Must return normally (not throw) on a BUDGET abort. */
  drain: (run: R) => AsyncGenerator<C>;

  /** Applied to a finished segment's response messages before they are re-sent (`stripReplayedReasoning`). */
  prepareCarried?: (messages: CoreMessage[]) => CoreMessage[];
  onDecision?: (decision: SegmentDecision, state: ToolLoopTurnState) => void;
}

/**
 * Run segments 2..N of a tool-loop turn: decide, build the next request, start it, drain it — until
 * `decideNextSegment` says done or stop. ONE generation, one stream, one settlement: the caller's
 * `drain` forwards every segment into the same response, and usage is metered per step.
 *
 * A budget-stopped segment is never awaited for its `response` — the decision stops first.
 */
export async function* runToolLoopSegments<C, R extends ToolLoopSegmentRun>(
  input: RunToolLoopSegmentsInput<C, R>,
): AsyncGenerator<C> {
  const { cfg, base, state } = input;
  let previous = input.first;
  let messages = base;

  state.segmentsRun += 1;

  for (;;) {
    const decision = decideNextSegment(
      { ...input.readFacts(), segmentsRun: state.segmentsRun, nudgesUsed: state.nudgesUsed },
      cfg,
    );

    input.onDecision?.(decision, state);

    if (decision.kind === 'done') {
      return;
    }

    if (decision.kind === 'stop') {
      state.stopReason = decision.reason;
      return;
    }

    const gate = decision.kind === 'gate';
    const prompt = gate ? GATE_PROMPT : CONTINUE_PROMPT;

    if (gate) {
      state.nudgesUsed += 1;
    }

    if (decision.compact) {
      messages = [...base, { role: 'user', content: `${carrySummary(input.summary())}\n\n${prompt}` }];
    } else {
      const carried = (await previous.response).messages;
      messages = [
        ...messages,
        ...(input.prepareCarried ? input.prepareCarried(carried) : carried),
        { role: 'user', content: prompt },
      ];
    }

    previous = input.start(gate ? 'tool-loop-gate' : 'tool-loop-continue', messages);
    yield* input.drain(previous);
    state.segmentsRun += 1;
  }
}

/*
 * ─── the turn's end verdict (D9, D22; SPEC §4.6) ────────────────────────────────────────────────────
 */

/**
 * Did the LOOP end the turn on purpose? The credit ceiling, the segment cap and the check breaker all
 * stop a turn that consumed real tokens and produced a real outcome (paused / incomplete / unverified).
 * A user Stop (`'aborted'`) is NOT one of these — it keeps today's Stop rules.
 */
export function isDeliberateLoopStop(stopReason: ToolLoopStopReason): boolean {
  return stopReason === 'budget' || stopReason === 'segments' || stopReason === 'breaker';
}

export type TurnEndVerdict = 'ok' | 'empty-response' | 'no-files-written';

/**
 * The failure verdict at the end of a turn, and therefore whether it REFUNDS (`failed` → §4.6
 * auto-refund). Pure because it decides money.
 *
 * 🔴 A deliberate loop stop is NEVER a failure and never refunds. The ceiling for a low-balance user
 * is their balance, and a cold first step can cost hundreds of credits — refunding a ceiling stop would
 * let them stop on step one, keep their balance and repeat for free.
 *
 * Otherwise, in order (the legacy order): no text → empty response (under the loop, tool calls count
 * as output); a first build that owed files and wrote none → no files written.
 */
export function decideTurnEndVerdict(input: {
  toolLoop: boolean;
  stopReason: ToolLoopStopReason;
  producedText: boolean;
  toolCallCount: number;
  failedBuild: boolean;
}): TurnEndVerdict {
  if (input.toolLoop && isDeliberateLoopStop(input.stopReason)) {
    return 'ok';
  }

  if (!input.producedText && !(input.toolLoop && input.toolCallCount > 0)) {
    return 'empty-response';
  }

  return input.failedBuild ? 'no-files-written' : 'ok';
}
