/**
 * The provider credit pool (§4.10, `spec/fail-loud.md` rule 2).
 *
 * Two things are worth testing here and they fail in opposite directions:
 *
 *   - **The arithmetic**, because an operator makes a purchasing decision on the runway number. Too
 *     high and they run the pool dry mid-demo; too low and they buy credit they did not need.
 *   - **The failure posture**, because a balance we could not read must render as UNKNOWN. A healthy
 *     number in place of a failed read is worse than no number at all — it is the one state that stops
 *     the operator checking, which is exactly the `premiumSessionHint` lesson.
 */
import { describe, expect, it } from 'vitest';
import { describeProviderBalance } from './provider-balance';

const base = {
  creditsPerUsd: 200,
  creditUnitCostUsd: 0.01,
  margin: 4,
  fetchedAt: '2026-07-26T06:00:00.000Z',
};

describe('describeProviderBalance — the arithmetic', () => {
  /*
   * The measured conversion: 200 KIE credits per dollar (calibration run in the module doc comment).
   * 87,020 credits is the real balance this shipped against, so the numbers below are the ones an
   * operator would have seen on day one.
   */
  it('converts provider credits to dollars at the measured rate', () => {
    const result = describeProviderBalance({ ...base, credits: 87_020 });

    expect(result.credits).toBe(87_020);
    expect(result.usd).toBeCloseTo(435.1, 1);
  });

  /*
   * The runway number: one dollar of raw provider spend becomes `margin / creditUnitCostUsd` platform
   * credits of sellable product — the biller's own formula, inverted. At $0.01 and 4x that is 400
   * platform credits per provider dollar.
   */
  it('reports how much PRODUCT the pool can still serve, not just how much money is left', () => {
    const result = describeProviderBalance({ ...base, credits: 87_020 });

    expect(result.platformCreditsRemaining).toBe(Math.floor(435.1 * 400));
  });

  it('tracks the billing config rather than hardcoding a rate', () => {
    const cheaper = describeProviderBalance({ ...base, credits: 20_000, creditUnitCostUsd: 0.02 });
    const richer = describeProviderBalance({ ...base, credits: 20_000, margin: 8 });

    // $100 of pool: at $0.02/credit and 4x margin that is 20,000 platform credits, not 40,000.
    expect(cheaper.platformCreditsRemaining).toBe(20_000);
    expect(richer.platformCreditsRemaining).toBe(80_000);
  });

  it('never reports a fractional platform credit — a credit is an integer everywhere else', () => {
    const result = describeProviderBalance({ ...base, credits: 7 });

    expect(Number.isInteger(result.platformCreditsRemaining)).toBe(true);
  });

  it('a genuinely empty pool is zero, not unknown — the operator must see the difference', () => {
    const result = describeProviderBalance({ ...base, credits: 0 });

    expect(result.credits).toBe(0);
    expect(result.usd).toBe(0);
    expect(result.platformCreditsRemaining).toBe(0);
    expect(result.reason).toBeUndefined();
  });
});

describe('describeProviderBalance — unknown is UNKNOWN, never a healthy zero', () => {
  it('carries the reason through so the panel can say what went wrong', () => {
    const result = describeProviderBalance({
      ...base,
      credits: null,
      reason: 'The provider refused the balance request (401: unauthorized).',
    });

    expect(result.credits).toBeNull();
    expect(result.usd).toBeNull();
    expect(result.platformCreditsRemaining).toBeNull();
    expect(result.reason).toContain('401');
  });

  it('supplies a reason even when the caller forgot one — a silent null is unreadable', () => {
    expect(describeProviderBalance({ ...base, credits: null }).reason).toBeTruthy();
  });

  /*
   * A non-finite balance is a provider returning nonsense, and it must not become `Infinity` dollars
   * of runway on the dashboard — the most reassuring possible way to be wrong.
   */
  it('refuses a non-finite balance rather than rendering infinite runway', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = describeProviderBalance({ ...base, credits: bad });

      expect(result.credits).toBeNull();
      expect(result.platformCreditsRemaining).toBeNull();
    }
  });

  it('refuses a nonsense conversion rate instead of dividing by zero', () => {
    expect(describeProviderBalance({ ...base, credits: 1000, creditsPerUsd: 0 }).usd).toBeNull();
  });
});
