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
import { errorResponse } from '~/lib/.server/http';

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    await requireAdmin(request, context);

    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 500, 1), 5000);

    const records = await getGenerationStore(context).list(limit);

    return json({ report: buildUsageReport(records), sampled: records.length });
  } catch (error) {
    return errorResponse(error);
  }
}
