/**
 * Admin usage aggregation (SPEC §4.10).
 *
 * This is the lens the operator judges platform health and spend through, so its arithmetic is a
 * correctness path: a wrong cache-hit-rate sends "why is the bill high" to the wrong fix, and a wrong
 * wasted-output number hides the exact pathology the diagnostics columns exist to expose
 * (spec/context-budget.md).
 */
import { describe, expect, it } from 'vitest';
import { buildUsageReport } from './usage-report';
import type { GenerationRecord } from '~/lib/.server/billing/generations';

const gen = (over: Partial<GenerationRecord>): GenerationRecord =>
  ({
    id: over.id ?? 'g',
    createdAt: '2026-07-14T00:00:00Z',
    model: 'claude-sonnet-5',
    provider: 'Anthropic',
    promptVersionId: null,
    skillsLoaded: [],
    blocksLoaded: [],
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolRounds: 0,
    ...over,
  }) as GenerationRecord;

describe('buildUsageReport', () => {
  it('is all-zero for no records, and never divides by zero', () => {
    const report = buildUsageReport([]);

    expect(report.generations).toBe(0);
    expect(report.failureRate).toBe(0);
    expect(report.cacheHitRate).toBe(0);
    expect(report.avgDurationMs).toBe(0);
  });

  it('sums cost and credits and computes the failure rate', () => {
    const report = buildUsageReport([
      gen({ status: 'completed', creditsCharged: 100, rawCostUsd: 0.05 }),
      gen({ status: 'completed', creditsCharged: 200, rawCostUsd: 0.1 }),
      gen({ status: 'failed', creditsCharged: 0, rawCostUsd: 0 }),
    ]);

    expect(report.creditsCharged).toBe(300);
    expect(report.rawCostUsd).toBeCloseTo(0.15);
    expect(report.completed).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.failureRate).toBeCloseTo(1 / 3);
  });

  it('computes cache hit rate as reads over all cacheable input', () => {
    // 900 read out of (100 prompt + 900 read + 0 write) = 0.9
    const report = buildUsageReport([gen({ promptTokens: 100, cacheReadTokens: 900, cacheCreationTokens: 0 })]);

    expect(report.cacheHitRate).toBeCloseTo(0.9);
  });

  it('counts output on steps that emitted no text at all', () => {
    const report = buildUsageReport([
      gen({
        steps: [
          // Thought, called a tool, wrote nothing. Billed at decode rate for zero user-visible output.
          { ms: 1, outTokens: 5000, inTokens: 0, cacheRead: 0, cacheWrite: 0, tools: ['load_skill'], textChars: 0 },
          { ms: 1, outTokens: 3000, inTokens: 0, cacheRead: 0, cacheWrite: 0, tools: [], textChars: 0 },
          { ms: 1, outTokens: 9000, inTokens: 0, cacheRead: 0, cacheWrite: 0, tools: [], textChars: 34_000 },
        ],
      }),
    ]);

    expect(report.silentStepOutputTokens).toBe(8000);
    expect(report.visibleTextChars).toBe(34_000);
  });

  /**
   * THE REGRESSION THIS METRIC EXISTS FOR.
   *
   * The old definition was "sum of all-but-last step outputs" — waste means extra steps. That was true
   * when written, and the fix for the pathology it measured made it false: pre-loading skills sets
   * `allowTools:false` → `maxSteps:1`, so a creation is now exactly ONE step and the old metric's
   * `steps.length <= 1` guard reported **zero waste on the most expensive generation in the product**.
   *
   * The real numbers: 44,308 output tokens billed, ~9k TOKENS of visible answer ≈ 34,200 chars at the
   * ~3.8 chars/token that real text runs at. That is 0.77 ch/tok — a fifth of healthy — so ~35k of that
   * output was thinking and redrafting. The old metric scored it a clean zero.
   */
  it('catches a single-step generation that was billed for output it never wrote', () => {
    const report = buildUsageReport([
      gen({
        completionTokens: 44_308,
        steps: [
          { ms: 550_000, outTokens: 44_308, inTokens: 0, cacheRead: 0, cacheWrite: 0, tools: [], textChars: 34_200 },
        ],
      }),
    ]);

    // The step DID emit text, so it is not "silent" — only the density exposes it.
    expect(report.silentStepOutputTokens).toBe(0);
    expect(report.charsPerOutputToken).toBeCloseTo(0.77, 2);

    // Well under the ~3.5 floor that real text cannot go below. That is the alarm.
    expect(report.charsPerOutputToken).toBeLessThan(3.5);
  });

  it('scores a healthy generation near the ~3.5-4 chars/token of real text', () => {
    const report = buildUsageReport([
      gen({
        completionTokens: 9000,
        steps: [
          { ms: 90_000, outTokens: 9000, inTokens: 0, cacheRead: 0, cacheWrite: 0, tools: [], textChars: 34_000 },
        ],
      }),
    ]);

    expect(report.charsPerOutputToken).toBeCloseTo(3.8, 1);
    expect(report.silentStepOutputTokens).toBe(0);
  });

  /*
   * `undefined` is "we never measured this", not "no text". Counting it as zero would report every
   * generation recorded before `textChars` existed as 100% waste, and the dashboard would show a
   * catastrophe that never happened.
   */
  it('skips steps recorded before textChars existed rather than calling them silent', () => {
    const report = buildUsageReport([
      gen({ steps: [{ ms: 1, outTokens: 9000, inTokens: 0, cacheRead: 0, cacheWrite: 0, tools: [] }] }),
    ]);

    expect(report.silentStepOutputTokens).toBe(0);
    expect(report.visibleTextChars).toBe(0);
  });

  it('never reports NaN density when there is no output', () => {
    expect(buildUsageReport([gen({ completionTokens: 0 })]).charsPerOutputToken).toBe(0);
    expect(buildUsageReport([]).charsPerOutputToken).toBe(0);
  });

  it('breaks down by model, most expensive first', () => {
    const report = buildUsageReport([
      gen({ model: 'claude-sonnet-5', rawCostUsd: 0.02 }),
      gen({ model: 'claude-opus-4-8', rawCostUsd: 0.5 }),
      gen({ model: 'claude-sonnet-5', rawCostUsd: 0.03 }),
    ]);

    expect(report.byModel[0].model).toBe('claude-opus-4-8');
    expect(report.byModel[1]).toMatchObject({ model: 'claude-sonnet-5', generations: 2 });
    expect(report.byModel[1].rawCostUsd).toBeCloseTo(0.05);
  });
});
