/**
 * The MODEL TIER LADDER (SPEC §4.6.1a) — money-path tests for `model-tiers.ts` + its resolver in `rates.ts`.
 *
 * The ladder replaced a boolean premium toggle with three rungs (Standard · Premium · SuperMax). Every
 * property pinned here fails SILENTLY if it regresses, and each one is money:
 *
 *  - **A rung's model and its price are ONE fact.** A selector the ACTIVE Marketplace price list cannot
 *    price must be REFUSED, never guessed — `ratesFor` falls back to the most expensive row we know of,
 *    so an unpriced rung does not fail, it over-charges forever with nothing throwing.
 *  - **The THRESHOLDS are what protect the free signup grant.** A rung that unlocks below the grant lets
 *    a brand-new account burn its whole giveaway on the most expensive model out the gate.
 *  - **A misconfigured rung degrades to OFF, never to ON** (the 2026-07-25 `premiumSessionHint` lesson):
 *    reporting a rung serveable when `getModelTier` would refuse it renders an enabled control that
 *    hard-fails on use — and `getModelTiers` sits on read paths where a throw is an app-wide outage.
 *  - **The DEFAULTS must be a real, priced, monotonic ladder**, because a deploy with no environment at
 *    all is the shipping default: an unpriced default model is a rung that is dead on arrival.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PREMIUM_MINIMUM_CREDITS,
  DEFAULT_PREMIUM_MODEL,
  DEFAULT_SUPERMAX_MINIMUM_CREDITS,
  DEFAULT_SUPERMAX_MODEL,
  MODEL_TIER_IDS,
  PAID_MODEL_TIERS,
  STANDARD_TIER_LABEL,
  paidModelTierDefinition,
  type PaidModelTierId,
} from './model-tiers';
import { getModelTier, getModelTiers, getPremiumTier } from './rates';
import { BAKED_MARKET_PRICES } from './baked-market-prices';
import { ENV_EXAMPLE_FILENAME, envExampleAssignments, envExampleValue } from './env-example';
import { validateMarketPriceList } from './market-prices';
import { invalidateMarketPricesCache, promoteMarketPrices } from './market-price-store';
import { KIE_MODELS } from '~/lib/modules/llm/providers/kie-wire';
import { DEFAULT_MODEL } from '~/utils/constants';
import type { ObjectStore } from '~/lib/.server/storage';

/**
 * Every var that can decide a rung's model, threshold or price — cleared before any case that means to
 * exercise a DEFAULT.
 *
 * ⚠️ This repo's `env()` falls back to `process.env` and vitest loads `.env.local`, so an "empty" context
 * silently resolves the developer's real configuration (the `oauth.spec.ts` trap). This developer's
 * `.env.local` sets `PREMIUM_MODEL`, `PREMIUM_MINIMUM_CREDITS` and `SUPERMAX_MODEL` today — a case that
 * forgets this passes in CI and fails only on the machine of whoever configured the feature.
 *
 * The RETIRED price vars are in the list for the same reason: `getModelTier` refuses when any of them is
 * set, so one left over in a local env would fail every default case here for an unrelated reason.
 */
function stubTierEnv(vars: Partial<Record<string, string>> = {}) {
  for (const key of [
    'PREMIUM_MODEL',
    'PREMIUM_MINIMUM_CREDITS',
    'SUPERMAX_MODEL',
    'ENABLE_EXTENDED_MODELS',
    'SUPERMAX_MINIMUM_CREDITS',
    'PREMIUM_INPUT_DOLLARS',
    'PREMIUM_OUTPUT_DOLLARS',
    'KIE_INPUT_DOLLARS',
    'KIE_OUTPUT_DOLLARS',
    'KIE_CACHED_INPUT',
    'KIE_CACHED_WRITES',
  ]) {
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

/**
 * The static table — the shape of the ladder itself.
 *
 * These are the properties that make the ladder a LIST rather than three copies of the premium
 * machinery. The order is the ladder (a UI renders rungs in this order and a user reads "more expensive
 * as I go down"), and totality means a caller that holds a `PaidModelTierId` never has to null-check a
 * definition — the branch that would have handled `undefined` is the one nobody tests.
 */
describe('the ladder table (model-tiers.ts)', () => {
  it('is Standard · Premium · SuperMax, and the paid table is that list minus the free rung, in order', () => {
    expect([...MODEL_TIER_IDS]).toEqual(['standard', 'premium', 'supermax']);
    expect(PAID_MODEL_TIERS.map((tier) => tier.id)).toEqual(['premium', 'supermax']);
    expect(STANDARD_TIER_LABEL).toBe('Standard');
  });

  it('resolves a definition for every paid rung — total, so callers need no null check', () => {
    for (const definition of PAID_MODEL_TIERS) {
      expect(paidModelTierDefinition(definition.id)).toBe(definition);
    }
  });

  /* A loud throw beats a silent `undefined` if the type and the table ever disagree. */
  it('throws rather than returning undefined for an id that is not a rung', () => {
    expect(() => paidModelTierDefinition('enterprise' as PaidModelTierId)).toThrow(/enterprise/);
  });

  /*
   * 🔴 A default model the BAKED list cannot price is a rung that is dead on arrival: `getModelTier`
   * refuses it, so a deploy with no env and no promotion offers a tier it can never serve. This is the
   * "model and price are one fact" rule applied to the fallbacks rather than to the selectors.
   */
  it('prices every default model in the baked list', () => {
    for (const definition of PAID_MODEL_TIERS) {
      expect(BAKED_MARKET_PRICES.llm[definition.defaultModel], `${definition.id} default model`).toBeDefined();
    }
  });

  /*
   * MONOTONIC THRESHOLDS. If SuperMax unlocked below Premium, the expensive rung would be the CHEAPER
   * one to reach — the threshold ladder exists to keep the pricier model further from a fresh grant.
   */
  it('keeps the in-code thresholds non-decreasing up the ladder', () => {
    expect(DEFAULT_SUPERMAX_MINIMUM_CREDITS).toBeGreaterThanOrEqual(DEFAULT_PREMIUM_MINIMUM_CREDITS);

    const minimums = PAID_MODEL_TIERS.map((tier) => tier.defaultMinimumCredits);
    expect(minimums).toEqual([...minimums].sort((a, b) => a - b));
  });

  /*
   * 🔴 No rung is locked on the first build turn any more (owner, 2026-08-03): a rung you can afford is
   * a rung you get, on every turn. Asserted rather than deleted — the flag and its branch in
   * `decideModelTier` deliberately survive so a single rung can be re-locked in one line if a provider
   * misbehaves again, and the failure mode of one silently flipping back to `true` is a user paying for
   * a model they do not receive on the most expensive turn in the product.
   */
  it('locks no paid rung on the first build turn', () => {
    for (const definition of PAID_MODEL_TIERS) {
      expect(definition.firstBuildLocked, `${definition.id}`).toBe(false);
    }
  });
});

/**
 * THE LADDER IS COHERENT — three DIFFERENT models, each priced AND listed (SPEC §4.6.1a, §4.2a).
 *
 * The three rungs are decided in two files that know nothing about each other: Standard is
 * `DEFAULT_MODEL` in `~/utils/constants` (a client constant, moved 2026-07-31 to Sonnet 5) and the two
 * paid rungs are the defaults in `model-tiers.ts`. Nothing at either end can see the other end, so every
 * property here is one an ordinary, well-intentioned edit breaks in silence:
 *
 *  - **Two rungs naming the SAME model is a paid rung that sells nothing.** A user over the threshold
 *    deliberately buys their way up, the picker shows an unlocked tier, settlement charges that tier's
 *    rates — and the request runs the model they were already on. It throws nothing and the token counts
 *    look ordinary. This is exactly the state the tree was in until T2 moved Standard off Opus 5.
 *  - **A rung the baked list cannot PRICE is dead on arrival.** `ratesFor` falls back to the most
 *    expensive row we know of, so it does not fail, it over-charges forever (`getModelTier` refuses first
 *    for the paid rungs — but `validateMarketPriceList` is what refuses a promotion that drops the
 *    Standard row, and the baked list is the fallback that must always pass its own validator).
 *  - **A rung the provider does not LIST is billed as itself and RUN as something else.** `stream-text.ts`
 *    (upstream, the enhancer path) looks a model up in the provider's list and falls back to
 *    `modelsList[0]` on a miss. `kieEnvModel` synthesises a `ModelInfo` for an operator's `LLM_MODEL`
 *    override, so priced-but-unlisted is survivable for an override and NOT for a bare default: with no
 *    env var there is nothing to synthesise. Wrong model, wrong price, no error.
 *  - **The prices must climb.** A rung that costs the user more must cost US more, or the ladder sells a
 *    downgrade at a premium.
 */
describe('the three-rung ladder is coherent (Standard · Premium · SuperMax defaults)', () => {
  /** The rungs' in-code default models, cheapest first — a bare deploy with no environment at all. */
  const ladder = [
    { rung: 'standard', model: DEFAULT_MODEL },
    { rung: 'premium', model: DEFAULT_PREMIUM_MODEL },
    { rung: 'supermax', model: DEFAULT_SUPERMAX_MODEL },
  ] as const;

  /*
   * The literal pin. `DEFAULT_MODEL` is the rung every generation runs on unless a user has bought their
   * way up, so moving it re-prices the whole product — it must be a deliberate edit with this test in
   * front of it, not a drive-by. Sonnet 5 was measured at 2.73x cheaper than Opus 5 over 62 real
   * generations; the KIE 500-rate history that makes `LLM_MODEL=claude-opus-5` the standing revert lives
   * on the constant's own doc block.
   */
  it('runs Standard on claude-sonnet-5', () => {
    expect(DEFAULT_MODEL).toBe('claude-sonnet-5');
  });

  /*
   * 🔴 PAIRWISE DISTINCT. Stated over the whole ladder rather than as "Standard is not Premium" because
   * the incoherent state is any collision, and the next rung added must answer this too.
   */
  it('names a DIFFERENT model on every rung — a paid tier must never resolve to the one below it', () => {
    const models = ladder.map((entry) => entry.model);
    expect(new Set(models).size, `collision in ${JSON.stringify(models)}`).toBe(models.length);
  });

  it.each(ladder)('prices the $rung rung ($model) in the baked list', ({ model }) => {
    expect(BAKED_MARKET_PRICES.llm[model]).toBeDefined();
  });

  /* The fallback list must never be refused by the validator every promotion passes through. */
  it('leaves the baked list valid — it prices all three rungs AND passes its own validator', () => {
    const result = validateMarketPriceList(BAKED_MARKET_PRICES);
    expect(result.ok, result.ok ? '' : result.errors.join('; ')).toBe(true);
  });

  /*
   * 🔴 PRICED IS NOT ENOUGH — the rung must be LISTED. See the module doc above: an unlisted default
   * silently runs `modelsList[0]` on the enhancer path while settlement charges the configured rates.
   */
  it.each(ladder)('lists the $rung rung ($model) in KIE_MODELS, not merely prices it', ({ model }) => {
    expect(KIE_MODELS.map((entry) => entry.name)).toContain(model);
  });

  /* Monotonic PRICE, the sibling of the monotonic-threshold pin above: paying more must buy more. */
  it('keeps the baked prices non-decreasing up the ladder', () => {
    const rows = ladder.map(({ model }) => BAKED_MARKET_PRICES.llm[model]);

    expect(rows.map((row) => row.inputPerMTok)).toEqual([...rows.map((row) => row.inputPerMTok)].sort((a, b) => a - b));
    expect(rows.map((row) => row.outputPerMTok)).toEqual(
      [...rows.map((row) => row.outputPerMTok)].sort((a, b) => a - b),
    );
  });
});

/**
 * `getModelTier` — a rung meeting the environment and the ACTIVE price list.
 *
 * The prices asserted here are the ones we ACTUALLY PAY, and credits are cost-proportional: a wrong rate
 * mis-bills every generation on that rung silently, in whichever direction the error happens to point.
 */
describe('getModelTier — resolving a paid rung with no environment at all', () => {
  it('defaults Premium to Opus 5 at the baked list price with a 1200-credit minimum', () => {
    stubTierEnv();

    const tier = getModelTier('premium', {});
    const baked = BAKED_MARKET_PRICES.llm['claude-opus-5'];

    expect(tier.id).toBe('premium');
    expect(tier.label).toBe('Premium');
    expect(tier.model).toBe(DEFAULT_PREMIUM_MODEL);
    expect(tier.model).toBe('claude-opus-5');
    expect(tier.minimumCredits).toBe(DEFAULT_PREMIUM_MINIMUM_CREDITS);
    expect(tier.minimumCredits).toBe(1200);
    expect(tier.firstBuildLocked).toBe(false);

    expect(tier.rates.inputPerMTok).toBe(baked.inputPerMTok);
    expect(tier.rates.inputPerMTok).toBe(2);
    expect(tier.rates.outputPerMTok).toBe(baked.outputPerMTok);
    expect(tier.rates.outputPerMTok).toBe(10);

    // Cache is DERIVED from the final input rate: 0.1x read, 2x write (the 1-hour tier, §4.2.8).
    expect(tier.rates.cacheReadPerMTok).toBeCloseTo(baked.inputPerMTok * 0.1, 9);
    expect(tier.rates.cacheWritePerMTok).toBeCloseTo(baked.inputPerMTok * 2, 9);
  });

  it('defaults SuperMax to Fable 5 at $4/$20 with a 1500-credit minimum', () => {
    stubTierEnv();

    const tier = getModelTier('supermax', {});
    const baked = BAKED_MARKET_PRICES.llm['claude-fable-5'];

    expect(tier.id).toBe('supermax');
    expect(tier.label).toBe('SuperMax');
    expect(tier.model).toBe(DEFAULT_SUPERMAX_MODEL);
    expect(tier.model).toBe('claude-fable-5');
    expect(tier.minimumCredits).toBe(DEFAULT_SUPERMAX_MINIMUM_CREDITS);
    expect(tier.minimumCredits).toBe(1500);
    expect(tier.firstBuildLocked).toBe(false);

    expect(tier.rates.inputPerMTok).toBe(baked.inputPerMTok);
    expect(tier.rates.inputPerMTok).toBe(4);
    expect(tier.rates.outputPerMTok).toBe(baked.outputPerMTok);
    expect(tier.rates.outputPerMTok).toBe(20);
    expect(tier.rates.cacheReadPerMTok).toBeCloseTo(0.4, 9);
    expect(tier.rates.cacheWritePerMTok).toBeCloseTo(8, 9);
  });

  /* One implementation, so the premium door and the ladder cannot drift into two answers. */
  it("getPremiumTier is the ladder's premium rung, not a second code path", () => {
    stubTierEnv();
    expect(getPremiumTier({})).toEqual(getModelTier('premium', {}));
  });
});

describe('getModelTier — the environment as SELECTOR, never as price', () => {
  /*
   * The selector may name any model the ACTIVE list prices, and its price comes from the LIST. Trimming
   * matters because a trailing space in an SSM value would otherwise produce a model id nothing prices,
   * turning a cosmetic typo into a refused rung (or, before the refusal existed, a mis-billed one).
   */
  it('honours SUPERMAX_MODEL and trims it, pricing it from the active list', () => {
    stubTierEnv({ SUPERMAX_MODEL: '  claude-sonnet-5  ', SUPERMAX_MINIMUM_CREDITS: '3000' });

    const tier = getModelTier('supermax', {});
    const baked = BAKED_MARKET_PRICES.llm['claude-sonnet-5'];

    expect(tier.model).toBe('claude-sonnet-5');
    expect(tier.minimumCredits).toBe(3000);
    expect(tier.rates.inputPerMTok).toBe(baked.inputPerMTok);
    expect(tier.rates.outputPerMTok).toBe(baked.outputPerMTok);
  });

  /*
   * The threshold is `envNumber`, not a price: it counts CREDITS, so a fallback is correct where a
   * fallback for dollars-per-token would be catastrophic. An unparseable value must land on the default
   * rather than on `NaN`, which compares false against every balance and would lock the rung for everyone.
   */
  it('falls back to the default minimum on an unparseable SUPERMAX_MINIMUM_CREDITS', () => {
    stubTierEnv({ SUPERMAX_MINIMUM_CREDITS: 'heaps' });
    expect(getModelTier('supermax', {}).minimumCredits).toBe(DEFAULT_SUPERMAX_MINIMUM_CREDITS);
    expect(getModelTier('supermax', {}).minimumCredits).toBe(1500);
  });

  /* The admin-promoted list is the authority — this is the path an operator actually reprices through. */
  it('prices a rung from a PROMOTED list when one is live', async () => {
    stubTierEnv();

    const result = await promoteMarketPrices(memoryStore(), {
      ...BAKED_MARKET_PRICES,
      llm: { ...BAKED_MARKET_PRICES.llm, 'claude-fable-5': { inputPerMTok: 7, outputPerMTok: 35 } },
    });
    expect(result.ok).toBe(true);

    const tier = getModelTier('supermax', {});
    expect(tier.rates.inputPerMTok).toBe(7);
    expect(tier.rates.outputPerMTok).toBe(35);
    expect(tier.rates.cacheWritePerMTok, 'cache re-derives from the promoted base').toBeCloseTo(14, 9);
  });
});

/**
 * The REFUSAL — a selector the active list cannot price.
 *
 * `ratesFor` falls back to the most expensive row we know of for an unknown model, so an unpriced rung
 * does not bill as free and does not throw at settlement: it silently bills at somebody else's price on
 * the tier users deliberately pay MORE for. "Is this rung configured?" and "do we know what it costs?"
 * must stay the same question, and the answer lives in the Admin panel.
 */
describe('getModelTier — an unpriceable selector is refused, never guessed', () => {
  it('throws NotConfiguredError naming the var and the model', () => {
    stubTierEnv({ SUPERMAX_MODEL: 'some-unpriced-model' });

    expect(() => getModelTier('supermax', {})).toThrow(/Marketplace price list/);
    expect(() => getModelTier('supermax', {})).toThrow(/SUPERMAX_MODEL="some-unpriced-model"/);

    let thrown: unknown;

    try {
      getModelTier('supermax', {});
    } catch (error) {
      thrown = error;
    }

    expect((thrown as Error).name).toBe('NotConfiguredError');
  });

  /*
   * 🔴 A REGRESSION GUARD WITH HISTORY. The sibling refusal in `agent/config.ts` (`getPremiumModel`) used
   * to tell operators to set `PREMIUM_INPUT_DOLLARS` / `PREMIUM_OUTPUT_DOLLARS` — vars that have been
   * RETIRED and are now themselves refused. An operator following that advice makes the error worse and
   * believes they have stated a price that nothing reads. The message must point at the panel that
   * replaced them and must not name them at all.
   */
  it('directs the operator to the Admin panel and never names the retired price vars', () => {
    stubTierEnv({ SUPERMAX_MODEL: 'some-unpriced-model' });

    let message = '';

    try {
      getModelTier('supermax', {});
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('Settings → Admin → Marketplace prices');
    expect(message).not.toContain('PREMIUM_INPUT_DOLLARS');
    expect(message).not.toContain('PREMIUM_OUTPUT_DOLLARS');

    // ...and it names the way out that costs nothing: unset the selector, take the priced default.
    expect(message).toContain(DEFAULT_SUPERMAX_MODEL);
  });
});

/**
 * `getModelTiers` — the whole ladder for a caller that MAY NOT THROW.
 *
 * Its readers are rendering surfaces (`/api/me`, the tier picker). `premiumSessionHint`'s 2026-07-25
 * outage is the precedent: an unguarded throw on the session endpoint took the whole app down for every
 * user because one env var named a model the price list had not been given a row for — the NORMAL
 * transient state while an operator moves to a new model. Degrading a rung to "off" is honest;
 * degrading it to "on" invents a capability that hard-fails the moment it is used.
 */
describe('getModelTiers — the whole ladder, never throwing', () => {
  it('returns exactly three rungs in ladder order, with a free, always-serveable Standard', () => {
    stubTierEnv();

    const tiers = getModelTiers('claude-sonnet-5', {});

    expect(tiers).toHaveLength(3);
    expect(tiers.map((tier) => tier.id)).toEqual(['standard', 'premium', 'supermax']);

    const [standard] = tiers;
    expect(standard.model, 'the platform model is passed IN — this file must not resolve it').toBe('claude-sonnet-5');
    expect(standard.label).toBe(STANDARD_TIER_LABEL);
    expect(standard.minimumCredits, 'the free rung has no threshold').toBe(0);
    expect(standard.firstBuildLocked, 'the first build turn must always have a model it can run').toBe(false);
    expect(standard.serveable).toBe(true);
    expect(standard.reason).toBeUndefined();

    for (const tier of tiers) {
      expect(tier.serveable, `${tier.id}`).toBe(true);
      expect(tier.reason, `${tier.id}`).toBeUndefined();
    }
  });

  it('reports the configured models and thresholds for the paid rungs', () => {
    stubTierEnv({ SUPERMAX_MODEL: 'claude-opus-4-8', SUPERMAX_MINIMUM_CREDITS: '4000' });

    const supermax = getModelTiers('claude-sonnet-5', {}).find((tier) => tier.id === 'supermax')!;

    expect(supermax.model).toBe('claude-opus-4-8');
    expect(supermax.minimumCredits).toBe(4000);
    expect(supermax.serveable).toBe(true);
  });

  /*
   * 🔴 THE DEGRADED RUNG. Three separate properties, each of which is its own silent failure:
   *   - it does not throw (the outage),
   *   - it reports `serveable: false` (an enabled control that hard-fails on use is worse than a
   *     disabled one),
   *   - and its model is the IN-CODE DEFAULT, not the selector we just refused to bill — naming the
   *     unpriceable model would put a model the platform will not run in front of the user.
   * The threshold survives regardless (`envNumber` cannot throw), so a locked rung can still say what it
   * would take to unlock.
   */
  it('degrades an unpriceable rung to serveable:false without throwing, keeping the default model and the threshold', () => {
    stubTierEnv({ SUPERMAX_MODEL: 'some-unpriced-model', SUPERMAX_MINIMUM_CREDITS: '2000' });

    const tiers = getModelTiers('claude-sonnet-5', {});
    expect(tiers).toHaveLength(3);

    const supermax = tiers.find((tier) => tier.id === 'supermax')!;
    expect(supermax.serveable).toBe(false);
    expect(supermax.reason).toMatch(/Marketplace price list/);
    expect(supermax.model, 'the in-code default, NOT the selector we refuse to bill').toBe(DEFAULT_SUPERMAX_MODEL);
    expect(supermax.model).not.toBe('some-unpriced-model');
    expect(supermax.minimumCredits, 'still readable — a locked rung can state its own price').toBe(2000);

    // The CONTROL: one broken rung must not take the healthy ones with it.
    expect(tiers.find((tier) => tier.id === 'premium')!.serveable).toBe(true);
    expect(tiers[0].serveable).toBe(true);
  });

  /*
   * A leftover RETIRED price var makes `getModelTier` refuse for a reason that has nothing to do with the
   * selector — and it refuses for EVERY rung at once. That is exactly the state an operator is in while
   * cleaning up an old deploy, and it must not blank the session endpoint that would tell them so.
   */
  it('survives a leftover retired price var — every paid rung degrades, nothing throws', () => {
    stubTierEnv({ PREMIUM_INPUT_DOLLARS: '4' });

    const tiers = getModelTiers('claude-sonnet-5', {});

    expect(tiers).toHaveLength(3);
    expect(tiers[0].serveable, 'the platform model is still serveable — it is not priced from these vars').toBe(true);

    for (const tier of tiers.slice(1)) {
      expect(tier.serveable, `${tier.id}`).toBe(false);
      expect(tier.reason, `${tier.id}`).toMatch(/retired/);
    }
  });
});

/**
 * 🔴 PRICED AND LISTED ARE ONE FACT (2026-07-31).
 *
 * Two tables describe every Claude model the platform can run on KIE, and they are edited in different
 * files for different reasons: `BAKED_MARKET_PRICES.llm` says what a model COSTS, `KIE_MODELS` says the
 * provider registry KNOWS it. Either one alone is a silent failure, and they are not symmetrical:
 *
 *  - **listed but unpriced** fails LOUDLY — `getPlatformModel` refuses the selector at config time, so
 *    the operator finds out before a single generation runs;
 *  - **priced but unlisted** fails SILENTLY, and is the worse one. The selector is ACCEPTED (the price
 *    row exists, which is all `getPlatformModel` validates), generations run, and `stream-text.ts`'s
 *    enhancer path — which looks the id up in the provider's model list — falls through to
 *    `modelsList[0]` instead. A different model runs than the one settlement charges for.
 *
 * This is not hypothetical: `claude-opus-4-6` and `claude-haiku-4-5` shipped priced-but-unlisted, and
 * `claude-sonnet-4-6` was the reverse case an operator hit for real (KIE serves it, we had no row, so
 * every generation was refused). Both directions are pinned here so the two tables cannot drift.
 */
describe('the price list and the provider model list agree', () => {
  const priced = Object.keys(BAKED_MARKET_PRICES.llm);
  const listed = KIE_MODELS.map((model) => model.name);

  it.each(priced)('%s is priced, so it must also be LISTED (else the enhancer runs modelsList[0])', (model) => {
    expect(listed).toContain(model);
  });

  it.each(listed)('%s is listed, so it must also be PRICED (else it is refused at config time)', (model) => {
    expect(priced).toContain(model);
  });

  /*
   * The CONTROL. Both assertions above are `toContain` over arrays built by reading the tables, so if a
   * table ever came back empty every `it.each` would simply not run and the suite would report a clean
   * bill of health forever — the scanner-that-matches-nothing failure this repo has hit before.
   */
  it('read both tables (control for the assertions above)', () => {
    expect(priced.length).toBeGreaterThanOrEqual(10);
    expect(listed.length).toBeGreaterThanOrEqual(10);
  });
});

/**
 * 🔴 `.env.example` SHIPS THE LADDER, AND A COPY OF IT MUST BOOT (§4.6.1a, T13).
 *
 * The file is copied verbatim to make a real `.env` (`scripts/setup-env.sh` is a `cp` and parses
 * nothing), so every defect here reaches an operator's deploy as-is, and all three shapes are silent:
 *
 *  - **A DUPLICATE assignment.** A later line wins in a real `.env`. `SIGNUP_GRANT_CREDITS` was once
 *    assigned twice with different values in this very file and handed out the wrong grant to everyone
 *    who copied it. **Commented duplicates count** — `# PREMIUM_MODEL=...` in a documentation block is
 *    one uncomment away from being the winning line, which is exactly what an operator reading that
 *    block does. The ladder's own prose block was written to re-assign NOTHING for this reason, and
 *    prose cannot fail; this can.
 *  - **An UNPRICED selector.** A rung's model and its price are one fact: `getModelTier` REFUSES a
 *    selector the active Marketplace list cannot price. A shipped example naming an unpriced model is a
 *    dead rung on a fresh deploy, and the operator's only clue is a runtime refusal pointing at the
 *    Admin panel rather than at the file they copied.
 *  - **A THRESHOLD at or below the signup grant.** The minimums exist to stop a brand-new account
 *    burning its free grant on the most expensive model out the gate. A rung that unlocks below the
 *    grant is not a weaker guard, it is no guard — and it looks completely normal.
 *  - **A RETIRED price var.** `*_DOLLARS` are refused at runtime with a `NotConfiguredError`; an example
 *    that assigns one boots straight into a hard failure.
 *
 * The counting is `env-example.ts`, shared with the `PROJECT_CREATE_CREDITS` pin in
 * `project-create.spec.ts` — one definition of "assigns this key", because two that disagree both report
 * "no duplicates" forever.
 */
describe('.env.example ships a working model tier ladder', () => {
  const example = readFileSync(path.join(process.cwd(), ENV_EXAMPLE_FILENAME), 'utf8');

  /**
   * Every key that decides which model runs and what it costs.
   *
   * ⚠️ `LLM_PROVIDER` is here even though it names no rung, and it earned its place: the file shipped a
   * commented `# LLM_PROVIDER=Anthropic` sitting two lines below a paragraph explaining why a commented
   * assignment is a footgun. Uncommenting it made the LATER line win over the real assignment at the top
   * — silently spending a different vendor's key at a different price, which the file's own coupling note
   * says drops grant headroom from 3.90x to 1.56x. A rule that only covers the keys someone remembered is
   * how the next one gets through.
   */
  const LADDER_KEYS = [
    'LLM_PROVIDER',
    'LLM_MODEL',
    'PREMIUM_MODEL',
    'PREMIUM_MINIMUM_CREDITS',
    'SUPERMAX_MODEL',
    'ENABLE_EXTENDED_MODELS',
    'SUPERMAX_MINIMUM_CREDITS',
  ] as const;

  /**
   * The CONTROL for every count assertion below. `envExampleAssignments` is a regex over lines: if it
   * silently stopped matching, "exactly one" would become "exactly zero" and the whole describe would go
   * green on a file that assigns nothing. Both halves are needed — that it finds a real key, and that it
   * genuinely counts a second occurrence rather than de-duplicating or short-circuiting.
   */
  describe('the duplicate counter works (control)', () => {
    it('finds a key that is genuinely present in the real file', () => {
      expect(envExampleAssignments(example, 'SIGNUP_GRANT_CREDITS').length).toBeGreaterThan(0);
      expect(envExampleAssignments(example, 'PREMIUM_MODEL').length).toBeGreaterThan(0);
    });

    it('reports 2 for a synthetic file with a deliberate duplicate — including a COMMENTED one', () => {
      const synthetic = ['PREMIUM_MODEL=claude-opus-5', '# some prose', '# PREMIUM_MODEL=claude-fable-5'].join('\n');

      expect(envExampleAssignments(synthetic, 'PREMIUM_MODEL')).toHaveLength(2);
    });

    /*
     * The other direction: a line that MENTIONS the key mid-sentence is not an assignment. Without this
     * the counter would flag the ladder's own explanatory prose and the pin would be unsatisfiable, which
     * is how a check gets loosened until it stops checking.
     */
    it('does not count a prose line that merely mentions the key', () => {
      const prose = '# A commented `# PREMIUM_MODEL=...` here would be a second assignment';

      expect(envExampleAssignments(prose, 'PREMIUM_MODEL')).toHaveLength(0);
    });
  });

  it.each(LADDER_KEYS)('assigns %s on exactly one line (commented duplicates count)', (key) => {
    const assignments = envExampleAssignments(example, key);
    expect(assignments, `assigned ${assignments.length}x: ${JSON.stringify(assignments)}`).toHaveLength(1);
  });

  /*
   * The literal shipping ladder. These are the values an operator gets by copying the file, so they are
   * pinned rather than derived: the in-code defaults deliberately DIFFER (Premium's fallback minimum is
   * 1200 while the file ships 1500, so both rungs unlock together), and a test that derived from the
   * constants would silently accept the file drifting to match a constant nobody meant to ship.
   */
  it('assigns the shipping three-rung ladder', () => {
    expect(envExampleValue(example, 'LLM_MODEL')).toBe('claude-sonnet-5');
    expect(envExampleValue(example, 'PREMIUM_MODEL')).toBe('claude-opus-5');
    expect(envExampleValue(example, 'SUPERMAX_MODEL')).toBe('claude-fable-5');
    expect(envExampleValue(example, 'PREMIUM_MINIMUM_CREDITS')).toBe('1500');
    expect(envExampleValue(example, 'SUPERMAX_MINIMUM_CREDITS')).toBe('1500');
  });

  /* Standard is the rung every generation runs on; the file and the constant must not disagree. */
  it('assigns the Standard rung the model the code actually defaults to', () => {
    expect(envExampleValue(example, 'LLM_MODEL')).toBe(DEFAULT_MODEL);
  });

  /*
   * 🔴 THE REAL MEANING OF "copying .env.example yields a working deploy". A selector is only ACCEPTED if
   * the active price list prices it, and a fresh deploy's active list is the BAKED one — nothing has been
   * promoted yet. So an example naming an unpriced model hands the operator a rung that refuses on first
   * use, with the refusal blaming the Admin panel.
   */
  it.each(['LLM_MODEL', 'PREMIUM_MODEL', 'SUPERMAX_MODEL'])('prices the model %s names, in the BAKED list', (key) => {
    const model = envExampleValue(example, key);

    expect(model, `${key} is not assigned exactly once`).toBeDefined();
    expect(BAKED_MARKET_PRICES.llm[model as string], `${key}=${model} has no baked price row`).toBeDefined();
  });

  /*
   * 🔴 THE THRESHOLDS PROTECT THE GRANT. The grant is read out of the same file rather than hardcoded:
   * the two numbers are only correct RELATIVE to each other, so deriving one from the other is the only
   * way the pair cannot drift apart unnoticed (the `storage/limits.ts` lesson).
   */
  it.each(['PREMIUM_MINIMUM_CREDITS', 'SUPERMAX_MINIMUM_CREDITS'])(
    'keeps %s a finite positive number at or above the signup grant',
    (key) => {
      const grantRaw = envExampleValue(example, 'SIGNUP_GRANT_CREDITS');
      const grant = Number(grantRaw);

      // Control: the grant really was read. A NaN here would make every comparison below vacuous.
      expect(Number.isFinite(grant) && grant > 0, `SIGNUP_GRANT_CREDITS read as ${grantRaw}`).toBe(true);

      const minimum = Number(envExampleValue(example, key));

      expect(Number.isFinite(minimum)).toBe(true);
      expect(minimum).toBeGreaterThan(0);
      expect(
        minimum,
        `${key}=${minimum} <= grant ${grant}: a fresh account unlocks this rung for free`,
      ).toBeGreaterThan(grant);
    },
  );

  /* Monotonic in the FILE too, not just in the code defaults — a copied ladder must still be a ladder. */
  it('does not let the SuperMax rung unlock below the Premium rung', () => {
    expect(Number(envExampleValue(example, 'SUPERMAX_MINIMUM_CREDITS'))).toBeGreaterThanOrEqual(
      Number(envExampleValue(example, 'PREMIUM_MINIMUM_CREDITS')),
    );
  });

  /*
   * The RETIRED price vars. `getModelTier`/`getPlatformModel` throw a `NotConfiguredError` naming the
   * Admin panel the moment any of these is set, so a shipped assignment is a deploy that cannot bill.
   * Prose mentions are fine and deliberate (the file explains the retirement); an ASSIGNMENT is not.
   */
  it('assigns no retired *_DOLLARS price variable anywhere', () => {
    const assigned = example.split('\n').filter((line) => /^\s*#*\s*[A-Z0-9_]*_DOLLARS\s*=/.test(line));
    expect(assigned, `retired price vars assigned: ${JSON.stringify(assigned)}`).toEqual([]);
  });

  /*
   * The type declaration is the other half of "the variable exists": `worker-configuration.d.ts` is what
   * makes `env(context, 'SUPERMAX_MODEL')` typecheck, so a var shipped in the example and missing here is
   * a compile error waiting for whoever wires the next reader.
   */
  it('declares both SuperMax variables in worker-configuration.d.ts, beside the Premium pair', () => {
    const declarations = readFileSync(path.join(process.cwd(), 'worker-configuration.d.ts'), 'utf8');

    for (const key of ['PREMIUM_MODEL', 'PREMIUM_MINIMUM_CREDITS', 'SUPERMAX_MODEL', 'SUPERMAX_MINIMUM_CREDITS']) {
      expect(declarations, `${key} is not declared`).toMatch(new RegExp(`^\\s*${key}\\s*:`, 'm'));
    }
  });
});
