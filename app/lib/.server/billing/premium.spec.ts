/**
 * The PREMIUM model tier (SPEC §4.6.1) and the MODEL TIER LADDER decision (§4.6.1a) — money-path tests.
 *
 * Three things are pinned here, all of which fail SILENTLY:
 *  - `decideModelTier`, the pure eligibility rule for the three-rung ladder (Standard · Premium ·
 *    SuperMax). It spends a user's credits at a HIGHER rate without a second confirmation, so — like
 *    `auto-repair` and `restore-target` — a wrong answer bills without asking. Its two silent
 *    directions are not symmetrical: refusing a rung the user paid for is annoying, while GRANTING a
 *    rung they did not choose (or could not afford) is money out of their balance with nothing
 *    objecting, which is why the exhaustive cross-product below exists and why every refusal is
 *    asserted to land on `standard` BY NAME rather than merely "not the requested tier".
 *  - `decidePremium`, now re-expressed on top of `decideModelTier`. Its behaviour must be unchanged,
 *    so the pre-ladder cases stay exactly as they were and a bridging test pins the two in agreement.
 *  - `modelTiersSessionHint`, the `/api/me` rendering hint for the WHOLE ladder — the generalization of
 *    `premiumSessionHint`. It has the same two silent directions as its predecessor plus one the
 *    single-toggle version could not have: with three rungs there are three independent ways for an
 *    operator to reach the misconfigured state, and a hint that reports a broken rung as available
 *    renders an enabled picker row that hard-fails the moment it is used.
 *  - the premium price + threshold config: since 2026-07-18 the PRICE side lives in the marketplace
 *    price list (`market-price-store.ts`), so what is pinned is that the tier prices from the ACTIVE
 *    list, that a `PREMIUM_MODEL` the list does not price is REFUSED, and that the retired
 *    `PREMIUM_*_DOLLARS` vars stop the show rather than being silently ignored.
 *
 * ⚠️ `decideModelTier` is PURE and reads no environment, so every ladder case below passes its ladder in
 * explicitly. That is not stylistic: this repo's `env()` falls back to `process.env` and vitest loads
 * `.env.local`, so a case that resolved the ladder from config would silently test whichever thresholds
 * the developer happens to have configured (the `oauth.spec.ts` trap). `stubPremium` covers the whole
 * ladder for the CONFIG cases below, but a pure function reading its inputs from a scrub list rather
 * than from its own arguments is a test that does not say what it tests — keep passing them in.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decideModelTier,
  decidePremium,
  modelTiersSessionHint,
  premiumDeclinedNotice,
  premiumSessionHint,
  tierDeclinedNotice,
  type ModelTierDecision,
  type ModelTierDecisionReason,
  type ModelTierHint,
  type ModelTierOption,
  type ModelTiersSessionHint,
  type ModelTierStatusLike,
} from './premium';
import { MODEL_TIER_IDS, PAID_MODEL_TIERS, STANDARD_TIER_LABEL, type ModelTierId } from './model-tiers';
import {
  DEFAULT_PREMIUM_MINIMUM_CREDITS,
  DEFAULT_PREMIUM_MODEL,
  MODEL_RATES,
  getPremiumTier,
  providerRates,
  ratesFor,
} from './rates';
import { BAKED_MARKET_PRICES } from './baked-market-prices';
import { invalidateMarketPricesCache, promoteMarketPrices } from './market-price-store';
import type { ObjectStore } from '~/lib/.server/storage';
import { getPremiumModel } from '~/lib/.server/agent/config';

/**
 * Every LADDER var, so a case that means to test the DEFAULT is not reading `.env.local` (§oauth.spec).
 *
 * 🔴 THE `SUPERMAX_*` PAIR BELONGS HERE BECAUSE THE TWO RUNGS NOW SHARE ONE CODE PATH (§4.6.1a).
 *
 * The list was written when premium was the only paid tier, so its four vars were the whole precedence
 * chain. `getPremiumTier` is now `getModelTier('premium', …)` over a ladder that `providerRates` walks
 * as a unit — one broken selector on either rung changes the injected rate tables that the price
 * assertions below grade against. Leaving SuperMax unscrubbed is the same trap the file header warns
 * about, one rung to the right: it fails on the machine of whoever configured SuperMax, with CI green.
 *
 * When you add a variable to a precedence chain, add it to every scrub list that already names its
 * siblings.
 */
function stubPremium(vars: Partial<Record<string, string>> = {}) {
  for (const key of [
    'PREMIUM_MODEL',
    'PREMIUM_INPUT_DOLLARS',
    'PREMIUM_OUTPUT_DOLLARS',
    'PREMIUM_MINIMUM_CREDITS',
    'SUPERMAX_MODEL',
    'ENABLE_EXTENDED_MODELS',
    'SUPERMAX_MINIMUM_CREDITS',
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
 * The ladder as the decision needs to see it, passed in explicitly by every case (see the file header).
 *
 * The numbers mirror the shipping defaults — premium 1200, supermax 1500, both first-build-locked, both
 * serveable — because the properties under test are RELATIVE (a balance that clears one rung and not the
 * other is only expressible against two different thresholds), and because the free signup grant (1000)
 * sitting below both is the arrangement the thresholds exist to protect.
 */
const PREMIUM_MINIMUM = 1200;
const SUPERMAX_MINIMUM = 1500;

const LADDER: readonly ModelTierOption[] = [
  { id: 'premium', label: 'Premium', minimumCredits: PREMIUM_MINIMUM, firstBuildLocked: true, serveable: true },
  { id: 'supermax', label: 'SuperMax', minimumCredits: SUPERMAX_MINIMUM, firstBuildLocked: true, serveable: true },
];

/** `standard` is free and has no row — it is short-circuited before the ladder is ever consulted. */
const THRESHOLDS: Record<ModelTierId, number> = {
  standard: 0,
  premium: PREMIUM_MINIMUM,
  supermax: SUPERMAX_MINIMUM,
};

describe('decideModelTier — the ladder eligibility rule (§4.6.1a)', () => {
  /*
   * THE EXHAUSTIVE CROSS-PRODUCT: every rung × every threshold boundary × both turn kinds.
   *
   * Written as a real product rather than a handful of hand-picked cases on purpose. A ladder decision
   * has one interesting behaviour per (requested rung, balance relative to EVERY threshold) pair, and
   * the hand-picked version of this test reliably picks the pairs where the requested rung's own
   * threshold is the only one in play — which is exactly the set that cannot see the bug this rule was
   * written to prevent (a declined rung stepping DOWN onto the rung the balance does clear).
   *
   * The balance points are every threshold minus one, exactly on, and plus one — so the boundary
   * comparison is pinned in both directions on both rungs — plus a zero and an absurdly large balance.
   *
   * The expectation is spelled out as an independent branch rather than by calling the function again.
   */
  const BALANCES = [
    0,
    PREMIUM_MINIMUM - 1,
    PREMIUM_MINIMUM,
    PREMIUM_MINIMUM + 1,
    SUPERMAX_MINIMUM - 1,
    SUPERMAX_MINIMUM,
    SUPERMAX_MINIMUM + 1,
    10_000_000,
  ];

  function expectedDecision(requested: ModelTierId, balance: number, isFirstBuildTurn: boolean): ModelTierDecision {
    if (requested === 'standard') {
      return { tier: 'standard', reason: 'standard_requested' };
    }

    if (isFirstBuildTurn) {
      return { tier: 'standard', reason: 'creation_turn' };
    }

    return balance >= THRESHOLDS[requested]
      ? { tier: requested, reason: 'sufficient_credits' }
      : { tier: 'standard', reason: 'below_minimum' };
  }

  for (const requested of MODEL_TIER_IDS) {
    for (const balance of BALANCES) {
      for (const isFirstBuildTurn of [false, true]) {
        const turn = isFirstBuildTurn ? 'a first build turn' : 'an edit turn';

        it(`${requested} requested at ${balance} credits on ${turn}`, () => {
          expect(decideModelTier({ requested, balance, tiers: LADDER, isFirstBuildTurn })).toEqual(
            expectedDecision(requested, balance, isFirstBuildTurn),
          );
        });
      }
    }
  }

  /*
   * 🔴 THE RULE THE CROSS-PRODUCT EXISTS FOR, asserted on its own so a failure names itself.
   *
   * 1,499 credits clears Premium (1200) and misses SuperMax (1500) by one. "Step down to the best rung
   * they can afford" is the helpful-looking version of this decision and it is the expensive direction:
   * the user did not ask for Premium, and running it bills them more than the standard model they would
   * have accepted as the fallback. The tier is asserted BY NAME — `not.toBe('supermax')` would pass on
   * the very bug this pins.
   */
  it('declines SuperMax at 1,499 credits to STANDARD — never down one rung to Premium', () => {
    const decision = decideModelTier({ requested: 'supermax', balance: SUPERMAX_MINIMUM - 1, tiers: LADDER });

    expect(decision.tier).toBe('standard');
    expect(decision.tier).not.toBe('premium');
    expect(decision.reason).toBe('below_minimum');
  });

  /*
   * The same shape one rung down, so the rule is not accidentally satisfied by "supermax is the top".
   * A balance below every threshold has no rung to step down to, and a balance above every threshold is
   * the control proving the requested rung really can be granted from this same ladder.
   */
  it('declines Premium below its own threshold, and grants the rung actually requested above it', () => {
    expect(decideModelTier({ requested: 'premium', balance: PREMIUM_MINIMUM - 1, tiers: LADDER })).toEqual({
      tier: 'standard',
      reason: 'below_minimum',
    });

    expect(decideModelTier({ requested: 'premium', balance: SUPERMAX_MINIMUM, tiers: LADDER })).toEqual({
      tier: 'premium',
      reason: 'sufficient_credits',
    });
  });

  /*
   * A FIRST BUILD TURN never runs a paid rung, however rich the balance (2026-07-18, observed live):
   * KIE serves Fable 5 with a buffered answer, and a creation-sized artifact cannot flush before KIE's
   * ~5-minute gateway timeout — the generation died at finish=error after 449s with the artifact never
   * arriving. The balance is deliberately absurd here: this lock must not be purchasable.
   */
  it('locks every paid rung on a first build turn at ANY balance', () => {
    for (const requested of ['premium', 'supermax'] as const) {
      for (const balance of [0, PREMIUM_MINIMUM, SUPERMAX_MINIMUM, 10_000_000, Number.MAX_SAFE_INTEGER]) {
        expect(decideModelTier({ requested, balance, tiers: LADDER, isFirstBuildTurn: true })).toEqual({
          tier: 'standard',
          reason: 'creation_turn',
        });
      }
    }
  });

  /* The control for the lock: it is the TURN that refuses, not the rung being unreachable in general. */
  it('CONTROL — the same rung at the same balance runs on an edit turn', () => {
    expect(
      decideModelTier({ requested: 'supermax', balance: 10_000_000, tiers: LADDER, isFirstBuildTurn: false }),
    ).toEqual({ tier: 'supermax', reason: 'sufficient_credits' });
  });

  /* A rung whose flag is false is not locked — the flag is per-tier so relaxing it is config, not surgery. */
  it('runs a rung that is NOT first-build-locked on a first build turn', () => {
    const streaming: readonly ModelTierOption[] = [{ ...LADDER[0], firstBuildLocked: false }];

    expect(
      decideModelTier({ requested: 'premium', balance: PREMIUM_MINIMUM, tiers: streaming, isFirstBuildTurn: true }),
    ).toEqual({ tier: 'premium', reason: 'sufficient_credits' });
  });

  /*
   * AN UNRECOGNISED TIER ID RESOLVES DOWN, NEVER UP.
   *
   * This value arrives in a browser body: a typo, a stale client, a hand-edited request. Every one of
   * them must land on the free rung. "Closest match" and "default to the best available" are the two
   * tempting implementations and both invent spend the user never asked for. Casing and whitespace are
   * included because a lenient parser is precisely how an id becomes valid by accident.
   */
  it.each([
    ['an unknown name', 'gold'],
    ['an empty string', ''],
    ['undefined', undefined],
    ['a whitespace-only string', '   '],
    ['the wrong case', 'SUPERMAX'],
    ['a trailing space', 'premium '],
    ['a leading space', ' premium'],
    ['a near-miss', 'super-max'],
    ['a truthy non-tier', 'true'],
  ])('resolves %s to standard rather than upward', (_label, requested) => {
    expect(decideModelTier({ requested, balance: 10_000_000, tiers: LADDER })).toEqual({
      tier: 'standard',
      reason: 'standard_requested',
    });
  });

  /*
   * A rung the operator has not configured is UNAVAILABLE — a distinct reason from every other refusal,
   * because it is the only one of the five that means a human must go and fix something. Both forms end
   * at `standard`, so the user sees no difference and only the generation log can tell them apart.
   */
  it('reports unavailable for a valid rung that is absent from the ladder', () => {
    expect(decideModelTier({ requested: 'supermax', balance: 10_000_000, tiers: [LADDER[0]] })).toEqual({
      tier: 'standard',
      reason: 'unavailable',
    });
  });

  it('reports unavailable for a rung present but not serveable', () => {
    const broken: readonly ModelTierOption[] = [LADDER[0], { ...LADDER[1], serveable: false }];

    expect(decideModelTier({ requested: 'supermax', balance: 10_000_000, tiers: broken })).toEqual({
      tier: 'standard',
      reason: 'unavailable',
    });

    // CONTROL: the healthy rung on the same ladder is unaffected — one broken selector is not an outage.
    expect(decideModelTier({ requested: 'premium', balance: 10_000_000, tiers: broken }).tier).toBe('premium');
  });

  it('reports unavailable, not creation_turn, for a broken rung on a first build turn', () => {
    /*
     * The ORDERING is the assertion. Both refusals produce `standard`, so ordering the availability
     * check behind a per-turn condition costs the user nothing and hides a broken operator selector on
     * exactly the turns where a paid rung is most likely to be asked for.
     */
    expect(
      decideModelTier({
        requested: 'supermax',
        balance: 10_000_000,
        tiers: [LADDER[0], { ...LADDER[1], serveable: false }],
        isFirstBuildTurn: true,
      }),
    ).toEqual({ tier: 'standard', reason: 'unavailable' });
  });

  /* An empty ladder is the no-paid-rungs-configured deploy: every paid request degrades, nothing throws. */
  it('degrades every paid request on an empty ladder', () => {
    for (const requested of ['premium', 'supermax'] as const) {
      expect(decideModelTier({ requested, balance: 10_000_000, tiers: [] })).toEqual({
        tier: 'standard',
        reason: 'unavailable',
      });
    }
  });

  /*
   * DUPLICATED ROWS ARE A CONFIG FAULT, AND THE DECISION MUST NOT GO SHOPPING.
   *
   * Two rows for one id can only arrive from a broken resolver, and the dangerous repair is a lenient
   * one: "find a row that grants" would make a duplicate the cheapest way to bypass a threshold or a
   * dead selector. The decision reads the FIRST row and lives with it, so a duplicate can never be more
   * permissive than the row that legitimately came first.
   */
  it('never picks the more permissive duplicate row', () => {
    const unserveableFirst: readonly ModelTierOption[] = [{ ...LADDER[0], serveable: false }, LADDER[0]];
    expect(decideModelTier({ requested: 'premium', balance: 10_000_000, tiers: unserveableFirst }).reason).toBe(
      'unavailable',
    );

    const expensiveFirst: readonly ModelTierOption[] = [LADDER[0], { ...LADDER[0], minimumCredits: 0 }];
    expect(decideModelTier({ requested: 'premium', balance: 0, tiers: expensiveFirst })).toEqual({
      tier: 'standard',
      reason: 'below_minimum',
    });
  });

  /*
   * IT IS NEVER AN ERROR. The decision sits on the generation path in front of the model, so a throw
   * here is a dead generation for a preference that could simply have been declined — the same
   * asymmetry `premiumSessionHint` records: degrading a capability to "off" is honest, taking the
   * request down is not. A NaN balance is included because every comparison against it is false, which
   * is the SAFE direction (it declines) and must stay that way rather than being "repaired" to 0.
   */
  it('never throws, and always answers with a real rung and a real reason', () => {
    const oddBalances = [-1, -10_000_000, 0, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, 0.5];
    const oddLadders: (readonly ModelTierOption[])[] = [
      [],
      LADDER,
      [{ ...LADDER[0], minimumCredits: NaN }],
      [{ ...LADDER[0], minimumCredits: -1 }],
      [LADDER[0], LADDER[0]],
      [{ ...LADDER[1], label: '', serveable: false }],
    ];
    const oddRequests: (string | undefined)[] = [undefined, '', 'gold', 'standard', 'premium', 'supermax', '__proto__'];

    for (const requested of oddRequests) {
      for (const balance of oddBalances) {
        for (const tiers of oddLadders) {
          for (const isFirstBuildTurn of [undefined, false, true]) {
            let decision!: ModelTierDecision;
            expect(() => (decision = decideModelTier({ requested, balance, tiers, isFirstBuildTurn }))).not.toThrow();
            expect(MODEL_TIER_IDS).toContain(decision.tier);
            expect([
              'standard_requested',
              'unavailable',
              'creation_turn',
              'below_minimum',
              'sufficient_credits',
            ] satisfies ModelTierDecisionReason[]).toContain(decision.reason);

            // The only way a PAID rung is ever returned is the one reason that grants it.
            if (decision.tier !== 'standard') {
              expect(decision.reason).toBe('sufficient_credits');
            }
          }
        }
      }
    }
  });

  it('a NaN balance is never rich enough', () => {
    expect(decideModelTier({ requested: 'supermax', balance: NaN, tiers: LADDER })).toEqual({
      tier: 'standard',
      reason: 'below_minimum',
    });
  });

  /* A zero threshold is the only free door onto a paid rung, and it must be an OPERATOR's stated choice. */
  it('grants a rung whose threshold the operator set to zero, at a zero balance', () => {
    expect(decideModelTier({ requested: 'premium', balance: 0, tiers: [{ ...LADDER[0], minimumCredits: 0 }] })).toEqual(
      {
        tier: 'premium',
        reason: 'sufficient_credits',
      },
    );
  });
});

/**
 * `decidePremium` is now a thin re-expression of `decideModelTier` over a one-rung ladder. Its 22
 * behavioural cases below are unchanged and are the real pin; this bridges the two so a change to the
 * general rule that quietly alters the premium answer fails on BOTH sides rather than only here.
 */
describe('decidePremium agrees with decideModelTier on a premium-only ladder', () => {
  it('matches across the whole requested × balance × turn product', () => {
    for (const requested of [false, true]) {
      for (const balance of [-1, 0, 1199, 1200, 1201, 10_000_000]) {
        for (const isFirstBuildTurn of [false, true]) {
          const premium = decidePremium({ requested, balance, minimumCredits: PREMIUM_MINIMUM, isFirstBuildTurn });
          const ladder = decideModelTier({
            requested: requested ? 'premium' : 'standard',
            balance,
            tiers: [LADDER[0]],
            isFirstBuildTurn,
          });

          expect(
            premium.usePremium,
            `balance ${balance}, requested ${requested}, first build ${isFirstBuildTurn}`,
          ).toBe(ladder.tier === 'premium');
        }
      }
    }
  });
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
    // Same shape as production: a fresh 1000-credit grant sits below the 1200 default, so a new account cannot pick premium.
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
  it('declines premium on a first build turn regardless of balance', () => {
    expect(decidePremium({ requested: true, balance: 50_000, minimumCredits: min, isFirstBuildTurn: true })).toEqual({
      usePremium: false,
      reason: 'creation_turn',
    });

    // The same balance on an ordinary turn: premium runs. The control that pins the distinction.
    expect(
      decidePremium({ requested: true, balance: 50_000, minimumCredits: min, isFirstBuildTurn: false }).usePremium,
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

    // The same rule on the generalized ladder, on the rung the 320-credit user actually reached for.
    expect(
      decideModelTier({ requested: 'premium', balance: 320, tiers: [{ ...LADDER[0], minimumCredits: min }] }),
    ).toEqual({ tier: 'standard', reason: 'below_minimum' });
    expect(
      decideModelTier({ requested: 'supermax', balance: 320, tiers: [{ ...LADDER[1], minimumCredits: min }] }),
    ).toEqual({ tier: 'standard', reason: 'below_minimum' });
    expect(
      decideModelTier({ requested: 'supermax', balance: 0, tiers: [{ ...LADDER[1], minimumCredits: 0 }] }).tier,
    ).toBe('supermax');
  });

  it('names the threshold in the declined notice', () => {
    expect(premiumDeclinedNotice(1000)).toContain('1,000');
  });
});

/**
 * 🔴 THE STRUCTURAL TRIPWIRE: no enforcement flag may enter either decision's input.
 *
 * The behavioural cases above ("binds on the balance…") can only prove that a bypass is not TAKEN for
 * the inputs they happen to pass. What the 2026-07-18 post-mortem actually demands is that the input
 * shape offers nowhere to put one: the retired rule let a 320-credit user run the 2x model because
 * "nobody is charged when enforcement is off", which was false — `settleGeneration` debits the ledger
 * regardless, so the balance is always the eligibility fact. A source scan is the honest form of "this
 * field does not exist", and it now covers `decideModelTier`, where the same field would be a bypass on
 * three rungs instead of one.
 *
 * Comments are stripped first because the retirement is DOCUMENTED in prose directly above both
 * functions (twice, naming `BILLING_ENFORCED`) — an unstripped scan would fail on the post-mortem that
 * exists to prevent the regression. CONTROLS below prove the reader still sees real code, that the
 * strip really happened, and that the interface extraction found the interfaces rather than nothing.
 */
describe('no enforcement bypass exists to be taken (§4.6.1 structural tripwire)', () => {
  const source = readFileSync(path.join(process.cwd(), 'app/lib/.server/billing/premium.ts'), 'utf-8');
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /** The body of one `export interface X { … }`, brace-matched. Empty when the interface is not found. */
  function interfaceBody(name: string): string {
    const start = stripped.indexOf(`interface ${name}`);

    if (start < 0) {
      return '';
    }

    const open = stripped.indexOf('{', start);
    let depth = 0;

    for (let i = open; i < stripped.length; i++) {
      if (stripped[i] === '{') {
        depth++;
      } else if (stripped[i] === '}' && --depth === 0) {
        return stripped.slice(open, i + 1);
      }
    }

    return '';
  }

  const premiumInput = interfaceBody('PremiumDecisionInput');
  const tierInput = interfaceBody('ModelTierDecisionInput');

  it('CONTROL — the scan reads real code, and found both decision inputs', () => {
    expect(stripped).toContain('export function decideModelTier');
    expect(stripped).toContain('export function decidePremium');
    expect(premiumInput).toContain('minimumCredits');
    expect(tierInput).toContain('tiers');
    expect(tierInput).toContain('isFirstBuildTurn');
  });

  it('CONTROL — comments are stripped, so the post-mortem prose does not count as code', () => {
    expect(source).toContain('BILLING_ENFORCED');
    expect(stripped).not.toContain('BILLING_ENFORCED');
  });

  it('neither decision input carries an enforcement flag', () => {
    expect(premiumInput.toLowerCase()).not.toContain('enforc');
    expect(tierInput.toLowerCase()).not.toContain('enforc');
  });

  it('the whole module is free of enforcement logic once its prose is stripped', () => {
    expect(stripped.toLowerCase()).not.toContain('enforc');
  });
});

/**
 * `tierDeclinedNotice` — the message a user sees when they asked for a rung and got the standard model.
 *
 * It takes the LABEL because the ladder has more than one paid rung: a hardcoded "premium" would tell a
 * SuperMax user the wrong model AND the wrong threshold, which is worse than saying nothing at all.
 */
describe('tierDeclinedNotice', () => {
  it('names the rung the user asked for and formats its threshold', () => {
    const notice = tierDeclinedNotice('SuperMax', 1500);

    expect(notice).toContain('SuperMax');
    expect(notice).toContain('1,500');
    expect(notice.toLowerCase()).not.toContain('premium');
  });

  it('names a different rung when a different rung was declined', () => {
    const notice = tierDeclinedNotice('Premium', 1200);

    expect(notice).toContain('Premium');
    expect(notice).toContain('1,200');
    expect(notice.toLowerCase()).not.toContain('supermax');
  });

  /* The deprecated wrapper is the premium-only callers' door until T6 migrates them — same string. */
  it('premiumDeclinedNotice is the same message with the premium label', () => {
    expect(premiumDeclinedNotice(1200)).toBe(tierDeclinedNotice('premium', 1200));
  });
});

describe('the premium tier config', () => {
  /*
   * Premium is the MIDDLE rung since the ladder shipped (§4.6.1a): Standard · Premium · SuperMax.
   * Fable 5 moved up to SuperMax and Opus 5 took this slot, so the in-code default named here changed
   * — the rules around it did not.
   */
  it('defaults to Opus 5 at the list price with a 1200-credit minimum, from code — no env required', () => {
    stubPremium();

    const tier = getPremiumTier({});
    const baked = BAKED_MARKET_PRICES.llm['claude-opus-5'];

    expect(tier.model).toBe(DEFAULT_PREMIUM_MODEL);
    expect(tier.model).toBe('claude-opus-5');
    expect(tier.minimumCredits).toBe(DEFAULT_PREMIUM_MINIMUM_CREDITS);
    expect(tier.minimumCredits).toBe(1200);
    expect(tier.rates.inputPerMTok).toBe(baked.inputPerMTok);
    expect(tier.rates.outputPerMTok).toBe(baked.outputPerMTok);

    // Cache re-derives from the final input: 0.1x read, 2x write (the 1h tier).
    expect(tier.rates.cacheReadPerMTok).toBeCloseTo(baked.inputPerMTok * 0.1, 9);
    expect(tier.rates.cacheWritePerMTok).toBeCloseTo(baked.inputPerMTok * 2, 9);
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
      llm: { ...BAKED_MARKET_PRICES.llm, 'claude-opus-5': { inputPerMTok: 6, outputPerMTok: 30 } },
    });
    expect(result.ok).toBe(true);

    const tier = getPremiumTier({});
    expect(tier.rates.inputPerMTok).toBe(6);
    expect(tier.rates.cacheWritePerMTok, 'cache re-derives from the promoted base').toBeCloseTo(12, 9);
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
  /*
   * 🔴 The default premium model is now one Anthropic prices NATIVELY, which turns the injection's
   * fill-a-gap rule from a no-op into the thing standing between us and a 60% loss on every premium
   * generation: `premium.rates` come from the KIE-shaped Marketplace list ($2/$10), and overwriting
   * Anthropic's own $5/$25 row with them measured 231 credits where 576 was correct (`rates.ts`).
   * While the default was Fable 5 — a model Anthropic bakes no row for — filling and overwriting were
   * indistinguishable, which is exactly why the bug was invisible for as long as it was.
   */
  it('leaves Anthropic its OWN row for a model Anthropic prices natively', () => {
    stubPremium();

    const anthropic = providerRates({}).Anthropic;

    expect(anthropic['claude-opus-5']).toEqual(MODEL_RATES['claude-opus-5']);
    expect(anthropic['claude-opus-5'].inputPerMTok, 'Anthropic list price, not the KIE list row').toBe(5);
    expect(ratesFor('claude-opus-5', 'Anthropic', {}).inputPerMTok).toBe(5);

    // ...and KIE keeps its own, cheaper, row for the same model. Same id, two prices, both correct.
    expect(ratesFor('claude-opus-5', 'KIE', {}).inputPerMTok).toBe(2);
  });

  it('injects a row into a provider that bakes none', () => {
    stubPremium({ PREMIUM_MODEL: 'claude-fable-5' });

    // MODEL_RATES has no fable-5 row (pinned in billing.spec) — this injection is what prices it.
    expect(providerRates({}).Anthropic['claude-fable-5']).toEqual({
      inputPerMTok: 4,
      outputPerMTok: 20,
      cacheReadPerMTok: 0.4,
      cacheWritePerMTok: 8.0,
    });

    expect(ratesFor('claude-fable-5', 'Anthropic', {}).inputPerMTok).toBe(4);
  });

  it('is idempotent on KIE, which already bakes the identical row', () => {
    stubPremium({ PREMIUM_MODEL: 'claude-fable-5' });
    expect(providerRates({}).KIE['claude-fable-5']).toEqual({
      inputPerMTok: 4,
      outputPerMTok: 20,
      cacheReadPerMTok: 0.4,
      cacheWritePerMTok: 8.0,
    });
  });

  /*
   * 🔴 THE INJECTION IS SCOPED TO THE RUNGS THE OPERATOR SELECTED — and this is the case that makes
   * `stubPremium`'s `SUPERMAX_*` half load-bearing rather than decorative (§4.6.1a, T14).
   *
   * `providerRates` walks the WHOLE ladder and fills a gap for every rung, so SuperMax's selector can
   * make a model priceable on Anthropic just as readily as Premium's can. That is correct behaviour and
   * precisely why it is dangerous here: an unpriced model does not bill as free, it bills at the most
   * expensive row we know of (`ratesFor`'s fallback), so "is this model priced?" is a question whose
   * answer must never depend on which rung an operator happened to point where.
   *
   * `claude-opus-4-7` is the probe because it is priced on the KIE-shaped Marketplace list and has NO
   * baked Anthropic row — the one shape where filling and overwriting are distinguishable. With the
   * ladder at its defaults nothing selects it, so no rung injects it and Anthropic still cannot price
   * it. Set `SUPERMAX_MODEL=claude-opus-4-7` and the SuperMax rung injects the row, the assertion below
   * inverts, and the failure lands on the machine of whoever configured SuperMax — with CI green,
   * blaming code they never touched. That is the `oauth.spec.ts` trap one rung to the right, and the
   * SAME leak `billing.spec.ts` records having fired twice already.
   *
   * The control half runs second and is what stops this from being a test that passes because the
   * injection is broken: pointed at the probe deliberately, SuperMax must genuinely price it.
   */
  it('injects ONLY for rungs the operator selected — an unselected model stays unpriced on Anthropic', () => {
    stubPremium();

    expect(MODEL_RATES, 'the probe must have no baked Anthropic row, or it proves nothing').not.toHaveProperty(
      'claude-opus-4-7',
    );
    expect(providerRates({}).Anthropic).not.toHaveProperty('claude-opus-4-7');

    /*
     * CONTROL — the SuperMax rung really does inject, so the absence above is scope, not a dead lever.
     * The base rates are asserted exactly (they are the billed numbers); the cache rates are compared
     * loosely because they are DERIVED (0.1× read / 2.0× write) and `0.1 * 1.425` is not `0.1425` in
     * IEEE 754 — pinning the float artifact would be pinning arithmetic noise, not a price.
     */
    stubPremium({ SUPERMAX_MODEL: 'claude-opus-4-7' });

    const injected = providerRates({}).Anthropic['claude-opus-4-7'];

    expect(injected.inputPerMTok).toBe(1.425);
    expect(injected.outputPerMTok).toBe(7.15);
    expect(injected.cacheReadPerMTok).toBeCloseTo(0.1425, 10);
    expect(injected.cacheWritePerMTok).toBeCloseTo(2.85, 10);
  });

  it('getPremiumModel returns the configured premium model on the active provider', () => {
    stubPremium();
    vi.stubEnv('LLM_PROVIDER', 'KIE');
    expect(getPremiumModel({})).toBe('claude-opus-5');

    vi.stubEnv('LLM_PROVIDER', 'Anthropic');
    expect(getPremiumModel({})).toBe('claude-opus-5');
  });
});

/**
 * `premiumSessionHint` — the `/api/me` rendering hint, and the guard around a MISCONFIGURED tier.
 *
 * Why this is a pure function with its own tests rather than an inline expression in the route: both of
 * its failure directions are silent, and the misconfigured case is an app-wide outage, not a cosmetic bug.
 */
describe('premiumSessionHint (§4.6.1 — degrade to OFF, never to ON)', () => {
  const CONFIGURED = { model: 'claude-fable-5', minimumCredits: 1200 };
  const FALLBACKS = { fallbackModel: DEFAULT_PREMIUM_MODEL, fallbackMinimumCredits: DEFAULT_PREMIUM_MINIMUM_CREDITS };

  it('offers premium to a user who holds the minimum', () => {
    expect(premiumSessionHint({ tier: CONFIGURED, balance: 1200, ...FALLBACKS })).toEqual({
      model: 'claude-fable-5',
      minimumCredits: 1200,
      available: true,
    });
  });

  it('locks the toggle for a user below the minimum, and still names the model + threshold', () => {
    expect(premiumSessionHint({ tier: CONFIGURED, balance: 1199, ...FALLBACKS })).toEqual({
      model: 'claude-fable-5',
      minimumCredits: 1200,
      available: false,
    });
  });

  /*
   * 🔴 THE ASYMMETRY. `getPremiumTier` throws while `PREMIUM_MODEL` names a model the active price list
   * cannot price — the normal transient state when an operator points SSM at a new premium model before
   * promoting its row. Premium genuinely cannot be served then (`getPremiumModel` refuses identically at
   * generation time), so reporting it available would render an enabled toggle that hard-fails on use.
   *
   * The balance is deliberately ENORMOUS here: availability must not be recoverable by being rich.
   */
  it('reports UNAVAILABLE when the tier is misconfigured, no matter how large the balance', () => {
    for (const balance of [0, 1200, 10_000_000]) {
      expect(premiumSessionHint({ tier: null, balance, ...FALLBACKS }).available).toBe(false);
    }
  });

  it('falls back to the baked model + threshold so the UI still has something honest to render', () => {
    expect(premiumSessionHint({ tier: null, balance: 5000, ...FALLBACKS })).toEqual({
      model: DEFAULT_PREMIUM_MODEL,
      minimumCredits: DEFAULT_PREMIUM_MINIMUM_CREDITS,
      available: false,
    });
  });

  /*
   * ⚠️ Its caller is `/api/me`, the SESSION endpoint on every page load. An unguarded throw there took the
   * whole app down for every user because a toggle's rendering hint was misconfigured. This must never
   * throw for ANY input, including the degenerate ones.
   */
  it('never throws — it is on the session path, where an exception is an app-wide outage', () => {
    for (const tier of [null, CONFIGURED, { model: '', minimumCredits: 0 }]) {
      for (const balance of [-1, 0, Number.MAX_SAFE_INTEGER]) {
        expect(() => premiumSessionHint({ tier, balance, ...FALLBACKS })).not.toThrow();
      }
    }
  });
});

/**
 * `modelTiersSessionHint` (§4.6.1a) — the same `/api/me` guard, generalized to the three-rung ladder.
 *
 * ⚠️ Pure and reads NO environment, so every case below passes the whole ladder in explicitly. That is
 * not stylistic (see the file header): a case that resolved its ladder from config would test whichever
 * SuperMax model and threshold the developer happens to have in `.env.local` rather than the rung this
 * file is about — the `oauth.spec.ts` trap with a second rung's worth of surface area. `stubPremium`
 * now covers both rungs, but a scrub list is a floor under the config cases, not a substitute for a
 * pure function being handed its own inputs.
 *
 * The incident this generalizes is 2026-07-25: `getPremiumTier` was called unguarded inside `/api/me`'s
 * response literal, so an unpriced `PREMIUM_MODEL` — the normal transient state while an operator moves
 * a rung to a new model — took the whole app down for every user because a toggle's rendering hint was
 * misconfigured. Three rungs means three selectors, three thresholds and three ways to be mid-move, so
 * the function has to be TOTAL and it has to degrade to "off" on every one of them.
 */
describe('modelTiersSessionHint (§4.6.1a — the whole ladder, degrade to OFF, never to ON)', () => {
  const STANDARD_MODEL = 'claude-opus-4-8';
  const FALLBACK_STANDARD_MODEL = 'claude-opus-5';

  /**
   * A healthy ladder as `getModelTiers` returns one, INCLUDING the free `standard` row.
   *
   * Standard is present because it is present in the real payload and because its zero threshold is the
   * one row that must never lock — the picker showing "Standard" greyed out would tell a user with no
   * credits that they cannot use the platform at all.
   */
  function ladder(overrides: Partial<Record<ModelTierId, Partial<ModelTierStatusLike>>> = {}): ModelTierStatusLike[] {
    const rows: ModelTierStatusLike[] = [
      { id: 'standard', label: 'Standard', model: STANDARD_MODEL, minimumCredits: 0, serveable: true },
      { id: 'premium', label: 'Premium', model: 'claude-opus-5', minimumCredits: PREMIUM_MINIMUM, serveable: true },
      { id: 'supermax', label: 'SuperMax', model: 'claude-fable-5', minimumCredits: SUPERMAX_MINIMUM, serveable: true },
    ];

    return rows.map((row) => ({ ...row, ...(overrides[row.id] ?? {}) }));
  }

  /** The rung by id, so an assertion names what it is asserting about rather than indexing a list. */
  function rung(hint: ModelTiersSessionHint, id: ModelTierId): ModelTierHint {
    const found = hint.tiers.find((row) => row.id === id);

    expect(found, `the hint has no ${id} rung`).toBeDefined();

    return found!;
  }

  it('offers every rung to a user who clears every threshold', () => {
    const hint = modelTiersSessionHint({
      tiers: ladder(),
      standardModel: STANDARD_MODEL,
      fallbackStandardModel: FALLBACK_STANDARD_MODEL,
      balance: 10_000_000,
    });

    expect(hint.standardModel).toBe(STANDARD_MODEL);
    expect(hint.tiers.map((row) => row.id)).toEqual(['standard', 'premium', 'supermax']);
    expect(hint.tiers.every((row) => row.available)).toBe(true);
  });

  /*
   * 🔴 THE INCIDENT, GENERALIZED — and the reason the two assertions are in ONE call.
   *
   * A rung whose selector the active Marketplace price list cannot price is `serveable: false`, and it
   * must report `available: false` at ANY balance: `getTierModel` applies the same validation and
   * refuses at generation time, so an "available" broken rung is an enabled picker row that hard-fails
   * the moment it is used. Degrading a capability to "off" is honest; degrading it to "on" invents one.
   *
   * The balance is deliberately ENORMOUS — availability must not be recoverable by being rich — and
   * Premium is asserted AVAILABLE in the same result. A blanket "if anything is broken, lock the
   * ladder" implementation passes a test that only looks at the broken rung, and it would take the
   * paid tiers away from every user on the platform because one operator selector was mid-move.
   */
  it('reports a misconfigured SuperMax UNAVAILABLE at 10,000,000 credits while Premium stays available', () => {
    const hint = modelTiersSessionHint({
      tiers: ladder({ supermax: { serveable: false } }),
      standardModel: STANDARD_MODEL,
      fallbackStandardModel: FALLBACK_STANDARD_MODEL,
      balance: 10_000_000,
    });

    expect(rung(hint, 'supermax').available).toBe(false);
    expect(rung(hint, 'premium').available, 'one broken selector is not a platform-wide outage').toBe(true);
    expect(rung(hint, 'standard').available, 'the free rung is never collateral damage').toBe(true);
  });

  /*
   * A broken rung still NAMES its model and threshold — the picker has to render something honest in the
   * locked row, and `getModelTiers` supplies the in-code default rather than the unpriceable selector.
   * The hint must pass that through untouched rather than blanking it.
   */
  it('still names a misconfigured rung’s model and threshold so the locked row can be rendered', () => {
    const hint = modelTiersSessionHint({
      tiers: ladder({ supermax: { serveable: false } }),
      standardModel: STANDARD_MODEL,
      fallbackStandardModel: FALLBACK_STANDARD_MODEL,
      balance: 0,
    });

    expect(rung(hint, 'supermax')).toEqual({
      id: 'supermax',
      label: 'SuperMax',
      model: 'claude-fable-5',
      minimumCredits: SUPERMAX_MINIMUM,
      available: false,
      serveable: false,
    });
  });

  /*
   * THE THRESHOLD BOUNDARY ON EVERY RUNG, as a loop over the ladder rather than three hand-picked cases.
   *
   * `available` is what the picker enables, so it is the client-side half of the money rule
   * `decideModelTier` enforces server-side; the two must agree at the boundary or a user clicks a rung
   * the server then silently declines. Testing `min - 1` / `min` / `min + 1` on every rung pins the
   * comparison in both directions — a `>` for a `>=` shifts every rung by exactly one credit, which is
   * invisible to any test that only checks a comfortable balance.
   *
   * Standard's `min - 1` is -1, i.e. an overdrawn account (a `generation` debit MAY go negative, §4.6),
   * and it locks like any other rung — the free-rung guarantee below is stated at a balance of 0, which
   * is the state a real user without credits is in.
   */
  it('makes every rung available at exactly its minimum and unavailable one credit below', () => {
    for (const row of ladder()) {
      for (const [offset, expected] of [
        [-1, false],
        [0, true],
        [1, true],
      ] as const) {
        const balance = row.minimumCredits + offset;
        const hint = modelTiersSessionHint({
          tiers: ladder(),
          standardModel: STANDARD_MODEL,
          fallbackStandardModel: FALLBACK_STANDARD_MODEL,
          balance,
        });

        expect(rung(hint, row.id).available, `${row.id} at ${balance} (minimum ${row.minimumCredits})`).toBe(expected);
      }
    }
  });

  /* The free rung must never lock: a greyed-out Standard tells a broke user the platform is closed. */
  it('keeps the zero-threshold standard rung available at a zero balance', () => {
    const hint = modelTiersSessionHint({
      tiers: ladder(),
      standardModel: STANDARD_MODEL,
      fallbackStandardModel: FALLBACK_STANDARD_MODEL,
      balance: 0,
    });

    expect(rung(hint, 'standard').available).toBe(true);
    expect(rung(hint, 'premium').available, 'CONTROL — the paid rungs really are locked at zero').toBe(false);
    expect(rung(hint, 'supermax').available).toBe(false);
  });

  /* A NaN balance compares false against every threshold, which is the SAFE direction: it locks. */
  it('locks every paid rung on a NaN balance', () => {
    const hint = modelTiersSessionHint({
      tiers: ladder(),
      standardModel: STANDARD_MODEL,
      fallbackStandardModel: FALLBACK_STANDARD_MODEL,
      balance: NaN,
    });

    expect(rung(hint, 'premium').available).toBe(false);
    expect(rung(hint, 'supermax').available).toBe(false);
  });

  /*
   * A MISSING LADDER REPORTS THE IN-CODE RUNGS, ALL LOCKED — never an empty list.
   *
   * The empty list is the other silent direction: the picker would render a single-option control and
   * the user would read "this platform has one model" from what is actually a transient config fault.
   *
   * The expectation is built FROM `PAID_MODEL_TIERS` rather than from hardcoded strings, so moving a
   * rung to a new default model or threshold cannot leave this test asserting yesterday's table.
   */
  it('falls back to the in-code rungs, all locked, when the ladder is missing', () => {
    for (const tiers of [null, undefined]) {
      const hint = modelTiersSessionHint({
        tiers,
        standardModel: STANDARD_MODEL,
        fallbackStandardModel: FALLBACK_STANDARD_MODEL,
        balance: 10_000_000,
      });

      expect(hint.tiers.length, 'an empty ladder reads as "this platform has one model"').toBeGreaterThan(0);

      /*
       * 🔴 The degraded ladder carries a STANDARD row, exactly like the healthy one. `getModelTiers`
       * prepends standard and `PAID_MODEL_TIERS` excludes it, so a fallback that maps the table alone
       * emits a picker with no free option — during a config fault, hiding the one model we are
       * certainly about to run. Two shapes for one field is also a client-normaliser branch nobody
       * tests. Built FROM the table so it cannot drift when a rung is added.
       */
      expect(hint.tiers).toEqual([
        {
          id: 'standard',
          label: STANDARD_TIER_LABEL,
          model: STANDARD_MODEL,
          minimumCredits: 0,
          available: true,
          serveable: true,
        },
        ...PAID_MODEL_TIERS.map((definition) => ({
          id: definition.id,
          label: definition.label,
          model: definition.defaultModel,
          minimumCredits: definition.defaultMinimumCredits,
          available: false,
          serveable: false,
        })),
      ]);
    }
  });

  /*
   * The property that matters more than either shape: healthy and degraded must agree about WHICH
   * rungs exist. A consumer renders `tiers` verbatim, so a ladder that changes length depending on
   * whether the operator's config parsed is a UI that changes shape for a reason the user cannot see.
   */
  it('reports the same rungs whether the ladder resolved or not', () => {
    const common = { standardModel: STANDARD_MODEL, fallbackStandardModel: FALLBACK_STANDARD_MODEL, balance: 0 };
    const healthy = modelTiersSessionHint({ ...common, tiers: ladder() });
    const degraded = modelTiersSessionHint({ ...common, tiers: null });

    expect(degraded.tiers.map((row) => row.id)).toEqual(healthy.tiers.map((row) => row.id));
  });

  /* A row that survived the ladder resolver as null/undefined is dropped, not rendered as a blank rung. */
  it('drops null rows rather than reporting a blank rung', () => {
    const holes = [null, ladder()[1], undefined] as unknown as readonly ModelTierStatusLike[];
    const hint = modelTiersSessionHint({
      tiers: holes,
      standardModel: STANDARD_MODEL,
      fallbackStandardModel: FALLBACK_STANDARD_MODEL,
      balance: 10_000_000,
    });

    expect(hint.tiers.map((row) => row.id)).toEqual(['premium']);
  });

  /*
   * The standard model falls back when the caller could not resolve one. `''` and whitespace count as
   * "could not": an env var that was misread is not a model name, and putting it in the composer pill
   * would render an empty label where a model name belongs.
   */
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('falls back to the caller’s standard model when it is %s', (_label, standardModel) => {
    expect(
      modelTiersSessionHint({
        tiers: ladder(),
        standardModel,
        fallbackStandardModel: FALLBACK_STANDARD_MODEL,
        balance: 0,
      }).standardModel,
    ).toBe(FALLBACK_STANDARD_MODEL);
  });

  it('CONTROL — a real standard model is reported as given, never replaced by the fallback', () => {
    expect(
      modelTiersSessionHint({
        tiers: ladder(),
        standardModel: STANDARD_MODEL,
        fallbackStandardModel: FALLBACK_STANDARD_MODEL,
        balance: 0,
      }).standardModel,
    ).toBe(STANDARD_MODEL);
  });

  /*
   * ⚠️ IT MUST BE TOTAL. Its caller is `/api/me`, the SESSION endpoint on every page load — the exact
   * place the 2026-07-25 outage happened, where an exception is not a broken toggle but a broken app.
   *
   * The property asserts the RESULT is well-formed, not merely that nothing was thrown: a function that
   * survives every input by returning `{ standardModel: undefined, tiers: undefined }` has not degraded
   * gracefully, it has moved the crash into the component that renders the picker.
   */
  it('never throws, and always answers with a well-formed hint', () => {
    const oddLadders: (readonly ModelTierStatusLike[] | null | undefined)[] = [
      null,
      undefined,
      [],
      ladder(),
      ladder({ premium: { serveable: false }, supermax: { serveable: false } }),
      [{ ...ladder()[2], minimumCredits: NaN }],
      [{ ...ladder()[1], label: '', model: '', minimumCredits: -1 }],
      [null, undefined] as unknown as readonly ModelTierStatusLike[],
      [ladder()[1], ladder()[1]],

      /*
       * A row that reached here MISSING `serveable`. Unreachable through `getModelTiers` and forbidden
       * by the type, which is exactly why it needs pinning: the implementation writes `=== true` rather
       * than a truthiness test specifically so this yields `false` and not `undefined`, and without a
       * case that produces the shape, that reasoning lives only in a comment — and a comment cannot
       * fail. The `available` assertion in the loop below (`typeof … === 'boolean'`) is what catches it.
       */
      [
        { id: 'premium', label: 'Premium', model: 'claude-opus-5', minimumCredits: 1 },
      ] as unknown as readonly ModelTierStatusLike[],
    ];
    const oddStandardModels: (string | null | undefined)[] = [null, undefined, '', '   ', STANDARD_MODEL];
    const oddBalances = [-1, 0, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER];

    for (const tiers of oddLadders) {
      for (const standardModel of oddStandardModels) {
        for (const balance of oddBalances) {
          const label = `tiers ${JSON.stringify(tiers)}, standardModel ${String(standardModel)}, balance ${balance}`;

          let hint!: ReturnType<typeof modelTiersSessionHint>;
          expect(
            () =>
              (hint = modelTiersSessionHint({
                tiers,
                standardModel,
                fallbackStandardModel: FALLBACK_STANDARD_MODEL,
                balance,
              })),
            label,
          ).not.toThrow();

          expect(typeof hint.standardModel, label).toBe('string');
          expect(hint.standardModel.trim().length, label).toBeGreaterThan(0);
          expect(Array.isArray(hint.tiers), label).toBe(true);

          for (const row of hint.tiers) {
            expect(MODEL_TIER_IDS, label).toContain(row.id);
            expect(typeof row.available, label).toBe('boolean');
            expect(typeof row.model, label).toBe('string');
            expect(typeof row.label, label).toBe('string');
          }
        }
      }
    }
  });

  /*
   * IT CAN ONLY FAIL TO OFFER A RUNG, NEVER GRANT ONE. Nothing here is authorization — `decideModelTier`
   * re-derives eligibility server-side on every generation — but a hint that says "yes" where the
   * decision says "no" is a control that hard-fails on use, so the two are pinned in agreement on the
   * one axis they share: an unserveable rung is unavailable, and an unaffordable rung is unavailable.
   */
  it('agrees with decideModelTier about which rungs a user may pick', () => {
    for (const serveable of [true, false]) {
      for (const balance of [0, PREMIUM_MINIMUM - 1, PREMIUM_MINIMUM, SUPERMAX_MINIMUM, 10_000_000]) {
        const rows = ladder({ supermax: { serveable } });
        const hint = modelTiersSessionHint({
          tiers: rows,
          standardModel: STANDARD_MODEL,
          fallbackStandardModel: FALLBACK_STANDARD_MODEL,
          balance,
        });

        const decision = decideModelTier({
          requested: 'supermax',
          balance,
          tiers: [{ ...LADDER[1], serveable }],
        });

        expect(rung(hint, 'supermax').available, `serveable ${serveable}, balance ${balance}`).toBe(
          decision.tier === 'supermax',
        );
      }
    }
  });
});
