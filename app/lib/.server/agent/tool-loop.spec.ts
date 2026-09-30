/**
 * `resolveToolLoopConfig` — the tool-loop kill switch and its budgets.
 *
 * ⚠️ `env()` falls back to `process.env`, and vitest loads `.env.local`: every `AGENT_*` var is stubbed
 * to undefined first, or a developer's local config silently becomes the "default" under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeTurnOutcome } from '~/lib/agent/turn-outcome';
import type { ModelInfo } from '~/lib/modules/llm/types';
import { buildReferenceIndex } from '~/lib/.server/prompt/reference-index';
import { ON_DEMAND_BLOCKS } from '~/lib/.server/prompt/sources';
import { emptyUsage } from './step-usage';
import {
  carrySummary,
  CONTINUE_PROMPT,
  createTurnMeter,
  decideNextSegment,
  decideTurnEndVerdict,
  DEFAULT_TOOL_LOOP_CONFIG,
  isDeliberateLoopStop,
  GATE_PROMPT,
  resolveMaxOutputTokens,
  resolveToolLoopConfig,
  resolveTurnBudgets,
  resolveTurnCeiling,
  type SegmentFacts,
} from './tool-loop';

const KEYS = [
  'AGENT_TOOL_LOOP',
  'AGENT_SEGMENT_STEPS',
  'AGENT_MAX_SEGMENTS',
  'AGENT_TURN_MAX_CREDITS',
  'AGENT_CHECK_MAX_NUDGES',
  'AGENT_COMPACT_AT_TOKENS',
  'AGENT_MAX_REFERENCE_LOADS',
  'AGENT_MAX_FILE_READS',
  'AGENT_MAX_READ_CHARS',
];

const ctx = (vars: Record<string, string>) => ({ cloudflare: { env: vars } });

beforeEach(() => {
  for (const key of KEYS) {
    vi.stubEnv(key, undefined as unknown as string);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveToolLoopConfig', () => {
  it('defaults with every AGENT_* var unset — and the loop is OFF', () => {
    expect(resolveToolLoopConfig({})).toEqual({
      enabled: false,
      segmentSteps: 40,
      maxSegments: 6,
      turnMaxCredits: 2500,
      checkMaxNudges: 3,
      compactAtTokens: 300_000,
    });
    expect(resolveToolLoopConfig({})).toEqual(DEFAULT_TOOL_LOOP_CONFIG);
  });

  it("enables only on exactly 'true'", () => {
    expect(resolveToolLoopConfig(ctx({ AGENT_TOOL_LOOP: 'true' })).enabled).toBe(true);

    for (const value of ['1', 'yes', 'TRUE', 'false', '']) {
      expect(resolveToolLoopConfig(ctx({ AGENT_TOOL_LOOP: value })).enabled).toBe(false);
    }
  });

  it('reads process.env too (the env() fallback)', () => {
    vi.stubEnv('AGENT_TOOL_LOOP', 'true');
    vi.stubEnv('AGENT_SEGMENT_STEPS', '12');

    const cfg = resolveToolLoopConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.segmentSteps).toBe(12);
  });

  it('CONTROL: configured values are honoured', () => {
    expect(
      resolveToolLoopConfig(
        ctx({
          AGENT_TOOL_LOOP: 'true',
          AGENT_SEGMENT_STEPS: '60',
          AGENT_MAX_SEGMENTS: '9',
          AGENT_TURN_MAX_CREDITS: '5000',
          AGENT_CHECK_MAX_NUDGES: '5',
          AGENT_COMPACT_AT_TOKENS: '400000',
        }),
      ),
    ).toEqual({
      enabled: true,
      segmentSteps: 60,
      maxSegments: 9,
      turnMaxCredits: 5000,
      checkMaxNudges: 5,
      compactAtTokens: 400_000,
    });
  });

  it('floors every number', () => {
    expect(
      resolveToolLoopConfig(
        ctx({
          AGENT_SEGMENT_STEPS: '0',
          AGENT_MAX_SEGMENTS: '-3',
          AGENT_TURN_MAX_CREDITS: '5',
          AGENT_CHECK_MAX_NUDGES: '-1',
          AGENT_COMPACT_AT_TOKENS: '10',
        }),
      ),
    ).toMatchObject({
      segmentSteps: 5,
      maxSegments: 1,
      turnMaxCredits: 100,
      checkMaxNudges: 0,
      compactAtTokens: 50_000,
    });
  });

  it('a nudge budget of 0 is legitimate (floor 0)', () => {
    expect(resolveToolLoopConfig(ctx({ AGENT_CHECK_MAX_NUDGES: '0' })).checkMaxNudges).toBe(0);
  });

  it('non-numeric values fall back to the default', () => {
    expect(
      resolveToolLoopConfig(
        ctx({ AGENT_SEGMENT_STEPS: 'lots', AGENT_MAX_SEGMENTS: 'NaN', AGENT_TURN_MAX_CREDITS: 'Infinity' }),
      ),
    ).toMatchObject({ segmentSteps: 40, maxSegments: 6, turnMaxCredits: 2500 });
  });
});

describe('decideNextSegment — every branch, in order', () => {
  const cfg = { maxSegments: 6, checkMaxNudges: 3, compactAtTokens: 300_000 };

  /** A segment that ended normally, wrote nothing, was never checked. */
  const facts = (over: Partial<SegmentFacts> = {}): SegmentFacts => ({
    aborted: false,
    budgetHit: false,
    finishReason: 'stop',
    lastStepToolCalls: 0,
    segmentsRun: 1,
    wroteThisTurn: false,
    lastCheck: null,
    lastWriteSeq: 0,
    nudgesUsed: 0,
    breakerTripped: false,
    lastStepInputTokens: 10_000,
    ...over,
  });

  const cutOff = { finishReason: 'tool-calls', lastStepToolCalls: 2 };

  it('a user Stop outranks the ceiling', () => {
    expect(decideNextSegment(facts({ aborted: true, budgetHit: true, ...cutOff }), cfg)).toEqual({
      kind: 'stop',
      reason: 'aborted',
    });
  });

  it('the ceiling outranks a continue', () => {
    expect(decideNextSegment(facts({ budgetHit: true, ...cutOff }), cfg)).toEqual({ kind: 'stop', reason: 'budget' });
  });

  it('the step cap mid-loop continues', () => {
    expect(decideNextSegment(facts({ ...cutOff, segmentsRun: 3 }), cfg)).toEqual({ kind: 'continue', compact: false });
  });

  it('the step cap at maxSegments stops with segments', () => {
    expect(decideNextSegment(facts({ ...cutOff, segmentsRun: 6 }), cfg)).toEqual({ kind: 'stop', reason: 'segments' });
  });

  it("a provider's `tool-calls` with NO tool call is not a cut-off", () => {
    expect(decideNextSegment(facts({ finishReason: 'tool-calls', lastStepToolCalls: 0 }), cfg)).toEqual({
      kind: 'done',
    });
  });

  it('unverified writes gate', () => {
    expect(decideNextSegment(facts({ wroteThisTurn: true, lastWriteSeq: 4 }), cfg)).toEqual({
      kind: 'gate',
      compact: false,
    });
  });

  it('a failed check after the last write still gates', () => {
    expect(
      decideNextSegment(
        facts({ wroteThisTurn: true, lastWriteSeq: 4, lastCheck: { ok: false, afterWriteSeq: 4 } }),
        cfg,
      ),
    ).toEqual({ kind: 'gate', compact: false });
  });

  it('verified, then a later write → gate', () => {
    expect(
      decideNextSegment(
        facts({ wroteThisTurn: true, lastWriteSeq: 5, lastCheck: { ok: true, afterWriteSeq: 4 } }),
        cfg,
      ),
    ).toEqual({ kind: 'gate', compact: false });
  });

  it('CONTROL: verified after the last write → done', () => {
    expect(
      decideNextSegment(
        facts({ wroteThisTurn: true, lastWriteSeq: 5, lastCheck: { ok: true, afterWriteSeq: 5 } }),
        cfg,
      ),
    ).toEqual({ kind: 'done' });
  });

  it('the breaker stops the gate', () => {
    expect(decideNextSegment(facts({ wroteThisTurn: true, lastWriteSeq: 1, breakerTripped: true }), cfg)).toEqual({
      kind: 'stop',
      reason: 'breaker',
    });
  });

  it('exhausted nudges stop with breaker', () => {
    expect(decideNextSegment(facts({ wroteThisTurn: true, lastWriteSeq: 1, nudgesUsed: 3 }), cfg)).toEqual({
      kind: 'stop',
      reason: 'breaker',
    });
  });

  it('a nudge budget of 0 never gates', () => {
    expect(decideNextSegment(facts({ wroteThisTurn: true, lastWriteSeq: 1 }), { ...cfg, checkMaxNudges: 0 })).toEqual({
      kind: 'stop',
      reason: 'breaker',
    });
  });

  it('a gate at maxSegments stops with segments', () => {
    expect(decideNextSegment(facts({ wroteThisTurn: true, lastWriteSeq: 1, segmentsRun: 6 }), cfg)).toEqual({
      kind: 'stop',
      reason: 'segments',
    });
  });

  it('no writes and the model ended → done (answer-only turns are never gated)', () => {
    expect(decideNextSegment(facts(), cfg)).toEqual({ kind: 'done' });
  });

  it('compacts at the threshold, not below it', () => {
    expect(decideNextSegment(facts({ ...cutOff, lastStepInputTokens: 300_000 }), cfg)).toEqual({
      kind: 'continue',
      compact: true,
    });
    expect(decideNextSegment(facts({ ...cutOff, lastStepInputTokens: 299_999 }), cfg)).toEqual({
      kind: 'continue',
      compact: false,
    });
    expect(
      decideNextSegment(facts({ wroteThisTurn: true, lastWriteSeq: 1, lastStepInputTokens: 300_000 }), cfg),
    ).toEqual({ kind: 'gate', compact: true });
  });
});

describe('the segment prompts', () => {
  it("are the plan's exact text", () => {
    expect(GATE_PROMPT).toBe(
      'You changed files in this project but have not verified them. Call `check_game` now (pass the `gameMode` of the GameMode you built). If it reports errors, fix them and call `check_game` again. Do not end your turn until `check_game` returns ok. If you believe an error is outside your control, say so in one sentence and name the file and line.',
    );
    expect(CONTINUE_PROMPT).toBe(
      'Continue working through your todo list from where you stopped. Re-read any file with `read_file` before editing it. When everything is built, run `check_game` and finish.',
    );
  });
});

describe('carrySummary', () => {
  it('renders the exact format', () => {
    expect(
      carrySummary({
        writes: ['src/scripts/KartMode.ts', 'src/pages/Home.tsx'],
        commands: [{ command: 'npm install cannon-es', exitCode: 0 }],
        todos: [
          { content: 'Write the kart mode', status: 'completed' },
          { content: 'Build the landing page', status: 'in_progress' },
          { content: 'Check the game', status: 'pending' },
        ],
        lastCheck: { ok: false, errors: ['src/a.ts(1,1): error TS2339: nope', 'Uncaught TypeError: x'] },
      }),
    ).toBe(
      [
        '## Progress so far this turn',
        'Files written: src/scripts/KartMode.ts, src/pages/Home.tsx',
        'Commands run: npm install cannon-es (exit 0)',
        'Todo list:',
        '- [x] Write the kart mode',
        '- [ ] Build the landing page',
        '- [ ] Check the game',
        'Last check: failed:',
        'src/a.ts(1,1): error TS2339: nope',
        'Uncaught TypeError: x',
      ].join('\n'),
    );
  });

  it('says none / not run yet / passed', () => {
    expect(carrySummary({ writes: [], commands: [], todos: [], lastCheck: null })).toBe(
      [
        '## Progress so far this turn',
        'Files written: none',
        'Commands run: none',
        'Todo list:',
        'Last check: not run yet',
      ].join('\n'),
    );
    expect(carrySummary({ writes: [], commands: [], todos: [], lastCheck: { ok: true, errors: [] } })).toMatch(
      /Last check: passed$/,
    );
  });
});

describe('resolveMaxOutputTokens (D14)', () => {
  const rows: ModelInfo[] = [
    {
      name: 'claude-sonnet-5',
      label: 'S5',
      provider: 'Anthropic',
      maxTokenAllowed: 1_000_000,
      maxCompletionTokens: 128_000,
    },
    { name: 'no-cap', label: 'x', provider: 'Anthropic', maxTokenAllowed: 200_000 },
  ];

  it("reads a static row's output cap", () => {
    expect(resolveMaxOutputTokens(rows, 'Anthropic', 'claude-sonnet-5')).toBe(128_000);
  });

  it('reads the env-synthesised row for an unlisted claude id', () => {
    expect(resolveMaxOutputTokens(rows, 'Anthropic', 'claude-opus-9')).toBe(128_000);
  });

  it('falls back to 64000 when the row names no cap', () => {
    expect(resolveMaxOutputTokens(rows, 'Anthropic', 'no-cap')).toBe(64_000);
  });
});

describe('resolveTurnCeiling (D9)', () => {
  const cfg = { turnMaxCredits: 2500 };

  it('credits: the smaller of the cap and the balance, floored at 1', () => {
    expect(resolveTurnCeiling({ mode: 'credits', balance: 10_000 }, cfg)).toBe(2500);
    expect(resolveTurnCeiling({ mode: 'credits', balance: 700 }, cfg)).toBe(700);
    expect(resolveTurnCeiling({ mode: 'credits', balance: 0 }, cfg)).toBe(1);
    expect(resolveTurnCeiling({ mode: 'credits', balance: -40 }, cfg)).toBe(1);
  });

  it('unmetered: the cap', () => {
    expect(resolveTurnCeiling({ mode: 'unmetered', balance: 5 }, cfg)).toBe(2500);
  });

  it('byok: no ceiling', () => {
    expect(resolveTurnCeiling({ mode: 'byok' }, cfg)).toBeNull();
  });
});

describe('createTurnMeter (D9)', () => {
  const step = (completionTokens: number) => ({ usage: { promptTokens: 100, completionTokens } });

  it('folds every step into the totals and aborts once the ceiling is crossed', () => {
    const totals = emptyUsage();
    const controller = new AbortController();
    const meter = createTurnMeter({
      totals,
      ceiling: 50,
      creditsFor: (u) => u.completionTokens / 10,
      controller,
    });

    meter.onStep(step(200));
    expect(meter.budgetHit).toBe(false);
    expect(controller.signal.aborted).toBe(false);

    meter.onStep(step(300));
    expect(meter.budgetHit).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe('budget');
    expect(totals.completionTokens).toBe(500);
    expect(totals.promptTokens).toBe(200);

    /* Steps after the hit still bill. */
    meter.onStep(step(1));
    expect(totals.completionTokens).toBe(501);
  });

  it('never aborts with no ceiling, no billing, or a throwing cost reader', () => {
    for (const [ceiling, creditsFor] of [
      [null, () => 1e9],
      [10, () => null],
      [
        10,
        () => {
          throw new Error('unpriced');
        },
      ],
    ] as const) {
      const controller = new AbortController();
      const meter = createTurnMeter({
        totals: emptyUsage(),
        ceiling,
        creditsFor: creditsFor as () => number | null,
        controller,
      });
      meter.onStep(step(10_000));
      expect(meter.budgetHit).toBe(false);
      expect(controller.signal.aborted).toBe(false);
    }
  });
});

describe('decideTurnEndVerdict — a deliberate loop stop never fails and never refunds (D9, D22, SPEC §4.6)', () => {
  /** The worst case: stopped on step one, no text, no tool call finished, a first build that owed files. */
  const nothing = { producedText: false, toolCallCount: 0, failedBuild: true };

  it.each(['budget', 'segments', 'breaker'] as const)(
    '%s stop with nothing written → ok (not failed, not refunded)',
    (stopReason) => {
      expect(decideTurnEndVerdict({ toolLoop: true, stopReason, ...nothing })).toBe('ok');
      expect(isDeliberateLoopStop(stopReason)).toBe(true);
    },
  );

  it('CONTROL: the same empty turn with no deliberate stop still fails (the refund stays reachable)', () => {
    expect(decideTurnEndVerdict({ toolLoop: true, stopReason: 'none', ...nothing })).toBe('empty-response');
    expect(
      decideTurnEndVerdict({
        toolLoop: true,
        stopReason: 'none',
        producedText: true,
        toolCallCount: 0,
        failedBuild: true,
      }),
    ).toBe('no-files-written');
  });

  it("a user Stop ('aborted') is not a deliberate loop stop — it keeps today's rules", () => {
    expect(isDeliberateLoopStop('aborted')).toBe(false);
    expect(isDeliberateLoopStop('none')).toBe(false);
    expect(decideTurnEndVerdict({ toolLoop: true, stopReason: 'aborted', ...nothing })).toBe('empty-response');
  });

  it('under the loop, tool calls are output — no text is not an empty response', () => {
    expect(
      decideTurnEndVerdict({
        toolLoop: true,
        stopReason: 'none',
        producedText: false,
        toolCallCount: 3,
        failedBuild: false,
      }),
    ).toBe('ok');
  });

  it('with the loop OFF the verdict is exactly the legacy two checks, and a stop reason cannot exempt anything', () => {
    for (const stopReason of ['none', 'budget', 'segments', 'breaker', 'aborted'] as const) {
      expect(decideTurnEndVerdict({ toolLoop: false, stopReason, ...nothing })).toBe('empty-response');
      expect(
        decideTurnEndVerdict({
          toolLoop: false,
          stopReason,
          producedText: false,
          toolCallCount: 5,
          failedBuild: false,
        }),
      ).toBe('empty-response');
      expect(
        decideTurnEndVerdict({ toolLoop: false, stopReason, producedText: true, toolCallCount: 0, failedBuild: true }),
      ).toBe('no-files-written');
      expect(
        decideTurnEndVerdict({ toolLoop: false, stopReason, producedText: true, toolCallCount: 0, failedBuild: false }),
      ).toBe('ok');
    }
  });

  it('a budget hit before any write on a first build: not failed, and the user is told it PAUSED (Keep building)', () => {
    expect(decideTurnEndVerdict({ toolLoop: true, stopReason: 'budget', ...nothing })).toBe('ok');

    const outcome = describeTurnOutcome({
      isFirstBuildTurn: true,
      finishReason: 'unknown',
      forcedContinuation: false,
      unproductiveRescue: false,
      completionPassWroteFiles: false,
      wroteFiles: false,
      aborted: false,
      stopReason: 'budget',
      lastCheckOk: null,
    });

    expect(outcome.state).toBe('paused');
    expect(outcome.actionLabel).toBe('Keep building');
  });
});

/*
 * The number the cached prompt TELLS the model must be the one `load_reference` enforces. The prompt
 * refresh and the proxy both resolve through `resolveTurnBudgets`; before it the refresh baked the
 * artifact-era 3 while the tool loop enforced 12.
 */
describe('resolveTurnBudgets — the reference budget the prompt bakes', () => {
  const baked = (context: unknown) =>
    buildReferenceIndex(ON_DEMAND_BLOCKS, resolveTurnBudgets(context).maxReferenceLoads);

  it('loop ON → the baked index says 12', () => {
    const index = baked(ctx({ AGENT_TOOL_LOOP: 'true' }));

    expect(index).toContain('You may load at most 12 references');
  });

  it('loop OFF → the baked index says 3', () => {
    const index = baked(ctx({}));

    expect(index).toContain('You may load at most 3 references');
  });

  it('an explicit AGENT_MAX_REFERENCE_LOADS still wins under the loop', () => {
    expect(resolveTurnBudgets(ctx({ AGENT_TOOL_LOOP: 'true', AGENT_MAX_REFERENCE_LOADS: '5' })).maxReferenceLoads).toBe(
      5,
    );
  });

  it('the proxy may pass the switch it already resolved', () => {
    expect(resolveTurnBudgets(ctx({}), true).maxReferenceLoads).toBe(12);
    expect(resolveTurnBudgets(ctx({ AGENT_TOOL_LOOP: 'true' }), false).maxReferenceLoads).toBe(3);
  });
});
