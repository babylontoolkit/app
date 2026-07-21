/**
 * Pro gating (SPEC §4.6.1, §4.1, §2.3).
 *
 * **Pro gates EXACTLY ONE thing: BYOK + model selection. Nothing else, ever.** These tests exist
 * because the failure is asymmetric and silent in both directions:
 *
 * - Leak BYOK to a non-entitled user, and we hand over the provider/model machinery we promised
 *   nobody would see — and, worse, honor a key we never verified an entitlement for.
 * - Refuse BYOK to a real subscriber, and we silently revoke a benefit somebody is paying for.
 *
 * The external license service was retired (§4.18): entitlements now perform NO network validation.
 * `getEntitlement`/`resolveByok` read the stored row and nothing else — there is no fetch to stub, and
 * a test that observes one is a regression.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getEntitlement,
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
   * Nothing here should ever reach the network — the license service is retired. Stub fetch to THROW
   * so any accidental reintroduction of a validation call fails loudly rather than passing silently.
   */
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('no network call is permitted from entitlements (§4.18)');
    }),
  );
});

afterEach(() => {
  setEntitlementStore(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('getEntitlement — no network validation (§4.18)', () => {
  it('returns the stored row without revalidating', async () => {
    store.seed(entitlement({ status: 'active', tier: 'small_business' }));

    const result = await getEntitlement('u1');

    expect(result?.status).toBe('active');
    expect(result?.tier).toBe('small_business');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns null for an unknown user and still never calls out', async () => {
    const result = await getEntitlement('nobody');

    expect(result).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns a stored lapsed row verbatim — it does not try to "refresh" it', async () => {
    store.seed(entitlement({ status: 'lapsed' }));

    expect((await getEntitlement('u1'))?.status).toBe('lapsed');
    expect(fetch).not.toHaveBeenCalled();
  });
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

  /* Local dev has no entitlement to read — but still obeys the master switch. */
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

  /*
   * The local-dev short-circuit runs BEFORE the store is ever read. If a refactor moved the store read
   * ahead of the isLocal check, a stale lapsed row keyed to the local user id would silently downgrade
   * the local developer to credits (and hand back a "subscription lapsed" notice that makes no sense
   * locally). Seed a lapsed row and assert isLocal still wins outright — no notice, no downgrade.
   */
  it('treats the local developer as Pro even when a lapsed row is stored under the same id', async () => {
    vi.stubEnv('PRO_FEATURES_ENABLED', 'true');
    store.seed(entitlement({ userId: 'local', status: 'lapsed' }));

    const decision = await resolveByok({ userId: 'local', email: 'local@localhost', isLocal: true, hasKey: true });

    expect(decision.allowed).toBe(true);
    expect(decision.tier).toBe('enterprise');
    expect(decision.notice).toBeUndefined();
  });
});
