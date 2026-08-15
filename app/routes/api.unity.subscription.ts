/**
 * `GET /api/unity/subscription?email=<address>` — the Unity Editor's licence check (SPEC §4.18, §5).
 *
 *   UnityWebRequest.Get("https://app.babylontoolkit.com/api/unity/subscription?email=" +
 *                       UnityWebRequest.EscapeURL(email));
 *   request.SetRequestHeader("Authorization", "Bearer " + apiKey);
 *
 *   → 200 {"email":"dev@studio.com","hasActiveSubscription":true,"reason":"subscription"}
 *
 * ## Why a GET is acceptable here
 *
 * The method is not the security axis — a GET with an `Authorization` header is exactly as
 * authenticated as a POST with one. The two things that actually matter are that the caller presents
 * a credential (`requireUnitySubscriptionKey`) and that the credential is never in the URL
 * (`presentedApiKey` reads headers only). The residual cost of GET is that the EMAIL sits in a query
 * string and therefore in access logs — accepted deliberately: it is the same address the developer
 * typed into the Editor, we already store it, and a GET is what makes this trivially callable from
 * `UnityWebRequest` and cacheable-by-nobody. `Cache-Control: no-store` is set so no intermediary keeps
 * an entitlement answer that can change the moment a subscription lapses.
 *
 * ## The response never distinguishes "no account" from "nothing bought"
 *
 * Both are `{"hasActiveSubscription":false,"reason":"none"}`. The key that authenticates this route
 * ships inside a distributed Editor package and is therefore extractable, so anything that told those
 * two apart would be an account-existence oracle for the whole internet — the same reasoning that
 * makes `requireOwnedProject` answer 404 rather than 403 (§4.5.3).
 *
 * ## Error shape
 *
 * 503 the endpoint is not configured · 401 missing/wrong key · 400 unusable email · 429 rate limited ·
 * 500 we could not answer. A 500 deliberately does NOT degrade to `false`: denying a paying customer
 * silently is the failure mode this codebase keeps finding, and the Editor can decide for itself
 * whether an unanswered check should fail open or closed (`spec/fail-loud.md`).
 */
import type { LoaderFunction } from '@remix-run/cloudflare';
import { json } from '@remix-run/cloudflare';
import { handle } from '~/lib/.server/http';
import { normalizeSubscriberEmail } from '~/lib/.server/licensing/subscription-access';
import { checkSubscriptionByEmail } from '~/lib/.server/licensing/subscriber-status';
import {
  callerFingerprint,
  enforceSubscriptionCheckRateLimit,
  requireUnitySubscriptionKey,
} from '~/lib/.server/licensing/unity-api-key';

/** A malformed address is a client mistake, and naming it saves a support round trip. */
class InvalidEmailError extends Error {
  readonly statusCode = 400;
  readonly isRetryable = false;

  constructor() {
    super('A valid "email" query parameter is required.');
    this.name = 'InvalidEmailError';
  }
}

export const loader: LoaderFunction = async ({ request, context }) =>
  handle(async () => {
    /*
     * Order matters: the key is checked BEFORE the rate limit, so an unauthenticated flood cannot
     * consume a legitimate caller's window, and before the email is parsed, so an anonymous caller
     * learns nothing about what this endpoint accepts.
     */
    requireUnitySubscriptionKey(request, context);

    await enforceSubscriptionCheckRateLimit({ fingerprint: callerFingerprint(request), context });

    const email = normalizeSubscriberEmail(new URL(request.url).searchParams.get('email'));

    if (!email) {
      throw new InvalidEmailError();
    }

    const status = await checkSubscriptionByEmail(email, context);

    return json(
      {
        email: status.email,
        hasActiveSubscription: status.active,
        reason: status.reason,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });
