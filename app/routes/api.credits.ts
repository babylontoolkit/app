/**
 * Balance and ledger history (SPEC §4.6).
 *
 * The user can always see exactly where their credits went — that is the payoff of an append-only
 * ledger, and the reason a mutable counter was never an option.
 */
import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireUser } from '~/lib/.server/supabase/auth';
import { getLedger } from '~/lib/.server/billing/ledger';
import { getGenerationStore } from '~/lib/.server/billing/generations';
import { buildLedgerView } from '~/lib/.server/billing/ledger-view';
import { getBillingConfigSafe } from '~/lib/.server/billing/rates';
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

    /*
     * A READ path: the balance and the ledger history are what this route exists for, and neither
     * needs the pricing configuration. A misconfigured price variable (`getBillingConfig` refuses a
     * retired `CREATION_FLAT_CREDITS`, §4.4a) must not blank the page that shows a user where their
     * credits went — `enforced` degrades to the conservative `true` exactly as it does in `/api/me`.
     * Spending paths keep calling `getBillingConfig` and keep throwing.
     */
    const config = getBillingConfigSafe(context);

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

    /*
     * Decorate the history — what each turn WAS, and what its gateway saved (§4.6).
     *
     * Best-effort by construction: `listByIds` returns [] on any failure and `buildLedgerView` renders
     * every row it cannot decorate exactly as before. The balance and the history are what this route
     * exists for and neither depends on this lookup succeeding.
     */
    const generationIds = entries.map((e) => e.generationId).filter((id): id is string => Boolean(id));
    const generations = generationIds.length > 0 ? await getGenerationStore(context).listByIds(generationIds) : [];
    const view = buildLedgerView(entries, generations);

    return json({
      balance,
      enforced: config?.enforced ?? true,
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

      history: view.rows,

      /*
       * WHAT THE GATEWAY LADDER IS WORTH, over the rows above (`billing/ledger-view.ts`).
       *
       * Credits are cost-proportional, so a cheaper gateway is not our margin — it is the user's pack
       * going further, and that had been completely invisible. `comparedRows` travels with the totals
       * because they cover THIS PAGE of the ledger, not the account's lifetime, and a headline number
       * without its scope is a claim the data does not support.
       */
      savings: view.savings,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
