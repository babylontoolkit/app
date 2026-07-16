/**
 * Start a monthly credit subscription (SPEC §4.6).
 *
 * The same rule as `api.checkout` and for the same reason: the client picks a PLAN ID, never a price or
 * a credit amount. Everything being sold is looked up server-side from `SUBSCRIPTION_PLANS`, and the
 * user id is server-asserted from the session — so a payment can never credit another account, and
 * nobody can subscribe to 25,000 credits/month for a cent.
 *
 * Note what this does NOT do: grant anything. Credits arrive when Stripe says the invoice is paid
 * (`invoice.paid` → `handleWebhook`), never when the browser comes back from Checkout.
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { createSubscriptionCheckout } from '~/lib/.server/billing/stripe';
import { env } from '~/lib/.server/env';
import { errorResponse } from '~/lib/.server/http';

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    const user = await requireVerifiedUser(request, context);
    const body = await request.json<{ planId: string }>();

    const appUrl = env(context, 'APP_URL') || new URL(request.url).origin;

    const { url } = await createSubscriptionCheckout({
      // Server-asserted, and copied onto the SUBSCRIPTION so every future renewal still knows whose it is.
      userId: user.id,
      userEmail: user.email,

      planId: body.planId,
      successUrl: `${appUrl}/settings/credits?subscription=success`,
      cancelUrl: `${appUrl}/settings/credits?subscription=cancelled`,
      context,
    });

    return json({ url });
  } catch (error) {
    return errorResponse(error);
  }
}
