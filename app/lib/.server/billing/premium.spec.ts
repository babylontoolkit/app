/**
 * The PREMIUM model tier (SPEC §4.6.1) — money-path tests.
 *
 * Two things are pinned here, both of which fail SILENTLY:
 *  - `decidePremium`, the pure eligibility rule that spends a user's credits at 2x WITHOUT a second
 *    confirmation. Like `auto-repair` and `restore-target`, a wrong `true` bills without asking.
 *  - the premium price + threshold config: since 2026-07-18 the PRICE side lives in the marketplace
 *    price list (`market-price-store.ts`), so what is pinned is that the tier prices from the ACTIVE
 *    list, that a `PREMIUM_MODEL` the list does not price is REFUSED, and that the retired
 *    `PREMIUM_*_DOLLARS` vars stop the show rather than being silently ignored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decidePremium, premiumDeclinedNotice } from './premium';
import {
  DEFAULT_PREMIUM_MINIMUM_CREDITS,
  DEFAULT_PREMIUM_MODEL,
  getPremiumTier,
  providerRates,
  ratesFor,
} from './rates';
import { BAKED_MARKET_PRICES } from './baked-market-prices';
import { invalidateMarketPricesCache, promoteMarketPrices } from './market-price-store';
import type { ObjectStore } from '~/lib/.server/storage';
import { getPremiumModel } from '~/lib/.server/agent/config';

/** Every PREMIUM_* var, so a case that means to test the DEFAULT is not reading `.env.local` (§oauth.spec). */
function stubPremium(vars: Partial<Record<string, string>> = {}) {
  for (const key of ['PREMIUM_MODEL', 'PREMIUM_INPUT_DOLLARS', 'PREMIUM_OUTPUT_DOLLARS', 'PREMIUM_MINIMUM_CREDITS']) {
    vi.stubEnv(key, (vars[key] ?? undefined) as unknown as string);
  }
}

/** A Map-backed ObjectStore — promotions here never touch disk (the module cache is what matters). */
function memoryStore(): ObjectStore {
  const objects = new Map<string, Uint8Array>();

  return {
    backend: 'filesystem',
    put: async (key, bytes) => void objects.set(key, bytes),
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => void objects.delete(key),
    list: async (prefix) =>
      [...objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ key: k, size: v.length })),
  };
}

beforeEach(() => {
  invalidateMarketPricesCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  invalidateMarketPricesCache();
});

describe('decidePremium — the eligibility rule', () => {
  const min = 1000;

  it('does not use premium when the user did not ask', () => {
    expect(decidePremium({ requested: false, balance: 999_999, minimumCredits: min })).toEqual({
      usePremium: false,
      reason: 'not_requested',
    });
  });

  it('allows premium at or above the threshold', () => {
    expect(decidePremium({ requested: true, balance: min, minimumCredits: min })).toEqual({
      usePremium: true,
      reason: 'sufficient_credits',
    });
    expect(decidePremium({ requested: true, balance: min + 1, minimumCredits: min }).usePremium).toBe(true);
  });

  it('declines premium below the threshold — this is what protects the free grant', () => {
    // Same shape as production: a fresh 800-credit grant sits below the 1200 default, so a new account cannot pick premium.
    expect(decidePremium({ requested: true, balance: 500, minimumCredits: min })).toEqual({
      usePremium: false,
      reason: 'below_minimum',
    });
    expect(decidePremium({ requested: true, balance: min - 1, minimumCredits: min }).usePremium).toBe(false);
  });

  /*
   * A CREATION turn never runs premium, however rich the balance (2026-07-18, observed live): KIE
   * serves Fable 5 with a buffered answer, and a creation-sized artifact cannot flush before KIE's
   * gateway timeout — the generation died at finish=error after 449s with the artifact never arriving.
   * Premium starts at the first edit turn.
   */
  it('declines premium on a creation turn regardless of balance', () => {
    expect(decidePremium({ requested: true, balance: 50_000, minimumCredits: min, isCreationTurn: true })).toEqual({
      usePremium: false,
      reason: 'creation_turn',
    });

    // The same balance on an ordinary turn: premium runs. The control that pins the distinction.
    expect(
      decidePremium({ requested: true, balance: 50_000, minimumCredits: min, isCreationTurn: false }).usePremium,
    ).toBe(true);
  });

  /*
   * The rule takes NO `enforced` input, on purpose (2026-07-18) — the retired "unmetered" bypass let a
   * 320-credit user run the 2x model because "nobody is charged when enforcement is off", which was
   * false: settlement debits the ledger regardless. The pin is structural — if an enforcement flag
   * ever grows back into this signature, this test is the tripwire that demands the debit question be
   * re-answered first. Free-premium deploys say `PREMIUM_MINIMUM_CREDITS=0` explicitly instead.
   */
  it('binds on the balance with no enforcement bypass — a zero minimum is the only free door', () => {
    expect(decidePremium({ requested: true, balance: 320, minimumCredits: min }).usePremium).toBe(false);
    expect(decidePremium({ requested: true, balance: 0, minimumCredits: 0 }).usePremium).toBe(true);
  });

  it('names the threshold in the declined notice', () => {
    expect(premiumDeclinedNotice(1000)).toContain('1,000');
  });
});

describe('the premium tier config', () => {
  it('defaults to Fable 5 at $4/$20 with a 1200-credit minimum, from code — no env required', () => {
    stubPremium();

    const tier = getPremiumTier({});

    expect(tier.model).toBe(DEFAULT_PREMIUM_MODEL);
    expect(tier.model).toBe('claude-fable-5');
    expect(tier.minimumCredits).toBe(DEFAULT_PREMIUM_MINIMUM_CREDITS);
    expect(tier.minimumCredits).toBe(1200);
    expect(tier.rates.inputPerMTok).toBe(4);
    expect(tier.rates.outputPerMTok).toBe(20);

    // Cache re-derives from the final input: 0.1x read, 2x write (the 1h tier).
    expect(tier.rates.cacheReadPerMTok).toBeCloseTo(0.4, 9);
    expect(tier.rates.cacheWritePerMTok).toBeCloseTo(8.0, 9);
  });

  /* The selector may name any model the ACTIVE list prices — its price comes from the LIST, not env. */
  it('takes a different PREMIUM_MODEL at the price the active list states for it', () => {
    stubPremium({ PREMIUM_MODEL: 'claude-sonnet-5', PREMIUM_MINIMUM_CREDITS: '2500' });

    const tier = getPremiumTier({});
    const baked = BAKED_MARKET_PRICES.llm['claude-sonnet-5'];

    expect(tier.model).toBe('claude-sonnet-5');
    expect(tier.minimumCredits).toBe(2500);
    expect(tier.rates.inputPerMTok).toBe(baked.inputPerMTok);
    expect(tier.rates.outputPerMTok).toBe(baked.outputPerMTok);
  });

  /*
   * A `PREMIUM_MODEL` the active list does not price is REFUSED — the same "selector without a row"
   * rule as `KIE_DEFAULT_MODEL`. An unpriced premium would otherwise bill at `ratesFor`'s
   * most-expensive fallback: over-charging, silently, on the tier users deliberately pay MORE for.
   */
  it('refuses a PREMIUM_MODEL the price list does not price', () => {
    stubPremium({ PREMIUM_MODEL: 'some-unpriced-model' });
    expect(() => getPremiumTier({})).toThrow(/Marketplace price list/);
  });

  /* A promoted list can reprice or add the premium row — the admin-panel path. */
  it('prices the tier from a PROMOTED list when one is live', async () => {
    stubPremium();

    const result = await promoteMarketPrices(memoryStore(), {
      ...BAKED_MARKET_PRICES,
      llm: { ...BAKED_MARKET_PRICES.llm, 'claude-fable-5': { inputPerMTok: 5, outputPerMTok: 25 } },
    });
    expect(result.ok).toBe(true);

    const tier = getPremiumTier({});
    expect(tier.rates.inputPerMTok).toBe(5);
    expect(tier.rates.cacheWritePerMTok, 'cache re-derives from the promoted base').toBeCloseTo(10, 9);
  });

  /*
   * The RETIRED env price vars must stop the show, never be silently ignored (the same refusal as
   * `kieRates` — pinned per-var in billing.spec; this pins the premium door specifically).
   */
  it.each([['PREMIUM_INPUT_DOLLARS'], ['PREMIUM_OUTPUT_DOLLARS']])('refuses the retired %s', (key) => {
    stubPremium({ [key]: '4' });
    expect(() => getPremiumTier({})).toThrow(/retired/);
  });

  /*
   * The THRESHOLD is `envNumber`, not `envMoney`: it is a credit count, not dollars per token, so a
   * fallback is correct. An unparseable value falls back to the default rather than throwing.
   */
  it('falls back to the default minimum on an unparseable threshold', () => {
    stubPremium({ PREMIUM_MINIMUM_CREDITS: 'lots' });
    expect(getPremiumTier({}).minimumCredits).toBe(1200);
  });
});

describe('the premium model is priceable on every provider', () => {
  it('injects the fable-5 row into Anthropic, which bakes none', () => {
    stubPremium();

    // MODEL_RATES has no fable-5 row (pinned in billing.spec) — this injection is what prices it.
    const anthropic = providerRates({}).Anthropic;
    expect(anthropic['claude-fable-5']).toEqual({
      inputPerMTok: 4,
      outputPerMTok: 20,
      cacheReadPerMTok: 0.4,
      cacheWritePerMTok: 8.0,
    });

    expect(ratesFor('claude-fable-5', 'Anthropic', {}).inputPerMTok).toBe(4);
  });

  it('is idempotent on KIE, which already bakes the identical row', () => {
    stubPremium();
    expect(providerRates({}).KIE['claude-fable-5']).toEqual({
      inputPerMTok: 4,
      outputPerMTok: 20,
      cacheReadPerMTok: 0.4,
      cacheWritePerMTok: 8.0,
    });
  });

  it('getPremiumModel returns the configured premium model on the active provider', () => {
    stubPremium();
    vi.stubEnv('LLM_PROVIDER', 'KIE');
    expect(getPremiumModel({})).toBe('claude-fable-5');

    vi.stubEnv('LLM_PROVIDER', 'Anthropic');
    expect(getPremiumModel({})).toBe('claude-fable-5');
  });
});
