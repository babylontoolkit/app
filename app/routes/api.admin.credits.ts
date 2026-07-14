/**
 * Admin credit adjustments (SPEC §4.6, §4.10).
 *
 *   POST /api/admin/credits  { userId, delta, note }  → append an adjustment to a user's ledger
 *
 * Admin-only. For manual grants (a goodwill top-up) and manual refunds (a support case). It goes
 * through the SAME append-only ledger as every other credit movement (`reason: 'adjustment'`) — never
 * a direct balance write, because the balance is DERIVED and there is no counter to poke (§4.6,
 * spec/billing.md). The adjustment is auditable forever, with the admin's note attached.
 *
 * `adjustment` is one of the two reasons allowed to drive a balance negative (the other is
 * `generation`) — a support refund that a later generation already spent must not be blocked by the
 * balance it would leave. The ledger enforces that rule; this route just names the reason correctly.
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { requireAdmin } from '~/lib/.server/supabase/auth';
import { getLedger } from '~/lib/.server/billing/ledger';
import { errorResponse } from '~/lib/.server/http';

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    const admin = await requireAdmin(request, context);

    const body = await request.json<{ userId: string; delta: number; note?: string }>();

    if (!body.userId || typeof body.delta !== 'number' || !Number.isFinite(body.delta) || body.delta === 0) {
      return json({ error: true, message: 'Need a userId and a non-zero numeric delta.' }, { status: 400 });
    }

    const entry = await getLedger(context).append({
      userId: body.userId,
      delta: Math.round(body.delta),
      reason: 'adjustment',

      // Who did it and why — the audit trail a manual credit movement must carry.
      note: `admin:${admin.id}${body.note ? ` — ${body.note}` : ''}`,
    });

    return json({ ok: true, balanceAfter: entry.balanceAfter });
  } catch (error) {
    return errorResponse(error);
  }
}
