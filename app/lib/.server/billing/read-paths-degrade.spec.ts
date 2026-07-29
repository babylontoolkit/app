/**
 * A RETIRED PRICE VARIABLE MUST NOT TAKE THE APP DOWN (§4.4a, 2026-07-29).
 *
 * `getBillingConfig` throws a `NotConfiguredError` when `CREATION_FLAT_CREDITS` is set — deliberately,
 * and that refusal is pinned in `creation-flat.spec.ts`. A price variable nothing reads is a mis-bill
 * waiting to be believed, so it fails loudly and names its replacement.
 *
 * What was NOT decided, and shipped by accident, is WHO inherits that throw. Every caller did:
 *
 *   - `/api/me` — the session endpoint on EVERY page load. One leftover line in an operator's env
 *     (the owner's own `.env.local` had one) 500ed the entire app, for every user, signed in or out.
 *   - `/api/credits` — the page a user opens to see where their credits went.
 *   - `getProviderBalance` → `/api/admin/usage` — the dashboard an operator opens to DIAGNOSE billing,
 *     which is the one surface that must survive a billing misconfiguration. Its own doc comment says
 *     "Never throws", and `api.admin.usage.ts` relies on that claim in a comment: it wraps the OTHER
 *     data source in try/catch and deliberately does not wrap this one. The claim had quietly become
 *     false, so the comment was documenting an intention rather than a behaviour.
 *
 * This is the `premiumSessionHint` defect (2026-07-25) a second time, and the rule it established is
 * the rule applied here: **money paths throw, read and rendering paths degrade honestly.** The gate,
 * settlement, project-create and the Stripe webhook keep calling `getBillingConfig` and keep throwing —
 * charging money against a configuration we could not read is the one direction that is never safe.
 * The read paths call `getBillingConfigSafe` and say what they do not know, rather than inventing it:
 * `enforced` degrades to TRUE (credits bind — claiming they do not is the invented capability), the
 * signup grant is SKIPPED rather than guessed at (it is idempotent, so the real one lands on the next
 * request once the env is fixed), and the provider balance reports remaining platform credits as
 * `null` instead of computing them from a margin it does not have.
 *
 * ⚠️ These tests set the retired variable ON PURPOSE — the inverse of the usual `oauth.spec.ts` scrub.
 * Every other billing spec scrubs it so its own assertions are not poisoned; here the poison IS the
 * subject, so each test stubs it explicitly and `afterEach` unstubs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBillingConfig, getBillingConfigSafe } from './rates';
import { NotConfiguredError } from '~/lib/.server/env';
import { getProviderBalance, resetProviderBalanceCache } from './provider-balance';
import { setLedger, type Ledger } from './ledger';

const USER = {
  id: 'u-1',
  email: 'u@example.com',
  displayName: 'U',
  emailVerified: true,
  isAdmin: false,
  isLocal: false,
} as const;

const session = vi.hoisted(() => ({ user: null as unknown }));

vi.mock('~/lib/.server/supabase/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/.server/supabase/auth')>();

  return { ...actual, getUser: async () => session.user, requireUser: async () => session.user };
});

/** Grants are the one MONEY act on `/api/me` — this records whether the degraded path issued one. */
const grants: number[] = [];

function fakeLedger(): Ledger {
  return {
    async balance() {
      return 1234;
    },
    async list() {
      return [];
    },
    async append(entry: { amount: number }) {
      grants.push(entry.amount);
      return { ...entry, id: 'e1', balanceAfter: 0 } as never;
    },
  } as unknown as Ledger;
}

beforeEach(() => {
  grants.length = 0;
  session.user = USER;
  setLedger(fakeLedger());

  /*
   * ⚠️ `env()` falls back to `process.env` and vitest loads `.env.local`: without this the route would
   * reach out to KIE on the developer's real key, and only on their machine. Empty is "not configured",
   * which `getProviderBalance` reports without a network call.
   */
  vi.stubEnv('KIE_API_KEY', '');
  resetProviderBalanceCache();
});

afterEach(() => {
  setLedger(undefined);
  vi.unstubAllEnvs();
  resetProviderBalanceCache();
});

describe('getBillingConfigSafe', () => {
  it('CONTROL — the strict reader really does throw on the retired variable', () => {
    vi.stubEnv('CREATION_FLAT_CREDITS', '500');
    expect(() => getBillingConfig()).toThrow(NotConfiguredError);
  });

  it('returns null instead of throwing, so a read path can say what it does not know', () => {
    vi.stubEnv('CREATION_FLAT_CREDITS', '500');
    expect(getBillingConfigSafe()).toBeNull();
  });

  it('is otherwise the same config — degrading is not a second source of truth', () => {
    vi.stubEnv('CREATION_FLAT_CREDITS', undefined as unknown as string);
    expect(getBillingConfigSafe()).toEqual(getBillingConfig());
  });
});

describe('/api/me survives a retired price variable', () => {
  const me = async () => {
    const { loader } = await import('~/routes/api.me');

    return loader({ request: new Request('http://localhost/api/me'), params: {}, context: {} } as never);
  };

  it('answers a signed-in session instead of 500ing the whole app', async () => {
    vi.stubEnv('CREATION_FLAT_CREDITS', '500');

    const response = await me();
    const body = (await response.json()) as { authenticated: boolean; credits: { balance: number } };

    expect(response.status).toBe(200);
    expect(body.authenticated).toBe(true);
    expect(body.credits.balance).toBe(1234);
  });

  /*
   * The signed-OUT branch matters on its own: the config is read ABOVE the `if (!user)` return, so a
   * throw took down the landing page for visitors who have no billing relationship with us at all.
   */
  it('answers a signed-out visitor too — the config is read before the user check', async () => {
    vi.stubEnv('CREATION_FLAT_CREDITS', '500');
    session.user = null;

    const response = await me();

    expect(response.status).toBe(200);
    expect(((await response.json()) as { authenticated: boolean }).authenticated).toBe(false);
  });

  /*
   * `enforced` is a rendering hint (the gate is the authority), and the degraded value is the
   * CONSERVATIVE one: telling the client credits do not bind when we cannot tell is the same class of
   * invention as advertising a premium model we cannot serve.
   */
  it('reports enforced=true when the configuration is unreadable', async () => {
    vi.stubEnv('CREATION_FLAT_CREDITS', '500');
    vi.stubEnv('BILLING_ENFORCED', 'false');

    const body = (await (await me()).json()) as { credits: { enforced: boolean } };

    expect(body.credits.enforced).toBe(true);
  });

  it("CONTROL — with the variable unset it reports the operator's real setting", async () => {
    vi.stubEnv('CREATION_FLAT_CREDITS', undefined as unknown as string);
    vi.stubEnv('BILLING_ENFORCED', 'false');

    const body = (await (await me()).json()) as { credits: { enforced: boolean } };

    expect(body.credits.enforced).toBe(false);
  });

  /*
   * 🔴 The one thing the degraded path must NOT do. The grant size lives in the config we could not
   * read, and issuing a guessed number of credits is unrecoverable — the ledger is append-only and a
   * partial unique index means the wrong grant is the ONLY grant that user will ever get. Skipping is
   * safe: `ensureSignupGrant` is idempotent, so the real one lands on the next request.
   */
  it('issues NO signup grant while the configuration is unreadable', async () => {
    vi.stubEnv('CREATION_FLAT_CREDITS', '500');
    vi.stubEnv('GRANTS_ENABLED', 'true');

    await me();

    expect(grants).toEqual([]);
  });
});

describe('/api/credits survives a retired price variable', () => {
  it('still shows the balance and the history', async () => {
    vi.stubEnv('CREATION_FLAT_CREDITS', '500');

    const { loader } = await import('~/routes/api.credits');
    const response = await loader({
      request: new Request('http://localhost/api/credits'),
      params: {},
      context: {},
    } as never);
    const body = (await response.json()) as { balance: number; enforced: boolean };

    expect(response.status).toBe(200);
    expect(body.balance).toBe(1234);
    expect(body.enforced).toBe(true);
  });
});

describe('getProviderBalance keeps its "never throws" promise', () => {
  it('resolves rather than throwing when the configuration is unreadable', async () => {
    vi.stubEnv('CREATION_FLAT_CREDITS', '500');

    const balance = await getProviderBalance();

    expect(balance.reason).toMatch(/not configured/i);
  });

  /*
   * The number that CANNOT be computed is reported as unknown rather than as zero or as a guess: the
   * platform-credit conversion needs both the retail unit cost and the margin, and neither is readable.
   */
  it('reports remaining platform credits as unknown, never as a computed guess', async () => {
    vi.stubEnv('CREATION_FLAT_CREDITS', '500');
    resetProviderBalanceCache();

    expect((await getProviderBalance()).platformCreditsRemaining).toBeNull();
  });
});
