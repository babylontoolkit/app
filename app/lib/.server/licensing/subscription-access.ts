/**
 * "Does this Unity developer have an active subscription?" — the pure decision (SPEC §4.18, §4.6).
 *
 * Consumed by the Unity Editor over `GET /api/unity/subscription`, which is the only caller that asks
 * this question about SOMEBODY ELSE by email. Everything that decides the answer lives here as a pure
 * function so it can be driven exhaustively: the route is then only plumbing (authenticate, look the
 * email up, read two facts, call this).
 *
 * ## Access is subscription OR credits (owner decision, 2026-08-14)
 *
 * §4.18 retired the PayPal-era Pro Tools subscription and made the platform credits-based —
 * "the credit balance IS the Pro Tools entitlement". A monthly plan is therefore not the only way to
 * be a paying customer: someone who bought a one-off credit pack has paid us money and expects the
 * Editor tools to work. Gating Unity on the subscription alone would lock out exactly those people,
 * silently, and they would have no way to tell why.
 *
 * So either fact grants access, and `reason` records which one did — an operator answering a support
 * ticket needs to know whether a developer is on a plan or burning down a pack.
 *
 * ## The two directions this can be wrong are NOT symmetrical
 *
 * Returning `true` wrongly gives away the paid Editor tools to someone who has not paid, and nothing
 * anywhere will report it. Returning `false` wrongly annoys a paying customer, who will tell us within
 * the hour. Every ambiguous case below therefore resolves toward `false` — with one exception, and it
 * is deliberate: a subscription in Stripe's dunning window (`past_due`) still counts, because that is a
 * customer whose card failed rather than a customer who left, and Stripe is at that moment retrying the
 * charge on our behalf. `unpaid`/`incomplete`/`canceled` do not count.
 *
 * ⚠️ **A Stripe outage must never read as "subscribed".** The caller passes `null` for the status when
 * Stripe is unconfigured, unreachable, or errored — not a made-up "active" and not an exception. That
 * degrades the subscription branch to absent while leaving the credits branch fully able to answer, so
 * a pack buyer is unaffected by a Stripe incident and a subscriber falls back to their credit balance.
 * The alternative — failing the whole check open — would hand out the Editor tools to the entire
 * internet for the duration of the outage.
 */

/** Which reason granted access. `'none'` is also the answer for an email we have never seen. */
export type SubscriptionAccessReason = 'subscription' | 'credits' | 'none';

export interface SubscriptionAccessInput {
  /**
   * Stripe's own subscription status verbatim, or `null` when there is no subscription — INCLUDING
   * when Stripe could not be consulted. The caller never re-interprets it; that is this module's job.
   */
  subscriptionStatus?: string | null;

  /**
   * The derived credit balance (latest `balance_after`).
   *
   * ⚠️ May legitimately be NEGATIVE: a `generation` debit is exempt from the non-negative rule because
   * §4.2.1 forbids killing an in-flight generation over balance, so the true cost can exceed what was
   * there when the gate ran (`ledger.ts` `mayGoNegative`). `> 0` is therefore the test — `!== 0` would
   * hand an overdrawn account the paid tools, and `>= 0` would hand them to every signed-up stranger
   * who has never bought anything.
   */
  creditBalance: number;
}

export interface SubscriptionAccess {
  active: boolean;
  reason: SubscriptionAccessReason;
}

/**
 * Stripe statuses that count as a live subscription.
 *
 * A `ReadonlySet` so a spec can pin MEMBERSHIP rather than re-listing the strings: "which statuses
 * grant the paid Editor tools" is a money decision, and a test that re-types the list agrees with
 * itself by construction. Notably absent: `canceled`, `unpaid`, `incomplete`, `incomplete_expired`,
 * `paused`.
 *
 * `cancel_at_period_end` is NOT a status — Stripe keeps such a subscription `active` until the period
 * actually ends, which is correct here: they paid for the month, they get the month.
 */
export const ACTIVE_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due']);

export function isActiveSubscriptionStatus(status: string | null | undefined): boolean {
  if (!status) {
    return false;
  }

  return ACTIVE_SUBSCRIPTION_STATUSES.has(status.trim().toLowerCase());
}

/**
 * The whole decision. Total: every input produces an answer, and it never throws — this runs on a
 * request that must return a boolean rather than an error page.
 */
export function decideSubscriptionAccess(input: SubscriptionAccessInput): SubscriptionAccess {
  if (isActiveSubscriptionStatus(input.subscriptionStatus)) {
    return { active: true, reason: 'subscription' };
  }

  /*
   * Number.isFinite rejects NaN/Infinity — a balance we could not compute is not a balance we may
   * spend the paid tools against.
   */
  if (Number.isFinite(input.creditBalance) && input.creditBalance > 0) {
    return { active: true, reason: 'credits' };
  }

  return { active: false, reason: 'none' };
}

/**
 * Normalize an email for lookup and for echoing back.
 *
 * Lowercased and trimmed because `Dev@Studio.com` and `dev@studio.com` are one account to Supabase
 * Auth, and a Unity developer typing their address into an Editor field will not match our casing.
 * Returns `null` for anything that is not plausibly an address, so the route refuses before it spends
 * a database round trip on `?email=' OR 1=1` — the parameter arrives from the public internet.
 */
export function normalizeSubscriberEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const email = raw.trim().toLowerCase();

  /*
   * Deliberately loose: exactly one `@`, no whitespace, something on both sides, bounded length. A
   * sanity gate to avoid spending a database round trip on junk — NOT an RFC 5322 validator. The real
   * authority on whether an address exists is the lookup, which is parameterized and cannot be
   * injected into.
   *
   * ⚠️ **It must NOT require a dot in the domain, and this was wrong on the first pass.** Requiring
   * one rejects `local@localhost` — the local-mode user (`LOCAL_USER.email`) — so the endpoint 400'd
   * on the only address that resolves when Supabase is unconfigured, i.e. it could not be exercised
   * outside production. Found by curling the running route: every unit test called
   * `checkSubscriptionByEmail` directly and never composed it with this function, which is the exact
   * seam the route is made of. Single-label domains are legal, intranet mail uses them, and the
   * stricter rule bought nothing the lookup does not already provide.
   */
  if (email.length < 3 || email.length > 254) {
    return null;
  }

  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    return null;
  }

  return email;
}
