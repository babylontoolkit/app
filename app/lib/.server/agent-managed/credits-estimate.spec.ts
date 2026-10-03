/**
 * The live "~N credits so far" estimate for a managed turn (`_specs/managed-billing-visibility_plan.md` D1).
 *
 * The number must be what settlement WOULD charge right now against the chat's cursor — the same
 * functions, never a second formula — and it must never write anything. These pin the estimator's own
 * rules (the cursor, the throttle, a failing source); `engine-turn.spec.ts` pins that the number a turn
 * showed equals the credits its settlement then charged.
 */
import { describe, expect, it } from 'vitest';
import type { ModelRates } from '~/lib/.server/billing/rates';
import { createCreditsEstimator, estimateManagedCredits } from './credits-estimate';
import {
  decideManagedCharge,
  EMPTY_COST_CURSOR,
  serializeCostCursor,
  sessionCost,
  tokensOf,
  type ApiUsageLike,
} from './session-cost';

const RATES: ModelRates = { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 6 };
const ratesOf = () => RATES;
const billing = { creditUnitCostUsd: 0.01, margin: 4 };
const MODEL = 'claude-sonnet-5';

const USAGE: ApiUsageLike = {
  input_tokens: 2_000,
  output_tokens: 12_000,
  cache_read_input_tokens: 400_000,
  cache_creation: { ephemeral_5m_input_tokens: 30_000 },
  active_seconds: 600,
  list_cost: { amount: '40', currency: 'USD' },
};

/** What `settleManagedTurn` charges for a one-thread session with this usage (its exact call shape). */
function settlementCharge(usage: ApiUsageLike, cursor = EMPTY_COST_CURSOR) {
  const cost = sessionCost({
    threads: [{ id: 'primary', model: MODEL, tokens: tokensOf(usage) }],
    sessionTokens: tokensOf(usage),
    activeSeconds: usage.active_seconds ?? 0,
    listCostCents: 40,
    fallbackModel: MODEL,
    ratesOf,
    sessionHourUsd: 0.08,
  });

  return decideManagedCharge(cost, cursor, billing);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('estimateManagedCredits', () => {
  it('is exactly what settlement would charge for the same usage and cursor', () => {
    const estimate = estimateManagedCredits({
      usage: USAGE,
      cursor: EMPTY_COST_CURSOR,
      model: MODEL,
      ratesOf,
      billing,
      sessionHourUsd: 0.08,
    });

    expect(estimate).toBe(settlementCharge(USAGE)!.credits);
    expect(estimate).toBeGreaterThan(0);
  });

  it('subtracts what the cursor says was already charged', () => {
    const half: ApiUsageLike = { ...USAGE, output_tokens: 6_000, cache_read_input_tokens: 200_000 };
    const cursor = settlementCharge(half)!.next;
    const estimate = estimateManagedCredits({
      usage: USAGE,
      cursor,
      model: MODEL,
      ratesOf,
      billing,
      sessionHourUsd: 0.08,
    });

    expect(estimate).toBe(settlementCharge(USAGE, cursor)!.credits);
    expect(estimate).toBeLessThan(settlementCharge(USAGE)!.credits);
  });

  it('nothing new since the cursor → 0', () => {
    const cursor = settlementCharge(USAGE)!.next;

    expect(estimateManagedCredits({ usage: USAGE, cursor, model: MODEL, ratesOf, billing, sessionHourUsd: 0.08 })).toBe(
      0,
    );
  });
});

describe('createCreditsEstimator', () => {
  const base = { model: MODEL, ratesOf, billing, sessionHourUsd: 0.08 };

  it('prices the latest session.usage event against the cursor read at turn start', async () => {
    const estimator = createCreditsEstimator({ ...base, cursor: async () => null });

    await flush();
    expect(estimator.current()).toBeNull();

    estimator.observe({ type: 'session.usage', usage: USAGE });
    expect(estimator.current()).toBe(settlementCharge(USAGE)!.credits);
  });

  it('a stored cursor is honoured — the estimate is this turn’s, not the session’s lifetime', async () => {
    const half: ApiUsageLike = { ...USAGE, output_tokens: 6_000, cache_read_input_tokens: 200_000 };
    const cursor = settlementCharge(half)!.next;
    const estimator = createCreditsEstimator({ ...base, cursor: async () => serializeCostCursor(cursor) });

    await flush();
    estimator.observe({ type: 'session.usage', usage: USAGE });

    expect(estimator.current()).toBe(settlementCharge(USAGE, cursor)!.credits);
  });

  it('a legacy (pre-v2) cursor shows NO estimate rather than one that includes already-billed usage', async () => {
    const estimator = createCreditsEstimator({
      ...base,
      cursor: async () => JSON.stringify({ at: '2026-10-01T00:00:00Z', activeSeconds: 3 }),
    });

    await flush();
    estimator.observe({ type: 'session.usage', usage: USAGE });

    expect(estimator.current()).toBeNull();
  });

  it('an older snapshot never replaces a newer one (cumulative usage only grows)', async () => {
    const estimator = createCreditsEstimator({ ...base, cursor: async () => null });

    await flush();
    estimator.observe({ type: 'session.usage', usage: USAGE });
    estimator.observe({ type: 'session.usage', usage: { ...USAGE, output_tokens: 1 } });

    expect(estimator.current()).toBe(settlementCharge(USAGE)!.credits);
  });

  it('without usage events it asks the session, at most once per 15 s', async () => {
    let clock = 0;
    let calls = 0;
    const estimator = createCreditsEstimator({
      ...base,
      cursor: async () => null,
      now: () => clock,
      refresh: async () => {
        calls += 1;
        return USAGE;
      },
    });

    await flush();
    expect(estimator.current()).toBeNull();
    await flush();
    expect(calls).toBe(1);
    expect(estimator.current()).toBe(settlementCharge(USAGE)!.credits);

    clock = 14_999;
    estimator.current();
    await flush();
    expect(calls).toBe(1);

    clock = 15_000;
    estimator.current();
    await flush();
    expect(calls).toBe(2);
  });

  it('a throwing source or cursor read drops the estimate, never throws', async () => {
    const estimator = createCreditsEstimator({
      ...base,
      cursor: async () => {
        throw new Error('db down');
      },
      refresh: async () => {
        throw new Error('anthropic down');
      },
    });

    await flush();
    expect(() => estimator.current()).not.toThrow();
    await flush();
    estimator.observe({ type: 'session.usage', usage: USAGE });
    expect(estimator.current()).toBeNull();
  });
});
