/**
 * Pro gating (SPEC §4.6.1, §4.1, §2.3).
 *
 * **Pro gates EXACTLY ONE thing: BYOK + model selection. Nothing else, ever.** These tests exist
 * because the failure is asymmetric and silent in both directions:
 *
 * - Leak BYOK to a non-entitled user, and we hand over the provider/model machinery we promised
 *   nobody would see — and, worse, honor a key we never verified an entitlement for.
 * - Refuse BYOK to a real subscriber (say, because the license service blipped), and we silently
 *   revoke a benefit somebody is paying for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  refreshEntitlement,
  resolveByok,
  setEntitlementStore,
  type Entitlement,
  type EntitlementStore,
} from './entitlements';

class FakeStore implements EntitlementStore {
  private _rows = new Map<string, Entitlement>();

  async get(userId: string) {
    return this._rows.get(userId) ?? null;
  }

  async put(entitlement: Entitlement) {
    this._rows.set(entitlement.userId, entitlement);
  }

  seed(entitlement: Entitlement) {
    this._rows.set(entitlement.userId, entitlement);
  }
}

let store: FakeStore;

function entitlement(over: Partial<Entitlement> = {}): Entitlement {
  return {
    userId: 'u1',
    source: 'protools_subscription',
    tier: 'indie',
    status: 'active',
    subscriberEmail: 'sub@example.com',
    lastValidatedAt: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  store = new FakeStore();
  setEntitlementStore(store);

  /*
   * Never let a test touch the real license service. Without this stub, the "no entitlement" case
   * reaches out to babylontoolkit.com — which makes the suite slow, flaky, and dependent on a vendor
   * being up. It also means CI would exercise a DIFFERENT code path than the one we think we're
   * testing (unreachable, not "not a subscriber"). Deny by default; the tests that care about the
   * service's answer seed the store directly.
   */
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('<active>false</active>', { status: 200 })),
  );
});

afterEach(() => {
  setEntitlementStore(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('resolveByok', () => {
  /*
   * THE SHIPPING DEFAULT. With PRO_FEATURES_ENABLED unset, BYOK does not exist for ANYONE — not even
   * for a user with a live, active, fully-paid Pro entitlement. The master switch wins. If this ever
   * inverts, the credits-only product starts rendering provider pickers and honoring client keys.
   */
  it('refuses BYOK when PRO_FEATURES_ENABLED is off — even for an active subscriber', async () => {
    vi.stubEnv('PRO_FEATURES_ENABLED', 'false');
    store.seed(entitlement({ status: 'active' }));

    const decision = await resolveByok({ userId: 'u1', email: 'u1@example.com', hasKey: true });

    expect(decision.allowed).toBe(false);
  });

  it('refuses BYOK when PRO is on but the user has no entitlement', async () => {
    vi.stubEnv('PRO_FEATURES_ENABLED', 'true');

    const decision = await resolveByok({ userId: 'nobody', email: 'nobody@example.com', hasKey: true });

    expect(decision.allowed).toBe(false);
  });

  it('allows BYOK for an active subscriber when PRO is on', async () => {
    vi.stubEnv('PRO_FEATURES_ENABLED', 'true');
    store.seed(entitlement({ status: 'active', tier: 'small_business' }));

    const decision = await resolveByok({ userId: 'u1', email: 'u1@example.com', hasKey: true });

    expect(decision.allowed).toBe(true);
    expect(decision.tier).toBe('small_business');
  });

  /*
   * A lapse falls back to CREDITS with a friendly notice — never an error, never a blocked build. The
   * user's project must keep working the moment their subscription expires (§4.6.1).
   */
  it('falls back to credits with a notice when the subscription has lapsed', async () => {
    vi.stubEnv('PRO_FEATURES_ENABLED', 'true');
    store.seed(entitlement({ status: 'lapsed' }));

    const decision = await resolveByok({ userId: 'u1', email: 'u1@example.com', hasKey: true });

    expect(decision.allowed).toBe(false);
    expect(decision.notice).toMatch(/lapsed/i);
  });

  /* No key means nothing to honor, however entitled they are. */
  it('refuses BYOK when the user supplied no key', async () => {
    vi.stubEnv('PRO_FEATURES_ENABLED', 'true');
    store.seed(entitlement({ status: 'active' }));

    const decision = await resolveByok({ userId: 'u1', email: 'u1@example.com', hasKey: false });

    expect(decision.allowed).toBe(false);
  });

  /* Local dev has no license service to ask — but still obeys the master switch. */
  it('allows BYOK for the local developer when PRO is on', async () => {
    vi.stubEnv('PRO_FEATURES_ENABLED', 'true');

    const decision = await resolveByok({ userId: 'local', email: 'local@localhost', isLocal: true, hasKey: true });

    expect(decision.allowed).toBe(true);
  });

  it('still refuses the local developer when PRO is off', async () => {
    vi.stubEnv('PRO_FEATURES_ENABLED', 'false');

    const decision = await resolveByok({ userId: 'local', email: 'local@localhost', isLocal: true, hasKey: true });

    expect(decision.allowed).toBe(false);
  });
});

/**
 * THE GRACE WINDOW (§4.6.1) — the subtlest rule in the entitlement system, and the one with the
 * worst failure mode.
 *
 * "The license service said nothing" and "the license service said no" are NOT the same fact. If we
 * conflate them, every blip in OUR infrastructure silently revokes BYOK from every paying Pro
 * subscriber on the platform — and it looks exactly like a normal lapse, so nobody would even know
 * to investigate. Our outage must never punish a subscriber.
 */
describe('the 72h grace window', () => {
  const unreachable = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

  it('HOLDS an active entitlement when the license service is unreachable', async () => {
    store.seed(entitlement({ status: 'active', lastValidatedAt: new Date().toISOString() }));
    unreachable();

    const result = await refreshEntitlement('u1', 'u1@example.com');

    expect(result?.status).toBe('active');
  });

  it('still holds it most of the way through the window (48h)', async () => {
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 3600_000).toISOString();
    store.seed(entitlement({ status: 'active', lastValidatedAt: fortyEightHoursAgo }));
    unreachable();

    expect((await refreshEntitlement('u1', 'u1@example.com'))?.status).toBe('active');
  });

  it('finally lapses only after the window has fully elapsed (73h)', async () => {
    const seventyThreeHoursAgo = new Date(Date.now() - 73 * 3600_000).toISOString();
    store.seed(entitlement({ status: 'active', lastValidatedAt: seventyThreeHoursAgo }));
    unreachable();

    expect((await refreshEntitlement('u1', 'u1@example.com'))?.status).toBe('lapsed');
  });

  /* A definitive "not a subscriber" is different — that we believe immediately. */
  it('lapses immediately when the service answers that they are not a subscriber', async () => {
    store.seed(entitlement({ status: 'active' }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<active>false</active>', { status: 200 })),
    );

    expect((await refreshEntitlement('u1', 'u1@example.com'))?.status).toBe('lapsed');
  });

  it('activates when the service confirms an active subscription', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<active>true</active><tier>enterprise</tier>', { status: 200 })),
    );

    const result = await refreshEntitlement('u1', 'u1@example.com');

    expect(result?.status).toBe('active');
    expect(result?.tier).toBe('enterprise');
  });
});
