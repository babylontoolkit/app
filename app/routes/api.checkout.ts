/**
 * Start a credit-pack purchase (SPEC §4.6).
 *
 * The client picks a PACK ID, never a price. Everything about what is being sold — the credit amount
 * and the amount charged — is looked up server-side from `CREDIT_PACKS`. A client-supplied
 * `credits` or `priceCents` would let anyone buy 40,000 credits for one cent.
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { createCheckoutSession } from '~/lib/.server/billing/stripe';
import { env } from '~/lib/.server/env';
import { errorResponse } from '~/lib/.server/http';

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    const user = await requireVerifiedUser(request, context);
    const body = await request.json<{ packId: string }>();

    const appUrl = env(context, 'APP_URL') || new URL(request.url).origin;

    const { url } = await createCheckoutSession({
      // Server-asserted. The webhook credits THIS id, so a payment can never land on another account.
      userId: user.id,
      userEmail: user.email,

      packId: body.packId,
      successUrl: `${appUrl}/settings/credits?purchase=success`,
      cancelUrl: `${appUrl}/settings/credits?purchase=cancelled`,
      context,
    });

    return json({ url });
  } catch (error) {
    return errorResponse(error);
  }
}
