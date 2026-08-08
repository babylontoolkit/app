/**
 * THE SESSION PAYLOAD — `/api/me`'s loader, driven for real (§4.6.1a, T8).
 *
 * T8 replaced `credits.premium` with `credits.modelTiers`, assembled in the route from three pieces
 * that each fail differently: `getPlatformModel` (throws on an unpriceable `LLM_MODEL`),
 * `getModelTiers` (never throws, but can be reached through a `getBillingConfig` refusal), and
 * `modelTiersSessionHint` (total by construction). The pure halves are already pinned —
 * `premium.spec.ts` owns the hint's rules, `model-tiers.spec.ts` owns the ladder's — and neither can
 * see the thing this file exists for: whether the ROUTE still holds them apart.
 *
 * 🔴 Why a route this boring is worth a live drive. `/api/me` is the session endpoint on EVERY page
 * load, and the 2026-07-25 outage was one unguarded call inside its response literal: a misconfigured
 * `PREMIUM_MODEL` — a variable that only decides how a toggle RENDERS — threw past the object into the
 * loader's catch and took the whole app down for every user. Generalizing two rungs into three
 * multiplies the ways an operator reaches that state, so the property under test is not "the hint is
 * correct", it is **"nothing an operator can type in an env file can make this loader return anything
 * but 200"**. A source scan cannot see that; only calling the loader can.
 *
 * ⚠️ A spec file must NEVER live in `app/routes/` (Remix compiles it as a route, the manifest imports
 * `vitest` at runtime, and every request 500s). Route tests live beside the code they exercise, which
 * is why this sits in `billing/` next to the functions the payload is built from.
 *
 * ⚠️ `env()` falls back to `process.env` and Vitest loads `.env.local` — which on this machine sets
 * `LLM_MODEL`, `LLM_PROVIDER`, `PREMIUM_MODEL`, `PREMIUM_MINIMUM_CREDITS`, `KIE_DEFAULT_MODEL` and
 * both platform keys — plus, on an upgrading machine, the RETIRED `ENABLE_EXTENDED_MODELS` and
 * `SUPERMAX_*`, which now make the ladder refuse. Every case scrubs the WHOLE
 * precedence chain before saying what it means to say (the `oauth.spec.ts` trap, which has now fired
 * twice in this repo for want of one sibling in a scrub list).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateMarketPricesCache } from '~/lib/.server/billing/market-price-store';
import { BAKED_MARKET_PRICES } from '~/lib/.server/billing/baked-market-prices';
import { DEFAULT_PREMIUM_MODEL } from '~/lib/.server/billing/model-tiers';
import { DEFAULT_MODEL } from '~/utils/constants';
import { loader as meLoader } from '~/routes/api.me';

/*
 * The loader's three doors to the WORLD, and nothing else.
 *
 * Every mock SPREADS the original rather than replacing the module: the route needs one or two
 * exports from each, but a plain factory silently deletes the rest for anything else that reaches
 * this module graph — `rates.ts` reads `activeMarketPrices` out of the price store, and
 * `ensureSignupGrant` shares a module with the ledger types. Spreading also keeps function identity,
 * so the price store's module-level cache is the same cache `invalidateMarketPricesCache` clears.
 *
 * - `getUser` — the session. Mocked so no Supabase client is ever built.
 * - `getLedger` / `ensureSignupGrant` — the BALANCE, and the only writer on this path. Unmocked,
 *   `getLedger` falls through to `FsLedger` and a verified session would deposit real grant rows in
 *   the developer's `.data/ledger` (the trap that put ~200 real rows in `.data/chats` once already).
 * - `ensureMarketPrices` — the async doorway. Mocked to a spy so the ACTIVE list is deterministically
 *   the baked one rather than whatever the developer has promoted into `.data/storage`.
 */
const doors = vi.hoisted(() => ({
  getUser: vi.fn(),
  getLedger: vi.fn(),
  ensureSignupGrant: vi.fn(),
  ensureMarketPrices: vi.fn(),
  getModelTiers: vi.fn(),
}));

vi.mock('~/lib/.server/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getUser: doors.getUser,
}));

vi.mock('~/lib/.server/billing/ledger', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLedger: doors.getLedger,
  ensureSignupGrant: doors.ensureSignupGrant,
}));

vi.mock('~/lib/.server/billing/market-price-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureMarketPrices: doors.ensureMarketPrices,
}));

/*
 * ⚠️ NOT a door — a PASS-THROUGH, and the distinction is the whole reason this mock is safe.
 *
 * `getModelTiers` is total by construction (it catches per rung internally), so no environment can
 * make it throw and the route's try/catch around it is defense in depth with no reachable trigger.
 * Verified by mutation: deleting that guard leaves all 31 other tests green — i.e. without this seam
 * the guard is unpinned, and the next refactor that gives `getModelTiers` a throw ABOVE its own loop
 * (a validation, a store read, a `refuseRetired*` moved one line up) restores the 2026-07-25 outage
 * with nothing failing.
 *
 * So it is wrapped, not replaced: the default implementation calls the real function, every other
 * test in this file runs against real ladder resolution, and exactly one test makes it throw.
 */
vi.mock('~/lib/.server/billing/rates', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  doors.getModelTiers.mockImplementation((...args: unknown[]) =>
    (original.getModelTiers as (...a: unknown[]) => unknown)(...args),
  );

  return { ...original, getModelTiers: doors.getModelTiers };
});

/**
 * Every variable that can reach the session payload: the tier selectors and thresholds, the platform
 * model chain, the RETIRED price vars (which throw before any of the above is read), the billing
 * config, the grant, and the secrets whose absence from the wire is asserted below.
 *
 * The list is deliberately longer than any single case needs. A scrub list that covers only "the
 * variable under test" is exactly how `LLM_MODEL` outranked `KIE_DEFAULT_MODEL` inside a green test
 * on one developer's machine.
 */
const SESSION_ENV = [
  // the platform model chain, in precedence order
  'LLM_MODEL',
  'LLM_PROVIDER',
  'KIE_DEFAULT_MODEL',

  // the paid rungs
  'PREMIUM_MODEL',
  'PREMIUM_MINIMUM_CREDITS',
  'ENABLE_PREMIUM_MODEL',

  // Retired 2026-08-08 and REFUSED if set — a leftover would degrade the ladder in every case here.
  'ENABLE_EXTENDED_MODELS',
  'SUPERMAX_MODEL',
  'SUPERMAX_MINIMUM_CREDITS',

  // retired, and REFUSED — these throw inside every rung resolution
  'KIE_INPUT_DOLLARS',
  'KIE_OUTPUT_DOLLARS',
  'KIE_CACHED_INPUT',
  'KIE_CACHED_WRITES',
  'PREMIUM_INPUT_DOLLARS',
  'PREMIUM_OUTPUT_DOLLARS',
  'CREATION_FLAT_CREDITS',

  // billing config + the grant
  'BILLING_ENFORCED',
  'CREDIT_UNIT_COST_USD',
  'CREDIT_MARGIN',
  'SIGNUP_GRANT_CREDITS',
  'GRANTS_ENABLED',
  'PROJECT_CREATE_CREDITS',

  // capability flags and vendors
  'PRO_FEATURES_ENABLED',
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'MONITORING_WEBHOOK_URL',
  'ANALYTICS_WEBHOOK_URL',

  // server-only credentials `getPlatformConfig` reads five lines above the tier block
  'ANTHROPIC_API_KEY',
  'KIE_API_KEY',
  'ADMIN_TOKEN',
  'GITHUB_API_KEY',
  'VITE_GITHUB_ACCESS_TOKEN',
] as const;

/** Scrub the whole chain, then apply only what this case means to say. */
function stubSessionEnv(vars: Partial<Record<string, string>> = {}) {
  for (const key of SESSION_ENV) {
    vi.stubEnv(key, (vars[key] ?? undefined) as unknown as string);
  }

  for (const [key, value] of Object.entries(vars)) {
    if (!(SESSION_ENV as readonly string[]).includes(key)) {
      vi.stubEnv(key, value as string);
    }
  }
}

/** A model id nothing prices, on purpose — the shape of every operator typo this file is about. */
const UNPRICEABLE = 'claude-nonesuch-9';

interface TierRow {
  id: string;
  label: string;
  model: string;
  minimumCredits: number;
  available: boolean;
}

interface SessionPayload {
  authenticated: boolean;
  accountsEnabled?: boolean;
  proFeaturesEnabled?: boolean;
  user?: Record<string, unknown>;
  credits?: {
    balance: number;
    enforced: boolean;
    purchasable: boolean;
    packs: unknown[];
    plans: unknown[];
    modelTiers: { standardModel: string; tiers: TierRow[] };
  };
  pro?: Record<string, unknown>;
}

/** Call the REAL loader and read the REAL response — status included, because status is the point. */
async function callMe(): Promise<{ status: number; body: SessionPayload; wire: string }> {
  const response = await (
    meLoader as unknown as (args: {
      request: Request;
      context: unknown;
      params: Record<string, string>;
    }) => Promise<Response>
  )({ request: new Request('http://localhost/api/me'), context: {}, params: {} });

  const wire = await response.text();

  return { status: response.status, body: JSON.parse(wire) as SessionPayload, wire };
}

function tiersOf(body: SessionPayload): Record<string, TierRow> {
  const rows = body.credits?.modelTiers?.tiers ?? [];
  return Object.fromEntries(rows.map((row) => [row.id, row]));
}

/** Sign in as a verified, non-admin user holding `balance` credits. */
function signedIn(balance: number) {
  doors.getUser.mockResolvedValue({
    id: 'user_1',
    email: 'dev@example.com',
    displayName: 'Dev',
    emailVerified: true,
    isAdmin: false,
    isLocal: false,
  });
  doors.getLedger.mockReturnValue({ balance: vi.fn(async () => balance) });
}

beforeEach(() => {
  invalidateMarketPricesCache();
  doors.getUser.mockReset();
  doors.getLedger.mockReset();
  doors.ensureSignupGrant.mockReset();
  doors.ensureMarketPrices.mockReset();
  doors.ensureSignupGrant.mockResolvedValue(null);
  doors.ensureMarketPrices.mockResolvedValue(BAKED_MARKET_PRICES);

  // `mockClear`, never `mockReset` — a reset would drop the pass-through to the real implementation.
  doors.getModelTiers.mockClear();
  signedIn(10_000);
});

afterEach(() => {
  vi.unstubAllEnvs();
  invalidateMarketPricesCache();
});

/* ============================================================ 1. CONTROLS — the drive is real */

describe('CONTROLS — the drive reaches the loader and the payload is the real one', () => {
  it('returns the whole authenticated payload, with the ladder in it', async () => {
    stubSessionEnv();

    const { status, body } = await callMe();

    expect(status).toBe(200);
    expect(body.authenticated).toBe(true);
    expect(body.user?.email).toBe('dev@example.com');
    expect(body.credits?.balance).toBe(10_000);
    expect(body.credits?.packs.length).toBeGreaterThan(0);
    expect(body.credits?.plans.length).toBeGreaterThan(0);
    expect(body.pro).toBeDefined();
    expect(body.accountsEnabled).toBeTypeOf('boolean');

    // The ladder, in rung order — three rungs, standard first.
    expect(body.credits?.modelTiers.tiers.map((row) => row.id)).toEqual(['standard', 'premium']);
  });

  it('reports the balance the ledger actually returned, not a constant wearing its name', async () => {
    stubSessionEnv();
    signedIn(4_242);

    const { body } = await callMe();

    expect(body.credits?.balance).toBe(4_242);
  });

  it('CONTROL — a signed-out session takes the short branch, so the payload above is a real choice', async () => {
    stubSessionEnv();
    doors.getUser.mockResolvedValue(null);

    const { status, body } = await callMe();

    expect(status).toBe(200);
    expect(body.authenticated).toBe(false);
    expect(body.credits).toBeUndefined();
  });

  /*
   * The async doorway (§"the Marketplace price list"). Every rung is priced from the ACTIVE list, and
   * the list is only refreshed at async entry points — so a loader that stops calling this serves the
   * baked prices forever after a promotion, silently, on the one screen an operator would use to check
   * that their promotion took. Nothing else on this path would notice: the payload stays well-formed.
   */
  it('refreshes the Marketplace price list at its async doorway, before pricing any rung', async () => {
    stubSessionEnv();

    await callMe();

    expect(doors.ensureMarketPrices).toHaveBeenCalledTimes(1);
  });

  /*
   * 🔴 BEFORE, not merely AT SOME POINT — the test above cannot tell the difference, and the difference
   * is the entire defect. Measured: MOVING the `ensureMarketPrices` call down to just above the
   * `return json(...)` left the assertion above green, while every rung had already been priced from
   * the stale in-process cache. That is exactly the symptom the doorway exists to prevent — an
   * operator promotes a price list, reloads, and `/api/me` still reports the old model, on the one
   * screen they would use to confirm the promotion took.
   *
   * Order is observed rather than asserted about source text: the refresh must have completed before
   * anything asked the ladder what it costs.
   */
  it('refreshes the price list BEFORE the ladder is resolved, not merely somewhere in the loader', async () => {
    stubSessionEnv();

    const order: string[] = [];

    doors.ensureMarketPrices.mockImplementationOnce(async () => {
      order.push('refresh');
      return undefined;
    });

    const realGetModelTiers = doors.getModelTiers.getMockImplementation()!;
    doors.getModelTiers.mockImplementationOnce((...args: unknown[]) => {
      order.push('resolve-ladder');
      return realGetModelTiers(...args);
    });

    await callMe();

    expect(order, 'the ladder was priced before the price list was refreshed').toEqual(['refresh', 'resolve-ladder']);
  });
});

/* ============================================================ 2. A misconfigured paid rung */

describe('a misconfigured PREMIUM_MODEL degrades that rung to off and takes nothing else down', () => {
  /** The acceptance case, at a balance that clears every threshold many times over. */
  async function withBrokenPaidRung() {
    stubSessionEnv({ PREMIUM_MODEL: UNPRICEABLE, PREMIUM_MINIMUM_CREDITS: '1500' });
    signedIn(10_000_000);

    return callMe();
  }

  it('still returns 200 — a rendering hint must never be an outage', async () => {
    const { status } = await withBrokenPaidRung();
    expect(status).toBe(200);
  });

  it('reports the paid rung as unavailable, at a balance that clears its threshold a thousand times', async () => {
    const { body } = await withBrokenPaidRung();

    expect(tiersOf(body).premium.available).toBe(false);
  });

  /*
   * 🔴 Names the in-code default, NOT the unpriceable selector. Putting `claude-nonesuch-9` on the
   * wire would show the user a model the platform has already refused to bill.
   */
  it('names the baked default rather than the selector it refused', async () => {
    const { body } = await withBrokenPaidRung();

    expect(tiersOf(body).premium.model).toBe(DEFAULT_PREMIUM_MODEL);
    expect(JSON.stringify(body)).not.toContain(UNPRICEABLE);
  });

  it('still states what the locked rung would cost to unlock', async () => {
    const { body } = await withBrokenPaidRung();

    expect(tiersOf(body).premium.minimumCredits).toBe(1500);
  });

  /*
   * ⚠️ Until 2026-08-08 this also asserted that a healthy SIBLING PAID rung was untouched. That went
   * with the third rung; the free rung is what remains, and it is the half that matters — a broken
   * operator selector must never tell a signed-in user the platform itself is unavailable.
   */
  it('leaves the free rung alone — one broken selector is not a broken ladder', async () => {
    const { body } = await withBrokenPaidRung();
    const tiers = tiersOf(body);

    expect(Object.keys(tiers)).toEqual(['standard', 'premium']);
    expect(tiers.standard.available).toBe(true);
    expect(tiers.standard.model).toBe(DEFAULT_MODEL);
    expect(tiers.premium.available, 'the broken rung is the only one withdrawn').toBe(false);
  });

  it('leaves the rest of the payload intact', async () => {
    const { body } = await withBrokenPaidRung();

    expect(body.authenticated).toBe(true);
    expect(body.credits?.balance).toBe(10_000_000);
    expect(body.credits?.enforced).toBeTypeOf('boolean');
    expect(body.credits?.purchasable).toBeTypeOf('boolean');
    expect(body.credits?.packs.length).toBeGreaterThan(0);
    expect(body.credits?.plans.length).toBeGreaterThan(0);
    expect(body.pro?.proFeaturesEnabled).toBe(false);
    expect(body.pro?.byokUnlocked).toBe(false);
  });

  /*
   * CONTROL. Without it, an `available: false` that is simply always false passes every assertion
   * above — the exact shape of a degraded-capability test that measures nothing.
   */
  it('CONTROL — a priceable selector is available at the same balance', async () => {
    stubSessionEnv({ PREMIUM_MODEL: DEFAULT_PREMIUM_MODEL, PREMIUM_MINIMUM_CREDITS: '1500' });
    signedIn(10_000_000);

    const { body } = await callMe();

    expect(tiersOf(body).premium.available).toBe(true);
    expect(tiersOf(body).premium.model).toBe(DEFAULT_PREMIUM_MODEL);
  });

  /*
   * The other direction of the same guard: a rung the platform CAN serve is still locked below its
   * threshold. `available` is "may this user pick it now", not "does it exist".
   */
  it('CONTROL — a healthy rung one credit below its threshold is locked, and available at it', async () => {
    stubSessionEnv({ PREMIUM_MINIMUM_CREDITS: '1500' });
    signedIn(1_499);

    expect(tiersOf((await callMe()).body).premium.available).toBe(false);

    signedIn(1_500);
    expect(tiersOf((await callMe()).body).premium.available).toBe(true);
  });

  /*
   * A retired price var throws inside `getModelTier` for EVERY rung at once (`refuseRetiredPriceEnv`
   * runs first). The ladder must come back whole with both paid rungs locked — this is the state an
   * operator is in for the minute between an upgrade and cleaning up their env file.
   */
  it('locks every paid rung — and still answers 200 — when a retired price var is set', async () => {
    stubSessionEnv({ PREMIUM_INPUT_DOLLARS: '2.0' });
    signedIn(10_000_000);

    const { status, body } = await callMe();
    const tiers = tiersOf(body);

    expect(status).toBe(200);
    expect(tiers.standard.available).toBe(true);
    expect(tiers.premium.available).toBe(false);
    expect(tiers.premium.available).toBe(false);
  });
});

/* ============================================================ 3. No billing configuration */

describe('no billing configuration at all', () => {
  it('answers 200 with a well-formed ladder when every billing variable is unset', async () => {
    stubSessionEnv();

    const { status, body } = await callMe();
    const tiers = tiersOf(body);

    expect(status).toBe(200);
    expect(body.credits?.modelTiers.standardModel).toBe(DEFAULT_MODEL);
    expect(tiers.standard).toMatchObject({ id: 'standard', minimumCredits: 0, available: true });
    expect(tiers.premium).toMatchObject({ id: 'premium', model: DEFAULT_PREMIUM_MODEL, available: true });
    expect(tiers.premium).toMatchObject({ id: 'premium', model: DEFAULT_PREMIUM_MODEL, available: true });
  });

  /*
   * `getBillingConfigSafe` returning NULL is a different state from "no variables set": it is the
   * config being UNREADABLE, which `CREATION_FLAT_CREDITS` (retired, refused) produces exactly. The
   * loader must still answer, and must report `enforced: true` — the conservative reading, since
   * telling a client that credits do not bind when we cannot tell is the same class of invention as
   * advertising a tier we cannot serve.
   */
  it('answers 200 with the ladder intact when the billing config cannot be read at all', async () => {
    stubSessionEnv({ CREATION_FLAT_CREDITS: '500' });

    const { status, body } = await callMe();

    expect(status).toBe(200);
    expect(body.credits?.enforced).toBe(true);
    expect(body.credits?.modelTiers.tiers.map((row) => row.id)).toEqual(['standard', 'premium']);
    expect(tiersOf(body).premium.model).toBe(DEFAULT_PREMIUM_MODEL);
  });

  it('issues no grant when the configuration it would size the grant from is unreadable', async () => {
    stubSessionEnv({ CREATION_FLAT_CREDITS: '500' });

    await callMe();

    expect(doors.ensureSignupGrant).not.toHaveBeenCalled();
  });

  /*
   * The route's LAST guard, and the only one no environment can trigger — see the pass-through mock's
   * comment. A ladder that cannot be resolved AT ALL still has to answer, and it answers with the
   * in-code rungs, the paid ones LOCKED: reporting no rungs would render a picker with a single option
   * and teach the user that this platform has one model, which is a config fault wearing the clothes
   * of a product decision.
   */
  it('answers 200 with the in-code rungs, locked, when the ladder itself cannot be resolved', async () => {
    stubSessionEnv();
    signedIn(10_000_000);
    doors.getModelTiers.mockImplementationOnce(() => {
      throw new Error('the ladder could not be resolved');
    });

    const { status, body } = await callMe();
    const tiers = tiersOf(body);

    expect(status).toBe(200);
    expect(body.credits?.modelTiers.standardModel).toBe(DEFAULT_MODEL);
    expect(Object.keys(tiers)).toEqual(['standard', 'premium']);
    expect(tiers.standard.available).toBe(true);
    expect(tiers.premium.available).toBe(false);
    expect(tiers.premium.available).toBe(false);
  });

  it('leaks nothing when the ladder itself cannot be resolved', async () => {
    stubSessionEnv(SENTINELS);
    doors.getModelTiers.mockImplementationOnce(() => {
      throw new Error(`the ladder could not be resolved: ${SENTINELS.ANTHROPIC_API_KEY}`);
    });

    assertNothingServerOnly(await callMe());
  });

  it('CONTROL — a readable configuration DOES reach the grant, so the assertion above is a choice', async () => {
    stubSessionEnv({ SIGNUP_GRANT_CREDITS: '1000' });

    await callMe();

    expect(doors.ensureSignupGrant).toHaveBeenCalledTimes(1);
  });
});

/* ============================================================ 4. An unresolvable platform model */

describe('an unresolvable platform model falls back rather than failing the session', () => {
  it('answers 200 and names DEFAULT_MODEL when LLM_MODEL cannot be priced', async () => {
    stubSessionEnv({ LLM_MODEL: UNPRICEABLE });

    const { status, body } = await callMe();

    expect(status).toBe(200);
    expect(body.credits?.modelTiers.standardModel).toBe(DEFAULT_MODEL);
    expect(tiersOf(body).standard.model).toBe(DEFAULT_MODEL);
  });

  it('keeps the standard rung usable — the free rung is never reported as locked', async () => {
    stubSessionEnv({ LLM_MODEL: UNPRICEABLE });
    signedIn(0);

    const { body } = await callMe();

    expect(tiersOf(body).standard.available).toBe(true);
    expect(tiersOf(body).standard.minimumCredits).toBe(0);
  });

  it('resolves the paid rungs anyway — the standard rung failing is not the ladder failing', async () => {
    stubSessionEnv({ LLM_MODEL: UNPRICEABLE });
    signedIn(10_000_000);

    const tiers = tiersOf((await callMe()).body);

    expect(tiers.premium).toMatchObject({ model: DEFAULT_PREMIUM_MODEL, available: true });
    expect(tiers.premium).toMatchObject({ model: DEFAULT_PREMIUM_MODEL, available: true });
  });

  it('CONTROL — a priceable LLM_MODEL is reported as itself, not as the fallback', async () => {
    stubSessionEnv({ LLM_MODEL: 'claude-opus-4-8' });

    const { body } = await callMe();

    expect(body.credits?.modelTiers.standardModel).toBe('claude-opus-4-8');
    expect(tiersOf(body).standard.model).toBe('claude-opus-4-8');
  });

  /*
   * Both halves broken at once. Each is individually guarded in the route, and a single try/catch
   * around the pair would pass every test above while collapsing here.
   */
  it('survives an unpriceable platform model AND an unpriceable paid rung together', async () => {
    stubSessionEnv({ LLM_MODEL: UNPRICEABLE, PREMIUM_MODEL: UNPRICEABLE });
    signedIn(10_000_000);

    const { status, body } = await callMe();
    const tiers = tiersOf(body);

    expect(status).toBe(200);
    expect(body.credits?.modelTiers.standardModel).toBe(DEFAULT_MODEL);
    expect(tiers.standard.available, 'the free rung falls back to the in-code default, not to nothing').toBe(true);
    expect(tiers.premium.available, 'the unpriceable rung is withdrawn, not invented').toBe(false);
  });

  /*
   * 🔴 A FINDING, NOT A PROPERTY — CHARACTERIZATION, AND THE ONLY ASSERTION IN THIS FILE THAT PINS
   * BEHAVIOUR WE DO NOT WANT.
   *
   * `getPlatformProvider` throws on a `LLM_PROVIDER` that is not a provider, and it is reached from
   * `getPlatformConfig(context)` on the FOURTH line of the loader — outside every guard the tier block
   * added, because `getPlatformConfig` has never been wrapped. So a typo'd provider name still returns
   * **503 on the session endpoint for every user**: exactly the 2026-07-25 outage, through a different
   * variable, in a call the tier block's own comment describes as "guarded for the same reason" (that
   * sentence is about `getPlatformModel`, not about `getPlatformConfig`).
   *
   * PRE-EXISTING and untouched by T8 — `git diff` shows that line unchanged — so it is FLAGGED here
   * rather than fixed under a task that was not asked to change it. The fix is one try/catch plus an
   * honest degraded `PlatformConfig` (`proFeaturesEnabled: false` is the safe reading, matching every
   * other degrade-to-off on this path).
   *
   * ⚠️ WHEN IT IS FIXED, FLIP THIS TEST — 200 with `standardModel === DEFAULT_MODEL` is the intended
   * direction, and this expectation failing means someone did the right thing.
   */
  it('FINDING (pre-existing) — an invalid LLM_PROVIDER still 503s the whole session endpoint', async () => {
    stubSessionEnv({ LLM_PROVIDER: 'Kei' });

    const { status } = await callMe();

    expect(status).toBe(503);
  });

  /*
   * CONTROL for the finding above: the same variable set to a REAL provider is fine, so the 503 is
   * about validation failing open into the loader's catch and not about the variable being read at all.
   */
  it('CONTROL — a valid LLM_PROVIDER is served normally', async () => {
    stubSessionEnv({ LLM_PROVIDER: 'KIE' });

    const { status, body } = await callMe();

    expect(status).toBe(200);
    expect(body.credits?.modelTiers.standardModel).toBe(DEFAULT_MODEL);
  });
});

/* ============================================================ 5. Nothing server-only on the wire */

/** Every key name anywhere in the payload, however deeply nested. */
function allKeys(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry) => allKeys(entry, into));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      into.push(key);
      allKeys(child, into);
    }
  }

  return into;
}

/** Every string value anywhere in the payload. */
function allStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') {
    into.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((entry) => allStrings(entry, into));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((child) => allStrings(child, into));
  }

  return into;
}

/**
 * Every `key: number` pair anywhere in the payload.
 *
 * 🔴 A PRICE IS A NUMBER, and a scan that reads only strings cannot see one. Measured: planting
 * `standardInputDollars: 0.85` and `premiumOutputDollars: 20` into the `credits` object passed the
 * whole file — so "the response never contains a price" was pinned for five spellings of a key, in
 * string form, and nothing else. A rate that reaches the client is a rate a competitor reads and a
 * number a user will believe is what they were charged; it is exactly the kind of field a future
 * `...tier` spread adds without anyone noticing, because it looks like data rather than a secret.
 */
function allNumberEntries(value: unknown, into: [string, number][] = [], path = ''): [string, number][] {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => allNumberEntries(entry, into, `${path}[${index}]`));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'number') {
        into.push([`${path}.${key}`, child]);
      } else {
        allNumberEntries(child, into, `${path}.${key}`);
      }
    }
  }

  return into;
}

/**
 * The numeric fields the session is ALLOWED to carry, by key name. Anything else numeric is refused.
 *
 * An allow-list rather than a deny-list, deliberately: a deny-list of price-shaped names can only ever
 * name the spellings someone thought of, and the leak above (`standardInputDollars`) is proof that the
 * one that gets through is the one nobody spelled. A new legitimate number is a one-line addition made
 * on purpose; a leaked rate is a test failure.
 */
const ALLOWED_NUMBER_KEYS = new Set([
  /* The user's own balance, and each rung's unlock threshold — both are what the picker renders. */
  'balance',
  'minimumCredits',

  /*
   * RETAIL prices, and the distinction from a model rate is the whole point of the rule. A pack's
   * `priceCents` is what the user is asked to pay and is rendered in the billing UI; an
   * `inputPerMTok` is what WE pay a vendor. One is the product, the other is the margin.
   */
  'priceCents',
  'credits',
  'creditsPerMonth',
]);

/**
 * Names that must never appear as a KEY, at any depth.
 *
 * Matched case-insensitively as substrings, because the failure this guards is a whole object being
 * forwarded rather than a field being renamed: `ModelTier` carries `rates`, `ModelTierStatus` carries
 * an operator-facing `reason` that enumerates every priced model, and `getPlatformConfig` carries two
 * platform API keys and the admin token. Each is one spread away from the response literal.
 */
const FORBIDDEN_KEY_FRAGMENTS = [
  'inputpermtok',
  'outputpermtok',
  'cacheread',
  'cachewrite',
  'rates',
  'apikey',
  'api_key',
  'secret',
  'servicerole',
  'service_role',
  'rawcost',
  'raw_cost',
  'admintoken',
  'admin_token',
  'githubtoken',
  'reason',
];

/** Fragments that must never appear in a VALUE — the sentinels, plus the operator-only error prose. */
const SENTINELS = {
  ANTHROPIC_API_KEY: 'sk-ant-SENTINEL-anthropic',
  KIE_API_KEY: 'SENTINEL-kie-key',
  ADMIN_TOKEN: 'SENTINEL-admin-token',
  STRIPE_SECRET_KEY: 'sk_test_SENTINEL_stripe',
  SUPABASE_SERVICE_ROLE_KEY: 'SENTINEL-service-role',
  GITHUB_API_KEY: 'ghp_SENTINEL_github',
};

const FORBIDDEN_VALUE_FRAGMENTS = [
  ...Object.values(SENTINELS),
  'sk-ant-',
  'sk_test_',
  'Marketplace price list',
  'Priced models:',
  'is not configured',
];

function assertNothingServerOnly(payload: { body: SessionPayload; wire: string }) {
  const keys = allKeys(payload.body).map((key) => key.toLowerCase());

  for (const fragment of FORBIDDEN_KEY_FRAGMENTS) {
    const offenders = keys.filter((key) => key.includes(fragment));
    expect(offenders, `a key matching "${fragment}" reached the client: ${offenders.join(', ')}`).toEqual([]);
  }

  const values = allStrings(payload.body);

  for (const fragment of FORBIDDEN_VALUE_FRAGMENTS) {
    const offenders = values.filter((value) => value.includes(fragment));
    expect(offenders, `a value containing "${fragment}" reached the client`).toEqual([]);
  }

  /*
   * Every NUMBER must be one we meant to send. See `allNumberEntries` — a rate is a number, and the
   * string scan above is structurally blind to it.
   */
  const numbers = allNumberEntries(payload.body);
  const unexpected = numbers.filter(([path]) => !ALLOWED_NUMBER_KEYS.has(path.split('.').pop() ?? ''));
  expect(
    unexpected,
    `an unrecognised NUMBER reached the client — if it is legitimate, add its key to ALLOWED_NUMBER_KEYS: ${unexpected
      .map(([path, value]) => `${path}=${value}`)
      .join(', ')}`,
  ).toEqual([]);

  // Belt and braces: the sentinels must not survive anywhere in the raw bytes either, key or value.
  for (const secret of Object.values(SENTINELS)) {
    expect(payload.wire).not.toContain(secret);
  }
}

describe('the session payload carries no price, no key, and no server-only value', () => {
  /** Every secret `getPlatformConfig` and `getBillingConfig` can read, set to a findable sentinel. */
  function stubWithSecrets(extra: Partial<Record<string, string>> = {}) {
    stubSessionEnv({ ...SENTINELS, ...extra });
  }

  it('healthy configuration — nothing server-only anywhere in the response', async () => {
    stubWithSecrets();

    const payload = await callMe();

    expect(payload.status).toBe(200);
    assertNothingServerOnly(payload);
  });

  /*
   * 🔴 The case that actually carries a secret upstream. `getModelTiers` puts the caught error's whole
   * message on the unserveable rung as `reason` — and that message enumerates every model the platform
   * prices, i.e. the operator's commercial configuration. `modelTiersSessionHint` drops it. If the
   * route ever forwards `tiers` verbatim instead of going through the hint, THIS is the test that
   * notices, and it is the only place the difference is observable.
   */
  it('a misconfigured rung leaks neither its operator reason nor the priced-model list', async () => {
    stubWithSecrets({ PREMIUM_MODEL: UNPRICEABLE });

    const payload = await callMe();

    expect(payload.status).toBe(200);
    expect(tiersOf(payload.body).premium.available).toBe(false);
    assertNothingServerOnly(payload);
  });

  it('an unresolvable platform model leaks neither its error nor the priced-model list', async () => {
    stubWithSecrets({ LLM_MODEL: UNPRICEABLE });

    const payload = await callMe();

    expect(payload.status).toBe(200);
    assertNothingServerOnly(payload);
  });

  it('an unreadable billing configuration leaks nothing either', async () => {
    stubWithSecrets({ CREATION_FLAT_CREDITS: '500' });

    const payload = await callMe();

    expect(payload.status).toBe(200);
    assertNothingServerOnly(payload);
  });

  /*
   * The positive half of the same rule: a rung is exactly six fields. Asserted as an EXACT key set
   * rather than as absences, because the next field added upstream is one nobody thought to forbid.
   */
  it('a tier row is exactly the six fields the picker needs', async () => {
    stubWithSecrets();

    const { body } = await callMe();

    for (const row of body.credits?.modelTiers.tiers ?? []) {
      expect(Object.keys(row).sort()).toEqual(['available', 'id', 'label', 'minimumCredits', 'model', 'serveable']);
    }

    expect(Object.keys(body.credits?.modelTiers ?? {}).sort()).toEqual(['standardModel', 'tiers']);
  });

  /*
   * CONTROL — the scanner can actually find a secret. Without this, a broken collector (a typo in a
   * recursion, a payload shape it does not walk) reports a clean bill of health forever, which is the
   * failure mode this repo has recorded for comment-stripping scanners and for `uno.generate`.
   */
  it('CONTROL — the scan catches a planted secret, so a clean result means something', () => {
    const planted = {
      body: {
        authenticated: true,
        credits: { modelTiers: { tiers: [{ id: 'premium', reason: SENTINELS.ANTHROPIC_API_KEY }] } },
      } as unknown as SessionPayload,
      wire: JSON.stringify({ nested: { deep: SENTINELS.ANTHROPIC_API_KEY } }),
    };

    expect(() => assertNothingServerOnly(planted)).toThrow();
  });

  it('CONTROL — the value scan alone catches a secret sitting under an innocent key', () => {
    const planted = {
      body: { authenticated: true, user: { displayName: SENTINELS.ADMIN_TOKEN } } as unknown as SessionPayload,
      wire: '{}',
    };

    expect(() => assertNothingServerOnly(planted)).toThrow();
  });

  /*
   * 🔴 CONTROL FOR THE KEY SCAN SPECIFICALLY, and it exists because the other two do not provide one.
   *
   * Measured: replacing `allKeys`' body with `return into` — a collector that finds nothing — left this
   * whole file green at 33/33. The "planted secret" control above satisfies itself through the VALUE
   * scan (its sentinel sits under the key `reason`), so the key half could rot to a no-op and stay
   * green forever. That is precisely the "a scan that silently matches nothing reports a clean bill of
   * health" failure this repo has hit before. The payload here therefore carries a forbidden KEY whose
   * VALUE is entirely innocent, so only `allKeys` can raise it.
   */
  it('CONTROL — the key scan alone catches a forbidden key holding an innocent value', () => {
    const planted = {
      body: {
        authenticated: true,
        credits: { modelTiers: { tiers: [{ id: 'premium', rates: { harmless: 'nothing secret here' } }] } },
      } as unknown as SessionPayload,
      wire: '{}',
    };

    expect(() => assertNothingServerOnly(planted)).toThrow(/rates/);
  });

  /*
   * CONTROL FOR THE NUMBER SCAN, same argument. A leaked model RATE is a number under a name nobody
   * deny-listed: `standardInputDollars: 0.85` passed every string and key assertion in this file.
   */
  it('CONTROL — the number scan alone catches a leaked rate under an unlisted key', () => {
    const planted = {
      body: {
        authenticated: true,
        credits: { balance: 100, standardInputDollars: 0.85, premiumOutputDollars: 20 },
      } as unknown as SessionPayload,
      wire: '{}',
    };

    expect(() => assertNothingServerOnly(planted)).toThrow(/standardInputDollars/);
  });
});
