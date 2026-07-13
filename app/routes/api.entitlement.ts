/**
 * Pro Tools entitlement — refresh and email linking (SPEC §4.6.1).
 *
 * **The email-mismatch recovery path, built on day one** — because the address someone subscribed to
 * Pro Tools with is very often not the address they signed up here with, and without this the
 * "upgrade to unlock BYOK" flow dead-ends into a support ticket for a customer who has already paid.
 *
 * It is self-serve because it can be: we are not deciding who is a subscriber. We ask the license
 * service — the sole authority (§4.6.1) — and record its answer.
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { getPlatformConfig } from '~/lib/.server/agent/config';
import { linkSubscriberEmail, refreshEntitlement } from '~/lib/.server/licensing/entitlements';
import { errorResponse } from '~/lib/.server/http';

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    const user = await requireVerifiedUser(request, context);

    /*
     * With Pro off (the shipping default) there is no entitlement surface at all — no BYOK, no linking
     * flow, nothing to refresh. Answering 404 rather than 403 keeps the credits-only product from even
     * admitting the machinery is there (§4.6.1).
     */
    if (!getPlatformConfig(context).proFeaturesEnabled) {
      return json({ error: true, message: 'Not found.' }, { status: 404 });
    }

    const body = await request.json<{ intent: 'refresh' | 'link'; subscriberEmail?: string }>();

    if (body.intent === 'link') {
      if (!body.subscriberEmail) {
        return json({ error: true, message: 'Enter the email on your Pro Tools subscription.' }, { status: 400 });
      }

      const result = await linkSubscriberEmail(user.id, body.subscriberEmail.trim(), context);

      return json(result, { status: result.linked ? 200 : 400 });
    }

    const entitlement = await refreshEntitlement(user.id, user.email, context);

    return json({
      status: entitlement?.status ?? 'lapsed',
      tier: entitlement?.tier ?? null,
      subscriberEmail: entitlement?.subscriberEmail ?? null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
