/**
 * `provider-status.ts` — CodeSandbox's live counters for the Admin panel.
 *
 * The properties that matter, each a silent dashboard lie if lost: it NEVER throws (one section must
 * not take the admin page down); the three reads degrade INDEPENDENTLY (a `/vm/running` hiccup still
 * shows the rate gauges, with the failure named in `reason`); no key → a described unavailable state
 * with zero fetches; and the cache keeps a dashboard render from being a provider round trip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSandboxProviderStatus, resetSandboxProviderStatusCache } from './provider-status';

const META = {
  rate_limits: {
    concurrent_vms: { limit: 10, remaining: 9 },
    requests_hourly: { reset: 1785308933, limit: 3600, remaining: 3530 },
    sandboxes_hourly: { reset: 1785308933, limit: 20, remaining: 17 },
  },
};

const RUNNING = {
  data: {
    concurrent_vm_limit: 10,
    concurrent_vm_count: 1,
    vms: [
      {
        id: 'rdgchm',
        specs: { cpu: 1, memory: 2, storage: 20 },
        credit_basis: 'vm_credits',
        session_started_at: '2026-07-29T06:11:21Z',
      },
    ],
  },
};

const FLEET = { data: { sandboxes: [], pagination: { total_records: 9 } } };

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe('getSandboxProviderStatus', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetSandboxProviderStatusCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('CODESANDBOX_API_KEY', 'csb_test_key');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('maps all three reads into the status shape', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/meta/info')) {
        return okJson(META);
      }

      if (url.includes('/vm/running')) {
        return okJson(RUNNING);
      }

      return okJson(FLEET);
    });

    const status = await getSandboxProviderStatus();

    expect(status.requestsHourly).toEqual({ limit: 3600, remaining: 3530, resetAt: 1785308933 });
    expect(status.sandboxesHourly).toEqual({ limit: 20, remaining: 17, resetAt: 1785308933 });
    expect(status.concurrentVms).toEqual({ limit: 10, remaining: 9 });
    expect(status.runningVms).toEqual([
      {
        id: 'rdgchm',
        specs: { cpu: 1, memory: 2, storage: 20 },
        creditBasis: 'vm_credits',
        sessionStartedAt: '2026-07-29T06:11:21Z',
        lastActiveAt: undefined,
      },
    ]);
    expect(status.fleetCount).toBe(9);
    expect(status.reason).toBeNull();
  });

  /*
   * The whole point of `allSettled`: one endpoint down must not blank the others, and the partial
   * state is EXPLAINED — a smaller silent answer reads as "fewer VMs", which is a wrong number on a
   * money panel.
   */
  it('degrades each read independently and names the failure', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/meta/info')) {
        return okJson(META);
      }

      if (url.includes('/vm/running')) {
        throw new Error('vm/running -> HTTP 503');
      }

      return okJson(FLEET);
    });

    const status = await getSandboxProviderStatus();

    expect(status.requestsHourly?.remaining).toBe(3530);
    expect(status.fleetCount).toBe(9);
    expect(status.runningVms).toBeNull();
    expect(status.reason).toContain('vm/running');
  });

  /* `/vm/running` carries its own concurrency gauge — used when `/meta/info` is the one that failed. */
  it('falls back to /vm/running for the concurrency gauge when /meta/info fails', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/meta/info')) {
        throw new Error('meta -> HTTP 500');
      }

      if (url.includes('/vm/running')) {
        return okJson(RUNNING);
      }

      return okJson(FLEET);
    });

    const status = await getSandboxProviderStatus();

    expect(status.concurrentVms).toEqual({ limit: 10, remaining: 9 });
    expect(status.requestsHourly).toBeNull();
    expect(status.reason).toContain('meta');
  });

  it('never throws — a total outage returns nulls with the failure named', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const status = await getSandboxProviderStatus();

    expect(status.requestsHourly).toBeNull();
    expect(status.fleetCount).toBeNull();
    expect(status.reason).toContain('ECONNREFUSED');
  });

  /*
   * The env-scrub lesson (`oauth.spec.ts`): asserting the NOT-CONFIGURED state requires clearing the
   * key `env()` would otherwise resolve from the developer's real `.env.local`.
   */
  it('reports unconfigured with ZERO provider calls when no key is set', async () => {
    vi.stubEnv('CODESANDBOX_API_KEY', undefined as unknown as string);

    const status = await getSandboxProviderStatus();

    expect(status.reason).toContain('not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caches: a second call within the TTL issues no new fetches', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      okJson(url.includes('meta') ? META : url.includes('running') ? RUNNING : FLEET),
    );

    await getSandboxProviderStatus();

    const callsAfterFirst = fetchMock.mock.calls.length;
    const second = await getSandboxProviderStatus();

    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    expect(second.fleetCount).toBe(9);
  });
});
