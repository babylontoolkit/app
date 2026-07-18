/**
 * The PREMIUM model tier (SPEC §4.6.1) — money-path tests.
 *
 * Two things are pinned here, both of which fail SILENTLY:
 *  - `decidePremium`, the pure eligibility rule that spends a user's credits at 2x WITHOUT a second
 *    confirmation. Like `auto-repair` and `restore-target`, a wrong `true` bills without asking.
 *  - the premium price + threshold config, where a `PREMIUM_INPUT_DOLLARS` typo must THROW (never
 *    default to another model's rate) and the fable-5 row must reach every provider's table.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decidePremium, premiumDeclinedNotice } from './premium';
import {
  DEFAULT_PREMIUM_MINIMUM_CREDITS,
  DEFAULT_PREMIUM_MODEL,
  getPremiumTier,
  providerRates,
  ratesFor,
} from './rates';
import { getPremiumModel } from '~/lib/.server/agent/config';

/** Every PREMIUM_* var, so a case that means to test the DEFAULT is not reading `.env.local` (§oauth.spec). */
function stubPremium(vars: Partial<Record<string, string>> = {}) {
  for (const key of ['PREMIUM_MODEL', 'PREMIUM_INPUT_DOLLARS', 'PREMIUM_OUTPUT_DOLLARS', 'PREMIUM_MINIMUM_CREDITS']) {
    vi.stubEnv(key, (vars[key] ?? undefined) as unknown as string);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('decidePremium — the eligibility rule', () => {
  const min = 1000;

  it('does not use premium when the user did not ask', () => {
    expect(decidePremium({ requested: false, balance: 999_999, minimumCredits: min, enforced: true })).toEqual({
      usePremium: false,
      reason: 'not_requested',
    });
  });

  it('allows premium freely when billing is not enforced (beta / local)', () => {
    // Nobody is charged, so the threshold that protects a grant is moot.
    expect(decidePremium({ requested: true, balance: 0, minimumCredits: min, enforced: false })).toEqual({
      usePremium: true,
      reason: 'unmetered',
    });
  });

  it('allows premium at or above the threshold', () => {
    expect(decidePremium({ requested: true, balance: min, minimumCredits: min, enforced: true })).toEqual({
      usePremium: true,
      reason: 'sufficient_credits',
    });
    expect(decidePremium({ requested: true, balance: min + 1, minimumCredits: min, enforced: true }).usePremium).toBe(
      true,
    );
  });

  it('declines premium below the threshold — this is what protects the free grant', () => {
    // A fresh 500-credit signup grant sits below the 1000 default, so a new account cannot pick premium.
    expect(decidePremium({ requested: true, balance: 500, minimumCredits: min, enforced: true })).toEqual({
      usePremium: false,
      reason: 'below_minimum',
    });
    expect(decidePremium({ requested: true, balance: min - 1, minimumCredits: min, enforced: true }).usePremium).toBe(
      false,
    );
  });

  it('names the threshold in the declined notice', () => {
    expect(premiumDeclinedNotice(1000)).toContain('1,000');
  });
});

describe('the premium tier config', () => {
  it('defaults to Fable 5 at $4/$20 with a 1000-credit minimum, from code — no env required', () => {
    stubPremium();

    const tier = getPremiumTier({});

    expect(tier.model).toBe(DEFAULT_PREMIUM_MODEL);
    expect(tier.model).toBe('claude-fable-5');
    expect(tier.minimumCredits).toBe(DEFAULT_PREMIUM_MINIMUM_CREDITS);
    expect(tier.minimumCredits).toBe(1000);
    expect(tier.rates.inputPerMTok).toBe(4);
    expect(tier.rates.outputPerMTok).toBe(20);

    // Cache re-derives from the final input: 0.1x read, 2x write (the 1h tier).
    expect(tier.rates.cacheReadPerMTok).toBeCloseTo(0.4, 9);
    expect(tier.rates.cacheWritePerMTok).toBeCloseTo(8.0, 9);
  });

  it('takes the operator overrides', () => {
    stubPremium({
      PREMIUM_MODEL: 'claude-sonnet-5',
      PREMIUM_INPUT_DOLLARS: '3',
      PREMIUM_OUTPUT_DOLLARS: '15',
      PREMIUM_MINIMUM_CREDITS: '2500',
    });

    const tier = getPremiumTier({});

    expect(tier.model).toBe('claude-sonnet-5');
    expect(tier.minimumCredits).toBe(2500);
    expect(tier.rates.inputPerMTok).toBe(3);
    expect(tier.rates.outputPerMTok).toBe(15);
  });

  /*
   * A PRICE is `envMoney`, not `envNumber`: a typo must THROW rather than silently bill at another
   * model's rate (the same rule as `KIE_INPUT_DOLLARS`). Zero is refused — a free model does not exist.
   */
  it.each([['$4'], ['four'], ['0'], ['-1']])('refuses a premium price it cannot trust: %s', (bad) => {
    stubPremium({ PREMIUM_INPUT_DOLLARS: bad });
    expect(() => getPremiumTier({})).toThrow(/PREMIUM_INPUT_DOLLARS/);
  });

  /*
   * The THRESHOLD is `envNumber`, not `envMoney`: it is a credit count, not dollars per token, so a
   * fallback is correct. An unparseable value falls back to the default rather than throwing.
   */
  it('falls back to the default minimum on an unparseable threshold', () => {
    stubPremium({ PREMIUM_MINIMUM_CREDITS: 'lots' });
    expect(getPremiumTier({}).minimumCredits).toBe(1000);
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
