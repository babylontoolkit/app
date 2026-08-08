/**
 * `ENHANCE_PROMPT_MODEL` — the cheap model for the ✨ button (§4.2a, §4.6.1a).
 *
 * Prompt enhancement rewrites ≤10k characters of English with no files, no history, no tools and no
 * cached prefix, and it had been running on whatever model builds the games. On Anthropic that is a
 * flat **3x** on both input and output (`claude-sonnet-5` $3/$15 vs `claude-haiku-4-5` $1/$5) for a
 * task that cannot use the difference.
 *
 * Three properties are pinned here, and each fails in its own direction:
 *
 *   1. **Unset means the platform model.** The knob is additive; a deploy that has never heard of it
 *      must behave exactly as it did before it existed.
 *   2. **An unpriced value is REFUSED, not used.** `ratesFor` falls back to the provider's most
 *      EXPENSIVE row for a model it does not know, so a typo in a variable whose entire purpose is to
 *      spend less would silently spend more — the precise inversion, and it throws nothing. Same rule
 *      and same reason as `getPlatformModel`.
 *   3. 🔴 **`ENABLE_PREMIUM_MODEL` does not gate it** (owner, 2026-08-08). That flag stops users
 *      opting into the EXPENSIVE §4.6.1a rungs on the platform's credits. This is the opposite motion:
 *      an operator setting, not a user choice, whose purpose is to spend less. Routing it through the
 *      tier machinery would mean the deploy that switched the paid classes off — the cost-conscious
 *      deploy — is the one that cannot have a cheap enhancer. Asserted behaviourally with the flag
 *      absent AND explicitly false, because a source scan cannot see a gate added one call deeper.
 *
 * ⚠️ `env()` falls back to `process.env` and Vitest loads `.env.local`, where a real developer has
 * `LLM_PROVIDER`, `LLM_MODEL`, `ENABLE_PREMIUM_MODEL` and (now) `ENHANCE_PROMPT_MODEL` all set. Every
 * case scrubs the WHOLE precedence chain rather than the one variable it is talking about — the
 * `oauth.spec.ts` trap, which has already fired twice in this repo for want of one sibling in a list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENHANCER_MODEL_ENV_KEY, NotConfiguredError, getEnhancerModel, getPlatformModel } from './config';
import { invalidateMarketPricesCache } from '~/lib/.server/billing/market-price-store';

/** Everything that can decide which model this function returns, on either provider. */
const MODEL_ENV = [
  'ENHANCE_PROMPT_MODEL',
  'LLM_MODEL',
  'LLM_PROVIDER',
  'KIE_DEFAULT_MODEL',
  'ENABLE_PREMIUM_MODEL',

  // Retired 2026-08-08 and REFUSED if set — a leftover would break the unrelated cases here.
  'ENABLE_EXTENDED_MODELS',
  'PREMIUM_MODEL',
  'SUPERMAX_MODEL',
] as const;

function stubEnv(vars: Partial<Record<string, string>> = {}) {
  for (const key of MODEL_ENV) {
    vi.stubEnv(key, (vars[key] ?? undefined) as unknown as string);
  }
}

beforeEach(() => {
  invalidateMarketPricesCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  invalidateMarketPricesCache();
});

describe('getEnhancerModel — unset is the platform model', () => {
  it('falls back to whatever the platform runs, on Anthropic', () => {
    stubEnv({ LLM_PROVIDER: 'Anthropic', LLM_MODEL: 'claude-sonnet-5' });

    expect(getEnhancerModel({})).toBe('claude-sonnet-5');
    expect(getEnhancerModel({})).toBe(getPlatformModel({}));
  });

  it('falls back on KIE too — the fallback is the platform model, not a hardcoded name', () => {
    stubEnv({ LLM_PROVIDER: 'KIE', LLM_MODEL: 'claude-opus-5' });

    expect(getEnhancerModel({})).toBe('claude-opus-5');
    expect(getEnhancerModel({})).toBe(getPlatformModel({}));
  });

  it('treats whitespace as unset — a blank line in a .env is not a model name', () => {
    stubEnv({ LLM_PROVIDER: 'Anthropic', LLM_MODEL: 'claude-sonnet-5', ENHANCE_PROMPT_MODEL: '   ' });

    expect(getEnhancerModel({})).toBe('claude-sonnet-5');
  });
});

describe('getEnhancerModel — a configured model is used, and it is cheaper than the platform one', () => {
  it('returns the configured model instead of the platform model', () => {
    stubEnv({
      LLM_PROVIDER: 'Anthropic',
      LLM_MODEL: 'claude-sonnet-5',
      ENHANCE_PROMPT_MODEL: 'claude-haiku-4-5',
    });

    expect(getEnhancerModel({})).toBe('claude-haiku-4-5');
    expect(getEnhancerModel({})).not.toBe(getPlatformModel({}));
  });

  it('works on KIE as well — the value is validated against the ACTIVE provider', () => {
    stubEnv({ LLM_PROVIDER: 'KIE', ENHANCE_PROMPT_MODEL: 'claude-haiku-4-5' });

    expect(getEnhancerModel({})).toBe('claude-haiku-4-5');
  });
});

describe('getEnhancerModel — an unpriced model is refused, never quietly used', () => {
  it('throws NotConfiguredError naming the variable, so the operator knows what to unset', () => {
    stubEnv({ LLM_PROVIDER: 'Anthropic', ENHANCE_PROMPT_MODEL: 'claude-hiaku-4-5' });

    expect(() => getEnhancerModel({})).toThrow(NotConfiguredError);

    try {
      getEnhancerModel({});
      expect.unreachable('an unpriced model must not resolve');
    } catch (error) {
      const message = (error as Error).message;

      expect(message).toContain(ENHANCER_MODEL_ENV_KEY);
      expect(message, 'the typo is quoted back — the operator has to see what they typed').toContain(
        'claude-hiaku-4-5',
      );
      expect(message, 'and how to get back to a working enhancer').toContain('Unset');
    }
  });

  /*
   * The direction that matters. `ratesFor` bills an unknown model at the provider's most expensive
   * row, so accepting this value would make a cost-cutting setting INCREASE the bill — silently, and
   * on the one path an operator sets it to save money.
   */
  it('refuses rather than falling back to the platform model', () => {
    stubEnv({ LLM_PROVIDER: 'Anthropic', LLM_MODEL: 'claude-sonnet-5', ENHANCE_PROMPT_MODEL: 'not-a-model' });

    expect(() => getEnhancerModel({})).toThrow(/not-a-model/);
  });
});

describe('🔴 ENABLE_PREMIUM_MODEL does not gate the enhancer model', () => {
  const CASES: Array<[string, string | undefined]> = [
    ['absent', undefined],
    ['explicitly false', 'false'],
    ['explicitly true', 'true'],
  ];

  it.each(CASES)('resolves with the flag %s', (_label, flag) => {
    stubEnv({
      LLM_PROVIDER: 'Anthropic',
      LLM_MODEL: 'claude-sonnet-5',
      ENHANCE_PROMPT_MODEL: 'claude-haiku-4-5',
      ...(flag === undefined ? {} : { ENABLE_PREMIUM_MODEL: flag }),
    });

    expect(getEnhancerModel({})).toBe('claude-haiku-4-5');
  });

  /*
   * `getTierModel` is the function that DOES honour the flag, and it throws when it is off. Asserting
   * that here is what proves the two paths are genuinely separate rather than merely appearing to be:
   * if someone routed the enhancer through the tier machinery, this contrast would collapse.
   */
  it('while a paid RUNG still refuses under the same environment', async () => {
    stubEnv({
      LLM_PROVIDER: 'Anthropic',
      LLM_MODEL: 'claude-sonnet-5',
      ENHANCE_PROMPT_MODEL: 'claude-haiku-4-5',
      ENABLE_PREMIUM_MODEL: 'false',
    });

    const { getTierModel } = await import('./config');

    expect(() => getTierModel('premium', {})).toThrow(NotConfiguredError);
    expect(getEnhancerModel({}), 'the enhancer is unaffected by the flag that stopped the rung').toBe(
      'claude-haiku-4-5',
    );
  });
});
