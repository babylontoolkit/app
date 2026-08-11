/**
 * `AUTO_MODEL_SELECT` — which LLM gateway serves a turn (SPEC §4.2a, `provider-select.ts`).
 *
 * Every property here fails SILENTLY if broken, and three of them fail in the expensive direction:
 *
 *   1. **DEFAULT OFF.** The ladder cannot move a single generation until an operator opts in. A
 *      regression here does not throw — it quietly starts serving turns from a gateway nobody chose,
 *      on a key nobody budgeted, with the credit count moving for reasons no log explains.
 *   2. 🔴 **THE `canPrice` GATE IS THE MONEY GATE.** `ratesFor` falls back to a provider's MOST
 *      EXPENSIVE row for a model it does not price, so failing over to a rung that cannot price the
 *      model would run the turn and bill it at the top of that rung's table. A ladder built to chase a
 *      discount would become the biggest bill in the product, and nothing would throw.
 *   3. **COOLDOWN IS A PREFERENCE, NEVER A WALL.** If every rung is cooling, the turn still runs. The
 *      failure mode of getting this wrong is "all providers had a blip" becoming "the product is
 *      down" — one refunded generation traded for every generation.
 *
 * ⚠️ **`env()` falls back to `process.env` and Vitest loads `.env.local`, which on a real developer's
 * machine sets `AUTO_MODEL_SELECT`, `LLM_PROVIDER`, `LLM_MODEL` AND all three platform API keys.** The
 * API keys are not incidental here: they ARE the `isConfigured` gate, so an unscrubbed one makes a rung
 * eligible that the test believes is absent. Every case scrubs the WHOLE chain — the `oauth.spec.ts`
 * trap, which has already fired three times in this repo for want of one sibling in a list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROVIDER_COOLDOWN_MS,
  providerUnhealthyUntil,
  recordProviderFailure,
  recordProviderSuccess,
  resetProviderHealth,
  selectPlatformProvider,
  type ProviderSelectInput,
} from './provider-select';
import {
  AUTO_MODEL_SELECT_ENV_KEY,
  DEFAULT_PROVIDER_CHAIN,
  LLM_PROVIDER_CHAIN_ENV_KEY,
  NotConfiguredError,
  PLATFORM_PROVIDERS,
  getPlatformConfig,
  getPlatformModel,
  getPlatformProvider,
  getProviderChain,
  providersToPrice,
  resolvePlatformProvider,
} from './config';
import { providerRates } from '~/lib/.server/billing/rates';
import { invalidateMarketPricesCache } from '~/lib/.server/billing/market-price-store';

/**
 * Everything that can decide which gateway this feature returns.
 *
 * The three `*_API_KEY` entries are the `isConfigured` gate and the tier vars reach `canPrice` through
 * `providerRates`' gap-fill injection — so a leftover in either group silently changes which rungs are
 * eligible rather than failing loudly.
 */
const SELECT_ENV = [
  'AUTO_MODEL_SELECT',
  'LLM_PROVIDER_CHAIN',
  'LLM_PROVIDER',
  'LLM_MODEL',
  'KIE_DEFAULT_MODEL',

  // The isConfigured gate reads these directly.
  'ANTHROPIC_API_KEY',
  'KIE_API_KEY',
  'COMET_API_KEY',

  // These reach canPrice: `providerRates` gap-fills each enabled rung's model into every table.
  'ENABLE_EXTENDED_MODELS',
  'ENABLE_PREMIUM_MODEL',
  'ENABLE_PLATINUM_MODEL',
  'PREMIUM_MODEL',
  'PLATINUM_MODEL',
  'PREMIUM_MINIMUM_CREDITS',
  'PLATINUM_MINIMUM_CREDITS',
] as const;

function stubEnv(vars: Partial<Record<string, string>> = {}) {
  for (const key of SELECT_ENV) {
    vi.stubEnv(key, (vars[key] ?? undefined) as unknown as string);
  }
}

/** Every key present, so a case can turn ONE of them off and know that is the only variable moving. */
const ALL_KEYS = {
  ANTHROPIC_API_KEY: 'sk-ant-test',
  KIE_API_KEY: 'kie-test',
  COMET_API_KEY: 'comet-test',
} as const;

beforeEach(() => {
  // Module state — a cooldown set by one case would otherwise decide the next one.
  resetProviderHealth();
  invalidateMarketPricesCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetProviderHealth();
  invalidateMarketPricesCache();
});

const input = (over: Partial<ProviderSelectInput> = {}): ProviderSelectInput => ({
  chain: ['KIE', 'Comet', 'Anthropic'],
  fixed: 'Anthropic',
  isConfigured: () => true,
  canPrice: () => true,
  nowMs: 1_000,
  ...over,
});

/**
 * The exported names ARE the contract, and this suite stubs raw strings.
 *
 * ⚠️ This is not ceremony. `AUTO_MODEL_SELECT` outranks `LLM_PROVIDER`, which makes it a new member of
 * the "which gateway" precedence chain — and on 2026-08-10 it was added without being added to
 * `platform-key.spec.ts`'s scrub list, so three of that file's cases silently became tests of the
 * ladder instead of tests of the key lookup. They failed only on the machine with the flag enabled,
 * with CI green. Pinning the constants against the literals every scrub list uses is what makes a
 * rename a loud failure here rather than a quiet one somewhere else.
 */
describe('the env keys this suite scrubs are the ones the implementation reads', () => {
  it('matches the exported constants', () => {
    expect(AUTO_MODEL_SELECT_ENV_KEY).toBe('AUTO_MODEL_SELECT');
    expect(LLM_PROVIDER_CHAIN_ENV_KEY).toBe('LLM_PROVIDER_CHAIN');
  });

  it('scrubs both of them, plus every platform key the isConfigured gate reads', () => {
    for (const key of [AUTO_MODEL_SELECT_ENV_KEY, LLM_PROVIDER_CHAIN_ENV_KEY, 'LLM_PROVIDER', 'LLM_MODEL']) {
      expect(SELECT_ENV, `${key} must be scrubbed or .env.local decides this suite`).toContain(key);
    }

    for (const provider of PLATFORM_PROVIDERS) {
      expect(SELECT_ENV).toContain(`${provider === 'Anthropic' ? 'ANTHROPIC' : provider.toUpperCase()}_API_KEY`);
    }
  });
});

describe('selectPlatformProvider — the happy path picks the head of the chain', () => {
  it('returns the first rung when every rung is serveable and healthy', () => {
    expect(selectPlatformProvider(input())).toEqual({
      provider: 'KIE',
      reason: 'auto_selected',
      switched: true,
    });
  });

  it('reports switched:false when the ladder lands on LLM_PROVIDER anyway', () => {
    const selection = selectPlatformProvider(input({ fixed: 'KIE' }));

    expect(selection.provider).toBe('KIE');
    expect(selection.switched, 'the ladder did nothing observable — do not claim it did').toBe(false);
  });

  it('honours the chain ORDER, not the declaration order of PLATFORM_PROVIDERS', () => {
    expect(selectPlatformProvider(input({ chain: ['Anthropic', 'Comet', 'KIE'] })).provider).toBe('Anthropic');
  });
});

describe('selectPlatformProvider — the isConfigured gate', () => {
  it('skips a rung with no API key', () => {
    const selection = selectPlatformProvider(input({ isConfigured: (p) => p !== 'KIE' }));

    expect(selection.provider).toBe('Comet');
    expect(selection.reason).toBe('auto_selected');
  });

  it('skips as many keyless rungs as it takes', () => {
    expect(selectPlatformProvider(input({ isConfigured: (p) => p === 'Anthropic' })).provider).toBe('Anthropic');
  });
});

describe('🔴 selectPlatformProvider — the canPrice gate is the money gate', () => {
  /*
   * The whole point of the gate. `ratesFor` bills an unpriced model at the provider's most expensive
   * row, so keeping a configured-but-unpriceable rung does not fail — it runs the turn at the top of
   * that gateway's table. A ladder chosen for a discount would write the biggest bill in the product.
   */
  it('skips a rung that is configured but cannot price the model it would run', () => {
    const selection = selectPlatformProvider(
      input({
        isConfigured: () => true,
        canPrice: (p) => p !== 'KIE',
      }),
    );

    expect(selection.provider).toBe('Comet');
  });

  it('requires BOTH gates — configured-but-unpriceable and priceable-but-keyless are both skipped', () => {
    const selection = selectPlatformProvider(
      input({
        isConfigured: (p) => p !== 'KIE', // KIE priceable, no key
        canPrice: (p) => p !== 'Comet', // Comet keyed, unpriceable
      }),
    );

    expect(selection.provider).toBe('Anthropic');
  });

  /* A rung that cannot be priced is not "cooling" — it is not a candidate at all, at any nowMs. */
  it('never resurrects an unpriceable rung, even when every other rung is cooling', () => {
    const selection = selectPlatformProvider(
      input({
        canPrice: (p) => p !== 'KIE',
        unhealthyUntilMs: (p) => (p === 'KIE' ? 0 : 9_000),
        nowMs: 1_000,
      }),
    );

    expect(selection.provider, 'KIE is healthy but unbillable — that is worse than cooling').toBe('Comet');
    expect(selection.reason).toBe('auto_selected_while_cooling');
  });
});

describe('selectPlatformProvider — nothing serveable falls back to LLM_PROVIDER', () => {
  it('returns the fixed provider with reason no_candidate, and does not claim a switch', () => {
    expect(selectPlatformProvider(input({ isConfigured: () => false }))).toEqual({
      provider: 'Anthropic',
      reason: 'no_candidate',
      switched: false,
    });
  });

  it('falls back when nothing can be priced either', () => {
    expect(selectPlatformProvider(input({ canPrice: () => false })).reason).toBe('no_candidate');
  });

  it('falls back on an empty chain rather than inventing a rung', () => {
    expect(selectPlatformProvider(input({ chain: [] }))).toEqual({
      provider: 'Anthropic',
      reason: 'no_candidate',
      switched: false,
    });
  });

  /*
   * There is deliberately no null return: a turn with no serveable gateway must produce the SAME
   * describable failure it produces today (`requirePlatformKey`'s 503 naming the missing variable),
   * not a second "nothing to run on" error path that makes that message worse.
   */
  it('always returns a provider — never null, never a throw', () => {
    const selection = selectPlatformProvider(input({ chain: [], isConfigured: () => false, canPrice: () => false }));

    expect(selection.provider).toBeTruthy();
    expect(PLATFORM_PROVIDERS).toContain(selection.provider);
  });
});

describe('selectPlatformProvider — cooldown skips, and prefers home the moment it is healthy', () => {
  it('skips a cooling rung in favour of a healthy one further down', () => {
    const selection = selectPlatformProvider(input({ unhealthyUntilMs: (p) => (p === 'KIE' ? 9_000 : 0) }));

    expect(selection.provider).toBe('Comet');
    expect(selection.reason).toBe('auto_selected');
  });

  it('returns to the head of the chain as soon as its cooldown lapses — that is where the warm prefix is', () => {
    const cooling = (p: ProviderSelectInput['chain'][number]) => (p === 'KIE' ? 9_000 : 0);

    expect(selectPlatformProvider(input({ unhealthyUntilMs: cooling, nowMs: 8_999 })).provider).toBe('Comet');
    expect(selectPlatformProvider(input({ unhealthyUntilMs: cooling, nowMs: 9_001 })).provider).toBe('KIE');
  });

  it('treats an absent health source as healthy', () => {
    expect(selectPlatformProvider(input({ unhealthyUntilMs: undefined })).provider).toBe('KIE');
  });

  it('treats a 0 / undefined stamp as healthy', () => {
    expect(selectPlatformProvider(input({ unhealthyUntilMs: () => 0 })).provider).toBe('KIE');
    expect(selectPlatformProvider(input({ unhealthyUntilMs: () => undefined as unknown as number })).provider).toBe(
      'KIE',
    );
  });
});

/**
 * The boundary is `unhealthyUntil > nowMs`, so the instant the clock REACHES the stamp the rung is
 * healthy again. Asserted on both sides because an off-by-one here is invisible: it just holds traffic
 * off the cheapest rung for one more tick, forever, on every request.
 */
describe('selectPlatformProvider — the cooldown boundary is exact', () => {
  const at = (nowMs: number) =>
    selectPlatformProvider(input({ unhealthyUntilMs: (p) => (p === 'KIE' ? 5_000 : 0), nowMs })).provider;

  it('is still cooling one millisecond before the stamp', () => {
    expect(at(4_999)).toBe('Comet');
  });

  it('is NOT cooling exactly AT the stamp — the comparison is > , not >=', () => {
    expect(at(5_000)).toBe('KIE');
  });

  it('is healthy after the stamp', () => {
    expect(at(5_001)).toBe('KIE');
  });
});

describe('🔴 selectPlatformProvider — cooldown is a preference, never a wall', () => {
  /*
   * Reaching this branch means every serveable rung is cooling. The honest move is to try the BEST one
   * anyway: the cost of being wrong is one failed generation (refunded, §4.6), while the cost of
   * refusing is every generation. Same asymmetry as `resolveMediaProvider` degrading to "no media
   * tools" instead of a 500.
   */
  it('still returns the FIRST serveable rung when every rung is cooling', () => {
    const selection = selectPlatformProvider(input({ unhealthyUntilMs: () => 9_000, nowMs: 1_000 }));

    expect(selection.provider, 'the best rung, not the fallback').toBe('KIE');
    expect(selection.reason).toBe('auto_selected_while_cooling');
    expect(selection.switched).toBe(true);
  });

  it('does not refuse, return null, or throw when everything is cooling', () => {
    expect(() => selectPlatformProvider(input({ unhealthyUntilMs: () => Number.MAX_SAFE_INTEGER }))).not.toThrow();

    const selection = selectPlatformProvider(input({ unhealthyUntilMs: () => Number.MAX_SAFE_INTEGER }));

    expect(selection.provider).toBe('KIE');
    expect(selection.reason).toBe('auto_selected_while_cooling');
  });

  /*
   * "First SERVEABLE", not "first in the chain" — a cooling free-for-all must not hand the turn to a
   * rung that has no key or no price, which would be a guaranteed failure rather than a hopeful one.
   */
  it('picks the first SERVEABLE cooling rung, never an unserveable one ahead of it', () => {
    const selection = selectPlatformProvider(
      input({
        isConfigured: (p) => p !== 'KIE',
        unhealthyUntilMs: () => 9_000,
        nowMs: 1_000,
      }),
    );

    expect(selection.provider).toBe('Comet');
    expect(selection.reason).toBe('auto_selected_while_cooling');
  });

  it('reports switched:false when the cooling pick is LLM_PROVIDER itself', () => {
    const selection = selectPlatformProvider(input({ fixed: 'KIE', unhealthyUntilMs: () => 9_000 }));

    expect(selection.provider).toBe('KIE');
    expect(selection.switched).toBe(false);
    expect(selection.reason).toBe('auto_selected_while_cooling');
  });
});

describe('the health memory', () => {
  it('reports 0 for a provider that has never failed', () => {
    expect(providerUnhealthyUntil('KIE')).toBe(0);
  });

  it('stamps now + the default cooldown on a failure', () => {
    recordProviderFailure('KIE', 1_000);

    expect(providerUnhealthyUntil('KIE')).toBe(1_000 + PROVIDER_COOLDOWN_MS);
  });

  it('honours an explicit cooldown', () => {
    recordProviderFailure('Comet', 1_000, 250);

    expect(providerUnhealthyUntil('Comet')).toBe(1_250);
  });

  it('cools only the provider that failed', () => {
    recordProviderFailure('KIE', 1_000);

    expect(providerUnhealthyUntil('Comet')).toBe(0);
    expect(providerUnhealthyUntil('Anthropic')).toBe(0);
  });

  /*
   * Without this, a single 500 in an otherwise healthy hour pushes every following turn onto the next
   * rung for the whole window — and each of those turns pays a cold-prefix cache WRITE at 2x.
   */
  it('clears the cooldown on a success — one blip must not cost a provider its place', () => {
    recordProviderFailure('KIE', 1_000);
    expect(providerUnhealthyUntil('KIE')).toBeGreaterThan(0);

    recordProviderSuccess('KIE');

    expect(providerUnhealthyUntil('KIE')).toBe(0);
  });

  it('puts a recovered provider back at the head of the ladder immediately', () => {
    recordProviderFailure('KIE', 1_000);

    const whileCooling = selectPlatformProvider(input({ unhealthyUntilMs: providerUnhealthyUntil, nowMs: 2_000 }));
    expect(whileCooling.provider).toBe('Comet');

    recordProviderSuccess('KIE');

    const afterSuccess = selectPlatformProvider(input({ unhealthyUntilMs: providerUnhealthyUntil, nowMs: 2_000 }));

    expect(afterSuccess.provider).toBe('KIE');
    expect(afterSuccess.reason).toBe('auto_selected');
  });

  it('is a no-op to clear a provider that was never cooling', () => {
    expect(() => recordProviderSuccess('Anthropic')).not.toThrow();
    expect(providerUnhealthyUntil('Anthropic')).toBe(0);
  });

  it('resetProviderHealth clears every provider', () => {
    for (const provider of PLATFORM_PROVIDERS) {
      recordProviderFailure(provider, 1_000);
    }

    resetProviderHealth();

    for (const provider of PLATFORM_PROVIDERS) {
      expect(providerUnhealthyUntil(provider)).toBe(0);
    }
  });

  /*
   * The flapping rule from the file header: every switch pays a full cache WRITE at 2x (~8x one prefix
   * before it warms), so a cooldown shorter than a warm-up window costs more in cache writes than the
   * outage costs in failures. Seconds would be a regression even though nothing would throw.
   */
  it('cools for minutes, not seconds — a switch costs a cold ~150k prefix', () => {
    expect(PROVIDER_COOLDOWN_MS).toBeGreaterThanOrEqual(60_000);
  });
});

describe('🔴 resolvePlatformProvider — DEFAULT OFF', () => {
  it('returns getPlatformProvider when the flag is unset, even though the chain would pick KIE', () => {
    stubEnv({ ...ALL_KEYS, LLM_PROVIDER: 'Anthropic' });

    expect(resolvePlatformProvider({})).toBe('Anthropic');
    expect(resolvePlatformProvider({})).toBe(getPlatformProvider({}));
  });

  it('stays off when the flag is explicitly false', () => {
    stubEnv({ ...ALL_KEYS, LLM_PROVIDER: 'Anthropic', AUTO_MODEL_SELECT: 'false' });

    expect(resolvePlatformProvider({})).toBe('Anthropic');
  });

  /* `envFlag` is exactly `"true"` — a truthy-looking value is OFF, which is the safe direction. */
  it.each(['1', 'yes', 'TRUE', 'on'])('stays off for the truthy-looking value %s', (value) => {
    stubEnv({ ...ALL_KEYS, LLM_PROVIDER: 'Anthropic', AUTO_MODEL_SELECT: value });

    expect(resolvePlatformProvider({})).toBe('Anthropic');
  });

  /*
   * 🔴 The case that proves it is genuinely inert rather than merely agreeing today. With the ladder
   * OFF, a fixed provider that cannot serve the turn must still be returned — `requirePlatformKey`'s
   * describable 503 is the correct outcome, and silently rescuing it would spend on a key the operator
   * never chose while reporting nothing.
   */
  it('returns LLM_PROVIDER even when it has NO key and a keyed rung is available', () => {
    stubEnv({ LLM_PROVIDER: 'Comet', KIE_API_KEY: 'kie-test', ANTHROPIC_API_KEY: 'sk-ant-test' });

    expect(resolvePlatformProvider({})).toBe('Comet');
  });

  it('does not consult the cooldown map at all while off', () => {
    stubEnv({ ...ALL_KEYS, LLM_PROVIDER: 'KIE' });
    recordProviderFailure('KIE', 1_000);

    expect(resolvePlatformProvider({}, 2_000)).toBe('KIE');
  });

  it('falls through to the baked default provider when LLM_PROVIDER is unset too', () => {
    stubEnv({ ...ALL_KEYS });

    expect(resolvePlatformProvider({})).toBe('KIE');
  });
});

describe('resolvePlatformProvider — the ladder, once an operator opts in', () => {
  it('picks the head of the default chain when every rung is keyed and priceable', () => {
    stubEnv({ ...ALL_KEYS, AUTO_MODEL_SELECT: 'true', LLM_PROVIDER: 'Anthropic' });

    expect(resolvePlatformProvider({})).toBe('KIE');
  });

  it('skips down the chain past a keyless rung', () => {
    stubEnv({
      AUTO_MODEL_SELECT: 'true',
      LLM_PROVIDER: 'Anthropic',
      COMET_API_KEY: 'comet-test',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    });

    expect(resolvePlatformProvider({})).toBe('Comet');
  });

  it('reaches the last rung when only it is keyed', () => {
    stubEnv({ AUTO_MODEL_SELECT: 'true', LLM_PROVIDER: 'KIE', ANTHROPIC_API_KEY: 'sk-ant-test' });

    expect(resolvePlatformProvider({})).toBe('Anthropic');
  });

  it('falls back to LLM_PROVIDER when no rung is keyed at all', () => {
    stubEnv({ AUTO_MODEL_SELECT: 'true', LLM_PROVIDER: 'Comet' });

    expect(resolvePlatformProvider({})).toBe('Comet');
  });

  it('honours an operator-supplied chain over the default order', () => {
    stubEnv({
      ...ALL_KEYS,
      AUTO_MODEL_SELECT: 'true',
      LLM_PROVIDER: 'KIE',
      LLM_PROVIDER_CHAIN: 'Anthropic,Comet',
    });

    expect(resolvePlatformProvider({})).toBe('Anthropic');
  });

  it('reads the real cooldown map, and returns home when the stamp lapses', () => {
    stubEnv({ ...ALL_KEYS, AUTO_MODEL_SELECT: 'true', LLM_PROVIDER: 'Anthropic' });
    recordProviderFailure('KIE', 1_000, 500);

    expect(resolvePlatformProvider({}, 1_400), 'still cooling').toBe('Comet');
    expect(resolvePlatformProvider({}, 1_500), 'the boundary is inclusive of health').toBe('KIE');
  });

  it('serves a turn anyway when every keyed rung is cooling', () => {
    stubEnv({ ...ALL_KEYS, AUTO_MODEL_SELECT: 'true', LLM_PROVIDER: 'Anthropic' });

    for (const provider of PLATFORM_PROVIDERS) {
      recordProviderFailure(provider, 1_000);
    }

    expect(resolvePlatformProvider({}, 2_000)).toBe('KIE');
  });
});

/**
 * The money gate against the REAL price tables, not a stub.
 *
 * `claude-haiku-4-5` is priced by Anthropic and KIE and NOT by Comet, so a chain of `Comet,Anthropic`
 * under `LLM_MODEL=claude-haiku-4-5` is a genuine unpriceable-rung scenario. The precondition is
 * asserted first: if Comet ever gains a haiku row this test would otherwise keep passing while testing
 * nothing at all.
 */
describe('🔴 resolvePlatformProvider — the canPrice gate against the real rate tables', () => {
  const UNPRICED_ON_COMET = 'claude-haiku-4-5';

  it('PRECONDITION — the fixture model is priced by Anthropic and not by Comet', () => {
    stubEnv({ ...ALL_KEYS });

    const rates = providerRates({});

    expect(Object.keys(rates.Anthropic)).toContain(UNPRICED_ON_COMET);
    expect(
      Object.keys(rates.Comet),
      'Comet gained a row for the fixture model — this suite is now vacuous, pick another',
    ).not.toContain(UNPRICED_ON_COMET);
  });

  it('skips the cheaper rung it cannot price and serves on the one it can', () => {
    stubEnv({
      ...ALL_KEYS,
      AUTO_MODEL_SELECT: 'true',
      LLM_PROVIDER: 'KIE',
      LLM_PROVIDER_CHAIN: 'Comet,Anthropic',
      LLM_MODEL: UNPRICED_ON_COMET,
    });

    expect(resolvePlatformProvider({})).toBe('Anthropic');
  });

  /* The control: the same chain, the same keys, a model Comet DOES price — Comet wins on rate. */
  it('CONTROL — the same chain picks Comet for a model Comet prices', () => {
    stubEnv({
      ...ALL_KEYS,
      AUTO_MODEL_SELECT: 'true',
      LLM_PROVIDER: 'KIE',
      LLM_PROVIDER_CHAIN: 'Comet,Anthropic',
      LLM_MODEL: 'claude-sonnet-5',
    });

    expect(resolvePlatformProvider({})).toBe('Comet');
  });

  /* An unpriceable rung is skipped even when it is the ONLY keyed one — falling back beats mis-billing. */
  it('falls back to LLM_PROVIDER rather than serving on a rung it cannot price', () => {
    stubEnv({
      AUTO_MODEL_SELECT: 'true',
      LLM_PROVIDER: 'KIE',
      LLM_PROVIDER_CHAIN: 'Comet',
      LLM_MODEL: UNPRICED_ON_COMET,
      COMET_API_KEY: 'comet-test',
    });

    expect(resolvePlatformProvider({})).toBe('KIE');
  });
});

/**
 * `getPlatformConfig` is called ONCE per generation and its `provider` flows to both the wire AND
 * `settleGeneration`. Asserted behaviourally rather than by source scan: this is what proves the two
 * can never disagree about which gateway spent the tokens.
 */
describe('getPlatformConfig resolves through the ladder', () => {
  it('reports the ladder pick, not LLM_PROVIDER, when the flag is on', () => {
    stubEnv({
      AUTO_MODEL_SELECT: 'true',
      LLM_PROVIDER: 'Anthropic',
      COMET_API_KEY: 'comet-test',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    });

    expect(getPlatformConfig({}).provider).toBe('Comet');
  });

  it('reports LLM_PROVIDER unchanged when the flag is off', () => {
    stubEnv({ ...ALL_KEYS, LLM_PROVIDER: 'Anthropic' });

    expect(getPlatformConfig({}).provider).toBe('Anthropic');
  });
});

describe('getProviderChain', () => {
  it('defaults to cheapest-first, with Anthropic last', () => {
    stubEnv({});

    expect(getProviderChain({})).toEqual(['KIE', 'Comet', 'Anthropic']);
    expect(getProviderChain({})).toEqual(DEFAULT_PROVIDER_CHAIN);
  });

  /*
   * Anthropic is PRESENT because "every gateway is down" must degrade to an expensive turn, not to no
   * product — and LAST because it is the only rung that is never a discount.
   */
  it('keeps the full-price rung in the default chain, at the end', () => {
    expect(DEFAULT_PROVIDER_CHAIN.at(-1)).toBe('Anthropic');
    expect(new Set(DEFAULT_PROVIDER_CHAIN).size).toBe(DEFAULT_PROVIDER_CHAIN.length);
  });

  it('parses a comma list', () => {
    stubEnv({ LLM_PROVIDER_CHAIN: 'Anthropic,KIE' });

    expect(getProviderChain({})).toEqual(['Anthropic', 'KIE']);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    stubEnv({ LLM_PROVIDER_CHAIN: '  kie , ANTHROPIC ,comet ' });

    expect(getProviderChain({})).toEqual(['KIE', 'Anthropic', 'Comet']);
  });

  it('ignores empty entries — a trailing comma is a typo with no consequence', () => {
    stubEnv({ LLM_PROVIDER_CHAIN: 'KIE,,Anthropic,' });

    expect(getProviderChain({})).toEqual(['KIE', 'Anthropic']);
  });

  /* A chain cannot make one rung eligible twice; first-seen wins so the operator's order is kept. */
  it('collapses duplicates to first-seen', () => {
    stubEnv({ LLM_PROVIDER_CHAIN: 'Anthropic,KIE,anthropic,KIE' });

    expect(getProviderChain({})).toEqual(['Anthropic', 'KIE']);
  });

  it('falls back to the default when the value is blank or all separators', () => {
    stubEnv({ LLM_PROVIDER_CHAIN: '   ' });
    expect(getProviderChain({})).toEqual(DEFAULT_PROVIDER_CHAIN);

    stubEnv({ LLM_PROVIDER_CHAIN: ',,,' });
    expect(getProviderChain({})).toEqual(DEFAULT_PROVIDER_CHAIN);
  });

  /*
   * 🔴 THROWS rather than skipping. Skipping would silently shorten the ladder, and a short ladder
   * looks exactly like normal operation — the platform keeps serving from the next rung down and the
   * operator never learns their cheapest gateway is spelled wrong.
   */
  it('throws NotConfiguredError on an unknown name, naming the variable and quoting the typo', () => {
    stubEnv({ LLM_PROVIDER_CHAIN: 'KIE,Komet,Anthropic' });

    expect(() => getProviderChain({})).toThrow(NotConfiguredError);

    try {
      getProviderChain({});
      expect.unreachable('an unknown provider must not resolve');
    } catch (error) {
      const message = (error as Error).message;

      expect(message).toContain(LLM_PROVIDER_CHAIN_ENV_KEY);
      expect(message, 'the operator has to see what they typed').toContain('Komet');
      expect(message, 'and what the valid names are').toContain('Anthropic');
    }
  });

  it('refuses rather than returning the valid subset', () => {
    stubEnv({ LLM_PROVIDER_CHAIN: 'KIE,Komet' });

    expect(() => getProviderChain({})).toThrow(/Komet/);
  });

  /*
   * 🔴 THE PARSER REFUSES; THE RESOLVER DEGRADES. Two different jobs, deliberately split.
   *
   * `getPlatformConfig` runs on `/api/me` — the session endpoint on every page load — so a throw here
   * turns "an operator typo'd a provider name" into a 503 for every user, which is the 2026-07-25
   * `modelTiersSessionHint` lesson exactly. This assertion originally read `.toThrow()`, matching the
   * first draft of the implementation, and `session-payload.spec.ts` caught the consequence: a retired
   * price variable (which makes `providerRates` refuse) took the whole session payload down.
   *
   * Degrading is safe BECAUSE `getPlatformProvider` consults no price list at all — the fallback is
   * byte-for-byte the path the platform runs with `AUTO_MODEL_SELECT` off, so the cost of a broken
   * chain is a turn that got no discount, never a turn that mis-bills. The operator still finds out:
   * the refusal is logged at error level, and the parser above still throws for anything that calls it
   * directly.
   */
  it('degrades to LLM_PROVIDER rather than taking the request down', () => {
    stubEnv({ ...ALL_KEYS, AUTO_MODEL_SELECT: 'true', LLM_PROVIDER: 'Comet', LLM_PROVIDER_CHAIN: 'Komet' });

    expect(resolvePlatformProvider({})).toBe('Comet');
  });

  /*
   * The CONTROL for the assertion above. Without it, "degrades to the fixed provider" passes for an
   * implementation that ignores the chain entirely — the silent-inert-ladder failure — so this proves
   * a WELL-FORMED chain really does move the answer away from `LLM_PROVIDER`.
   */
  it('still ladders when the chain is well-formed — the degrade is not a no-op', () => {
    stubEnv({ ...ALL_KEYS, AUTO_MODEL_SELECT: 'true', LLM_PROVIDER: 'Comet', LLM_PROVIDER_CHAIN: 'KIE,Comet' });

    expect(resolvePlatformProvider({})).toBe('KIE');
  });
});

/**
 * 🔴 `getPlatformModel(context, providerOverride)` — the two-readers defect, closed.
 *
 * With the ladder on, the gateway is chosen PER REQUEST, so a caller holding `config.provider` must be
 * able to say so. Re-deriving from `LLM_PROVIDER` here would validate the model against a DIFFERENT
 * price table than the one about to serve and bill it — `kieEnvModel` exactly.
 */
describe('getPlatformModel — the provider override decides which price table validates', () => {
  const KIE_ONLY = 'claude-opus-4-7';

  it('PRECONDITION — the fixture model is priced by KIE alone', () => {
    stubEnv({ ...ALL_KEYS });

    const rates = providerRates({});

    expect(Object.keys(rates.KIE)).toContain(KIE_ONLY);
    expect(Object.keys(rates.Anthropic), 'fixture no longer isolates KIE — pick another model').not.toContain(KIE_ONLY);
  });

  it('validates against the OVERRIDE, not LLM_PROVIDER', () => {
    stubEnv({ ...ALL_KEYS, LLM_PROVIDER: 'Anthropic', LLM_MODEL: KIE_ONLY });

    expect(getPlatformModel({}, 'KIE')).toBe(KIE_ONLY);
    expect(() => getPlatformModel({}), 'without the override it validates against Anthropic').toThrow(
      NotConfiguredError,
    );
  });

  it('refuses when the override cannot price the model, even though LLM_PROVIDER could', () => {
    stubEnv({ ...ALL_KEYS, LLM_PROVIDER: 'KIE', LLM_MODEL: KIE_ONLY });

    expect(getPlatformModel({})).toBe(KIE_ONLY);
    expect(() => getPlatformModel({}, 'Comet')).toThrow(NotConfiguredError);
  });

  it('names the OVERRIDE provider in the refusal, so the operator fixes the right price list', () => {
    stubEnv({ ...ALL_KEYS, LLM_PROVIDER: 'KIE', LLM_MODEL: KIE_ONLY });

    try {
      getPlatformModel({}, 'Comet');
      expect.unreachable('an unpriced model must not resolve');
    } catch (error) {
      const message = (error as Error).message;

      expect(message).toContain('Comet');
      expect(message).toContain(KIE_ONLY);
    }
  });

  /* Omitting the argument must behave exactly as it did before the parameter existed. */
  it('falls back to LLM_PROVIDER when no override is given', () => {
    stubEnv({ ...ALL_KEYS, LLM_PROVIDER: 'Anthropic', LLM_MODEL: 'claude-sonnet-5' });

    expect(getPlatformModel({})).toBe(getPlatformModel({}, 'Anthropic'));
    expect(getPlatformModel({})).toBe('claude-sonnet-5');
  });

  /* With `LLM_MODEL` unset the rungs can legitimately run DIFFERENT models — the override must pick. */
  it('resolves each provider default independently when LLM_MODEL is unset', () => {
    stubEnv({ ...ALL_KEYS, LLM_PROVIDER: 'Anthropic', KIE_DEFAULT_MODEL: 'claude-opus-4-7' });

    expect(getPlatformModel({}, 'KIE')).toBe('claude-opus-4-7');
    expect(getPlatformModel({}, 'Anthropic')).not.toBe('claude-opus-4-7');
  });
});

/**
 * 🔴 `providersToPrice` — PRICES FIRST, THEN THE CHOICE THAT DEPENDS ON THEM.
 *
 * The ladder's `canPrice` gate and settlement's `ratesFor` read the marketplace lists SYNCHRONOUSLY,
 * and those lists are only populated by the async `ensureMarketPrices` at the doorway. That doorway
 * used to ensure `LLM_PROVIDER` alone — correct while the gateway was fixed, and silently wrong the
 * moment auto-select could pick a different one: the SELECTED gateway would be judged, and then
 * BILLED, from its BAKED table with whatever the operator promoted ignored entirely. Nothing throws,
 * no request fails, and the only symptom is a credit count that moves for reasons no log explains.
 *
 * Two properties, failing in opposite directions:
 *
 *   - **Flag OFF is byte-identical to the old behaviour.** Widening the ensure set on a deploy that
 *     never opted in buys object-store reads at the doorway of every generation for nothing.
 *   - **Flag ON covers the WHOLE chain**, including `LLM_PROVIDER` itself — which is the fallback the
 *     resolver degrades to, so a set that omitted it would leave the one gateway guaranteed to be
 *     reachable as the one gateway priced from its baked table.
 */
describe('🔴 providersToPrice — every gateway that could serve the turn is priced first', () => {
  it.each(['Anthropic', 'KIE', 'Comet'] as const)('with the flag OFF it is exactly [%s]', (fixed) => {
    stubEnv({ ...ALL_KEYS, LLM_PROVIDER: fixed });

    expect(providersToPrice({})).toEqual([fixed]);
  });

  /* Explicitly off, and the falsey spellings — the same set `resolvePlatformProvider` treats as off. */
  it.each(['false', '0', 'no', 'off', ''])('stays narrow for AUTO_MODEL_SELECT=%s', (value) => {
    stubEnv({ ...ALL_KEYS, LLM_PROVIDER: 'Anthropic', AUTO_MODEL_SELECT: value });

    expect(providersToPrice({})).toEqual(['Anthropic']);
  });

  it('with the flag ON it is the whole default chain', () => {
    stubEnv({ ...ALL_KEYS, AUTO_MODEL_SELECT: 'true', LLM_PROVIDER: 'KIE' });

    expect(providersToPrice({})).toEqual(DEFAULT_PROVIDER_CHAIN);
  });

  it('honours an operator chain, in the operator’s order', () => {
    stubEnv({ ...ALL_KEYS, AUTO_MODEL_SELECT: 'true', LLM_PROVIDER: 'Comet', LLM_PROVIDER_CHAIN: 'Comet,Anthropic' });

    expect(providersToPrice({})).toEqual(['Comet', 'Anthropic']);
  });

  /*
   * 🔴 The fixed provider is ALWAYS in the set, chain or no chain. `resolvePlatformProvider` falls back
   * to it whenever the ladder finds nothing serveable — and whenever the chain itself is unparseable —
   * so it is the one gateway that can serve a turn no matter what the ladder decides. Omitting it is
   * the original defect wearing the new feature's clothes.
   */
  it('appends the fixed provider when the chain omits it', () => {
    stubEnv({ ...ALL_KEYS, AUTO_MODEL_SELECT: 'true', LLM_PROVIDER: 'Anthropic', LLM_PROVIDER_CHAIN: 'KIE,Comet' });

    expect(providersToPrice({})).toEqual(['KIE', 'Comet', 'Anthropic']);
  });

  it('does not duplicate it when the chain already names it', () => {
    stubEnv({ ...ALL_KEYS, AUTO_MODEL_SELECT: 'true', LLM_PROVIDER: 'KIE', LLM_PROVIDER_CHAIN: 'KIE,Anthropic' });

    const set = providersToPrice({});

    expect(set).toEqual(['KIE', 'Anthropic']);
    expect(new Set(set).size).toBe(set.length);
  });

  /*
   * 🔴 A TYPO'D CHAIN DEGRADES, EXACTLY AS `resolvePlatformProvider` DOES. This runs at the top of
   * `runAgentGeneration` AND inside `/api/me` — the session endpoint on every page load — so a throw
   * here turns "an operator misspelled a gateway" into a 503 for every user. Degrading is safe because
   * the resolver degrades to the same single provider, so the set still covers whoever serves the turn.
   */
  it('degrades to the fixed provider on an unparseable chain rather than throwing', () => {
    stubEnv({ ...ALL_KEYS, AUTO_MODEL_SELECT: 'true', LLM_PROVIDER: 'Comet', LLM_PROVIDER_CHAIN: 'Komet' });

    expect(() => providersToPrice({})).not.toThrow();
    expect(providersToPrice({})).toEqual(['Comet']);
  });

  /*
   * CONTROL for the degrade above, and for the whole feature: without it, "returns [fixed]" passes for
   * an implementation that ignores `AUTO_MODEL_SELECT` and the chain entirely — the silently-inert
   * ladder, which is precisely the shape this file's header warns about.
   */
  it('CONTROL — the ON set is strictly wider than the OFF set for the same environment', () => {
    stubEnv({ ...ALL_KEYS, LLM_PROVIDER: 'Anthropic' });

    const off = providersToPrice({});

    stubEnv({ ...ALL_KEYS, AUTO_MODEL_SELECT: 'true', LLM_PROVIDER: 'Anthropic' });

    const on = providersToPrice({});

    expect(off).toEqual(['Anthropic']);
    expect(on.length).toBeGreaterThan(off.length);
    expect(on).toContain('Anthropic');
  });

  /*
   * 🔴 IT IS NOT GATED ON `isConfigured` OR `canPrice`, AND THAT ORDERING IS THE POINT. `canPrice`
   * READS the very lists this call exists to load, so filtering the ensure set by it would ask the gate
   * its question before the answer had been fetched — a gate that judges every rung from its baked
   * table, i.e. the original defect re-entering through the fix for it.
   */
  it('prices every rung in the chain even when no key for it is configured', () => {
    stubEnv({ AUTO_MODEL_SELECT: 'true', LLM_PROVIDER: 'Anthropic', ANTHROPIC_API_KEY: 'sk-ant-test' });

    expect(providersToPrice({})).toEqual(DEFAULT_PROVIDER_CHAIN);
  });

  /* Whatever the ladder ends up choosing, this set contains it. The invariant, stated directly. */
  it.each([
    { LLM_PROVIDER: 'Anthropic' },
    { LLM_PROVIDER: 'Comet', LLM_PROVIDER_CHAIN: 'Comet,KIE' },
    { LLM_PROVIDER: 'KIE', LLM_PROVIDER_CHAIN: 'Anthropic' },
    { LLM_PROVIDER: 'Comet', LLM_PROVIDER_CHAIN: 'Komet' },
  ])('always contains the provider the resolver actually returns (%o)', (vars) => {
    stubEnv({ ...ALL_KEYS, AUTO_MODEL_SELECT: 'true', ...vars });

    expect(providersToPrice({})).toContain(resolvePlatformProvider({}));
  });
});
