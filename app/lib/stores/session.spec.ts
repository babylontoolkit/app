/**
 * The CLIENT half of the model tier ladder (SPEC §4.6.1a) — `canUseTier`, `normalizeModelTiers`, and
 * the `/api/me` merge that feeds them.
 *
 * This store decides nothing about what the user may DO — the server re-derives every rung on every
 * generation (`decideModelTier`) — but it decides what the composer RENDERS, and both of its wrong
 * answers are silent:
 *
 *  - **Rendering a rung as pickable that the platform cannot serve** is the `premiumSessionHint`
 *    lesson reaching the client: an enabled picker row that hard-fails the moment it is used.
 *    Degrading a capability to "off" is honest; degrading it to "on" invents one. That is why
 *    `serveable` exists as a separate field from `available` and why every "is it locked" rule below
 *    is asserted at an absurd balance — no amount of credits may unlock an unserveable rung.
 *  - **Rendering a rung as locked that the user just paid to unlock.** `available` is a SNAPSHOT taken
 *    when `/api/me` was fetched (page load); the balance moves on every settlement and every purchase.
 *    A `canUseTier` that reads `available` therefore leaves a user locked out on the very screen they
 *    just bought credits on, with nothing throwing and nothing to see in a log. Test 4 below is that
 *    case in both directions and is the single most important assertion in this file.
 *
 * `normalizeModelTiers` is tested as a property — "never throws, always returns a well-formed ladder"
 * — rather than case by case, because the shapes it must survive are exactly the ones nobody
 * anticipated: an older deploy, a mid-rollout box, a proxy that mangled the body. The `credits` merge
 * in `refreshSession` is SHALLOW, so whatever the server sends REPLACES the default outright; a
 * half-formed object there is `undefined.tiers` in the picker, i.e. a blank screen instead of a locked
 * ladder.
 *
 * Note the deliberate asymmetry in the normaliser's rules, pinned in test 6: a row missing `serveable`
 * or `minimumCredits` ends up LOCKED (`=== true`, and a non-finite threshold becomes `Infinity`).
 * Refuse, never guess cheap — the guessing direction spends the user's credits at a higher rate
 * without them asking.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_SESSION,
  LOCKED_MODEL_TIERS,
  applySettlement,
  canUsePremium,
  canUseTier,
  normalizeModelTiers,
  refreshSession,
  sessionStore,
  type ModelTierState,
  type ModelTiersState,
  type SessionState,
} from './session';
import { DEFAULT_MODEL } from '~/utils/constants';

/** A rung with everything switched ON, so a test that means to lock one has to say which field it broke. */
function rung(overrides: Partial<ModelTierState> & { id: string }): ModelTierState {
  return {
    label: overrides.id,
    model: 'claude-test-model',
    minimumCredits: 0,
    available: true,
    serveable: true,
    ...overrides,
  };
}

/**
 * A session carrying an explicit ladder and balance.
 *
 * The ladder is always passed in rather than resolved from `LOCKED_MODEL_TIERS`, so that retuning the
 * shipped defaults cannot silently change what these cases mean (the same reason `decideModelTier`
 * takes its ladder as an argument server-side).
 */
function sessionWith(balance: number, tiers: ModelTierState[], standardModel = DEFAULT_MODEL): SessionState {
  return {
    ...EMPTY_SESSION,
    loading: false,
    authenticated: true,
    credits: { ...EMPTY_SESSION.credits, balance, modelTiers: { standardModel, tiers } },
  };
}

/** The three-rung shape the product actually ships, with distinct thresholds so a rung mix-up shows. */
const LADDER: ModelTierState[] = [
  rung({ id: 'standard', label: 'Standard', model: 'claude-sonnet-5', minimumCredits: 0 }),
  rung({ id: 'premium', label: 'Premium', model: 'claude-opus-5', minimumCredits: 1200 }),
  rung({ id: 'supermax', label: 'SuperMax', model: 'claude-fable-5', minimumCredits: 1500 }),
];

describe('canUseTier — the affordability boundary', () => {
  /*
   * A real loop over every rung × four balances around its own threshold. The expectations are written
   * out per case rather than derived from a re-implementation of the rule: a helper that computes
   * `balance >= min` is the function under test spelled twice, and it agrees with a broken
   * implementation as readily as with a correct one.
   */
  const cases: Array<{
    tierId: string;
    minimum: number;
    name: string;
    expected: { below: boolean; at: boolean; above: boolean };
  }> = [
    // Standard has no threshold and no selector to misconfigure, so every balance clears it.
    {
      tierId: 'standard',
      minimum: 0,
      name: 'standard: usable below, at and above its (zero) threshold',
      expected: { below: true, at: true, above: true },
    },
    {
      tierId: 'premium',
      minimum: 1200,
      name: 'premium: locked one credit below 1200, usable at it and above',
      expected: { below: false, at: true, above: true },
    },
    {
      tierId: 'supermax',
      minimum: 1500,
      name: 'supermax: locked one credit below 1500, usable at it and above',
      expected: { below: false, at: true, above: true },
    },
  ];

  for (const { tierId, minimum, name, expected } of cases) {
    it(name, () => {
      expect(canUseTier(sessionWith(minimum - 1, LADDER), tierId)).toBe(expected.below);
      expect(canUseTier(sessionWith(minimum, LADDER), tierId)).toBe(expected.at);
      expect(canUseTier(sessionWith(minimum + 1, LADDER), tierId)).toBe(expected.above);

      // The fourth balance the acceptance names: a stone-broke user. Standard alone survives it.
      expect(canUseTier(sessionWith(0, LADDER), tierId)).toBe(tierId === 'standard');
    });
  }

  it('every non-standard rung is locked at a zero balance', () => {
    const broke = sessionWith(0, LADDER);

    expect(canUseTier(broke, 'premium')).toBe(false);
    expect(canUseTier(broke, 'supermax')).toBe(false);
  });

  it('a tier id that is not on the ladder is refused, never granted by default', () => {
    // An unknown id is a client/server version skew. The safe answer is "you cannot pick that".
    expect(canUseTier(sessionWith(10_000_000, LADDER), 'gold')).toBe(false);
    expect(canUseTier(sessionWith(10_000_000, LADDER), '')).toBe(false);
    expect(canUseTier(sessionWith(10_000_000, LADDER), 'PREMIUM')).toBe(false);
  });

  it('the deprecated canUsePremium delegate still agrees with canUseTier', () => {
    for (const balance of [0, 1199, 1200, 5000]) {
      const session = sessionWith(balance, LADDER);
      expect(canUsePremium(session)).toBe(canUseTier(session, 'premium'));
    }
  });
});

describe('canUseTier — standard is always usable', () => {
  it('at a zero balance', () => {
    expect(canUseTier(sessionWith(0, LADDER), 'standard')).toBe(true);
  });

  it('at a NEGATIVE balance — a generation debit may legitimately overdraw (§4.6)', () => {
    expect(canUseTier(sessionWith(-750, LADDER), 'standard')).toBe(true);
  });

  it('even when the standard row is missing from the ladder entirely', () => {
    /*
     * A server that ships a ladder with no `standard` row is broken, but the composer must still have
     * something to send. Standard is the platform default model: there is no threshold to check and no
     * operator selector to misconfigure, so it is answered before the ladder is consulted at all.
     */
    const noStandard = sessionWith(0, [LADDER[1], LADDER[2]]);
    expect(canUseTier(noStandard, 'standard')).toBe(true);

    const emptyLadder = sessionWith(0, []);
    expect(canUseTier(emptyLadder, 'standard')).toBe(true);
  });

  it('even when the standard row itself claims to be unserveable and unaffordable', () => {
    const sabotaged = sessionWith(0, [
      rung({ id: 'standard', minimumCredits: 999_999, available: false, serveable: false }),
      LADDER[1],
    ]);

    expect(canUseTier(sabotaged, 'standard')).toBe(true);
  });
});

describe('canUseTier — serveable is the operator wall, and no balance buys past it', () => {
  it('an unserveable rung stays locked at ten million credits while its siblings stay usable', () => {
    const brokenSupermax = sessionWith(10_000_000, [
      LADDER[0],
      LADDER[1],
      rung({ id: 'supermax', minimumCredits: 1500, available: true, serveable: false }),
    ]);

    // The operator's SuperMax selector is unpriceable — the platform would refuse the generation.
    expect(canUseTier(brokenSupermax, 'supermax')).toBe(false);

    // ...and the misconfiguration is scoped to that rung. It must not take the whole picker down.
    expect(canUseTier(brokenSupermax, 'standard')).toBe(true);
    expect(canUseTier(brokenSupermax, 'premium')).toBe(true);
  });

  it('serveable false wins over a passing balance at every threshold boundary', () => {
    for (const balance of [1500, 1501, 100_000, Number.MAX_SAFE_INTEGER]) {
      const session = sessionWith(balance, [rung({ id: 'supermax', minimumCredits: 1500, serveable: false })]);
      expect(canUseTier(session, 'supermax')).toBe(false);
    }
  });
});

describe('canUseTier — the LIVE balance decides, never the server snapshot', () => {
  /*
   * 🔴 The buy-credits-mid-session case. `available` was computed when `/api/me` was fetched; the user
   * has since bought credits and `applySettlement` (or a refresh of the balance alone) moved the
   * number. An implementation reading `available` returns false here and leaves the user staring at a
   * locked row on the screen they just paid on — no error, no log line, nothing to notice.
   */
  it('a rung the snapshot called unavailable is usable once the live balance clears it', () => {
    const justBought = sessionWith(2_000, [
      rung({ id: 'supermax', minimumCredits: 1500, available: false, serveable: true }),
    ]);

    expect(canUseTier(justBought, 'supermax')).toBe(true);
  });

  /*
   * The converse, and the direction that spends money: the snapshot said yes, then generations debited
   * the balance below the threshold. Reading `available` here sends a `supermax` request the server
   * will decline (or, worse, honour at the higher rate against a balance that cannot cover it).
   */
  it('a rung the snapshot called available is locked once the live balance drops below it', () => {
    const spent = sessionWith(900, [rung({ id: 'premium', minimumCredits: 1200, available: true, serveable: true })]);

    expect(canUseTier(spent, 'premium')).toBe(false);
  });

  it('available is inert in both directions — flipping it alone changes no answer', () => {
    for (const balance of [0, 1199, 1200, 5000]) {
      const yes = sessionWith(balance, [rung({ id: 'premium', minimumCredits: 1200, available: true })]);
      const no = sessionWith(balance, [rung({ id: 'premium', minimumCredits: 1200, available: false })]);

      expect(canUseTier(yes, 'premium')).toBe(canUseTier(no, 'premium'));
    }
  });
});

describe('normalizeModelTiers — hostile input never crashes the picker', () => {
  /**
   * The shape contract every return value must satisfy, whatever went in. `tiers` non-empty because the
   * picker maps over it; the booleans REAL booleans because a consumer reading `available === false`
   * and one reading `!available` must agree (an `undefined` there renders an enabled control that
   * hard-fails); `minimumCredits` a number that is never NaN, because `balance >= NaN` is false in a way
   * no reader would predict.
   */
  function expectWellFormed(result: ModelTiersState) {
    expect(typeof result.standardModel).toBe('string');
    expect(result.standardModel.trim().length).toBeGreaterThan(0);
    expect(Array.isArray(result.tiers)).toBe(true);
    expect(result.tiers.length).toBeGreaterThan(0);

    for (const row of result.tiers) {
      expect(typeof row.id).toBe('string');
      expect(typeof row.label).toBe('string');
      expect(typeof row.model).toBe('string');
      expect(typeof row.minimumCredits).toBe('number');
      expect(Number.isNaN(row.minimumCredits)).toBe(false);
      expect(typeof row.available).toBe('boolean');
      expect(typeof row.serveable).toBe('boolean');
    }
  }

  const hostile: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
    ['an array', []],
    ['an empty string', ''],
    ['a number', 0],
    ['a boolean', true],
    ['a function', () => LOCKED_MODEL_TIERS],
    ['tiers: null', { tiers: null }],
    ['tiers: []', { tiers: [] }],
    ['tiers: {}', { tiers: {} }],
    ['tiers: [null, undefined]', { tiers: [null, undefined] }],
    ['tiers: [{}]', { tiers: [{}] }],
    ['tiers rows with no id', { tiers: [{ label: 'SuperMax', minimumCredits: 1500 }] }],
    ['a row missing serveable', { tiers: [{ id: 'supermax', minimumCredits: 1500, available: true }] }],
    ['a row missing minimumCredits', { tiers: [{ id: 'supermax', available: true, serveable: true }] }],
    ['minimumCredits: "lots"', { tiers: [{ id: 'supermax', minimumCredits: 'lots', serveable: true }] }],
    ['minimumCredits: NaN', { tiers: [{ id: 'supermax', minimumCredits: Number.NaN, serveable: true }] }],
    ['minimumCredits: Infinity', { tiers: [{ id: 'supermax', minimumCredits: Number.POSITIVE_INFINITY }] }],
    ['minimumCredits: null', { tiers: [{ id: 'supermax', minimumCredits: null }] }],
    ['standardModel: ""', { standardModel: '', tiers: [{ id: 'standard' }] }],
    ['standardModel: "   "', { standardModel: '   ', tiers: [{ id: 'standard' }] }],
    ['standardModel: 42', { standardModel: 42, tiers: [{ id: 'standard' }] }],
    ['standardModel: null', { standardModel: null, tiers: [{ id: 'standard' }] }],
    ['a numeric id', { tiers: [{ id: 7, serveable: true }] }],
    ['available/serveable as strings', { tiers: [{ id: 'supermax', available: 'yes', serveable: 'yes' }] }],
    ['a deeply nested surprise', { standardModel: { toString: () => 'x' }, tiers: [{ id: 'a', label: { x: 1 } }] }],
    ['a JSON __proto__ payload', JSON.parse('{"__proto__":{"polluted":true},"tiers":[{"id":"supermax"}]}')],
  ];

  for (const [name, value] of hostile) {
    it(`${name} yields a well-formed ladder, no throw`, () => {
      let result!: ModelTiersState;

      expect(() => {
        result = normalizeModelTiers(value);
      }).not.toThrow();

      expectWellFormed(result);
    });
  }

  it('a JSON __proto__ payload does not pollute Object.prototype', () => {
    normalizeModelTiers(JSON.parse('{"__proto__":{"polluted":true},"tiers":[{"id":"supermax"}]}'));

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('unusable shapes fall back to the LOCKED default rather than to something invented', () => {
    for (const value of [null, undefined, {}, [], '', 0, { tiers: [] }, { tiers: [null] }, { tiers: [{}] }]) {
      expect(normalizeModelTiers(value)).toEqual(LOCKED_MODEL_TIERS);
    }
  });

  it('a well-formed ladder survives intact', () => {
    const wire = {
      standardModel: 'claude-sonnet-5',
      tiers: [
        {
          id: 'standard',
          label: 'Standard',
          model: 'claude-sonnet-5',
          minimumCredits: 0,
          available: true,
          serveable: true,
        },
        {
          id: 'supermax',
          label: 'SuperMax',
          model: 'claude-fable-5',
          minimumCredits: 1500,
          available: false,
          serveable: true,
        },
      ],
    };

    expect(normalizeModelTiers(wire)).toEqual(wire);
  });

  it('an unknown extra field is dropped rather than carried into the store', () => {
    const result = normalizeModelTiers({
      standardModel: 'claude-sonnet-5',
      tiers: [{ id: 'supermax', minimumCredits: 1500, available: true, serveable: true, secretDiscount: true }],
    });

    expect(result.tiers[0]).not.toHaveProperty('secretDiscount');
  });

  it('a blank or non-string standardModel falls back to the platform default', () => {
    for (const value of ['', '   ', 42, null, undefined, {}]) {
      expect(normalizeModelTiers({ standardModel: value, tiers: [{ id: 'standard' }] }).standardModel).toBe(
        DEFAULT_MODEL,
      );
    }
  });
});

describe('normalizeModelTiers — a half-described row ends LOCKED, never unlocked', () => {
  /*
   * `=== true` rather than truthiness, and a non-finite threshold as `Infinity`. Both rules point the
   * same way: the field the server FAILED to send must not be the field that unlocks an expensive rung.
   * Asserted through `canUseTier` at an absurd balance, because that is what the rule is FOR — a shape
   * assertion alone would pass against an implementation that stored the right value and read it wrong.
   */
  const rich = 10_000_000;

  it('a row with no serveable field is locked', () => {
    const tiers = normalizeModelTiers({ tiers: [{ id: 'supermax', minimumCredits: 1500, available: true }] });

    expect(tiers.tiers[0].serveable).toBe(false);
    expect(canUseTier(sessionWith(rich, tiers.tiers), 'supermax')).toBe(false);
  });

  it('a row with no minimumCredits is unaffordable at any balance', () => {
    const tiers = normalizeModelTiers({ tiers: [{ id: 'supermax', available: true, serveable: true }] });

    expect(tiers.tiers[0].minimumCredits).toBe(Number.POSITIVE_INFINITY);
    expect(canUseTier(sessionWith(rich, tiers.tiers), 'supermax')).toBe(false);
  });

  it('a non-numeric minimumCredits is unaffordable, not free', () => {
    for (const minimumCredits of ['lots', Number.NaN, null, undefined, {}, '1500']) {
      const tiers = normalizeModelTiers({ tiers: [{ id: 'supermax', minimumCredits, serveable: true }] });

      expect(tiers.tiers[0].minimumCredits).toBe(Number.POSITIVE_INFINITY);
      expect(canUseTier(sessionWith(rich, tiers.tiers), 'supermax')).toBe(false);
    }
  });

  it('a truthy-but-not-true serveable or available is normalised to false', () => {
    const tiers = normalizeModelTiers({
      tiers: [{ id: 'supermax', minimumCredits: 0, available: 'yes', serveable: 1 }],
    });

    expect(tiers.tiers[0].available).toBe(false);
    expect(tiers.tiers[0].serveable).toBe(false);
    expect(canUseTier(sessionWith(rich, tiers.tiers), 'supermax')).toBe(false);
  });
});

describe('the store default and the /api/me merge', () => {
  beforeEach(() => {
    sessionStore.set(EMPTY_SESSION);
    vi.unstubAllGlobals();
  });

  it('EMPTY_SESSION ships the locked ladder', () => {
    expect(EMPTY_SESSION.credits.modelTiers).toEqual(LOCKED_MODEL_TIERS);
    expect(EMPTY_SESSION.credits.modelTiers.standardModel).toBe(DEFAULT_MODEL);
  });

  it('the locked default lists every rung with the paid ones locked', () => {
    const paid = LOCKED_MODEL_TIERS.tiers.filter((tier) => tier.id !== 'standard');

    // Listed, not omitted: the picker keeps a stable shape and can explain what it would take.
    expect(paid.length).toBeGreaterThan(0);

    for (const tier of paid) {
      expect(tier.serveable).toBe(false);
      expect(canUseTier(sessionWith(10_000_000, LOCKED_MODEL_TIERS.tiers), tier.id)).toBe(false);
    }

    expect(canUseTier(sessionWith(0, LOCKED_MODEL_TIERS.tiers), 'standard')).toBe(true);
  });

  /** Stub `fetch` with one canned `/api/me` body. */
  function stubMe(body: unknown, ok = true) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok, json: async () => body })),
    );
  }

  it('a credits block with NO modelTiers key leaves the store on the locked default', async () => {
    // The older-deploy case: the shallow merge backfills from EMPTY_SESSION and the normaliser confirms it.
    stubMe({
      authenticated: true,
      accountsEnabled: true,
      credits: { balance: 4_000, enforced: true, purchasable: true, packs: [], plans: [] },
    });

    const next = await refreshSession();

    expect(next.credits.modelTiers).toEqual(LOCKED_MODEL_TIERS);
    expect(sessionStore.get().credits.modelTiers).toEqual(LOCKED_MODEL_TIERS);

    // ...and with a 4,000-credit balance the paid rungs are STILL locked, because nothing is serveable.
    expect(canUseTier(next, 'premium')).toBe(false);
    expect(canUseTier(next, 'supermax')).toBe(false);
    expect(canUseTier(next, 'standard')).toBe(true);
  });

  it('a HALF-formed modelTiers is replaced by the locked default, not stored as undefined.tiers', async () => {
    // The shallow merge would otherwise hand the picker `tiers: undefined` — a blank screen.
    stubMe({
      authenticated: true,
      credits: { balance: 9_000, modelTiers: { standardModel: 'claude-sonnet-5' } },
    });

    const next = await refreshSession();

    expect(Array.isArray(next.credits.modelTiers.tiers)).toBe(true);
    expect(next.credits.modelTiers).toEqual(LOCKED_MODEL_TIERS);
    expect(() => next.credits.modelTiers.tiers.find((tier) => tier.id === 'supermax')).not.toThrow();
  });

  it('a well-formed ladder from the server reaches the store and unlocks against the live balance', async () => {
    stubMe({
      authenticated: true,
      credits: {
        balance: 1_500,
        modelTiers: {
          standardModel: 'claude-sonnet-5',
          tiers: [
            {
              id: 'standard',
              label: 'Standard',
              model: 'claude-sonnet-5',
              minimumCredits: 0,
              available: true,
              serveable: true,
            },
            {
              id: 'supermax',
              label: 'SuperMax',
              model: 'claude-fable-5',
              minimumCredits: 1500,

              // The snapshot says no; the live balance says yes. The live balance wins.
              available: false,
              serveable: true,
            },
          ],
        },
      },
    });

    const next = await refreshSession();

    expect(next.credits.modelTiers.standardModel).toBe('claude-sonnet-5');
    expect(canUseTier(next, 'supermax')).toBe(true);
  });

  it('a failed /api/me leaves the locked ladder rather than an empty one', async () => {
    stubMe({}, false);

    const next = await refreshSession();

    expect(next.credits.modelTiers).toEqual(LOCKED_MODEL_TIERS);
    expect(next.loading).toBe(false);
  });

  it('a thrown fetch (offline, mid-deploy) leaves the locked ladder', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );

    const next = await refreshSession();

    expect(next.credits.modelTiers).toEqual(LOCKED_MODEL_TIERS);
    expect(canUseTier(next, 'standard')).toBe(true);
    expect(canUseTier(next, 'premium')).toBe(false);
  });
});

/*
 * ============================================================================================
 * THE SETTLEMENT PATH ITSELF (§4.6.1a)
 *
 * The live-balance property is pinned above by CONSTRUCTING a session at a given balance. That is not
 * the same path as the one the plan actually names: a generation settles, `applySettlement` writes the
 * new balance into the store, and the picker must re-lock off the store's own state.
 *
 * 🔴 Measured: replacing `applySettlement`'s spread with `{ ...EMPTY_SESSION.credits, balance }` — a
 * plausible-looking edit that drops the ladder on every settlement — left all 4,063 tests green. Its
 * effect is that every paid rung locks PERMANENTLY after a user's first generation, on a session that
 * still shows the right balance, until they reload. The abstract property test cannot see it, because
 * it never routes through the store.
 * ============================================================================================
 */
describe('applySettlement — a settlement re-locks a rung the user can no longer afford', () => {
  const PREMIUM_MINIMUM = 1_200;

  function ladder(): ModelTiersState {
    return {
      standardModel: 'claude-sonnet-5',
      tiers: [
        {
          id: 'standard',
          label: 'Standard',
          model: 'claude-sonnet-5',
          minimumCredits: 0,
          available: true,
          serveable: true,
        },
        {
          id: 'premium',
          label: 'Premium',
          model: 'claude-opus-5',
          minimumCredits: PREMIUM_MINIMUM,
          available: true,
          serveable: true,
        },
      ],
    };
  }

  function seed(balance: number) {
    sessionStore.set({
      ...EMPTY_SESSION,
      loading: false,
      authenticated: true,
      credits: { ...EMPTY_SESSION.credits, balance, modelTiers: ladder() },
    });
  }

  it('re-locks premium when the settled balance falls below its threshold', () => {
    seed(PREMIUM_MINIMUM + 100);
    expect(canUseTier(sessionStore.get(), 'premium'), 'CONTROL — usable before the settlement').toBe(true);

    applySettlement(PREMIUM_MINIMUM - 1);

    expect(sessionStore.get().credits.balance).toBe(PREMIUM_MINIMUM - 1);
    expect(canUseTier(sessionStore.get(), 'premium')).toBe(false);
  });

  /*
   * The other direction, and the one a dropped ladder makes permanent: a settlement that leaves the
   * user ABOVE the threshold must not lock anything. This is the assertion the mutation fails.
   */
  it('keeps a rung usable when the settled balance still clears it', () => {
    seed(10_000);

    applySettlement(9_000);

    expect(canUseTier(sessionStore.get(), 'premium')).toBe(true);
    expect(sessionStore.get().credits.modelTiers.tiers).toHaveLength(2);
  });

  /* The ladder is state about the PLATFORM, not about this turn — a settlement must not touch it. */
  it('carries the ladder through untouched', () => {
    seed(10_000);

    applySettlement(9_000);

    expect(sessionStore.get().credits.modelTiers).toEqual(ladder());
  });

  /* Standard survives any balance, including one a generation drove negative (§4.6 allows it). */
  it('never locks standard, even on a balance driven negative', () => {
    seed(50);

    applySettlement(-400);

    expect(canUseTier(sessionStore.get(), 'standard')).toBe(true);
  });

  /* A null balance means "nothing settled" — the store must be left exactly as it was. */
  it('leaves the session alone when nothing settled', () => {
    seed(10_000);

    const before = sessionStore.get();
    applySettlement(null);

    expect(sessionStore.get()).toBe(before);
  });
});

/*
 * The free rung of the LOCKED DEFAULT specifically. Every other assertion about that default filters
 * standard out, and `canUseTier` short-circuits `'standard'` before it ever reads the row — so the row
 * could be marked unserveable and nothing would notice, until T11's picker drew a lock on the one rung
 * every user can always use. The server's degraded ladder reports standard serveable
 * (`modelTiersSessionHint`), and the two fallbacks must not disagree about the same fault.
 */
describe('LOCKED_MODEL_TIERS — the free rung is never locked', () => {
  it('marks standard serveable and available even in the locked default', () => {
    const standard = LOCKED_MODEL_TIERS.tiers.find((tier) => tier.id === 'standard');

    expect(standard).toBeDefined();
    expect(standard!.serveable).toBe(true);
    expect(standard!.available).toBe(true);
    expect(standard!.minimumCredits).toBe(0);
  });

  it('CONTROL — the paid rungs in that same default really are locked', () => {
    for (const tier of LOCKED_MODEL_TIERS.tiers.filter((row) => row.id !== 'standard')) {
      expect(tier.serveable, `${tier.id} must be locked in the default`).toBe(false);
      expect(tier.available).toBe(false);
    }
  });
});
