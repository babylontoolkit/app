/**
 * Admin refund audit (SPEC §4.10; `spec/fail-loud.md`).
 *
 *   GET /api/admin/refunds?limit=200            → report over the newest refunds (summary + rows)
 *   GET /api/admin/refunds?limit=200&offset=400 → the next page of ROWS (summary still computed,
 *                                                  but the panel keeps page one's — see below)
 *   GET /api/admin/refunds?format=csv           → EVERY refund, as a CSV download
 *
 * Admin-only (`requireAdmin` — the wall `outbound-enumerate.spec.ts` requires). Cross-user by
 * design: refunds are the operator's money leaving, and "am I refunding people, and why?" must be
 * answerable from the Admin panel — ALL of them, not a most-recent window (an audit with an
 * invisible tail is a partial audit presenting as a complete one). Read-only; ledger mutations go
 * through `/api/admin/credits` and the settlement paths, never here.
 */
import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireAdmin } from '~/lib/.server/supabase/auth';
import { getLedger, type LedgerEntry } from '~/lib/.server/billing/ledger';
import { getGenerationStore } from '~/lib/.server/billing/generations';
import { buildRefundReport, refundRowsToCsv } from '~/lib/.server/admin/refund-report';
import { errorResponse } from '~/lib/.server/http';

/**
 * The CSV export pages the ledger until it runs dry, bounded by a runaway backstop — 100k refunds
 * is far beyond any real history (it would mean ~100k failed generations), so the cap exists to
 * bound a bug, not a customer. If it is ever hit, the export says so in its last line rather than
 * silently truncating (`spec/fail-loud.md` rule 3: a best-effort step that cannot fail must REPORT).
 */
const CSV_PAGE = 1000;
const CSV_MAX_ROWS = 100_000;

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    await requireAdmin(request, context);

    const url = new URL(request.url);
    const ledger = getLedger(context);
    const store = getGenerationStore(context);

    if (url.searchParams.get('format') === 'csv') {
      const all: LedgerEntry[] = [];
      let truncated = false;

      for (let offset = 0; ; offset += CSV_PAGE) {
        const page = await ledger.listByReason('refund', CSV_PAGE, offset);
        all.push(...page);

        if (page.length < CSV_PAGE) {
          break;
        }

        if (all.length >= CSV_MAX_ROWS) {
          truncated = true;
          break;
        }
      }

      // One big join sample: the cause lives on the generation row (bounded like the rows themselves).
      const generations = await store.list(Math.min(Math.max(all.length * 2, 2000), CSV_MAX_ROWS));
      const report = buildRefundReport(all, generations);

      const csv =
        refundRowsToCsv(report.rows) +
        (truncated ? `\r\n"TRUNCATED at ${CSV_MAX_ROWS} rows — narrow the range or query the ledger directly"` : '');

      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="refunds-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    }

    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 2000);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);

    /*
     * Fetch one extra row: `hasMore` from an actual probe, never inferred from `length === limit`
     * (which would show a phantom "Load more" exactly when the count is a multiple of the page).
     */
    const refunds = await ledger.listByReason('refund', limit + 1, offset);
    const hasMore = refunds.length > limit;

    /*
     * The generation sample is larger than the refund page on purpose: it is BOTH the join target (a
     * refund's cause lives on its generation row) and the denominator of the refund rate. Deep pages
     * join against the same recent sample, so older rows may report their ledger note as the cause —
     * counted in `unjoined`, never dropped.
     */
    const generations = await store.list(Math.max(limit * 5, 1000));

    return json({
      report: buildRefundReport(refunds.slice(0, limit), generations),
      offset,
      hasMore,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
