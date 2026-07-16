/**
 * Start a one-time purchase of a premium store asset (SPEC §4.9).
 *
 *   POST /api/assets/purchase  { assetId }  → { url }   (Stripe Checkout URL)
 *
 * The client picks an ASSET ID, never a price — the amount charged is looked up server-side from the
 * catalog, exactly like credit packs (`api.checkout.ts`). On success the Stripe webhook grants a durable
 * entitlement (`asset_entitlements`); the add gate then lets the asset into the project. When Stripe is
 * not configured this degrades to a descriptive 503 (`getStripe` → NotConfiguredError), never a stub.
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { createAssetCheckoutSession } from '~/lib/.server/billing/stripe';
import { env } from '~/lib/.server/env';
import { errorResponse } from '~/lib/.server/http';

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    const user = await requireVerifiedUser(request, context);
    const body = await request.json<{ assetId: string }>();

    const appUrl = env(context, 'APP_URL') || new URL(request.url).origin;

    const { url } = await createAssetCheckoutSession({
      userId: user.id,
      userEmail: user.email,
      assetId: body.assetId,
      successUrl: `${appUrl}/settings/assets?purchase=success`,
      cancelUrl: `${appUrl}/settings/assets?purchase=cancelled`,
      context,
    });

    return json({ url });
  } catch (error) {
    return errorResponse(error);
  }
}
