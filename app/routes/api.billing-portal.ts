/**
 * Open the Stripe billing portal (SPEC §4.6).
 *
 *   POST /api/billing-portal  → { url }
 *
 * Where a subscriber cancels, swaps a card, or downloads invoices. All of that is Stripe's, on Stripe's
 * domain: cancellation, proration and dunning are theirs to get right, and card details must never come
 * near our server.
 *
 * The customer is resolved from the SESSION's user id (via the `userId` we stamped on the subscription
 * at checkout), never from anything the client sends — otherwise a portal link would be an invitation
 * to manage someone else's billing.
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { createBillingPortalSession } from '~/lib/.server/billing/stripe';
import { env } from '~/lib/.server/env';
import { errorResponse } from '~/lib/.server/http';

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    const user = await requireVerifiedUser(request, context);
    const appUrl = env(context, 'APP_URL') || new URL(request.url).origin;

    const { url } = await createBillingPortalSession({
      userId: user.id,
      returnUrl: `${appUrl}/settings/credits`,
      context,
    });

    return json({ url });
  } catch (error) {
    return errorResponse(error);
  }
}
