/**
 * Balance and ledger history (SPEC §4.6).
 *
 * The user can always see exactly where their credits went — that is the payoff of an append-only
 * ledger, and the reason a mutable counter was never an option.
 */
import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireUser } from '~/lib/.server/supabase/auth';
import { getLedger } from '~/lib/.server/billing/ledger';
import { getBillingConfig } from '~/lib/.server/billing/rates';
import { CREDIT_PACKS, isStripeConfigured } from '~/lib/.server/billing/stripe';
import { errorResponse } from '~/lib/.server/http';

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    const user = await requireUser(request, context);
    const ledger = getLedger(context);
    const config = getBillingConfig(context);

    const [balance, entries] = await Promise.all([ledger.balance(user.id), ledger.list(user.id, 100)]);

    return json({
      balance,
      enforced: config.enforced,
      purchasable: isStripeConfigured(context),
      packs: CREDIT_PACKS.filter((p) => p.isActive),

      history: entries.map((e) => ({
        id: e.id,
        delta: e.delta,
        reason: e.reason,
        balanceAfter: e.balanceAfter,
        note: e.note,
        createdAt: e.createdAt,
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
