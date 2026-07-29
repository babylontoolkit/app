/**
 * Admin usage & cost dashboard data (SPEC §4.10).
 *
 *   GET /api/admin/usage?limit=500  → aggregated diagnostics over the most recent generations
 *
 * Admin-only (session `isAdmin`). Returns the `buildUsageReport` aggregation — the numbers that
 * DIAGNOSE spend (cache hit rate, failure rate, wasted-output tokens, per-model cost) rather than just
 * chart it (§4.10, spec/context-budget.md). This is a read; it never mutates anything.
 */
import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireAdmin } from '~/lib/.server/supabase/auth';
import { getGenerationStore } from '~/lib/.server/billing/generations';
import { buildUsageReport } from '~/lib/.server/admin/usage-report';
import { getProviderBalance } from '~/lib/.server/billing/provider-balance';
import { getSandboxUsageStore } from '~/lib/.server/sandbox/usage-store';
import { getSandboxProviderStatus } from '~/lib/.server/sandbox/provider-status';
import { buildVmReport } from '~/lib/.server/admin/vm-report';
import { errorResponse } from '~/lib/.server/http';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.admin.usage');

/**
 * How many lifecycle marks the VM report reads.
 *
 * Independent of the generation `limit`: marks are written per project OPEN, not per generation, and
 * pairing needs BOTH ends of an interval — a window that clips the opening mark turns a closed
 * interval into hours that are never counted.
 */
const MAX_VM_MARKS = 5000;

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    await requireAdmin(request, context);

    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 500, 1), 5000);

    const records = await getGenerationStore(context).list(limit);

    /*
     * The provider pool every user's generation draws from (§4.10). Fetched alongside the report
     * rather than on its own route: it is one number on one panel, and `getProviderBalance` never
     * throws, so a provider outage degrades this field to "unknown" instead of failing the dashboard.
     * That claim is load-bearing HERE (there is deliberately no try/catch around it) and it briefly
     * stopped being true: the function reached `getBillingConfig`, which refuses a retired
     * `CREATION_FLAT_CREDITS` (§4.4a), so a leftover env line 500ed the very dashboard an operator
     * would open to diagnose billing. It reads the config through `getBillingConfigSafe` now.
     */
    const providerBalance = await getProviderBalance(context);

    /*
     * Sandbox VM time (plan T12), joined the same way `providerBalance` is: it is one section on one
     * panel, and a second data source must never be able to take the dashboard down. Unlike
     * `getProviderBalance` this store CAN throw, so the catch is here — a usage-store outage renders
     * "unavailable" beside a usage report that is still perfectly readable.
     */
    let vm: ReturnType<typeof buildVmReport> | null = null;

    try {
      vm = buildVmReport(await getSandboxUsageStore(context).list(MAX_VM_MARKS), Date.now());
    } catch (error) {
      logger.warn(`Sandbox VM report unavailable: ${(error as Error)?.message}`);
    }

    /*
     * CodeSandbox's live counters (rate-limit headroom, running VMs, fleet size), joined like
     * `providerBalance`: `getSandboxProviderStatus` never throws (nulls + a `reason` instead), so a
     * provider outage degrades this section to "unavailable" beside a report that still renders.
     * There is no CSB credit BALANCE — their API has none; the spend estimate is `vm` hours × rate.
     */
    const sandboxStatus = await getSandboxProviderStatus(context);

    return json({ report: buildUsageReport(records), sampled: records.length, providerBalance, vm, sandboxStatus });
  } catch (error) {
    return errorResponse(error);
  }
}
