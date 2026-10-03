/**
 * `ENHANCE_PROMPT_MODEL` and its per-gateway sibling — the cheap model for the ✨ button (§4.2a, §4.6.1a).
 *
 * Prompt enhancement rewrites ≤10k characters of English with no files, no history, no tools and no
 * cached prefix, and it had been running on whatever model builds the games — a flat multiple on both
 * input and output (`claude-sonnet-5` vs `claude-haiku-4-5`) for a task that cannot use the difference.
 *
 * Since 2026-10-03 Anthropic is the ONLY LLM provider (`_specs/anthropic-only_plan.md`), so the chain
 * is `ANTHROPIC_ENHANCE_PROMPT_MODEL` → `ENHANCE_PROMPT_MODEL` → the platform model. Properties pinned
 * here, each failing in its own direction:
 *
 *   1. **Unset means the platform model.** The knob is additive; a deploy that has never heard of it
 *      must behave exactly as it did before it existed.
 *   2. **An unpriced value is REFUSED, not used.** `ratesFor` falls back to the provider's most
 *      EXPENSIVE row for a model it does not know, so a typo in a variable whose entire purpose is to
 *      spend less would silently spend more — the precise inversion, and it throws nothing.
 *   3. 🔴 **`ENABLE_EXTENDED_MODELS` does not gate it** (owner, 2026-08-08). That flag stops users
 *      opting into the EXPENSIVE §4.6.1a rungs; this is an operator setting whose purpose is to spend
 *      less. Asserted behaviourally with the flag absent AND explicitly false.
 *   4. **The per-gateway key outranks the generic one**, and the refusal names it as the fix — a model
 *      id is not portable across gateways (Haiku 4.5's dated id is priced nowhere we serve).
 *   5. 🔴 **A retired gateway cannot move it.** A stale `LLM_PROVIDER=KIE`, an `AUTO_MODEL_SELECT` chain
 *      naming KIE/Comet, or a lingering `KIE_`/`COMET_ENHANCE_PROMPT_MODEL` must never change which key
 *      is read or which price table validates it.
 *
 * ⚠️ **THE ENV TRAP.** `env()` falls back to `process.env` and Vitest loads `.env.local`, where a real
 * developer may have `LLM_PROVIDER`, `LLM_MODEL`, `AUTO_MODEL_SELECT`, `LLM_PROVIDER_CHAIN`, API keys and
 * enhancer selectors for gateways that no longer exist. Every case scrubs the whole list first, and the
 * per-gateway key and the API key are DERIVED from `PLATFORM_PROVIDERS` through the very functions under
 * test, so a provider re-added later brings its own variables into the scrub automatically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ENHANCER_MODEL_ENV_KEY,
  NotConfiguredError,
  PLATFORM_PROVIDERS,
  enhancerModelEnvKeyFor,
  getEnhancerModel,
  getPlatformModel,
  platformKeyEnvFor,
  resolvePlatformProvider,
  type PlatformProviderName,
} from './config';
import { resetProviderHealth } from './provider-select';
import { providerRates } from '~/lib/.server/billing/rates';
import { invalidateMarketPricesCache } from '~/lib/.server/billing/market-price-store';

/** Priced on Anthropic. */
const HAIKU_BARE = 'claude-haiku-4-5';

/** Comet's spelling of the same model — priced on NO gateway the platform serves. */
const HAIKU_DATED = 'claude-haiku-4-5-20251001';

/** The retired gateways' enhancer selectors — scrubbed, and asserted never to be read. */
const RETIRED_ENHANCER_KEYS = ['KIE_ENHANCE_PROMPT_MODEL', 'COMET_ENHANCE_PROMPT_MODEL'] as const;

/** Everything that can decide which model this function returns. */
const MODEL_ENV: readonly string[] = [
  /* The enhancer's own precedence chain, per gateway then cross-provider. */
  ...PLATFORM_PROVIDERS.map(enhancerModelEnvKeyFor),
  ENHANCER_MODEL_ENV_KEY,
  ...RETIRED_ENHANCER_KEYS,

  /* What the platform model would be, i.e. the fallback the chain ends at. */
  'LLM_MODEL',
  'KIE_DEFAULT_MODEL',

  /* Which gateway is selected — the fixed one, and everything the dormant ladder consults. */
  'LLM_PROVIDER',
  'AUTO_MODEL_SELECT',
  'LLM_PROVIDER_CHAIN',
  ...PLATFORM_PROVIDERS.map(platformKeyEnvFor),
  'KIE_API_KEY',
  'COMET_API_KEY',

  /* The paid rungs, whose selectors are injected into the rate table. */
  'ENABLE_EXTENDED_MODELS',
  'PREMIUM_MODEL',
  'PREMIUM_MINIMUM_CREDITS',
  'PLATINUM_MODEL',
  'PLATINUM_MINIMUM_CREDITS',

  /*
   * Retired and REFUSED if set. None of these decides a model — they make `providerRates` THROW, which
   * turns every unrelated case in this file into a failure that names the wrong thing.
   */
  'ENABLE_PREMIUM_MODEL',
  'SUPERMAX_MODEL',
  'SUPERMAX_MINIMUM_CREDITS',
  'KIE_INPUT_DOLLARS',
  'KIE_OUTPUT_DOLLARS',
  'KIE_CACHED_INPUT',
  'KIE_CACHED_WRITES',
  'PREMIUM_INPUT_DOLLARS',
  'PREMIUM_OUTPUT_DOLLARS',
  'CREATION_FLAT_CREDITS',
] as const;

function stubEnv(vars: Partial<Record<string, string>> = {}) {
  for (const key of MODEL_ENV) {
    vi.stubEnv(key, (vars[key] ?? undefined) as unknown as string);
  }

  for (const key of Object.keys(vars)) {
    if (!MODEL_ENV.includes(key)) {
      throw new Error(
        `${key} is not in MODEL_ENV, so it is set for this case and LEFT SET for every later one. ` +
          'Add it to the scrub list.',
      );
    }
  }
}

const ANTHROPIC_KEY = enhancerModelEnvKeyFor('Anthropic');

beforeEach(() => {
  invalidateMarketPricesCache();
  resetProviderHealth();
});

afterEach(() => {
  vi.unstubAllEnvs();
  invalidateMarketPricesCache();
  resetProviderHealth();
});

describe('the scrub list itself', () => {
  /*
   * A CONTROL on the trap. Every case below is only meaningful if the environment it describes is the
   * environment it gets, and the failure mode of a short list is a green CI and a red laptop.
   */
  it('covers every per-gateway variable the implementation can read', () => {
    expect(PLATFORM_PROVIDERS.length, 'a derivation over an empty union scrubs nothing').toBeGreaterThan(0);

    for (const provider of PLATFORM_PROVIDERS) {
      expect(MODEL_ENV, `${provider}'s enhancer selector`).toContain(enhancerModelEnvKeyFor(provider));
      expect(MODEL_ENV, `${provider}'s platform key`).toContain(platformKeyEnvFor(provider));
    }
  });

  it('actually clears the developer .env.local values these cases depend on', () => {
    stubEnv();

    expect(process.env.ENHANCE_PROMPT_MODEL).toBeUndefined();
    expect(process.env[ANTHROPIC_KEY]).toBeUndefined();
    expect(process.env.COMET_ENHANCE_PROMPT_MODEL).toBeUndefined();
    expect(process.env.AUTO_MODEL_SELECT).toBeUndefined();
    expect(resolvePlatformProvider({})).toBe('Anthropic');
  });

  it('refuses to set a variable it does not also scrub', () => {
    expect(() => stubEnv({ NOT_IN_THE_LIST: 'x' })).toThrow(/MODEL_ENV/);
  });
});

describe('getEnhancerModel — unset is the platform model', () => {
  it('falls back to whatever the platform runs', () => {
    stubEnv({ LLM_MODEL: 'claude-sonnet-5' });

    expect(getEnhancerModel({})).toBe('claude-sonnet-5');
    expect(getEnhancerModel({})).toBe(getPlatformModel({}));
  });

  it('follows LLM_MODEL — the fallback is the platform model, not a hardcoded name', () => {
    stubEnv({ LLM_MODEL: 'claude-opus-5' });

    expect(getEnhancerModel({})).toBe('claude-opus-5');
    expect(getEnhancerModel({})).toBe(getPlatformModel({}));
  });

  it('treats whitespace as unset — a blank line in a .env is not a model name', () => {
    stubEnv({ LLM_MODEL: 'claude-sonnet-5', ENHANCE_PROMPT_MODEL: '   ' });

    expect(getEnhancerModel({})).toBe('claude-sonnet-5');
  });

  it('treats a whitespace-only PER-GATEWAY value as unset and falls through to the generic one', () => {
    stubEnv({ LLM_MODEL: 'claude-sonnet-5', [ANTHROPIC_KEY]: '   ', ENHANCE_PROMPT_MODEL: HAIKU_BARE });

    expect(getEnhancerModel({})).toBe(HAIKU_BARE);
  });
});

describe('getEnhancerModel — a configured model is used, and it is cheaper than the platform one', () => {
  it('returns the configured model instead of the platform model', () => {
    stubEnv({ LLM_MODEL: 'claude-sonnet-5', ENHANCE_PROMPT_MODEL: HAIKU_BARE });

    expect(getEnhancerModel({})).toBe(HAIKU_BARE);
    expect(getEnhancerModel({})).not.toBe(getPlatformModel({}));
  });

  it('and the configured model really is priced below the platform model', () => {
    stubEnv({ LLM_MODEL: 'claude-sonnet-5', ENHANCE_PROMPT_MODEL: HAIKU_BARE });

    const rates = providerRates({}).Anthropic;

    expect(rates[HAIKU_BARE].inputPerMTok).toBeLessThan(rates['claude-sonnet-5'].inputPerMTok);
    expect(rates[HAIKU_BARE].outputPerMTok).toBeLessThan(rates['claude-sonnet-5'].outputPerMTok);
  });
});

describe('getEnhancerModel — precedence: per-gateway, then cross-provider, then the platform model', () => {
  it('ANTHROPIC_ENHANCE_PROMPT_MODEL BEATS the cross-provider one', () => {
    stubEnv({ LLM_MODEL: 'claude-sonnet-5', [ANTHROPIC_KEY]: HAIKU_BARE, ENHANCE_PROMPT_MODEL: 'claude-opus-5' });

    expect(getEnhancerModel({})).toBe(HAIKU_BARE);
  });

  it('the cross-provider key is used when the gateway has no key of its own', () => {
    stubEnv({ LLM_MODEL: 'claude-sonnet-5', ENHANCE_PROMPT_MODEL: 'claude-opus-5' });

    expect(getEnhancerModel({})).toBe('claude-opus-5');
  });

  it('the platform model is used when neither key is set', () => {
    stubEnv({ LLM_MODEL: 'claude-sonnet-5' });

    expect(getEnhancerModel({})).toBe('claude-sonnet-5');
  });
});

describe('getEnhancerModel — an unpriced model is refused, never quietly used', () => {
  it('throws NotConfiguredError naming the variable, so the operator knows what to unset', () => {
    stubEnv({ ENHANCE_PROMPT_MODEL: 'claude-hiaku-4-5' });

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
      expect(message, 'and how to get back to a working enhancer').toContain('unset');
    }
  });

  /*
   * The direction that matters. `ratesFor` bills an unknown model at the provider's most expensive
   * row, so accepting this value would make a cost-cutting setting INCREASE the bill.
   */
  it('refuses rather than falling back to the platform model', () => {
    stubEnv({ LLM_MODEL: 'claude-sonnet-5', ENHANCE_PROMPT_MODEL: 'not-a-model' });

    expect(() => getEnhancerModel({})).toThrow(/not-a-model/);
  });

  it('names the SPECIFIC key as the source when that is where the bad value came from', () => {
    stubEnv({ [ANTHROPIC_KEY]: 'claude-hiaku-4-5' });

    try {
      getEnhancerModel({});
      expect.unreachable('an unpriced per-gateway model must not resolve');
    } catch (error) {
      expect((error as Error).message, 'the operator must be sent to the variable they actually set').toContain(
        `${ANTHROPIC_KEY}="claude-hiaku-4-5"`,
      );
    }
  });

  /*
   * The 2026-08-11 regression, in its surviving shape: a generic value carrying another gateway's
   * spelling of the model. The refusal must name the per-gateway key as the fix.
   */
  it('refuses another gateway spelling and names ANTHROPIC_ENHANCE_PROMPT_MODEL as the fix', () => {
    stubEnv({ ENHANCE_PROMPT_MODEL: HAIKU_DATED });

    try {
      getEnhancerModel({});
      expect.unreachable('the dated haiku id is unpriced on Anthropic and must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(NotConfiguredError);

      const message = (error as Error).message;

      expect(message).toContain(HAIKU_DATED);
      expect(message).toContain(ENHANCER_MODEL_ENV_KEY);
      expect(message).toMatch(new RegExp(`Set ${ANTHROPIC_KEY}`));
    }
  });

  /* CONTROL: the same variable with Anthropic's spelling resolves — the refusal above is about the id. */
  it('CONTROL: the bare id in the same variable resolves', () => {
    stubEnv({ ENHANCE_PROMPT_MODEL: HAIKU_BARE });

    expect(getEnhancerModel({})).toBe(HAIKU_BARE);
  });

  it('an explicit providerOverride is validated too — it cannot smuggle an unpriced id', () => {
    stubEnv({ ENHANCE_PROMPT_MODEL: HAIKU_DATED });

    expect(() => getEnhancerModel({}, 'Anthropic')).toThrow(NotConfiguredError);
  });
});

/*
 * 🔴 A RETIRED GATEWAY CANNOT MOVE THE ENHANCER. Every one of these was a live configuration on some
 * deploy before 2026-10-03; leaving one behind must change nothing about which key is read or which
 * price table validates it.
 */
describe('🔴 retired gateways are ignored', () => {
  it('a stale LLM_PROVIDER=KIE or Comet still reads the Anthropic key and validates against Anthropic', () => {
    for (const stale of ['KIE', 'Comet']) {
      vi.unstubAllEnvs();
      invalidateMarketPricesCache();
      stubEnv({ LLM_PROVIDER: stale, LLM_MODEL: 'claude-sonnet-5', [ANTHROPIC_KEY]: HAIKU_BARE });

      expect(resolvePlatformProvider({}), `LLM_PROVIDER=${stale}`).toBe('Anthropic');
      expect(getEnhancerModel({}), `LLM_PROVIDER=${stale}`).toBe(HAIKU_BARE);
    }
  });

  it('an AUTO_MODEL_SELECT chain naming the retired gateways still lands on Anthropic', () => {
    stubEnv({
      AUTO_MODEL_SELECT: 'true',
      LLM_PROVIDER: 'KIE',
      LLM_PROVIDER_CHAIN: 'KIE,Comet,Anthropic',
      KIE_API_KEY: 'kie-key',
      COMET_API_KEY: 'comet-key',
      ANTHROPIC_API_KEY: 'anthropic-key',
      LLM_MODEL: 'claude-sonnet-5',
      [ANTHROPIC_KEY]: HAIKU_BARE,
      COMET_ENHANCE_PROMPT_MODEL: HAIKU_DATED,
    });

    expect(resolvePlatformProvider({})).toBe('Anthropic');
    expect(getEnhancerModel({})).toBe(HAIKU_BARE);
  });

  /*
   * A lingering `KIE_`/`COMET_ENHANCE_PROMPT_MODEL` must not leak in as the enhancer model. Without
   * the specific Anthropic key and the generic one, the answer is the platform model.
   */
  it.each(RETIRED_ENHANCER_KEYS)('%s is never read', (key) => {
    stubEnv({ LLM_MODEL: 'claude-sonnet-5', [key]: HAIKU_BARE });

    expect(getEnhancerModel({})).toBe('claude-sonnet-5');
  });
});

describe('enhancerModelEnvKeyFor', () => {
  /* A literal spot-check first: a derived assertion alone would pass for any consistent-but-wrong rule. */
  it('spells the Anthropic key exactly', () => {
    expect(enhancerModelEnvKeyFor('Anthropic')).toBe('ANTHROPIC_ENHANCE_PROMPT_MODEL');
  });

  it.each(PLATFORM_PROVIDERS)('derives %s from the provider name and the shared suffix', (provider) => {
    const key = enhancerModelEnvKeyFor(provider as PlatformProviderName);

    expect(key).toBe(`${provider.toUpperCase()}_${ENHANCER_MODEL_ENV_KEY}`);
    expect(key.endsWith(ENHANCER_MODEL_ENV_KEY), 'the cross-provider key is the suffix').toBe(true);
  });
});

describe('the haiku price rows', () => {
  it('prices the BARE id on Anthropic — without a row the enhancer key can never resolve', () => {
    stubEnv();

    expect(providerRates({}).Anthropic[HAIKU_BARE]).toBeDefined();
  });

  it('leaves the DATED id unpriced — it is another gateway spelling, not a model we serve', () => {
    stubEnv();

    expect(providerRates({}).Anthropic[HAIKU_DATED]).toBeUndefined();
  });
});

describe('🔴 ENABLE_EXTENDED_MODELS does not gate the enhancer model', () => {
  const CASES: Array<[string, string | undefined]> = [
    ['absent', undefined],
    ['explicitly false', 'false'],
    ['explicitly true', 'true'],
  ];

  it.each(CASES)('resolves with the flag %s', (_label, flag) => {
    stubEnv({
      LLM_MODEL: 'claude-sonnet-5',
      ENHANCE_PROMPT_MODEL: HAIKU_BARE,
      ...(flag === undefined ? {} : { ENABLE_EXTENDED_MODELS: flag }),
    });

    expect(getEnhancerModel({})).toBe(HAIKU_BARE);
  });

  /*
   * `getTierModel` is the function that DOES honour the flag, and it throws when it is off. Asserting
   * that here is what proves the two paths are genuinely separate rather than merely appearing to be.
   */
  it('while a paid RUNG still refuses under the same environment', async () => {
    stubEnv({ LLM_MODEL: 'claude-sonnet-5', ENHANCE_PROMPT_MODEL: HAIKU_BARE, ENABLE_EXTENDED_MODELS: 'false' });

    const { getTierModel } = await import('./config');

    expect(() => getTierModel('premium', {})).toThrow(NotConfiguredError);
    expect(getEnhancerModel({}), 'the enhancer is unaffected by the flag that stopped the rung').toBe(HAIKU_BARE);
  });
});
