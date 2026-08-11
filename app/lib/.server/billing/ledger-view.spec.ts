/**
 * The credits panel's read-time decorations (SPEC §4.6).
 *
 * Two things are being pinned, and they fail in opposite directions. The DECORATION must never be able
 * to take the panel down — a row it cannot describe still has to render, because the balance and the
 * history are what that screen exists for. And the SAVINGS must never be claimed on a charge the user
 * did not ultimately pay, because that inflates a headline number with our own failures.
 *
 * ## ⚠️ NO GLOBAL ENV SCRUB — see `savings.spec.ts` for the full reasoning
 *
 * `buildLedgerView` lost its `context` parameter when `describeSavings` was made pure. It reads no env,
 * no price store and no billing config, so a 20-key `vi.stubEnv` prologue would assert a dependency
 * that no longer exists. Env is stubbed only inside the tests that assert a CONTROL about the paths
 * this code refuses to use.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLedgerView } from './ledger-view';
import { MODEL_RATES, costForRates, providerRates, type TokenUsage } from './rates';
import { invalidateMarketPricesCache } from './market-price-store';
import type { LedgerEntry } from './ledger';
import type { GenerationRecord } from './generations';

afterEach(() => {
  vi.unstubAllEnvs();
  invalidateMarketPricesCache();
});

const MODEL = 'claude-opus-5';

/**
 * A build-turn-sized vector on purpose: it prices to several hundred credits at Anthropic list, which
 * leaves plenty of room BELOW it for the gateway charges the fixtures use. A small vector would make
 * every "charged" figure exceed list, silently turning each saving into the floored-at-zero case and
 * grading the whole file against `full_price` instead of the arithmetic it means to assert.
 */
const USAGE: TokenUsage = {
  promptTokens: 20_000,
  completionTokens: 30_000,
  cacheReadTokens: 200_000,
  cacheCreationTokens: 100_000,
};

/** Anthropic list for `USAGE`, derived from the live baked table rather than pasted. */
const LIST_COST_USD = costForRates(USAGE, MODEL_RATES[MODEL]);

/**
 * Every fixture generation records a raw cost of exactly a QUARTER of Anthropic list, so the expected
 * numbers in this file fall out of the RATIO (`referenceCredits = charged x 4`) rather than out of a
 * second copy of the savings formula. A test that re-implements the code it tests passes for any
 * consistent pair of bugs.
 */
const GATEWAY_DISCOUNT = 4;
const GATEWAY_COST_USD = LIST_COST_USD / GATEWAY_DISCOUNT;

function referenceFor(charged: number): number {
  return charged * GATEWAY_DISCOUNT;
}

function gen(id: string, over: Partial<GenerationRecord> = {}): GenerationRecord {
  return {
    id,
    createdAt: '2026-08-10T10:00:00.000Z',
    model: MODEL,
    provider: 'Comet',
    promptVersionId: null,
    skillsLoaded: [],
    blocksLoaded: [],
    totalTokens: USAGE.promptTokens + USAGE.completionTokens,
    toolRounds: 0,
    statusKind: 'edit',

    /* The raw USD RECORDED with the turn — what `describeSavings` compares against (never re-derived). */
    rawCostUsd: GATEWAY_COST_USD,
    ...USAGE,
    ...over,
  };
}

function entry(over: Partial<LedgerEntry> & Pick<LedgerEntry, 'id' | 'delta' | 'reason'>): LedgerEntry {
  return {
    userId: 'u-1',
    balanceAfter: 1_000,
    createdAt: '2026-08-10T10:00:00.000Z',
    ...over,
  } as LedgerEntry;
}

describe('buildLedgerView leaves every row it cannot describe exactly as it found it', () => {
  it('passes non-generation reasons through undecorated', () => {
    const entries = [
      entry({ id: 'e-grant', delta: 1_000, reason: 'grant' }),
      entry({ id: 'e-purchase', delta: 9_500, reason: 'purchase' }),
      entry({ id: 'e-media', delta: -24, reason: 'media' }),
      entry({ id: 'e-project', delta: -100, reason: 'project_create' }),

      /*
       * A refund row carries a `generationId`, so it is the one non-generation reason that could
       * plausibly pick up a decoration by accident — and a refund wearing a savings figure would be
       * the panel claiming a discount on money it just handed back.
       */
      entry({ id: 'e-refund', delta: 316, reason: 'refund', generationId: 'g-1' }),
    ];

    const view = buildLedgerView(entries, [gen('g-1')]);

    expect(view.rows).toHaveLength(5);

    for (const row of view.rows) {
      expect(row.kind).toBeUndefined();
      expect(row.savedCredits).toBeUndefined();
    }

    // ...and the ledger's own fields still travel, unchanged.
    expect(view.rows[0]).toMatchObject({ id: 'e-grant', delta: 1_000, reason: 'grant', balanceAfter: 1_000 });
  });

  /*
   * A generation row can be swept, or the lookup can fail wholesale (`listByIds` returns [] on any
   * error). Dropping the ledger row would look, to the user, exactly like the credits going missing.
   */
  it('renders a generation whose generation row is missing — undecorated, never dropped', () => {
    const view = buildLedgerView([entry({ id: 'e-1', delta: -80, reason: 'generation', generationId: 'gone' })], []);

    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ id: 'e-1', delta: -80, reason: 'generation' });
    expect(view.rows[0].kind).toBeUndefined();
    expect(view.rows[0].savedCredits).toBeUndefined();
    expect(view.savings.comparedRows).toBe(0);
  });

  /* An unpriceable model is the `describeSavings` guard reaching this layer: kind yes, savings no. */
  it('keeps the kind but drops the savings when Anthropic cannot price the model', () => {
    const view = buildLedgerView(
      [entry({ id: 'e-1', delta: -80, reason: 'generation', generationId: 'g-1' })],
      [gen('g-1', { model: 'some-open-weights-model-anthropic-never-sold', statusKind: 'creation' })],
    );

    expect(view.rows[0].kind).toBe('creation');
    expect(view.rows[0].savedCredits).toBeUndefined();
    expect(view.savings).toEqual({ savedCredits: 0, referenceCredits: 0, percent: 0, comparedRows: 0 });
  });

  /*
   * 🔴 AN OLDER ROW PREDATES `raw_cost_usd`, AND A MISSING COST IS NOT A FREE TURN. `buildLedgerView`
   * passes `record.rawCostUsd ?? 0`, and `describeSavings` refuses a zero cost — the alternative is a
   * division by zero rendering as an `Infinity`-credit saving, or a re-pricing of the turn against
   * today's marketplace list, which is not what the user was billed against.
   */
  it('claims nothing on a generation row that has no recorded raw cost', () => {
    const view = buildLedgerView(
      [entry({ id: 'e-1', delta: -80, reason: 'generation', generationId: 'g-1' })],
      [gen('g-1', { rawCostUsd: undefined })],
    );

    expect(view.rows[0].kind).toBe('edit');
    expect(view.rows[0].savedCredits).toBeUndefined();
    expect(view.savings).toEqual({ savedCredits: 0, referenceCredits: 0, percent: 0, comparedRows: 0 });
  });

  /*
   * THE CONTROL for the test above. Without it, "no savings without a recorded cost" passes just as
   * happily for a `buildLedgerView` that never computes savings at all — the cheap way to make an
   * over-claiming bug go green while deleting the feature.
   */
  it('...and the SAME row WITH a recorded cost is compared', () => {
    const view = buildLedgerView(
      [entry({ id: 'e-1', delta: -80, reason: 'generation', generationId: 'g-1' })],
      [gen('g-1')],
    );

    expect(view.rows[0].savedCredits).toBe(referenceFor(80) - 80);
    expect(view.savings.comparedRows).toBe(1);
  });

  /*
   * 🔴 A STALE PRICE VARIABLE MUST NOT 503 THE CREDITS PANEL. The first draft of `describeSavings`
   * reached `providerRates`, which REFUSES a retired price var — so a leftover line in an env file
   * took down the one page a user opens to find out where their credits went. `buildLedgerView` now
   * touches no configuration at all, which is why the CONTROL below is the load-bearing half.
   */
  it('builds the whole view while a RETIRED price variable is set', () => {
    vi.stubEnv('KIE_INPUT_DOLLARS', '2');
    vi.stubEnv('PREMIUM_OUTPUT_DOLLARS', '10');

    // CONTROL: the path the first draft used really does refuse under exactly these variables.
    expect(() => providerRates()).toThrow();

    const view = buildLedgerView(
      [entry({ id: 'e-1', delta: -80, reason: 'generation', generationId: 'g-1' })],
      [gen('g-1')],
    );

    expect(view.rows[0].savedCredits).toBe(referenceFor(80) - 80);
    expect(view.savings.comparedRows).toBe(1);
  });
});

describe('buildLedgerView savings', () => {
  /*
   * 🔴 A REFUNDED GENERATION SAVED NOBODY ANYTHING. A failed turn is debited and handed straight back
   * (§4.6), so its debit row is still in the history — correctly, it happened — and claiming a
   * discount on it would inflate the headline figure with our own failures.
   */
  it('claims nothing on a generation that was refunded in the same page', () => {
    const charged = 80;
    const entries = [
      entry({ id: 'e-debit', delta: -charged, reason: 'generation', generationId: 'g-1' }),
      entry({ id: 'e-refund', delta: charged, reason: 'refund', generationId: 'g-1' }),
    ];

    const view = buildLedgerView(entries, [gen('g-1')]);

    expect(view.rows[0].kind).toBe('edit');
    expect(view.rows[0].savedCredits).toBeUndefined();
    expect(view.savings).toEqual({ savedCredits: 0, referenceCredits: 0, percent: 0, comparedRows: 0 });
  });

  /*
   * THE CONTROL for the test above. Without it, "no savings on a refunded generation" passes just as
   * happily for a `buildLedgerView` that computes no savings at all — which is the cheap way to make
   * a claim-too-much bug go green while deleting the feature.
   */
  it('...and the SAME charge WITHOUT a refund row is compared and counted', () => {
    const charged = 80;
    const view = buildLedgerView(
      [entry({ id: 'e-debit', delta: -charged, reason: 'generation', generationId: 'g-1' })],
      [gen('g-1')],
    );

    expect(view.rows[0].savedCredits).toBe(referenceFor(charged) - charged);
    expect(view.savings.comparedRows).toBe(1);
    expect(view.savings.referenceCredits).toBe(referenceFor(charged));
    expect(view.savings.savedCredits).toBe(referenceFor(charged) - charged);
  });

  /*
   * 🔴 THE LEDGER'S NUMBER, NOT THE GENERATION'S. They should agree; when they do not, the ledger row
   * is the one that moved the user's balance, and a saving derived from the other number describes a
   * charge that never happened. The fixture makes them disagree by an order of magnitude so a swap
   * cannot hide inside rounding.
   */
  it('measures the saving against the LEDGER delta, not generations.credits_charged', () => {
    const view = buildLedgerView(
      [entry({ id: 'e-debit', delta: -400, reason: 'generation', generationId: 'g-1' })],
      [gen('g-1', { creditsCharged: 5 })],
    );

    expect(view.rows[0].savedCredits).toBe(referenceFor(400) - 400);

    // The number the code must NOT have used — asserted explicitly so the fixture cannot go stale.
    expect(view.rows[0].savedCredits).not.toBe(referenceFor(5) - 5);
  });

  /*
   * "Saved 0" is a fact we do not have — it reads as "your gateway is no cheaper", when the truth may
   * be "this turn was billed at list". The row simply carries nothing and the panel renders nothing.
   */
  it('omits savedCredits entirely when the saving is zero', () => {
    const charged = 80;
    const view = buildLedgerView(
      [entry({ id: 'e-debit', delta: -charged, reason: 'generation', generationId: 'g-1' })],

      // Served at Anthropic list: the recorded cost IS list, so the reference equals the charge.
      [gen('g-1', { rawCostUsd: LIST_COST_USD })],
    );

    expect(view.rows[0].savedCredits).toBeUndefined();

    // ...but it IS a comparison, so it still counts toward the page's scope and its reference total.
    expect(view.savings.comparedRows).toBe(1);
    expect(view.savings.referenceCredits).toBe(charged);
    expect(view.savings.savedCredits).toBe(0);
    expect(view.savings.percent).toBe(0);
  });

  /*
   * ⚠️ `comparedRows` is not decoration. The totals cover THIS PAGE of the ledger — not the account's
   * lifetime — so a headline number without its scope is a claim the data does not support.
   */
  it('summarises only the rows that were actually compared', () => {
    const entries = [
      entry({ id: 'e-1', delta: -80, reason: 'generation', generationId: 'g-1' }),
      entry({ id: 'e-2', delta: -120, reason: 'generation', generationId: 'g-2' }),

      // Not compared: no generation row, an unpriceable model, a refunded charge, and a purchase.
      entry({ id: 'e-3', delta: -50, reason: 'generation', generationId: 'gone' }),
      entry({ id: 'e-4', delta: -70, reason: 'generation', generationId: 'g-unpriced' }),
      entry({ id: 'e-5', delta: -90, reason: 'generation', generationId: 'g-refunded' }),
      entry({ id: 'e-6', delta: 90, reason: 'refund', generationId: 'g-refunded' }),
      entry({ id: 'e-7', delta: 9_500, reason: 'purchase' }),

      // Not compared either: an older row with no recorded raw cost to compare against.
      entry({ id: 'e-8', delta: -60, reason: 'generation', generationId: 'g-nocost' }),
    ];

    const view = buildLedgerView(entries, [
      gen('g-1', { statusKind: 'creation' }),
      gen('g-2', { statusKind: 'repair' }),
      gen('g-unpriced', { model: 'some-open-weights-model-anthropic-never-sold' }),
      gen('g-refunded'),
      gen('g-nocost', { rawCostUsd: undefined }),
    ]);

    const expectedReference = referenceFor(80) + referenceFor(120);
    const expectedSaved = referenceFor(80) - 80 + (referenceFor(120) - 120);

    expect(view.savings).toEqual({
      comparedRows: 2,
      referenceCredits: expectedReference,
      savedCredits: expectedSaved,
      percent: Math.round((expectedSaved / expectedReference) * 100),
    });

    // Every row still renders, decorated or not — eight in, eight out, in order.
    expect(view.rows.map((r) => r.id)).toEqual(['e-1', 'e-2', 'e-3', 'e-4', 'e-5', 'e-6', 'e-7', 'e-8']);
    expect(view.rows[0].kind).toBe('creation');
    expect(view.rows[1].kind).toBe('repair');
  });

  it('an empty page reports zeroes rather than NaN', () => {
    expect(buildLedgerView([], []).savings).toEqual({
      savedCredits: 0,
      referenceCredits: 0,
      percent: 0,
      comparedRows: 0,
    });
  });
});
