/**
 * The savings figure is a MARKETING CLAIM printed next to a money number (SPEC §4.6).
 *
 * Every test here pins a way of saying nothing, because the only safe failure mode for this module is
 * silence: a wrong "you saved 300 credits" is not a cosmetic bug, it is the platform telling a user
 * something flattering and false about their own bill. Nothing throws when it goes wrong — the number
 * just gets bigger, which reads as good news.
 *
 * ## ⚠️ THE ENV SCRUB IS GONE ON PURPOSE — READ THIS BEFORE ADDING ONE BACK
 *
 * The previous version of this file opened with a 20-key `vi.stubEnv` block guarding the `oauth.spec.ts`
 * trap, because `describeSavings` reached `providerRates` → the marketplace price store → the billing
 * config, and every one of those chains is `.env.local`-sensitive. Adversarial review found three real
 * defects in exactly that reach, the module was rewritten PURE, and the scrub became a lie: it would
 * imply this code still depends on configuration it can no longer see.
 *
 * The absence is now itself an assertion. In particular `PREMIUM_MODEL` is deliberately NOT scrubbed
 * anywhere except the one test that stubs it IN — the old scrub existed to hide defect 2 (a paid rung's
 * model being injected into the "Anthropic" table at marketplace rates), and hiding it is precisely how
 * a test grades a bug as a feature.
 *
 * Env is stubbed only inside the tests that assert a CONTROL about the paths this module refuses to
 * use, and inside the margin-invariance tests — where the whole point is that a mutant which reads
 * config would answer differently.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeSavings, REFERENCE_RATES } from './savings';
import {
  MODEL_RATES,
  costForRates,
  creditsForRawCost,
  getBillingConfig,
  kieRates,
  providerRates,
  ratesFor,
  type BillingConfig,
  type TokenUsage,
} from './rates';
import { invalidateMarketPricesCache } from './market-price-store';

afterEach(() => {
  vi.unstubAllEnvs();
  invalidateMarketPricesCache();
});

/**
 * Retired price variables and retired ladder variables, scrubbed only where a CONTROL calls into
 * `providerRates`/`kieRates`/`ratesFor` — which genuinely do refuse them (that refusal is defect 1).
 *
 * ⚠️ The developer's real `.env.local` sets `ENABLE_EXTENDED_MODELS`, `PREMIUM_MODEL` and friends, and
 * `env()` falls back to `process.env`, so a control that reaches the ladder must state its own world.
 * The module under test needs none of this.
 */
function scrubLadderAndPriceEnv(): void {
  for (const key of [
    'KIE_INPUT_DOLLARS',
    'KIE_OUTPUT_DOLLARS',
    'KIE_CACHED_INPUT',
    'KIE_CACHED_WRITES',
    'PREMIUM_INPUT_DOLLARS',
    'PREMIUM_OUTPUT_DOLLARS',
    'ENABLE_PREMIUM_MODEL',
    'SUPERMAX_MODEL',
    'SUPERMAX_MINIMUM_CREDITS',
  ]) {
    vi.stubEnv(key, undefined as unknown as string);
  }
}

/** A real turn's shape: mostly cached prefix, a modest answer. Anthropic prices this model natively. */
const USAGE: TokenUsage = {
  promptTokens: 9_000,
  completionTokens: 3_000,
  cacheReadTokens: 110_000,
  cacheCreationTokens: 0,
};

const PRICED_MODEL = 'claude-opus-5';

/**
 * Anthropic list for `USAGE`, derived from the live baked table rather than pasted.
 *
 * A hardcoded dollar figure would be a number nobody could re-derive the next time a rate moves — it
 * would be "changed to make the test pass", which is not an assertion.
 */
const LIST_COST_USD = costForRates(USAGE, MODEL_RATES[PRICED_MODEL]);

/**
 * The fixture gateway costs exactly a QUARTER of Anthropic list, which makes every expected number in
 * this file fall out of the RATIO — the contract — rather than out of a second copy of the formula.
 * A test that re-implements the function it is testing passes for any consistent pair of bugs.
 */
const GATEWAY_DISCOUNT = 4;
const GATEWAY_COST_USD = LIST_COST_USD / GATEWAY_DISCOUNT;

/** `creditsForRawCost` against a stated margin — no env, so the test's yardstick is explicit. */
function creditsAtMargin(costUsd: number, margin: number, creditUnitCostUsd = 0.01): number {
  const config: BillingConfig = {
    enforced: false,
    creditUnitCostUsd,
    margin,
    signupGrantCredits: 0,
    creationFlatCredits: 0,
    projectCreateCredits: 0,
    grantsEnabled: false,
  };

  return creditsForRawCost(costUsd, config);
}

describe('describeSavings says nothing rather than something false', () => {
  it('is null when nothing was charged — BYOK, unmetered, a turn that consumed nothing', () => {
    /*
     * "You saved 300 credits" beside a 0-credit row reads as "we charged you and gave it back", which
     * is a different and much more alarming story than the true one ("this turn was free").
     */
    const input = { usage: USAGE, model: PRICED_MODEL, actualCostUsd: GATEWAY_COST_USD };

    expect(describeSavings({ ...input, creditsCharged: 0 })).toBeNull();
    expect(describeSavings({ ...input, creditsCharged: -5 })).toBeNull();
  });

  /*
   * 🔴 NO RECORDED COST, NO RATIO — AND NO GUESS. `actualCostUsd` is the raw USD recorded WITH the turn
   * (`settlement.rawCostUsd` live, `generations.raw_cost_usd` for history), and an older row predates
   * that column. Re-pricing the turn today would use today's marketplace list and today's gateway,
   * neither of which is what the user was billed against.
   *
   * ⚠️ This guard is also the only thing standing between the panel and a division by zero: without it
   * a zero cost yields `Infinity` credits "saved" and a `NaN` percent, which renders as a headline
   * figure rather than as an error.
   */
  it('is null when the turn has no recorded raw cost to compare against', () => {
    const input = { usage: USAGE, model: PRICED_MODEL, creditsCharged: 100 };

    expect(describeSavings({ ...input, actualCostUsd: 0 })).toBeNull();
    expect(describeSavings({ ...input, actualCostUsd: -0.5 })).toBeNull();
    expect(describeSavings({ ...input, actualCostUsd: Number.NaN })).toBeNull();
  });

  /*
   * 🔴 THE GUARD THIS MODULE IS BUILT AROUND. `ratesFor` cannot report "I do not know this model" — by
   * design it answers with the provider's MOST EXPENSIVE row, which is right for billing (wrong in our
   * own favour is recoverable) and poison here: a model Anthropic has no row for would be "compared"
   * against the priciest thing Anthropic sells, manufacturing an enormous discount out of nothing.
   */
  it('is null when Anthropic does not price the model IN ITS OWN RIGHT', () => {
    const model = 'some-open-weights-model-anthropic-never-sold';

    expect(MODEL_RATES[model]).toBeUndefined();
    expect(REFERENCE_RATES[model]).toBeUndefined();

    expect(describeSavings({ usage: USAGE, model, actualCostUsd: GATEWAY_COST_USD, creditsCharged: 100 })).toBeNull();
  });

  /*
   * The CONTROL for the test above, and the thing that makes it an assertion about the guard rather
   * than about an accidentally-empty table: `ratesFor` DOES hand back a full (and very expensive) row
   * for that same unpriced model, so a `describeSavings` that went through it would return a large,
   * confident, entirely fabricated saving instead of null.
   */
  it('...and the fallback it refuses to use would have invented a saving out of nothing', () => {
    scrubLadderAndPriceEnv();

    const model = 'some-open-weights-model-anthropic-never-sold';
    const fallbackRates = ratesFor(model, 'Anthropic');

    expect(fallbackRates.outputPerMTok).toBeGreaterThan(0);

    const charged = 100;
    const throughTheFallback = Math.round(charged * (costForRates(USAGE, fallbackRates) / GATEWAY_COST_USD));

    // A confident, entirely fabricated discount — this is the number the guard exists to never print.
    expect(throughTheFallback).toBeGreaterThan(charged);
  });

  it('is null when the reference itself prices to nothing (a turn that used no tokens)', () => {
    const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

    expect(
      describeSavings({ usage, model: PRICED_MODEL, actualCostUsd: GATEWAY_COST_USD, creditsCharged: 5 }),
    ).toBeNull();
  });
});

/**
 * 🔴 DEFECT 1 — IT CANNOT TAKE A READ PATH DOWN.
 *
 * The first draft called `rawCostUsd` → `providerRates`, which REFUSES loudly when a retired price
 * variable is still set. That put a 503 on `/api/credits` — the page a user opens to find out where
 * their credits went — for a stale line in an env file. The module now reads a MODULE CONSTANT, so the
 * failure is not merely unlikely, it is inexpressible.
 */
describe('describeSavings is PURE, so a stale env var cannot 503 the credits panel', () => {
  it('answers normally while a RETIRED price variable is set', () => {
    vi.stubEnv('KIE_INPUT_DOLLARS', '2');
    vi.stubEnv('PREMIUM_OUTPUT_DOLLARS', '10');

    // CONTROL: the path the first draft used really does refuse under exactly these variables.
    expect(() => providerRates()).toThrow();

    expect(
      describeSavings({
        usage: USAGE,
        model: PRICED_MODEL,
        actualCostUsd: GATEWAY_COST_USD,
        creditsCharged: 100,
      }),
    ).toEqual({
      basis: 'saved',
      referenceCredits: 400,
      savedCredits: 300,
      percent: 75,
    });
  });

  it('answers normally while the BILLING CONFIG itself is unreadable', () => {
    // `CREATION_FLAT_CREDITS` is retired and refused — `getBillingConfig` throws on it (§4.4a).
    vi.stubEnv('CREATION_FLAT_CREDITS', '500');

    expect(() => getBillingConfig()).toThrow();

    expect(
      describeSavings({
        usage: USAGE,
        model: PRICED_MODEL,
        actualCostUsd: GATEWAY_COST_USD,
        creditsCharged: 100,
      })?.savedCredits,
    ).toBe(300);
  });

  it('never throws, whatever it is handed', () => {
    const hostile = [
      { usage: USAGE, model: '', actualCostUsd: Number.NaN, creditsCharged: Number.NaN },
      { usage: USAGE, model: PRICED_MODEL, actualCostUsd: Number.POSITIVE_INFINITY, creditsCharged: 10 },
      {
        usage: { promptTokens: Number.NaN, completionTokens: -1, cacheReadTokens: -1, cacheCreationTokens: Number.NaN },
        model: PRICED_MODEL,
        actualCostUsd: 0.01,
        creditsCharged: 10,
      },
    ];

    for (const input of hostile) {
      expect(() => describeSavings(input)).not.toThrow();
    }
  });
});

/**
 * 🔴 DEFECT 2 — `providerRates().Anthropic` IS NOT ANTHROPIC'S OWN TABLE.
 *
 * It INJECTS every paid rung's model at MARKETPLACE (KIE-shaped) rates so a rung Anthropic does not
 * sell still settles. Priced through that, a model Anthropic never listed resolves anyway — so the
 * "Anthropic list" a saving is measured against would be a KIE price wearing an Anthropic label, and
 * for `claude-fable-5` (which KIE prices ABOVE Anthropic's Opus row) it would invent a discount out of
 * a premium. The baked `MODEL_RATES` table is the only thing that means "what Anthropic charges".
 */
describe('describeSavings measures against the BAKED table, never the injected one', () => {
  it('is null for a rung model Anthropic never priced — even with PREMIUM_MODEL naming it', () => {
    scrubLadderAndPriceEnv();
    vi.stubEnv('PREMIUM_MODEL', 'claude-fable-5');

    // Anthropic bakes no row for it. That is the whole reason the injection exists.
    expect(MODEL_RATES['claude-fable-5']).toBeUndefined();

    /*
     * CONTROL: through the table the first draft used, this model IS priced — and priced at KIE's own
     * rate, not at anything Anthropic ever charged. A lookup there would have resolved and produced a
     * confident number.
     */
    const injected = providerRates().Anthropic['claude-fable-5'];
    expect(injected).toBeDefined();
    expect(injected).toEqual(kieRates()['claude-fable-5']);

    expect(
      describeSavings({
        usage: USAGE,
        model: 'claude-fable-5',
        actualCostUsd: GATEWAY_COST_USD,
        creditsCharged: 100,
      }),
    ).toBeNull();
  });

  /*
   * The CONTROL for the control: a model Anthropic DOES bake is still compared, with PREMIUM_MODEL set
   * exactly as above. Without this, "returns null for fable-5" passes just as happily for a module that
   * returns null for everything — the cheapest way to make an over-claiming bug go green.
   */
  it('...and a natively-priced model with the SAME env still reports', () => {
    scrubLadderAndPriceEnv();
    vi.stubEnv('PREMIUM_MODEL', 'claude-fable-5');

    expect(
      describeSavings({
        usage: USAGE,
        model: PRICED_MODEL,
        actualCostUsd: GATEWAY_COST_USD,
        creditsCharged: 100,
      })?.savedCredits,
    ).toBe(300);
  });
});

/**
 * 🔴 DEFECT 3 — THE MARGIN MUST CANCEL.
 *
 * The first draft compared two ABSOLUTE credit figures: the credits the turn was charged (computed at
 * whatever `CREDIT_MARGIN` was in force when it ran) against a reference recomputed at TODAY's margin.
 * Those are two different yardsticks, so the 3.34 → 4.0 change on 2026-07-18 retroactively painted
 * every older full-price turn as discounted. Scaling the charge by a pure USD ratio makes the margin
 * appear on both sides and cancel — this module never learns what the margin is.
 *
 * This is the strongest available statement of the fix: the SAME recorded turn must produce the SAME
 * answer under any pricing configuration at all.
 */
describe('describeSavings is invariant to CREDIT_MARGIN and CREDIT_UNIT_COST_USD', () => {
  /**
   * One recorded turn: the facts as they were written down, never re-derived.
   *
   * ⚠️ `creditsCharged` is deliberately SMALL relative to the reference. Mutation testing caught the
   * first draft of this fixture: at a large charge, a margin-reading mutant floors two of the three
   * configurations below to the same `full_price` answer, so a pairwise invariance assertion passes on
   * that pair for the wrong reason. The charge has to sit low enough that every configuration produces
   * a DIFFERENT wrong answer, or "invariant" is being asserted over a plateau.
   */
  const RECORDED = {
    usage: USAGE,
    model: PRICED_MODEL,
    actualCostUsd: GATEWAY_COST_USD,
    creditsCharged: 40,
  };

  it('gives an identical answer under three different pricing configurations', () => {
    const answers = (
      [
        ['3.34', '0.01'],
        ['4.0', '0.01'],
        ['12', '0.005'],
      ] as const
    ).map(([margin, unitCost]) => {
      vi.stubEnv('CREATION_FLAT_CREDITS', undefined as unknown as string);
      vi.stubEnv('CREDIT_MARGIN', margin);
      vi.stubEnv('CREDIT_UNIT_COST_USD', unitCost);

      return describeSavings(RECORDED);
    });

    /*
     * The INVARIANCE is the property, so it is asserted first. The literal below is only a sanity
     * check on the fixture — putting it first means a margin-reading mutant trips on the sanity check
     * and the property itself is never evaluated, which is a test that passes its own point by.
     */
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);

    expect(answers[0]).toEqual({
      basis: 'saved',
      referenceCredits: RECORDED.creditsCharged * GATEWAY_DISCOUNT,
      savedCredits: RECORDED.creditsCharged * (GATEWAY_DISCOUNT - 1),
      percent: 75,
    });
  });

  /*
   * 🔴 THE MEASURED REGRESSION, REPRODUCED EXACTLY. An Anthropic-SERVED turn (so `actualCostUsd` IS
   * Anthropic list — there is no gateway and no discount) charged 59 credits at the OLD 3.34 margin
   * reported "saved 11 (16%)" once the margin moved to 4.0. Every number below is derived, and they
   * land on the figures recorded in `savings.ts`'s header.
   */
  it('does not invent a discount on an Anthropic-served turn charged at the OLD margin', () => {
    vi.stubEnv('CREATION_FLAT_CREDITS', undefined as unknown as string);
    vi.stubEnv('CREDIT_MARGIN', '4.0');
    vi.stubEnv('CREDIT_UNIT_COST_USD', '0.01');

    const chargedAtOldMargin = creditsAtMargin(LIST_COST_USD, 3.34);
    const wouldHaveBeenChargedToday = creditsAtMargin(LIST_COST_USD, 4.0);

    // The fixture reproduces the measured case rather than approximating it.
    expect(chargedAtOldMargin).toBe(59);
    expect(wouldHaveBeenChargedToday - chargedAtOldMargin).toBe(11);

    const savings = describeSavings({
      usage: USAGE,
      model: PRICED_MODEL,

      // Served BY Anthropic: the raw cost recorded with the turn IS Anthropic list.
      actualCostUsd: LIST_COST_USD,
      creditsCharged: chargedAtOldMargin,
    });

    expect(savings).toEqual({
      basis: 'full_price',
      referenceCredits: chargedAtOldMargin,
      savedCredits: 0,
      percent: 0,
    });
  });
});

describe('describeSavings arithmetic', () => {
  it('reports the difference in credits, with the percent of full price not paid', () => {
    const charged = 100;

    const savings = describeSavings({
      usage: USAGE,
      model: PRICED_MODEL,
      actualCostUsd: GATEWAY_COST_USD,
      creditsCharged: charged,
    });

    // The gateway cost a quarter of list, so list is 4x what was charged — the ratio, not a re-derivation.
    expect(savings).toEqual({
      basis: 'saved',
      referenceCredits: charged * GATEWAY_DISCOUNT,
      savedCredits: charged * (GATEWAY_DISCOUNT - 1),
      percent: 75,
    });
  });

  /*
   * 🔴 FLOORED AT ZERO, AND THAT IS NOT COSMETIC. A gateway can be DEARER than Anthropic for a given
   * model — the ladder orders capability, not price (measured: the fable-5 rung settled 814 credits on
   * Anthropic against Opus 5's 1,017). A negative "saving" would tell a user we overcharged them
   * relative to an option they were never offered, on a turn billed exactly right.
   */
  it('never reports a negative saving when the gateway was DEARER', () => {
    const savings = describeSavings({
      usage: USAGE,
      model: PRICED_MODEL,
      actualCostUsd: LIST_COST_USD * 3,
      creditsCharged: 99,
    });

    expect(savings).toEqual({ basis: 'full_price', referenceCredits: 33, savedCredits: 0, percent: 0 });
  });

  /* Served BY Anthropic: charged exactly list. `full_price` is the honest answer, not null. */
  it('reports full_price — not null — when there was simply no discount', () => {
    const savings = describeSavings({
      usage: USAGE,
      model: PRICED_MODEL,
      actualCostUsd: LIST_COST_USD,
      creditsCharged: 250,
    });

    expect(savings).toEqual({ basis: 'full_price', referenceCredits: 250, savedCredits: 0, percent: 0 });
  });

  /*
   * Cache classes are not interchangeable (0.1x read, 2.0x the 1-hour write), so the reference has to
   * price all four of them. A comparison that only counted prompt+completion would understate list
   * price and therefore UNDERSTATE the discount on exactly the turns the platform is proudest of —
   * and it would fail as EQUALITY, not as an error, which is why both assertions are strict.
   */
  it('prices the cache classes, not just prompt and completion', () => {
    const base = { model: PRICED_MODEL, actualCostUsd: GATEWAY_COST_USD, creditsCharged: 100 };

    const withoutCache = describeSavings({
      ...base,
      usage: { ...USAGE, cacheReadTokens: 0, cacheCreationTokens: 0 },
    })!;

    const withReads = describeSavings({ ...base, usage: { ...USAGE, cacheCreationTokens: 0 } })!;
    const withWrites = describeSavings({ ...base, usage: { ...USAGE, cacheCreationTokens: 100_000 } })!;

    expect(withReads.referenceCredits).toBeGreaterThan(withoutCache.referenceCredits);
    expect(withWrites.referenceCredits).toBeGreaterThan(withReads.referenceCredits);
  });
});
