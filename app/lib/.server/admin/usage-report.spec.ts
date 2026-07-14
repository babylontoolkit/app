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

  it('counts wasted output as every step BUT the last (the visible answer)', () => {
    const report = buildUsageReport([
      gen({
        steps: [
          { ms: 1, outTokens: 5000, inTokens: 0, cacheRead: 0, cacheWrite: 0, tools: ['load_skill'] },
          { ms: 1, outTokens: 3000, inTokens: 0, cacheRead: 0, cacheWrite: 0, tools: [] },
          { ms: 1, outTokens: 9000, inTokens: 0, cacheRead: 0, cacheWrite: 0, tools: [] }, // the answer
        ],
      }),
    ]);

    // 5000 + 3000 spent on steps whose text the user never saw; the 9000 answer is not waste.
    expect(report.estimatedWastedOutputTokens).toBe(8000);
  });

  it('reports zero waste for a single-step generation', () => {
    const report = buildUsageReport([
      gen({ steps: [{ ms: 1, outTokens: 9000, inTokens: 0, cacheRead: 0, cacheWrite: 0, tools: [] }] }),
    ]);

    expect(report.estimatedWastedOutputTokens).toBe(0);
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
