/**
 * Guards the tool-loop token accounting (§4.6 — a money path).
 *
 * The regression these tests exist to prevent: reading cache tokens from `result.providerMetadata`,
 * which ai@4 documents as "from the LAST step". In a 6-round tool loop that throws away five rounds
 * of cache accounting while `result.usage` (combined across all steps) keeps all six — so the bill is
 * computed from two different denominators and nothing anywhere throws.
 */
import { describe, expect, it } from 'vitest';
import { accumulateStepUsage, emptyUsage, type UsageStep } from './step-usage';

/** One round of a tool loop, shaped like the provider actually reports it. */
function step(promptTokens: number, completionTokens: number, cacheRead: number, cacheWrite: number): UsageStep {
  return {
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    providerMetadata: { anthropic: { cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite } },
  };
}

describe('accumulateStepUsage', () => {
  /**
   * The shape of a real creation: round 1 pays to WRITE the 133K prefix into the cache, rounds 2-6
   * READ it back. A correct accounting sees five reads. The bug saw one.
   */
  it('sums cache tokens across EVERY step, not just the last', () => {
    const PREFIX = 133_000;
    const steps: UsageStep[] = [
      step(4_000, 900, 0, PREFIX), // round 1: cold — writes the cache
      step(1_200, 800, PREFIX, 0), // rounds 2-6: warm — read it back
      step(1_400, 850, PREFIX, 0),
      step(1_600, 900, PREFIX, 0),
      step(1_800, 950, PREFIX, 0),
      step(2_000, 40_000, PREFIX, 0), // the answer step, where the file bodies get written
    ];

    const totals = accumulateStepUsage(emptyUsage(), steps);

    expect(totals.cacheReadTokens).toBe(PREFIX * 5);
    expect(totals.cacheCreationTokens).toBe(PREFIX);

    // The precise failure mode: last-step-only accounting would have recorded exactly one read.
    expect(totals.cacheReadTokens).not.toBe(PREFIX);

    expect(totals.promptTokens).toBe(12_000);
    expect(totals.completionTokens).toBe(44_400);
  });

  /**
   * `promptTokens` (combined) and the cache columns (last-step) must share a denominator. Before the
   * fix, input summed over 6 rounds while cache summed over 1 — so the ratio between them, which is
   * what the margin depends on, was fiction.
   */
  it('keeps input and cache accounting on the same denominator', () => {
    const steps = [step(1_000, 100, 0, 50_000), step(1_000, 100, 50_000, 0), step(1_000, 100, 50_000, 0)];

    const totals = accumulateStepUsage(emptyUsage(), steps);

    expect(totals.promptTokens).toBe(3_000);
    expect(totals.cacheReadTokens).toBe(100_000);
  });

  /**
   * A generation can stream more than once — when the tool-round cap is hit we run a second stream
   * with tools disabled to force an answer (§4.2, "on cap, proceed with what's loaded"). Both drains
   * fold into one bill; the second must not clobber the first.
   */
  it('accumulates across multiple drains rather than overwriting', () => {
    const totals = emptyUsage();

    accumulateStepUsage(totals, [step(1_000, 500, 10_000, 0)]);
    accumulateStepUsage(totals, [step(2_000, 700, 20_000, 0)]);

    expect(totals.promptTokens).toBe(3_000);
    expect(totals.completionTokens).toBe(1_200);
    expect(totals.cacheReadTokens).toBe(30_000);
  });

  /** Never bill NaN, and never fail a finished generation over our own bookkeeping. */
  it('treats missing or malformed provider numbers as zero', () => {
    const totals = accumulateStepUsage(emptyUsage(), [
      {},
      { usage: { promptTokens: 100 } },
      { usage: { promptTokens: Number.NaN, completionTokens: 50 }, providerMetadata: {} },
      { providerMetadata: { anthropic: {} } },
    ]);

    expect(totals.promptTokens).toBe(100);
    expect(totals.completionTokens).toBe(50);
    expect(totals.cacheReadTokens).toBe(0);
    expect(Number.isNaN(totals.promptTokens)).toBe(false);
  });

  it('handles a generation with no steps at all', () => {
    expect(accumulateStepUsage(emptyUsage(), undefined)).toEqual(emptyUsage());
  });
});
