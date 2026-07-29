/**
 * `GET /api/admin/usage` — the admin dashboard's data, with the VM report joined in (plan T12, §4.10).
 *
 * One property carries this file: **a second data source must never be able to take the dashboard
 * down.** The VM section is one panel among several; the usage report beside it is what an operator
 * reads to diagnose spend, and losing all of it because a lifecycle-mark store was unreachable would
 * be a strictly worse outage than the missing section. `providerBalance` earns this by never throwing
 * at all; the usage store CAN throw, so the route catches — and this asserts that it does.
 *
 * The loader is driven directly (auth and both stores mocked), the way every route is exercised in
 * this codebase. ⚠️ Beside the code, never in `app/routes/` — Remix compiles a spec there as a route
 * and the manifest then imports `vitest` at runtime, 500ing every request (§4.5.6).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setGenerationStore, type GenerationRecord } from '~/lib/.server/billing/generations';
import { resetProviderBalanceCache } from '~/lib/.server/billing/provider-balance';
import { setSandboxUsageStore, type SandboxMark, type SandboxUsageStore } from '~/lib/.server/sandbox/usage-store';
import type { VmReport } from './vm-report';

const ADMIN = { id: 'admin-1', email: 'a@example.com', emailVerified: true, isAdmin: true } as const;

const auth = vi.hoisted(() => ({ admin: true }));

vi.mock('~/lib/.server/supabase/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/.server/supabase/auth')>();

  return {
    ...actual,
    requireAdmin: async () => {
      if (!auth.admin) {
        // The real error type, so the route's `errorResponse` maps it to the real status.
        throw new actual.ForbiddenError('Admin access required.');
      }

      return ADMIN;
    },
  };
});

const HOUR = 3_600_000;

/** Marks are stubbed into the store rather than written through the service — this is a read path. */
function usageStore(marks: SandboxMark[], fail = false): SandboxUsageStore {
  return {
    async append() {
      /* Read path only — the report never writes. */
    },
    async list() {
      if (fail) {
        throw new Error('sandbox_lifecycle_marks is unreachable');
      }

      return [...marks].sort((a, b) => b.at - a.at);
    },
  };
}

beforeEach(() => {
  auth.admin = true;

  /*
   * ⚠️ `env()` falls back to `process.env`, and vitest loads `.env.local` — so an unstubbed key here
   * would make the route reach out to KIE on the developer's real credentials, and only on their
   * machine. Empty means "not configured", which `getProviderBalance` reports without a network call.
   */
  vi.stubEnv('KIE_API_KEY', '');

  /*
   * ⚠️ Same trap, retired variable: the report reaches `getBillingConfig`, which REFUSES
   * `CREATION_FLAT_CREDITS` (§4.4a). An operator still carrying it in `.env.local` gets a
   * `NotConfiguredError` out of every admin-usage assertion instead of a report.
   */
  vi.stubEnv('CREATION_FLAT_CREDITS', undefined as unknown as string);
  resetProviderBalanceCache();

  // No FS fallback: a real store would read and write the repo's own `.data/`.
  setGenerationStore({
    async upsert() {
      /* The route only lists. */
    },
    async hasBilledGeneration() {
      /* The route never asks — that is the project-delete refund path (§4.4a). */
      return false;
    },
    async list() {
      return [] as GenerationRecord[];
    },
  });
  setSandboxUsageStore(usageStore([]));
});

afterEach(() => {
  vi.unstubAllEnvs();
  setGenerationStore(undefined);
  setSandboxUsageStore(undefined);
  resetProviderBalanceCache();
});

async function usage(query = '') {
  const { loader } = await import('~/routes/api.admin.usage');

  return loader({
    request: new Request(`http://localhost/api/admin/usage${query}`),
    params: {},
    context: {},
  } as never);
}

/** The wire shape these tests read. `vm` is nullable ON THE WIRE — that is the degraded state. */
interface UsageBody {
  report?: unknown;
  providerBalance?: unknown;
  vm: (VmReport & { topUsers: { userId: string }[] }) | null;
}

const usageJson = async (query = '') => (await (await usage(query)).json()) as UsageBody;

describe('the VM section', () => {
  it('builds the report from the seeded marks', async () => {
    const now = Date.now();

    setSandboxUsageStore(
      usageStore([
        { event: 'create', sandboxId: 'sb-1', userId: 'u1', projectId: 'p1', at: now - 3 * HOUR },
        { event: 'hibernate', sandboxId: 'sb-1', userId: 'u1', projectId: 'p1', at: now - 1 * HOUR },
        { event: 'create', sandboxId: 'sb-2', userId: 'u2', projectId: 'p2', at: now - 5 * HOUR },
      ]),
    );

    const body = await usageJson();

    expect(body.vm!.marks).toBe(3);
    expect(body.vm!.sandboxes).toBe(2);

    // u1 ran a closed 2h session; u2's VM is still up and has been for 5h — the route measures to now.
    expect(body.vm!.vmHours).toBeCloseTo(7, 1);
    expect(body.vm!.running).toBe(1);
    expect(body.vm!.users).toBe(2);
    expect(body.vm!.topUsers.map((u: { userId: string }) => u.userId)).toEqual(['u2', 'u1']);
  });

  it('leaves the REST of the report rendering when the usage store is down', async () => {
    /*
     * 🔴 The whole reason the join is wrapped. `vm: null` is the honest "unavailable" the panel
     * renders; a 500 here would take the cache-hit-rate, failure-rate and per-model cost numbers with
     * it — the ones spend is actually diagnosed from.
     */
    setSandboxUsageStore(usageStore([], true));

    const response = await usage();
    const body = (await response.json()) as UsageBody;

    expect(response.status).toBe(200);
    expect(body.vm).toBeNull();
    expect(body.report).toBeTruthy();
    expect(body.providerBalance).toBeTruthy();
  });

  it('reports an empty stream as empty rather than as an outage', async () => {
    // "Nothing recorded" and "could not read" are different answers and must not collapse into one.
    const body = await usageJson();

    expect(body.vm).toMatchObject({ marks: 0, vmHours: 0, running: 0, users: 0 });
  });
});

/**
 * THE DASHBOARD MUST SURVIVE THE MISCONFIGURATION IT IS OPENED TO DIAGNOSE (§4.4a, 2026-07-29).
 *
 * `beforeEach` above scrubs `CREATION_FLAT_CREDITS` so the other assertions are not poisoned by a
 * developer's `.env.local` — which is correct, and which is also how this hid: the route reached
 * `getBillingConfig` through `getProviderBalance`, that call REFUSES the retired variable, and the
 * scrub meant no test ever ran the route with it set. An operator whose env still carried it got a
 * 500 from the one surface that would have told them why their billing looked wrong.
 *
 * The fix is in `provider-balance.ts` (`getBillingConfigSafe`), which restores the "never throws"
 * claim this route relies on IN A COMMENT — it wraps the VM store and deliberately does not wrap the
 * balance. This test is what keeps that comment true.
 */
describe('a retired price variable does not 500 the dashboard', () => {
  it('renders the whole report with CREATION_FLAT_CREDITS still set', async () => {
    vi.stubEnv('CREATION_FLAT_CREDITS', '500');

    const response = await usage();
    const body = (await response.json()) as UsageBody;

    expect(response.status).toBe(200);
    expect(body.report).toBeTruthy();
    expect(body.providerBalance).toBeTruthy();
  });
});

describe('the admin wall', () => {
  it('refuses a non-admin before reading anything', async () => {
    auth.admin = false;

    const listed = vi.fn(async () => []);
    setSandboxUsageStore({
      async append() {
        /* Read path only. */
      },
      list: listed,
    });

    const response = await usage();

    expect(response.status).toBe(403);
    expect(listed).not.toHaveBeenCalled();
  });
});
