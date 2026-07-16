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
import {
  CREDIT_PACKS,
  SUBSCRIPTION_PLANS,
  findActiveSubscription,
  isStripeConfigured,
} from '~/lib/.server/billing/stripe';
import { errorResponse } from '~/lib/.server/http';

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    const user = await requireUser(request, context);
    const ledger = getLedger(context);
    const config = getBillingConfig(context);

    /*
     * The subscription lookup lives HERE, not in `/api/me`, because it is a Stripe API call and `/api/me`
     * runs on every page load. This route is only hit when someone opens billing — the one moment the
     * answer is worth a round trip. It NEVER fails the page: an unreachable or unconfigured Stripe means
     * "no subscription shown", not a broken balance (§1.3 — a missing vendor degrades, never breaks).
     */
    const [balance, entries, subscription] = await Promise.all([
      ledger.balance(user.id),
      ledger.list(user.id, 100),
      isStripeConfigured(context) ? findActiveSubscription(user.id, context).catch(() => null) : Promise.resolve(null),
    ]);

    return json({
      balance,
      enforced: config.enforced,
      purchasable: isStripeConfigured(context),
      packs: CREDIT_PACKS.filter((p) => p.isActive),
      plans: SUBSCRIPTION_PLANS.filter((p) => p.isActive),

      // Stripe's status verbatim (active / trialing / past_due / canceled) — we never re-interpret it.
      subscription: subscription
        ? {
            planId: subscription.planId,
            status: subscription.status,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            creditsPerMonth: subscription.creditsPerMonth,
          }
        : null,

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
