/**
 * The wall on `GET /api/unity/subscription` — a shared API key held by the Unity Editor tool
 * (SPEC §4.18, §5, `spec/spend-holes.md`).
 *
 * This route is the one place in the product that answers a question about SOMEBODY ELSE from an
 * email, so it cannot use any of the session walls (`denyUnlessVerified` and friends): the caller is
 * a desktop Editor with no browser cookie. It authenticates with a key instead — and that key is a
 * genuinely weaker credential, so the limits below are part of the wall rather than decoration.
 *
 * ## What this key can and cannot be trusted to do (owner decision, 2026-08-14)
 *
 * The key ships INSIDE a distributed Unity package, so it is extractable by anyone who downloads the
 * tools. It is therefore a **throttle and an attribution mark, not a secret**: it stops the endpoint
 * being trivially scriptable by someone who has never seen our Editor tools, and it lets us rotate a
 * leaked key. It does NOT make the endpoint safe to point at arbitrary emails without limit, which is
 * why `enforceSubscriptionCheckRateLimit` is not optional and why the response never distinguishes
 * "no such account" from "account with nothing" (`subscription-access.ts`).
 *
 * The upgrade path, if this ever matters more: issue a per-developer token from the account page and
 * report only the CALLER's own status, which removes the email parameter and the enumeration surface
 * entirely. The route is shaped so that becomes a second accepted credential rather than a rewrite.
 *
 * ## Fail CLOSED
 *
 * An unset `UNITY_SUBSCRIPTION_API_KEY` refuses every request with 503, never serves an open endpoint.
 * The inverse — "no key configured means no check required" — is how an internal tool becomes a public
 * customer-list oracle during a deploy that dropped one variable, and nothing would throw
 * (`assertNotLocalInProduction` is the same preference: refuse rather than quietly downgrade).
 */
import { timingSafeEqual } from 'node:crypto';
import { createScopedLogger } from '~/utils/logger';
import { env, envNumber, NotConfiguredError } from '~/lib/.server/env';
import { UnauthorizedError } from '~/lib/.server/supabase/auth';
import {
  getUserRateLimitStore,
  RateLimitedError,
  type UserRateLimitRule,
} from '~/lib/.server/security/user-rate-limit';

const logger = createScopedLogger('licensing.unity-api-key');

/** Is the endpoint configured at all? Used by `/api/health` to report state without the value (§5). */
export function isUnitySubscriptionApiConfigured(context?: unknown): boolean {
  return Boolean(env(context, 'UNITY_SUBSCRIPTION_API_KEY'));
}

/**
 * Pull the presented key off the request.
 *
 * Two accepted spellings because `UnityWebRequest.SetRequestHeader` is equally happy with either and
 * developers reach for both: `Authorization: Bearer <key>` and `X-Api-Key: <key>`. Never a query
 * parameter — a credential in a URL lands in access logs, proxy logs and browser history, which is
 * the one thing that would make this key materially worse than it already is.
 */
export function presentedApiKey(request: Request): string | null {
  const authorization = request.headers.get('authorization');

  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());

    if (match) {
      return match[1].trim();
    }
  }

  return request.headers.get('x-api-key')?.trim() || null;
}

/**
 * Constant-time key comparison.
 *
 * `===` on a secret is a byte-at-a-time timing oracle — the same reasoning as the git OAuth state HMAC
 * (`git/oauth.ts`), and the same trap: **`timingSafeEqual` THROWS on a length mismatch** rather than
 * returning false, so the length is compared first. Comparing lengths is not itself a leak worth
 * caring about (it discloses the key's length, which the attacker holding the package already knows).
 */
function keysMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');

  if (a.length !== b.length) {
    return false;
  }

  return timingSafeEqual(a, b);
}

/**
 * Throws `NotConfiguredError` (503) when no key is set, `UnauthorizedError` (401) when the presented
 * key is absent or wrong. Returns nothing on success — there is no identity to return, which is
 * exactly the limitation this credential has.
 */
export function requireUnitySubscriptionKey(request: Request, context?: unknown): void {
  const expected = env(context, 'UNITY_SUBSCRIPTION_API_KEY');

  if (!expected) {
    throw new NotConfiguredError(
      'The Unity subscription API',
      'Set UNITY_SUBSCRIPTION_API_KEY on the server to enable it.',
    );
  }

  const presented = presentedApiKey(request);

  if (!presented || !keysMatch(presented, expected)) {
    logger.warn('Rejected a Unity subscription check with a missing or incorrect API key');

    /*
     * One message for both cases on purpose. "No key" and "wrong key" are the same refusal to a
     * caller who has no business here, and telling them apart is free reconnaissance.
     */
    throw new UnauthorizedError('A valid API key is required.');
  }
}

/**
 * Requests one caller may make per window.
 *
 * Bounded because the shared key cannot bound anything by itself: whoever extracts it from the Editor
 * package can otherwise walk a list of addresses and learn which of them are our paying customers.
 * The limit is per CLIENT, not global — a single global bucket would let one busy studio throttle
 * every other developer on the platform, which is a self-inflicted outage rather than a defence.
 */
export function subscriptionCheckRateLimit(context?: unknown): UserRateLimitRule {
  return {
    windowMs: envNumber(context, 'UNITY_SUBSCRIPTION_RATE_WINDOW_MS', 60_000),
    max: Math.max(1, envNumber(context, 'UNITY_SUBSCRIPTION_RATE_MAX', 60)),
  };
}

/**
 * Best-effort caller identity for the rate-limit bucket.
 *
 * ⚠️ Deliberately NOT passed to `enforceUserRateLimit`, whose parameter is named `userId` and means
 * it — an IP is not a user id, and this codebase has already been bitten once by a call site that did
 * not satisfy a parameter's declared contract (`recordAgentWrite`'s `absoluteFilePath`). The store is
 * used directly instead, with a key that says what it actually is.
 *
 * A spoofable header is an acceptable bucket key here because the limit is a throttle rather than an
 * authorization boundary: an attacker who rotates `X-Forwarded-For` still had to obtain the key, and
 * the endpoint discloses one boolean per request either way.
 */
export function callerFingerprint(request: Request): string {
  const forwarded = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for');

  if (forwarded) {
    // `x-forwarded-for` is a list; the client is the first entry.
    const first = forwarded.split(',')[0]?.trim();

    if (first) {
      return first;
    }
  }

  return 'unknown';
}

/** Count one call for this caller, or throw `RateLimitedError` (429 + `Retry-After`). */
export async function enforceSubscriptionCheckRateLimit(input: {
  fingerprint: string;
  context?: unknown;
  now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  const rule = subscriptionCheckRateLimit(input.context);
  const decision = await getUserRateLimitStore().hit(`unity-subscription:${input.fingerprint}`, rule, now);

  if (!decision.allowed) {
    logger.warn(
      `Rate limited Unity subscription checks from ${input.fingerprint} until ${new Date(
        decision.resetAt,
      ).toISOString()}`,
    );
    throw new RateLimitedError(decision.resetAt, now, 'subscription checks');
  }
}
