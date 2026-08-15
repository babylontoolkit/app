/**
 * The MODEL TIER LADDER (SPEC §4.6.1a) — money-path tests for `model-tiers.ts` + its resolver in `rates.ts`.
 *
 * The ladder replaced a boolean premium toggle with a LIST of rungs — three for a week (Standard ·
 * Premium · SuperMax), two since 2026-08-08 (Standard · Premium). Every property pinned here fails
 * SILENTLY if it regresses, and each one is money:
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
 * `.env.local` sets `PREMIUM_MODEL` and `PREMIUM_MINIMUM_CREDITS` today — a case that forgets this
 * passes in CI and fails only on the machine of whoever configured the feature.
 *
 * The RETIRED vars are in the list for the same reason, and there are now two families of them:
 * `getModelTier` refuses when any retired PRICE var (`*_DOLLARS`) or any retired LADDER var
 * (`ENABLE_EXTENDED_MODELS`, `SUPERMAX_*`) is set, so one left over in a developer's env — and an
 * upgrading deploy is EXACTLY where they linger — would fail every default case here for an unrelated
 * reason. Retiring a variable makes it MORE important to scrub, not less.
 */
function stubTierEnv(vars: Partial<Record<string, string>> = {}) {
  for (const key of [
    'PREMIUM_MODEL',
    'PREMIUM_MINIMUM_CREDITS',

    /*
     * ⚠️ `ENABLE_EXTENDED_MODELS` was MISSING from this list until 2026-08-10, and the PLATINUM trio is
     * added with it. Every assertion here about ladder LENGTH reads that flag through
     * `getModelTiers`, so a developer running `ENABLE_EXTENDED_MODELS=false` would have seen this file
     * fail with CI green — the `oauth.spec.ts` trap, in a scrub list that already named its siblings.
     */
    'ENABLE_EXTENDED_MODELS',
    'PLATINUM_MODEL',
    'PLATINUM_MINIMUM_CREDITS',
    'ENABLE_PLATINUM_MODEL',

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
  it('is Standard · Premium, and the paid table is that list minus the free rung, in order', () => {
    expect([...MODEL_TIER_IDS]).toEqual(['standard', 'premium']);
    expect(PAID_MODEL_TIERS.map((tier) => tier.id)).toEqual(['premium']);
    expect(STANDARD_TIER_LABEL).toBe('Standard');
  });

  /*
   * 🔴 `supermax` IS RETIRED AND MUST NOT COME BACK BY ACCIDENT (2026-08-08).
   *
   * A stale browser bundle, a `localStorage` value written before the change, or an in-flight request
   * can still say `'supermax'`, and the ladder's standing rule handles it correctly: an unrecognised
   * tier id resolves DOWN to Standard, never up. That resolution only stays correct while the id is
   * genuinely absent from the table — re-adding the string without re-adding a priced, listed rung
   * would make it *recognised* and unresolvable, which is the one direction that costs money.
   */
  it('no longer knows the retired supermax rung', () => {
    expect([...MODEL_TIER_IDS] as string[]).not.toContain('supermax');
    expect(PAID_MODEL_TIERS.map((tier) => tier.id) as string[]).not.toContain('supermax');
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
   * MONOTONIC THRESHOLDS. If a dearer rung unlocked below a cheaper one, the expensive model would be
   * the CHEAPER one to reach — the threshold ladder exists to keep the pricier model further from a
   * fresh grant.
   *
   * ⚠️ With ONE paid rung this is trivially satisfied and cannot fail. It is kept, stated over the
   * table rather than over two named constants, because the ladder is a list whose length has already
   * changed twice: written this way it starts guarding again the moment a rung is added, whereas the
   * `SUPERMAX >= PREMIUM` comparison it replaced had to be deleted with the rung and would have had to
   * be remembered and re-derived by hand.
   */
  it('keeps the in-code thresholds non-decreasing up the ladder', () => {
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
describe('the ladder is coherent (Standard · Premium defaults)', () => {
  /** The rungs' in-code default models, cheapest first — a bare deploy with no environment at all. */
  const ladder = [
    { rung: 'standard', model: DEFAULT_MODEL },
    { rung: 'premium', model: DEFAULT_PREMIUM_MODEL },
  ] as const;

  /*
   * The literal pin. `DEFAULT_MODEL` is the rung every generation runs on unless a user has bought their
   * way up, so moving it re-prices the whole product — it must be a deliberate edit with this test in
   * front of it, not a drive-by. Sonnet 5 was measured at 2.73x cheaper than Opus 5 over 62 real
   * generations; the KIE 500-rate history that makes `LLM_MODEL=claude-opus-5` the standing revert lives
   * on the constant's own doc block.
   */
  it('runs Standard on claude-opus-5', () => {
    /*
     * 🔴 Opus since 2026-08-14 (owner): Sonnet could not reliably finish a game build. Sonnet remains
     * priced and supported — it is the enhancer model — it is simply not what Standard runs.
     */
    expect(DEFAULT_MODEL).toBe('claude-opus-5');
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
  it('leaves the baked list valid — it prices every rung AND passes its own validator', () => {
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
  it('defaults Premium to Fable 5 at the baked list price with a 1500-credit minimum', () => {
    stubTierEnv();

    const tier = getModelTier('premium', {});
    const baked = BAKED_MARKET_PRICES.llm['claude-fable-5'];

    expect(tier.id).toBe('premium');
    expect(tier.label).toBe('Premium');
    expect(tier.model).toBe(DEFAULT_PREMIUM_MODEL);

    /* Premium inherited the retired Platinum rung's model on 2026-08-14 — see model-tiers.ts. */
    expect(tier.model).toBe('claude-fable-5');
    expect(tier.minimumCredits).toBe(DEFAULT_PREMIUM_MINIMUM_CREDITS);
    expect(tier.minimumCredits).toBe(1500);
    expect(tier.firstBuildLocked).toBe(false);

    expect(tier.rates.inputPerMTok).toBe(baked.inputPerMTok);
    expect(tier.rates.inputPerMTok).toBe(4);
    expect(tier.rates.outputPerMTok).toBe(baked.outputPerMTok);
    expect(tier.rates.outputPerMTok).toBe(20);

    // Cache is DERIVED from the final input rate: 0.1x read, 2x write (the 1-hour tier, §4.2.8).
    expect(tier.rates.cacheReadPerMTok).toBeCloseTo(baked.inputPerMTok * 0.1, 9);
    expect(tier.rates.cacheWritePerMTok).toBeCloseTo(baked.inputPerMTok * 2, 9);
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
  it('honours PREMIUM_MODEL and trims it, pricing it from the active list', () => {
    stubTierEnv({ PREMIUM_MODEL: '  claude-sonnet-5  ', PREMIUM_MINIMUM_CREDITS: '3000' });

    const tier = getModelTier('premium', {});
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
  it('falls back to the default minimum on an unparseable PREMIUM_MINIMUM_CREDITS', () => {
    stubTierEnv({ PREMIUM_MINIMUM_CREDITS: 'heaps' });
    expect(getModelTier('premium', {}).minimumCredits).toBe(DEFAULT_PREMIUM_MINIMUM_CREDITS);
    expect(getModelTier('premium', {}).minimumCredits).toBe(1500);
  });

  /*
   * The admin-promoted list is the authority — this is the path an operator actually reprices through.
   *
   * ⚠️ Onto **KIE's** list explicitly, because that is the list `getModelTier` prices the §4.6.1a paid
   * rungs from on every provider (`rates.ts`, unchanged by the 2026-08-10 per-provider split). Promote
   * onto Comet's list instead and the assertions below would read the untouched baked KIE row — a
   * green-looking test grading a promotion nothing consulted.
   */
  it('prices a rung from a PROMOTED list when one is live', async () => {
    stubTierEnv();

    const result = await promoteMarketPrices(memoryStore(), 'KIE', {
      ...BAKED_MARKET_PRICES,
      llm: { ...BAKED_MARKET_PRICES.llm, 'claude-fable-5': { inputPerMTok: 7, outputPerMTok: 35 } },
    });
    expect(result.ok).toBe(true);

    const tier = getModelTier('premium', {});
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
    stubTierEnv({ PREMIUM_MODEL: 'some-unpriced-model' });

    expect(() => getModelTier('premium', {})).toThrow(/Marketplace price list/);
    expect(() => getModelTier('premium', {})).toThrow(/PREMIUM_MODEL="some-unpriced-model"/);

    let thrown: unknown;

    try {
      getModelTier('premium', {});
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
    stubTierEnv({ PREMIUM_MODEL: 'some-unpriced-model' });

    let message = '';

    try {
      getModelTier('premium', {});
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('Settings → Admin → Marketplace prices');
    expect(message).not.toContain('PREMIUM_INPUT_DOLLARS');
    expect(message).not.toContain('PREMIUM_OUTPUT_DOLLARS');

    // ...and it names the way out that costs nothing: unset the selector, take the priced default.
    expect(message).toContain(DEFAULT_PREMIUM_MODEL);
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
  it('returns exactly the declared rungs in ladder order, with a free, always-serveable Standard', () => {
    stubTierEnv();

    const tiers = getModelTiers('claude-sonnet-5', {});

    expect(tiers).toHaveLength(1 + PAID_MODEL_TIERS.length);
    expect(tiers.map((tier) => tier.id)).toEqual([...MODEL_TIER_IDS]);
    expect(tiers.map((tier) => tier.id)).toEqual(['standard', 'premium']);

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
    stubTierEnv({ PREMIUM_MODEL: 'claude-opus-4-8', PREMIUM_MINIMUM_CREDITS: '4000' });

    const premium = getModelTiers('claude-sonnet-5', {}).find((tier) => tier.id === 'premium')!;

    expect(premium.model).toBe('claude-opus-4-8');
    expect(premium.minimumCredits).toBe(4000);
    expect(premium.serveable).toBe(true);
  });

  /*
   * 🔴 RESTORED 2026-08-10 — one of the two properties `premium.spec.ts` recorded as LOST when the
   * ladder was cut to a single paid rung, and unwritable until PLATINUM brought a sibling back.
   *
   * A rung is misconfigured PER RUNG: its selector names a model the active price list cannot price.
   * The failure must stay contained, because the alternative is the worst kind of outage — an operator
   * mistypes one model id and the whole paid ladder disappears from the picker, with the healthy rung
   * they never touched vanishing alongside the one they broke. `getModelTiers` catches per rung for
   * exactly this reason; without a second paid rung, "contained" and "the only rung" are the same
   * observation and nothing was actually being asserted.
   */
  /**
   * 🔴 **DELETED 2026-08-14 — the containment property needs two paid rungs and PLATINUM is retired.**
   *
   * It asserted that a rung whose selector cannot be priced locks ALONE, leaving a healthy sibling
   * serveable. With one paid rung, "contained" and "the only rung" are the same observation, so the
   * test can no longer tell a per-rung catch apart from a whole-ladder one. `getModelTiers` still
   * catches per rung — the behaviour is unchanged — but nothing proves it any more.
   *
   * ⚠️ Re-pointed at premium it would still go green while asserting nothing, which is the shape this
   * file has twice refused to ship. Restoring a second paid rung is the trigger to write it again.
   */

  /**
   * 🔴 **DELETED 2026-08-14 — `ENABLE_PLATINUM_MODEL` is retired and now REFUSED if set.**
   *
   * It asserted the per-rung WITHDRAWAL (absent) against a broken selector's LOCK (present,
   * `serveable: false`) — locked means "an operator must fix something", withdrawn means "this deploy
   * has decided". With one paid rung the per-rung flag and the master switch are the same key, so
   * there is nothing left to withdraw independently.
   *
   * ⚠️ The distinction itself is NOT gone from the code, only from the test. `getModelTiers` still
   * documents it and `ENABLE_EXTENDED_MODELS=false` still withdraws rather than locks — asserted by
   * the master-switch case directly below, which is now the only proof of the withdrawal shape.
   */
  /*
   * ⚠️ The one-directional rule: the MASTER switch still wins. A deploy that had already turned paid
   * models off must not start serving Platinum because a new per-rung flag defaults ON — that would be
   * an upgrade silently widening what is billed, which is the `ENABLE_EXTENDED_MODELS` bug's shape.
   */
  it('ENABLE_EXTENDED_MODELS=false withdraws EVERY paid rung, whatever the per-rung flags say', () => {
    stubTierEnv({ ENABLE_EXTENDED_MODELS: 'false', ENABLE_PLATINUM_MODEL: 'true' });

    expect(getModelTiers('claude-sonnet-5', {}).map((tier) => tier.id)).toEqual(['standard']);
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
    stubTierEnv({ PREMIUM_MODEL: 'some-unpriced-model', PREMIUM_MINIMUM_CREDITS: '2000' });

    const tiers = getModelTiers('claude-sonnet-5', {});
    expect(tiers).toHaveLength(1 + PAID_MODEL_TIERS.length);

    const premium = tiers.find((tier) => tier.id === 'premium')!;
    expect(premium.serveable).toBe(false);
    expect(premium.reason).toMatch(/Marketplace price list/);
    expect(premium.model, 'the in-code default, NOT the selector we refuse to bill').toBe(DEFAULT_PREMIUM_MODEL);
    expect(premium.model).not.toBe('some-unpriced-model');
    expect(premium.minimumCredits, 'still readable — a locked rung can state its own price').toBe(2000);

    // The CONTROL: a broken paid rung must not take the free one with it.
    expect(tiers[0].serveable).toBe(true);
    expect(tiers[0].reason).toBeUndefined();
  });

  /*
   * A leftover RETIRED price var makes `getModelTier` refuse for a reason that has nothing to do with the
   * selector — and it refuses for EVERY rung at once. That is exactly the state an operator is in while
   * cleaning up an old deploy, and it must not blank the session endpoint that would tell them so.
   */
  it('survives a leftover retired price var — every paid rung degrades, nothing throws', () => {
    stubTierEnv({ PREMIUM_INPUT_DOLLARS: '4' });

    const tiers = getModelTiers('claude-sonnet-5', {});

    expect(tiers).toHaveLength(1 + PAID_MODEL_TIERS.length);
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
    'ENABLE_EXTENDED_MODELS',
    'PREMIUM_MODEL',
    'PREMIUM_MINIMUM_CREDITS',
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
   * pinned rather than derived. ⚠️ The in-code default and the shipped value AGREE on every key today
   * (they diverged until 2026-08-14, when Premium's fallback minimum moved 1200 -> 1500 with the
   * rung's model) — which makes this pin weaker than it was, not stronger: a test that derived from
   * the constants would now be a tautology, so keep these literal. They are what an operator gets by
   * copying the file, and that is a different fact from what the code falls back to.
   */
  it('assigns the shipping ladder', () => {
    expect(envExampleValue(example, 'LLM_MODEL')).toBe('claude-opus-5');
    expect(envExampleValue(example, 'ENABLE_EXTENDED_MODELS')).toBe('true');
    expect(envExampleValue(example, 'PREMIUM_MODEL')).toBe('claude-fable-5');
    expect(envExampleValue(example, 'PREMIUM_MINIMUM_CREDITS')).toBe('1500');
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
  it.each(['LLM_MODEL', 'PREMIUM_MODEL'])('prices the model %s names, in the BAKED list', (key) => {
    const model = envExampleValue(example, key);

    expect(model, `${key} is not assigned exactly once`).toBeDefined();
    expect(BAKED_MARKET_PRICES.llm[model as string], `${key}=${model} has no baked price row`).toBeDefined();
  });

  /*
   * 🔴 THE THRESHOLDS PROTECT THE GRANT. The grant is read out of the same file rather than hardcoded:
   * the two numbers are only correct RELATIVE to each other, so deriving one from the other is the only
   * way the pair cannot drift apart unnoticed (the `storage/limits.ts` lesson).
   */
  it.each(['PREMIUM_MINIMUM_CREDITS'])('keeps %s a finite positive number at or above the signup grant', (key) => {
    const grantRaw = envExampleValue(example, 'SIGNUP_GRANT_CREDITS');
    const grant = Number(grantRaw);

    // Control: the grant really was read. A NaN here would make every comparison below vacuous.
    expect(Number.isFinite(grant) && grant > 0, `SIGNUP_GRANT_CREDITS read as ${grantRaw}`).toBe(true);

    const minimum = Number(envExampleValue(example, key));

    expect(Number.isFinite(minimum)).toBe(true);
    expect(minimum).toBeGreaterThan(0);
    expect(minimum, `${key}=${minimum} <= grant ${grant}: a fresh account unlocks this rung for free`).toBeGreaterThan(
      grant,
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
   * makes `env(context, 'PREMIUM_MODEL')` typecheck, so a var shipped in the example and missing here is
   * a compile error waiting for whoever wires the next reader.
   */
  it('declares every ladder variable in worker-configuration.d.ts', () => {
    const declarations = readFileSync(path.join(process.cwd(), 'worker-configuration.d.ts'), 'utf8');

    for (const key of [
      'ENABLE_EXTENDED_MODELS',
      'ENABLE_PLATINUM_MODEL',
      'PREMIUM_MODEL',
      'PREMIUM_MINIMUM_CREDITS',
      'PLATINUM_MODEL',
      'PLATINUM_MINIMUM_CREDITS',
    ]) {
      expect(declarations, `${key} is not declared`).toMatch(new RegExp(`^\\s*${key}\\s*:`, 'm'));
    }
  });

  /*
   * 🔴 THE RETIRED LADDER VARS MUST NOT BE *ASSIGNED* ANYWHERE IN THE FILE (2026-08-08).
   *
   * `.env.example` is copied verbatim to make a real `.env`, and `refuseRetiredModelTierEnv` throws on
   * any of these — so an example that assigns one hands the operator a deploy whose Premium rung is
   * permanently locked with a message about a variable they never chose to set. The retirement note in
   * the ladder block MENTIONS all three by name on purpose (that is how an upgrading operator learns
   * what to delete); mentioning is fine, assigning is not, and `envExampleAssignments` is precisely the
   * function that already knows the difference.
   *
   * ⚠️ The `_DOLLARS` sibling above scans by SHAPE (a regex over the line); this scans by NAME, because
   * these three share no shape with each other. A shape-based scan is what would have to be invented if
   * a fourth retired key arrived, and inventing it is how the two halves drift — keep them separate and
   * keep both.
   */
  it.each(['ENABLE_PREMIUM_MODEL', 'SUPERMAX_MODEL', 'SUPERMAX_MINIMUM_CREDITS'])(
    'never assigns the retired %s — mentioning it in the upgrade note is fine, assigning it is not',
    (key) => {
      expect(envExampleAssignments(example, key)).toEqual([]);
    },
  );

  /*
   * CONTROL for the three assertions above. They are all "expect empty", which is what a scanner that
   * has silently stopped matching also returns — the failure mode this repo has hit more than once. So
   * assert the file really does still talk about the retirement, and that the counter finds a synthetic
   * assignment of the very key it is meant to catch.
   */
  it('control — the counter still catches a retired key when one IS assigned', () => {
    expect(example).toContain('ENABLE_EXTENDED_MODELS');
    expect(envExampleAssignments('# ENABLE_EXTENDED_MODELS=true', 'ENABLE_EXTENDED_MODELS')).toHaveLength(1);
  });
});
