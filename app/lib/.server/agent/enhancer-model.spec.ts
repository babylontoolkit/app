/**
 * `ENHANCE_PROMPT_MODEL` and its PER-GATEWAY siblings — the cheap model for the ✨ button (§4.2a, §4.6.1a).
 *
 * Prompt enhancement rewrites ≤10k characters of English with no files, no history, no tools and no
 * cached prefix, and it had been running on whatever model builds the games. On Anthropic that is a
 * flat **3x** on both input and output (`claude-sonnet-5` $3/$15 vs `claude-haiku-4-5` $1/$5) for a
 * task that cannot use the difference.
 *
 * Properties pinned here, each failing in its own direction:
 *
 *   1. **Unset means the platform model.** The knob is additive; a deploy that has never heard of it
 *      must behave exactly as it did before it existed.
 *   2. **An unpriced value is REFUSED, not used.** `ratesFor` falls back to the provider's most
 *      EXPENSIVE row for a model it does not know, so a typo in a variable whose entire purpose is to
 *      spend less would silently spend more — the precise inversion, and it throws nothing. Same rule
 *      and same reason as `getPlatformModel`.
 *   3. 🔴 **`ENABLE_EXTENDED_MODELS` does not gate it** (owner, 2026-08-08). That flag stops users
 *      opting into the EXPENSIVE §4.6.1a rungs on the platform's credits. This is the opposite motion:
 *      an operator setting, not a user choice, whose purpose is to spend less. Routing it through the
 *      tier machinery would mean the deploy that switched the paid classes off — the cost-conscious
 *      deploy — is the one that cannot have a cheap enhancer. Asserted behaviourally with the flag
 *      absent AND explicitly false, because a source scan cannot see a gate added one call deeper.
 *   4. 🔴 **ONE MODEL HAS DIFFERENT IDS ON DIFFERENT GATEWAYS** (owner, 2026-08-11). Haiku 4.5 is
 *      `claude-haiku-4-5` on KIE and Anthropic and ONLY `claude-haiku-4-5-20251001` on Comet, where the
 *      bare id is a hard 400. A single cross-provider value therefore cannot be correct on more than
 *      one gateway, and because rule 2 REFUSES an unpriceable model the symptom is total: the first
 *      press of ✨ after a gateway change is a 503. `<PROVIDER>_ENHANCE_PROMPT_MODEL` outranks the
 *      bare key so one deploy can hold the right id for every gateway it might ladder onto.
 *   5. 🔴 **The gateway is the LADDER-SELECTED one, not `LLM_PROVIDER`.** With `AUTO_MODEL_SELECT` on,
 *      re-deriving the provider here validates the model against a DIFFERENT price table than the one
 *      about to serve and bill the request — the `kieEnvModel` two-readers defect, which survived in
 *      this one function after the ladder shipped.
 *
 * ⚠️ **THE ENV TRAP, and it fired on this very file.** `env()` falls back to `process.env` and Vitest
 * loads `.env.local`, where a real developer has `LLM_PROVIDER`, `LLM_MODEL`, `AUTO_MODEL_SELECT`,
 * `LLM_PROVIDER_CHAIN`, all three API keys and (now) BOTH `ENHANCE_PROMPT_MODEL` and
 * `COMET_ENHANCE_PROMPT_MODEL` set. Before this file's scrub list was widened, all 11 of its cases
 * failed on the owner's machine and passed in CI — the `oauth.spec.ts` trap for the fourth time, and
 * this repo's own stated rule arriving on schedule: **when you add a variable to a precedence chain,
 * add it to every scrub list that already names its sibling.**
 *
 * So the list is DERIVED from `PLATFORM_PROVIDERS` through the very functions under test rather than
 * hand-written: a fourth gateway brings its own `<X>_ENHANCE_PROMPT_MODEL` and `<X>_API_KEY` into the
 * scrub automatically, which is the whole reason those keys are computed instead of declared. The
 * hand-written half (the ladder vars and the retired-and-refused vars that make `providerRates` throw)
 * carries a coverage assertion below so it cannot silently fall behind either.
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

/**
 * The gateway ids for one model, as each gateway actually spells it. The whole point of the feature.
 *
 * `HAIKU_BARE` is priced on KIE and Anthropic and deliberately ABSENT from Comet's table — see
 * `baked-comet-prices.ts`: pricing a model that 400s would make "unpriced" and "unserveable" two
 * different states with one spelling between them.
 */
const HAIKU_BARE = 'claude-haiku-4-5';
const HAIKU_DATED = 'claude-haiku-4-5-20251001';

/**
 * Everything that can decide which model this function returns, on ANY provider.
 *
 * The per-gateway keys and the API keys are derived so a new provider cannot ship with a variable this
 * file forgets to scrub; `SCRUB_COVERAGE` below asserts the derivation actually covers the union.
 */
const MODEL_ENV: readonly string[] = [
  /* The enhancer's own precedence chain, per gateway then cross-provider. */
  ...PLATFORM_PROVIDERS.map(enhancerModelEnvKeyFor),
  ENHANCER_MODEL_ENV_KEY,

  /* What the platform model would be, i.e. the fallback the chain ends at. */
  'LLM_MODEL',
  'KIE_DEFAULT_MODEL',

  /* Which gateway is selected — the fixed one, and everything the ladder consults. */
  'LLM_PROVIDER',
  'AUTO_MODEL_SELECT',
  'LLM_PROVIDER_CHAIN',
  ...PLATFORM_PROVIDERS.map(platformKeyEnvFor),

  /* The paid rungs, whose selectors are injected into every provider's rate table. */
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

/** Shorthand for the two per-gateway keys this file uses constantly. */
const KIE_KEY = enhancerModelEnvKeyFor('KIE');
const COMET_KEY = enhancerModelEnvKeyFor('Comet');

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
    for (const provider of PLATFORM_PROVIDERS) {
      expect(MODEL_ENV, `${provider}'s enhancer selector`).toContain(enhancerModelEnvKeyFor(provider));
      expect(MODEL_ENV, `${provider}'s platform key gates the ladder`).toContain(platformKeyEnvFor(provider));
    }
  });

  it('actually clears the developer .env.local values these cases depend on', () => {
    stubEnv({ LLM_PROVIDER: 'Anthropic' });

    /* The two that were live on the owner's machine and silently decided every assertion. */
    expect(process.env.ENHANCE_PROMPT_MODEL).toBeUndefined();
    expect(process.env[COMET_KEY]).toBeUndefined();
    expect(process.env.AUTO_MODEL_SELECT).toBeUndefined();
    expect(resolvePlatformProvider({}), 'and the ladder cannot move the gateway out from under a case').toBe(
      'Anthropic',
    );
  });

  it('refuses to set a variable it does not also scrub', () => {
    expect(() => stubEnv({ NOT_IN_THE_LIST: 'x' })).toThrow(/MODEL_ENV/);
  });
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

  it('falls back on Comet, against COMET pricing', () => {
    stubEnv({ LLM_PROVIDER: 'Comet', LLM_MODEL: 'claude-sonnet-5' });

    expect(getEnhancerModel({})).toBe('claude-sonnet-5');
  });

  it('treats whitespace as unset — a blank line in a .env is not a model name', () => {
    stubEnv({ LLM_PROVIDER: 'Anthropic', LLM_MODEL: 'claude-sonnet-5', ENHANCE_PROMPT_MODEL: '   ' });

    expect(getEnhancerModel({})).toBe('claude-sonnet-5');
  });

  it('treats a whitespace-only PER-GATEWAY value as unset and falls through to the generic one', () => {
    stubEnv({
      LLM_PROVIDER: 'KIE',
      [KIE_KEY]: '   ',
      ENHANCE_PROMPT_MODEL: HAIKU_BARE,
    });

    expect(getEnhancerModel({})).toBe(HAIKU_BARE);
  });
});

describe('getEnhancerModel — a configured model is used, and it is cheaper than the platform one', () => {
  it('returns the configured model instead of the platform model', () => {
    stubEnv({
      LLM_PROVIDER: 'Anthropic',
      LLM_MODEL: 'claude-sonnet-5',
      ENHANCE_PROMPT_MODEL: HAIKU_BARE,
    });

    expect(getEnhancerModel({})).toBe(HAIKU_BARE);
    expect(getEnhancerModel({})).not.toBe(getPlatformModel({}));
  });

  it('works on KIE as well — the value is validated against the ACTIVE provider', () => {
    stubEnv({ LLM_PROVIDER: 'KIE', ENHANCE_PROMPT_MODEL: HAIKU_BARE });

    expect(getEnhancerModel({})).toBe(HAIKU_BARE);
  });
});

/*
 * 🔴 THE MOTIVATING CASE. One `.env`, both gateways, the right id on each.
 *
 * These two variables are set TOGETHER — that is the shape of a real deploy, and it is the only shape
 * in which the feature is worth anything. Asserting them one at a time would pass for an implementation
 * that read whichever key it found first.
 */
describe('🔴 one model, two gateway ids — the per-gateway key', () => {
  const BOTH = {
    [KIE_KEY]: HAIKU_BARE,
    [COMET_KEY]: HAIKU_DATED,
  } as const;

  it('uses the BARE id when the selected gateway is KIE', () => {
    stubEnv({ ...BOTH, LLM_PROVIDER: 'KIE' });

    expect(getEnhancerModel({})).toBe(HAIKU_BARE);
  });

  it('uses the DATED id when the selected gateway is Comet', () => {
    stubEnv({ ...BOTH, LLM_PROVIDER: 'Comet' });

    expect(getEnhancerModel({})).toBe(HAIKU_DATED);
  });

  it('uses the ANTHROPIC key on Anthropic — the derivation is not a two-provider special case', () => {
    stubEnv({
      ...BOTH,
      [enhancerModelEnvKeyFor('Anthropic')]: HAIKU_BARE,
      LLM_PROVIDER: 'Anthropic',
      LLM_MODEL: 'claude-sonnet-5',
    });

    expect(getEnhancerModel({})).toBe(HAIKU_BARE);
  });

  /*
   * The contrast that proves the ids are genuinely gateway-specific rather than two spellings we happen
   * to accept everywhere. If either half of this stopped being true the feature would be unnecessary.
   */
  it('and each gateway REFUSES the other gateway id', () => {
    stubEnv({ LLM_PROVIDER: 'Comet', [COMET_KEY]: HAIKU_BARE });
    expect(() => getEnhancerModel({}), 'the bare id is a 400 on Comet and must stay unpriced there').toThrow(
      NotConfiguredError,
    );

    vi.unstubAllEnvs();
    invalidateMarketPricesCache();

    stubEnv({ LLM_PROVIDER: 'KIE', [KIE_KEY]: HAIKU_DATED });
    expect(() => getEnhancerModel({}), 'and KIE has no row for the dated id').toThrow(NotConfiguredError);
  });
});

describe('getEnhancerModel — precedence: per-gateway, then cross-provider, then the platform model', () => {
  it('the per-gateway key BEATS the cross-provider one', () => {
    stubEnv({
      LLM_PROVIDER: 'KIE',
      LLM_MODEL: 'claude-sonnet-5',
      [KIE_KEY]: HAIKU_BARE,
      ENHANCE_PROMPT_MODEL: 'claude-opus-5',
    });

    expect(getEnhancerModel({})).toBe(HAIKU_BARE);
  });

  it('the cross-provider key is used when the gateway has no key of its own', () => {
    stubEnv({
      LLM_PROVIDER: 'KIE',
      LLM_MODEL: 'claude-sonnet-5',
      [COMET_KEY]: HAIKU_DATED,
      ENHANCE_PROMPT_MODEL: 'claude-opus-5',
    });

    expect(getEnhancerModel({}), "another gateway's key must not leak into this one").toBe('claude-opus-5');
  });

  it('the platform model is used when neither key is set', () => {
    stubEnv({ LLM_PROVIDER: 'KIE', LLM_MODEL: 'claude-sonnet-5' });

    expect(getEnhancerModel({})).toBe('claude-sonnet-5');
    expect(getEnhancerModel({})).toBe(getPlatformModel({}));
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
      expect(message, 'and how to get back to a working enhancer').toContain('unset');
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

  it('names the SPECIFIC key as the source when that is where the bad value came from', () => {
    stubEnv({ LLM_PROVIDER: 'KIE', [KIE_KEY]: 'claude-hiaku-4-5' });

    try {
      getEnhancerModel({});
      expect.unreachable('an unpriced per-gateway model must not resolve');
    } catch (error) {
      const message = (error as Error).message;

      expect(message, 'the operator must be sent to the variable they actually set').toContain(
        `${KIE_KEY}="claude-hiaku-4-5"`,
      );
    }
  });
});

/*
 * 🔴 THE REGRESSION THIS FEATURE EXISTS FOR.
 *
 * `.env.local` held `ENHANCE_PROMPT_MODEL=claude-haiku-4-5` — correct, and quietly so, for as long as
 * the platform served KIE. Switching to Comet made the FIRST press of ✨ a 503, because the bare id is
 * unpriced there by design. The refusal is right; what was missing was the sentence telling the
 * operator that the fix is a per-gateway key, not a different model.
 */
describe('🔴 the generic-only regression: a cross-provider id that the selected gateway cannot price', () => {
  it('refuses on Comet and names COMET_ENHANCE_PROMPT_MODEL as the fix', () => {
    stubEnv({ LLM_PROVIDER: 'Comet', ENHANCE_PROMPT_MODEL: HAIKU_BARE });

    try {
      getEnhancerModel({});
      expect.unreachable('the bare haiku id is unpriced on Comet and must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(NotConfiguredError);

      const message = (error as Error).message;

      expect(message, 'the value that broke it').toContain(HAIKU_BARE);
      expect(message, 'the variable it came from').toContain(ENHANCER_MODEL_ENV_KEY);
      expect(message, '🔴 and the per-gateway key that fixes it — the whole point of the error').toContain(COMET_KEY);
      expect(message, 'named as an action, not merely mentioned').toMatch(new RegExp(`Set ${COMET_KEY}`));
    }
  });

  /*
   * CONTROL. The same value, the same variable, a different gateway — and it works. Without this the
   * case above passes for an implementation that simply refuses the bare haiku id everywhere, which
   * would be a different bug wearing the same test.
   */
  it('CONTROL: the identical generic value resolves fine on KIE', () => {
    stubEnv({ LLM_PROVIDER: 'KIE', ENHANCE_PROMPT_MODEL: HAIKU_BARE });

    expect(getEnhancerModel({})).toBe(HAIKU_BARE);
  });
});

/*
 * 🔴 THE TWO-READERS DEFECT. With `AUTO_MODEL_SELECT` on, the gateway is chosen per request, so
 * re-deriving it from `LLM_PROVIDER` here validates the model against a price table that is not the one
 * about to serve and bill the turn. Reverting `resolvePlatformProvider` to `getPlatformProvider` must
 * fail these.
 */
describe('🔴 AUTO_MODEL_SELECT — the enhancer follows the LADDER-selected gateway', () => {
  /** `LLM_PROVIDER=KIE` with no KIE key: the ladder must skip that rung and land on Comet. */
  const LADDERS_TO_COMET = {
    AUTO_MODEL_SELECT: 'true',
    LLM_PROVIDER: 'KIE',
    LLM_PROVIDER_CHAIN: 'KIE,Comet',
    COMET_API_KEY: 'comet-key',
    LLM_MODEL: 'claude-sonnet-5',
  } as const;

  it('precondition: the ladder really does move off the configured gateway', () => {
    stubEnv(LADDERS_TO_COMET);

    expect(resolvePlatformProvider({}), 'KIE is unkeyed, so it is not serveable').toBe('Comet');
  });

  it("uses COMET's key when the ladder chose Comet, even though LLM_PROVIDER says KIE", () => {
    stubEnv({
      ...LADDERS_TO_COMET,
      [KIE_KEY]: HAIKU_BARE,
      [COMET_KEY]: HAIKU_DATED,
    });

    expect(getEnhancerModel({})).toBe(HAIKU_DATED);
  });

  /*
   * The live symptom, exactly. A generic bare-haiku value is priceable on KIE and not on Comet, so an
   * implementation reading `LLM_PROVIDER` returns it happily and the wire 400s; one reading the ladder
   * refuses at config time and says which variable to set.
   */
  it("refuses against COMET's price table, not KIE's", () => {
    stubEnv({ ...LADDERS_TO_COMET, ENHANCE_PROMPT_MODEL: HAIKU_BARE });

    expect(() => getEnhancerModel({})).toThrow(NotConfiguredError);
    expect(() => getEnhancerModel({})).toThrow(new RegExp(COMET_KEY));
  });

  /*
   * The fallback branch has the same defect and needs its own case: `qwen3-coder` is priced on Comet
   * and NOWHERE else, so an implementation that re-derives KIE here refuses a model the gateway it is
   * about to use serves perfectly well. A model priced on both gateways would let this pass either way.
   */
  it('and the platform-model fallback is priced against the selected gateway too', () => {
    stubEnv({ ...LADDERS_TO_COMET, LLM_MODEL: 'qwen3-coder' });

    expect(getEnhancerModel({})).toBe('qwen3-coder');
    expect(getEnhancerModel({})).toBe(getPlatformModel({}, 'Comet'));
  });

  it('CONTROL: with the flag off the very same environment stays on KIE', () => {
    stubEnv({
      ...LADDERS_TO_COMET,
      AUTO_MODEL_SELECT: undefined as unknown as string,
      [KIE_KEY]: HAIKU_BARE,
      [COMET_KEY]: HAIKU_DATED,
    });

    expect(resolvePlatformProvider({})).toBe('KIE');
    expect(getEnhancerModel({})).toBe(HAIKU_BARE);
  });
});

describe('getEnhancerModel — providerOverride is the caller stating the gateway it will actually use', () => {
  /*
   * The route resolves the provider ONCE and threads the same value to the model lookup, the wire and
   * `settleGeneration`. An override that did not win would put the two readers back, one call deeper.
   */
  it('an explicit provider beats the configured one', () => {
    stubEnv({
      LLM_PROVIDER: 'KIE',
      LLM_MODEL: 'claude-sonnet-5',
      [KIE_KEY]: HAIKU_BARE,
      [COMET_KEY]: HAIKU_DATED,
    });

    expect(getEnhancerModel({}, 'Comet')).toBe(HAIKU_DATED);
    expect(getEnhancerModel({}, 'KIE')).toBe(HAIKU_BARE);
  });

  it('an explicit provider beats the LADDER as well', () => {
    stubEnv({
      AUTO_MODEL_SELECT: 'true',
      LLM_PROVIDER: 'KIE',
      LLM_PROVIDER_CHAIN: 'KIE,Comet',
      COMET_API_KEY: 'comet-key',
      LLM_MODEL: 'claude-sonnet-5',
      [KIE_KEY]: HAIKU_BARE,
      [COMET_KEY]: HAIKU_DATED,
    });

    expect(resolvePlatformProvider({}), 'the ladder would have chosen Comet').toBe('Comet');
    expect(getEnhancerModel({}, 'KIE'), 'but the caller said KIE, so KIE it is').toBe(HAIKU_BARE);
  });

  it('and it is validated against the OVERRIDDEN provider — an override cannot smuggle an unpriced id', () => {
    stubEnv({ LLM_PROVIDER: 'KIE', ENHANCE_PROMPT_MODEL: HAIKU_BARE });

    expect(getEnhancerModel({}), 'priceable on the configured gateway').toBe(HAIKU_BARE);
    expect(() => getEnhancerModel({}, 'Comet'), 'and refused on the overridden one').toThrow(NotConfiguredError);
  });
});

describe('enhancerModelEnvKeyFor', () => {
  /* Literal spot-checks first: a derived assertion alone would pass for any consistent-but-wrong rule. */
  it('spells the three shipped gateways exactly', () => {
    expect(enhancerModelEnvKeyFor('Comet')).toBe('COMET_ENHANCE_PROMPT_MODEL');
    expect(enhancerModelEnvKeyFor('KIE')).toBe('KIE_ENHANCE_PROMPT_MODEL');
    expect(enhancerModelEnvKeyFor('Anthropic')).toBe('ANTHROPIC_ENHANCE_PROMPT_MODEL');
  });

  /*
   * Over the REAL list, so a fourth provider is covered the day it is added — which is the reason this
   * is a function and not three constants: a gateway whose variable nothing reads is unfixable from the
   * outside and looks exactly like the feature not existing.
   */
  it.each(PLATFORM_PROVIDERS)('derives %s from the provider name and the shared suffix', (provider) => {
    const key = enhancerModelEnvKeyFor(provider as PlatformProviderName);

    expect(key).toBe(`${provider.toUpperCase()}_${ENHANCER_MODEL_ENV_KEY}`);
    expect(key.endsWith(ENHANCER_MODEL_ENV_KEY), 'the cross-provider key is the suffix').toBe(true);
  });

  it('gives every gateway a DISTINCT key — a collision would silently merge two gateways', () => {
    const keys = PLATFORM_PROVIDERS.map((p) => enhancerModelEnvKeyFor(p as PlatformProviderName));

    expect(new Set(keys).size).toBe(PLATFORM_PROVIDERS.length);
  });
});

/*
 * The price row is the other half of the feature: the dated id is useless if nothing can bill it, and
 * `getEnhancerModel` REFUSES an unpriced model, so the row and the variable ship together or not at all.
 */
describe('🔴 the Comet haiku price row', () => {
  it('prices the DATED id at the live-probed rate (pricing 1/5 x ratio 0.8)', () => {
    stubEnv({ LLM_PROVIDER: 'Comet' });

    const row = providerRates({}).Comet[HAIKU_DATED];

    expect(row, 'without a row, COMET_ENHANCE_PROMPT_MODEL can never resolve').toBeDefined();
    expect(row.inputPerMTok).toBe(0.8);
    expect(row.outputPerMTok).toBe(4.0);
  });

  it('leaves the BARE id ABSENT on Comet — that absence is deliberate, not an omission', () => {
    stubEnv({ LLM_PROVIDER: 'Comet' });

    expect(
      providerRates({}).Comet[HAIKU_BARE],
      'the bare id is a hard 400 on Comet; pricing it would make "unpriced" and "unserveable" one state',
    ).toBeUndefined();
  });

  it('CONTROL: the BARE id IS priced on KIE and Anthropic — the ids differ by gateway, not by model', () => {
    stubEnv({ LLM_PROVIDER: 'KIE' });

    const rates = providerRates({});

    expect(rates.KIE[HAIKU_BARE]).toBeDefined();
    expect(rates.Anthropic[HAIKU_BARE]).toBeDefined();
    expect(rates.KIE[HAIKU_DATED], 'and the dated id is Comet-only').toBeUndefined();
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
      LLM_PROVIDER: 'Anthropic',
      LLM_MODEL: 'claude-sonnet-5',
      ENHANCE_PROMPT_MODEL: HAIKU_BARE,
      ...(flag === undefined ? {} : { ENABLE_EXTENDED_MODELS: flag }),
    });

    expect(getEnhancerModel({})).toBe(HAIKU_BARE);
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
      ENHANCE_PROMPT_MODEL: HAIKU_BARE,
      ENABLE_EXTENDED_MODELS: 'false',
    });

    const { getTierModel } = await import('./config');

    expect(() => getTierModel('premium', {})).toThrow(NotConfiguredError);
    expect(getEnhancerModel({}), 'the enhancer is unaffected by the flag that stopped the rung').toBe(HAIKU_BARE);
  });
});
