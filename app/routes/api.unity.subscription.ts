/**
 * `GET`/`POST /api/unity/subscription` — the Unity Editor's subscription check (SPEC §4.18a, §5).
 *
 * The one surviving piece of the Unity integration: the Unity Editor Bridge (§4.17) and the Unity
 * Project Licenser (§4.18) were removed 2026-08-30, and this endpoint was deliberately kept, because
 * it is the only way a distributed Editor package can ask whether the developer using it has paid.
 *
 * POST (preferred — the address stays out of URLs and access logs):
 *
 *   var body = "{\"email\":\"" + email + "\"}";
 *   var request = UnityWebRequest.Put(url, Encoding.UTF8.GetBytes(body));
 *   request.method = "POST";
 *   request.SetRequestHeader("Content-Type", "application/json");
 *   request.SetRequestHeader("Authorization", "Bearer " + apiKey);
 *
 * GET (kept working — it is what shipped, and an Editor in the field must not break):
 *
 *   UnityWebRequest.Get(url + "?email=" + UnityWebRequest.EscapeURL(email));
 *   request.SetRequestHeader("Authorization", "Bearer " + apiKey);
 *
 *   → 200 {"email":"dev@studio.com","hasActiveSubscription":true,"reason":"subscription"}
 *
 * ## Both methods share ONE handler, deliberately
 *
 * The method is not the security axis — a GET with an `Authorization` header is exactly as
 * authenticated as a POST with one. What actually matters is that the caller presents a credential
 * (`requireUnitySubscriptionKey`) and that the credential is never in the URL (`presentedApiKey`
 * reads headers only). Both of those are properties of `answer()`, which is why the two entry points
 * differ ONLY in where the email is read from: two handlers would be two authentication decisions
 * that can drift, and the drift would be silent on whichever method nobody tested.
 *
 * The one real difference is the residual cost of GET: the EMAIL sits in a query string and therefore
 * in access logs. That is why POST is the documented form. `Cache-Control: no-store` is set on both so
 * no intermediary keeps an entitlement answer that can change the moment a subscription lapses.
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
import type { ActionFunction, LoaderFunction } from '@remix-run/cloudflare';
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
    super('A valid "email" is required — as a JSON body field on POST, or a query parameter on GET.');
    this.name = 'InvalidEmailError';
  }
}

/**
 * Authenticate, rate-limit, then answer — the whole route, minus where the email came from.
 *
 * ⚠️ Order matters and is asserted: the key is checked BEFORE the rate limit, so an unauthenticated
 * flood cannot consume a legitimate caller's window, and before the email is read, so an anonymous
 * caller learns nothing about what this endpoint accepts. `readEmail` therefore runs LAST and must
 * never be hoisted above these two calls for the convenience of parsing a body earlier.
 */
async function answer(request: Request, context: unknown, readEmail: () => Promise<string | null>) {
  requireUnitySubscriptionKey(request, context);

  await enforceSubscriptionCheckRateLimit({ fingerprint: callerFingerprint(request), context });

  const email = normalizeSubscriberEmail(await readEmail());

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
}

export const loader: LoaderFunction = async ({ request, context }) =>
  handle(async () => answer(request, context, async () => new URL(request.url).searchParams.get('email')));

export const action: ActionFunction = async ({ request, context }) =>
  handle(async () =>
    answer(request, context, async () => {
      /*
       * A body that is not JSON is a caller mistake, not a server fault: it degrades to `null` so the
       * request falls into the same 400 as a missing address, rather than surfacing a parse error as a
       * 500 that reads to the Editor as "the platform is down".
       */
      try {
        const body = (await request.json()) as { email?: unknown } | null;

        return typeof body?.email === 'string' ? body.email : null;
      } catch {
        return null;
      }
    }),
  );
