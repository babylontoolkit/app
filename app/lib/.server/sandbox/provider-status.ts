/**
 * CodeSandbox operational status for the Admin panel (SPEC §4.10, plan follow-up 2026-07-29).
 *
 * ## What this answers — and what it deliberately cannot
 *
 * CodeSandbox exposes NO credit-balance endpoint (verified against the full REST surface the SDK
 * calls, the docs, and live probes of every plausible path — all 404). So unlike KIE's
 * `provider-balance.ts` there is no runway number to show. What their API DOES report is the
 * operational headroom that fails FIRST in practice:
 *
 *   - `GET /meta/info`  → the three rate limits: hourly API requests (3,600/hr — the cap
 *     `spec/sandbox-codesandbox.md` records as the one that bites before concurrency), hourly
 *     sandbox CREATIONS (20/hr — the whole platform's fork budget, the reason for the per-user
 *     create rate limit), and concurrent VMs;
 *   - `GET /vm/running` → which VMs are burning credits RIGHT NOW, with the tier specs each one
 *     bills at;
 *   - `GET /sandbox?tags=btk` → the fleet count (every sandbox this platform ever created carries
 *     the `btk` tag), whose divergence from live project rows is what the T4 orphan sweep reaps.
 *
 * Estimated SPEND lives elsewhere on the same panel: T12's VM-hours report × the measured
 * `SANDBOX_VM_USD_PER_HOUR` rate. This module is the provider's own live counters, not our meter.
 *
 * ## Failure posture (same as `provider-balance.ts`, `spec/fail-loud.md` rule 2)
 *
 * NEVER throws — one section on one admin page must not take the dashboard down. Every failure
 * returns nulls with a stated `reason`, and the panel renders "unavailable", never zero and never a
 * stale guess. Raw `fetch` rather than the SDK on purpose: two of the three endpoints are not in the
 * SDK's typed client, the host is a fixed constant (no caller input — no SSRF surface), and it keeps
 * this module importable without tripping the sandbox-seam scan or the workerd lazy-import rule the
 * SDK's module-scope `createRequire` forced on `service.ts`.
 */
import { sandboxApiKey } from './config';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('sandbox-status');

const API_BASE = 'https://api.codesandbox.io';

/** A provider round trip per dashboard render would be silly; the counters move slowly. */
const CACHE_TTL_MS = 30_000;

/** One slow provider must not hold the admin page — the rest of the report is already computed. */
const FETCH_TIMEOUT_MS = 5_000;

interface RateWindow {
  limit: number;
  remaining: number;

  /** Unix seconds when the window resets. Absent for the concurrent-VM gauge (not a window). */
  resetAt?: number;
}

export interface RunningVmInfo {
  id: string;

  /** e.g. `{ cpu: 1, memory: 2, storage: 20 }` — the tier the VM is billing at. */
  specs?: { cpu?: number; memory?: number; storage?: number };
  creditBasis?: string;
  sessionStartedAt?: string;
  lastActiveAt?: string;
}

export interface SandboxProviderStatus {
  /** Hourly API request budget — the limit that bites first (3,600/hr measured). */
  requestsHourly: RateWindow | null;

  /** Hourly sandbox-creation budget — the whole platform's fork allowance. */
  sandboxesHourly: RateWindow | null;

  /** Concurrent running VMs allowed vs currently used. */
  concurrentVms: RateWindow | null;

  /** VMs burning credits right now, with what each bills at. */
  runningVms: RunningVmInfo[] | null;

  /** Total `btk`-tagged sandboxes in the workspace (the fleet the orphan sweep audits). */
  fleetCount: number | null;

  /** Why any of the above is null — `null` when everything was read. */
  reason: string | null;
}

const UNAVAILABLE = (reason: string): SandboxProviderStatus => ({
  requestsHourly: null,
  sandboxesHourly: null,
  concurrentVms: null,
  runningVms: null,
  fleetCount: null,
  reason,
});

let cache: { at: number; value: SandboxProviderStatus } | undefined;

async function getJson(path: string, key: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`${path} -> HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function asWindow(raw: unknown): RateWindow | null {
  const value = raw as { limit?: number; remaining?: number; reset?: number } | undefined;

  if (typeof value?.limit !== 'number' || typeof value?.remaining !== 'number') {
    return null;
  }

  return {
    limit: value.limit,
    remaining: value.remaining,
    ...(typeof value.reset === 'number' ? { resetAt: value.reset } : {}),
  };
}

/**
 * Read the provider's live counters. Never throws; caches for {@link CACHE_TTL_MS}.
 *
 * The three reads run in PARALLEL and degrade independently — a `/vm/running` hiccup still shows the
 * rate-limit gauges (`Promise.allSettled`, with the first failure's message as the `reason` so the
 * partial state is explained rather than silently smaller).
 */
export async function getSandboxProviderStatus(context?: unknown): Promise<SandboxProviderStatus> {
  const key = sandboxApiKey(context);

  if (!key) {
    return UNAVAILABLE('CodeSandbox is not configured (CODESANDBOX_API_KEY).');
  }

  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }

  const [meta, running, fleet] = await Promise.allSettled([
    getJson('/meta/info', key),
    getJson('/vm/running', key),
    getJson('/sandbox?tags=btk&page_size=1', key),
  ]);

  const status: SandboxProviderStatus = UNAVAILABLE('');
  status.reason = null;

  if (meta.status === 'fulfilled') {
    const limits = (meta.value as { rate_limits?: Record<string, unknown> })?.rate_limits ?? {};
    status.requestsHourly = asWindow(limits.requests_hourly);
    status.sandboxesHourly = asWindow(limits.sandboxes_hourly);
    status.concurrentVms = asWindow(limits.concurrent_vms);
  }

  if (running.status === 'fulfilled') {
    const data = (
      running.value as { data?: { vms?: unknown[]; concurrent_vm_count?: number; concurrent_vm_limit?: number } }
    )?.data;

    status.runningVms = (data?.vms ?? []).map((raw) => {
      const vm = raw as {
        id?: string;
        specs?: { cpu?: number; memory?: number; storage?: number };
        credit_basis?: string;
        session_started_at?: string;
        last_active_at?: string;
      };

      return {
        id: vm.id ?? 'unknown',
        specs: vm.specs,
        creditBasis: vm.credit_basis,
        sessionStartedAt: vm.session_started_at,
        lastActiveAt: vm.last_active_at,
      };
    });

    /*
     * `/vm/running` also reports the concurrency gauge; prefer it when `/meta/info` failed (they
     * agree when both succeed — measured), so a partial outage still shows the most useful number.
     */
    if (!status.concurrentVms && typeof data?.concurrent_vm_limit === 'number') {
      status.concurrentVms = {
        limit: data.concurrent_vm_limit,
        remaining: data.concurrent_vm_limit - (data.concurrent_vm_count ?? 0),
      };
    }
  }

  if (fleet.status === 'fulfilled') {
    const total = (fleet.value as { data?: { pagination?: { total_records?: number } } })?.data?.pagination
      ?.total_records;
    status.fleetCount = typeof total === 'number' ? total : null;
  }

  const firstFailure = [meta, running, fleet].find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );

  if (firstFailure) {
    status.reason = (firstFailure.reason as Error)?.message ?? String(firstFailure.reason);
    logger.warn(`CodeSandbox status partially unavailable: ${status.reason}`);
  }

  cache = { at: Date.now(), value: status };

  return status;
}

/** Test seam: forget the cache (module state survives across specs otherwise). */
export function resetSandboxProviderStatusCache(): void {
  cache = undefined;
}
