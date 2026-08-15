/**
 * The Unity Editor subscription check (SPEC §4.18): the pure decision, the shared-key wall, and the
 * route's symmetry between "no account" and "account with nothing".
 *
 * ⚠️ **EVERY test here scrubs the environment first.** `env()` falls back to `process.env`, and vitest
 * loads `.env.local` — so a "not configured" assertion silently resolves the developer's REAL keys and
 * passes for the wrong reason, or starts failing the moment someone configures the feature, on their
 * machine only, with CI green (`oauth.spec.ts`, and twice since). The scrub list covers the WHOLE
 * precedence chain this code reads, not just the variable under test: the key, the rate limits, and —
 * easy to forget — `SUPABASE_*` and `STRIPE_SECRET_KEY`, because leaving those live would send these
 * tests at a real database and a real payment processor.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_SUBSCRIPTION_STATUSES,
  decideSubscriptionAccess,
  isActiveSubscriptionStatus,
  normalizeSubscriberEmail,
} from './subscription-access';
import {
  callerFingerprint,
  isUnitySubscriptionApiConfigured,
  presentedApiKey,
  requireUnitySubscriptionKey,
} from './unity-api-key';
import { checkSubscriptionByEmail } from './subscriber-status';
import { LOCAL_USER, UnauthorizedError } from '~/lib/.server/supabase/auth';
import { setLedger } from '~/lib/.server/billing/ledger';
import { RateLimitedError, setUserRateLimitStore } from '~/lib/.server/security/user-rate-limit';
import { errorResponse } from '~/lib/.server/http';

const KEY = 'test-key-0123456789abcdef';

function scrubEnv(): void {
  for (const name of [
    'UNITY_SUBSCRIPTION_API_KEY',
    'UNITY_SUBSCRIPTION_RATE_MAX',
    'UNITY_SUBSCRIPTION_RATE_WINDOW_MS',
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'STRIPE_SECRET_KEY',
  ]) {
    vi.stubEnv(name, undefined as unknown as string);
  }
}

/** A ledger stub: `balance` is the only method this path reads. */
function ledgerWithBalance(balance: number) {
  return { balance: async () => balance } as never;
}

function requestWithKey(key?: string, extraHeaders: Record<string, string> = {}): Request {
  return new Request('https://app.example.com/api/unity/subscription?email=dev@studio.com', {
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...extraHeaders },
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  scrubEnv();
  setLedger(undefined);
  setUserRateLimitStore(undefined);
});

describe('decideSubscriptionAccess', () => {
  it('grants on a live subscription', () => {
    expect(decideSubscriptionAccess({ subscriptionStatus: 'active', creditBalance: 0 })).toEqual({
      active: true,
      reason: 'subscription',
    });
  });

  it('grants on a positive credit balance with no subscription', () => {
    expect(decideSubscriptionAccess({ subscriptionStatus: null, creditBalance: 250 })).toEqual({
      active: true,
      reason: 'credits',
    });
  });

  it('refuses when there is neither', () => {
    expect(decideSubscriptionAccess({ subscriptionStatus: null, creditBalance: 0 })).toEqual({
      active: false,
      reason: 'none',
    });
  });

  /*
   * A `generation` debit is exempt from the non-negative rule (§4.2.1), so a real balance can be below
   * zero. `!== 0` or `>= 0` would each hand the paid Editor tools to the wrong people — in opposite
   * directions.
   */
  it('does not grant on a NEGATIVE balance', () => {
    expect(decideSubscriptionAccess({ subscriptionStatus: null, creditBalance: -120 })).toEqual({
      active: false,
      reason: 'none',
    });
  });

  it('does not grant on a balance it could not compute', () => {
    expect(decideSubscriptionAccess({ subscriptionStatus: null, creditBalance: Number.NaN }).active).toBe(false);
  });

  /*
   * 🔴 The money-direction test. `null` is what the caller passes when Stripe is unconfigured or down,
   * and an outage must never read as "everybody is subscribed".
   */
  it('treats an unavailable Stripe as no subscription, not as an active one', () => {
    expect(decideSubscriptionAccess({ subscriptionStatus: null, creditBalance: 0 }).active).toBe(false);
  });

  it('still answers from credits while Stripe is unavailable', () => {
    expect(decideSubscriptionAccess({ subscriptionStatus: null, creditBalance: 5 })).toEqual({
      active: true,
      reason: 'credits',
    });
  });

  it.each(['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'])(
    'does not grant on status %s',
    (status) => {
      expect(decideSubscriptionAccess({ subscriptionStatus: status, creditBalance: 0 }).active).toBe(false);
    },
  );

  it.each(['active', 'trialing', 'past_due'])('grants on status %s', (status) => {
    expect(decideSubscriptionAccess({ subscriptionStatus: status, creditBalance: 0 }).active).toBe(true);
  });

  it('is case- and whitespace-insensitive about the status', () => {
    expect(isActiveSubscriptionStatus('  ACTIVE ')).toBe(true);
  });

  /*
   * Membership, not a re-typed list: "which statuses grant the paid tools" is a money decision, and a
   * test that re-lists the strings agrees with itself by construction.
   */
  it('pins exactly which statuses count', () => {
    expect([...ACTIVE_SUBSCRIPTION_STATUSES].sort()).toEqual(['active', 'past_due', 'trialing']);
  });
});

describe('normalizeSubscriberEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeSubscriberEmail('  Dev@Studio.COM ')).toBe('dev@studio.com');
  });

  it.each([null, undefined, '', 'not-an-email', 'two@@at.com', 'spaces in@mail.com', '@nolocal.com', 'a'.repeat(300)])(
    'refuses %s',
    (raw) => {
      expect(normalizeSubscriberEmail(raw as string | null)).toBeNull();
    },
  );

  it('accepts an ordinary address with subdomains', () => {
    expect(normalizeSubscriberEmail('first.last@mail.studio.co.uk')).toBe('first.last@mail.studio.co.uk');
  });

  /*
   * 🔴 THE REGRESSION THAT SHIPPED AND WAS CAUGHT BY CURLING THE ROUTE, NOT BY THIS FILE.
   *
   * The first regex required a dot in the domain, so the local-mode user was rejected as malformed and
   * the endpoint 400'd on the only address that resolves with Supabase unconfigured — a feature that
   * could not be exercised outside production, which is the state every live-fidelity defect in this
   * codebase was found in.
   *
   * It hid because every other test here calls `checkSubscriptionByEmail` directly. The ROUTE composes
   * normalize → check, and nothing exercised the composition. Asserting `LOCAL_USER.email` by
   * reference rather than as a literal means this keeps holding if that address ever changes.
   */
  it('accepts the local-mode user, whose domain has no dot', () => {
    expect(normalizeSubscriberEmail(LOCAL_USER.email)).toBe(LOCAL_USER.email);
  });

  it('accepts any single-label domain', () => {
    expect(normalizeSubscriberEmail('dev@localhost')).toBe('dev@localhost');
  });
});

describe('the shared-key wall', () => {
  /*
   * 🔴 FAIL CLOSED. "No key configured" must never mean "no key required" — that turns the endpoint
   * into a public customer-list oracle during any deploy that drops one variable, silently.
   */
  it('refuses everything when no key is configured', () => {
    expect(isUnitySubscriptionApiConfigured({})).toBe(false);
    expect(() => requireUnitySubscriptionKey(requestWithKey(KEY), {})).toThrow(/not configured/i);
  });

  it('accepts the configured key as a bearer token', () => {
    vi.stubEnv('UNITY_SUBSCRIPTION_API_KEY', KEY);
    expect(() => requireUnitySubscriptionKey(requestWithKey(KEY), {})).not.toThrow();
  });

  it('accepts the configured key as X-Api-Key', () => {
    vi.stubEnv('UNITY_SUBSCRIPTION_API_KEY', KEY);
    expect(() => requireUnitySubscriptionKey(requestWithKey(undefined, { 'x-api-key': KEY }), {})).not.toThrow();
  });

  it('refuses a wrong key and a missing key with the SAME message', () => {
    vi.stubEnv('UNITY_SUBSCRIPTION_API_KEY', KEY);

    const wrong = (() => {
      try {
        requireUnitySubscriptionKey(requestWithKey('nope-nope-nope-nope-nope'), {});
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    })();

    const missing = (() => {
      try {
        requireUnitySubscriptionKey(requestWithKey(undefined), {});
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    })();

    expect(wrong).toBeTruthy();
    expect(wrong).toBe(missing);
  });

  /*
   * `timingSafeEqual` THROWS on a length mismatch rather than returning false — the exact trap
   * `git/oauth.ts` records. A key of a different length must be a clean 401, never a 500.
   */
  it('does not throw a non-auth error on a key of a different LENGTH', () => {
    vi.stubEnv('UNITY_SUBSCRIPTION_API_KEY', KEY);
    expect(() => requireUnitySubscriptionKey(requestWithKey('short'), {})).toThrow(/valid API key/i);
  });

  /*
   * A credential in a URL lands in access logs, proxy logs and browser history. The reader is
   * headers-only, and this pins it: a key presented as a query parameter is NOT accepted.
   */
  it('never accepts the key from the query string', () => {
    vi.stubEnv('UNITY_SUBSCRIPTION_API_KEY', KEY);

    const request = new Request(`https://app.example.com/api/unity/subscription?email=a@b.com&apiKey=${KEY}`);

    expect(presentedApiKey(request)).toBeNull();
    expect(() => requireUnitySubscriptionKey(request, {})).toThrow(/valid API key/i);
  });
});

describe('callerFingerprint', () => {
  it('prefers cf-connecting-ip', () => {
    expect(callerFingerprint(requestWithKey(KEY, { 'cf-connecting-ip': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('takes the FIRST entry of x-forwarded-for (the client, not the proxy)', () => {
    expect(callerFingerprint(requestWithKey(KEY, { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe('203.0.113.7');
  });

  it('degrades to a constant rather than throwing when nothing identifies the caller', () => {
    expect(callerFingerprint(requestWithKey(KEY))).toBe('unknown');
  });
});

describe('checkSubscriptionByEmail (local mode)', () => {
  /*
   * 🔴 THE SYMMETRY THAT KEEPS THIS FROM BEING AN ACCOUNT-EXISTENCE ORACLE.
   *
   * The key that guards this route ships inside a distributed Editor package, so a response that told
   * "we have never seen this address" apart from "this address has nothing" would let anyone who
   * extracted it enumerate our customers — the reason `requireOwnedProject` answers 404 and not 403.
   */
  it('answers identically for an unknown email and a known email with nothing', async () => {
    setLedger(ledgerWithBalance(0));

    const unknown = await checkSubscriptionByEmail('stranger@example.com', {});
    const knownButEmpty = await checkSubscriptionByEmail(LOCAL_USER.email, {});

    expect(unknown.active).toBe(knownButEmpty.active);
    expect(unknown.reason).toBe(knownButEmpty.reason);
    expect(unknown).toEqual({ email: 'stranger@example.com', active: false, reason: 'none' });
  });

  it('grants a known email holding credits', async () => {
    setLedger(ledgerWithBalance(4200));

    await expect(checkSubscriptionByEmail(LOCAL_USER.email, {})).resolves.toEqual({
      email: LOCAL_USER.email,
      active: true,
      reason: 'credits',
    });
  });

  /*
   * The CONTROL for the test above. Without it, "grants a known email holding credits" passes for a
   * function that grants EVERY email — which is the same bug pointing the other way, and the one that
   * costs money.
   */
  it('does not grant an unknown email even when the ledger would report credits', async () => {
    setLedger(ledgerWithBalance(4200));

    await expect(checkSubscriptionByEmail('stranger@example.com', {})).resolves.toEqual({
      email: 'stranger@example.com',
      active: false,
      reason: 'none',
    });
  });

  /* Stripe is unconfigured here, so this also proves the lookup degrades rather than throwing. */
  it('does not throw when Stripe cannot be consulted', async () => {
    setLedger(ledgerWithBalance(1));
    await expect(checkSubscriptionByEmail(LOCAL_USER.email, {})).resolves.toMatchObject({ active: true });
  });

  /*
   * 🔴 THE COMPOSITION THE ROUTE ACTUALLY PERFORMS — normalize, THEN check.
   *
   * Everything above calls `checkSubscriptionByEmail` with an already-clean address, which is not what
   * the endpoint does and is why a normalizer that rejected the local user survived a green suite. This
   * drives the pair exactly as `api.unity.subscription.ts` does, from the raw shape a Unity developer
   * types: padded and mixed-case.
   */
  it('resolves a raw, mixed-case, padded address end to end (normalize → check)', async () => {
    setLedger(ledgerWithBalance(10));

    const raw = `  ${LOCAL_USER.email.toUpperCase()}  `;
    const normalized = normalizeSubscriberEmail(raw);

    expect(normalized).toBe(LOCAL_USER.email);

    await expect(checkSubscriptionByEmail(normalized!, {})).resolves.toEqual({
      email: LOCAL_USER.email,
      active: true,
      reason: 'credits',
    });
  });
});

describe('the 429 carries Retry-After (http.ts)', () => {
  /*
   * `RateLimitedError` has always documented itself as "429 + `Retry-After`" and always carried
   * `retryAfterSeconds` — but `errorResponse` built no headers, so the header was never sent by any
   * rate-limited route. Found by curling a real 429, not by any test: every existing assertion read the
   * BODY. A client that cannot read a back-off interval retries immediately and makes the limit worse.
   */
  it('emits Retry-After on a rate-limit refusal', () => {
    const now = 1_000_000;
    const response = errorResponse(new RateLimitedError(now + 90_000, now, 'subscription checks'));

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('90');
  });

  /* The CONTROL: a header that is always present is meaningless on a 401/404. */
  it('does not emit Retry-After on an ordinary refusal', () => {
    expect(errorResponse(new UnauthorizedError()).headers.get('Retry-After')).toBeNull();
  });
});
