/**
 * Email → entitlement, for the Unity Editor subscription check (SPEC §4.18, §4.6).
 *
 * The decision itself is pure and lives in `subscription-access.ts`; this module is the two lookups
 * that feed it, plus the email→user-id step that has to happen first because every entitlement fact we
 * hold is keyed on our own user id (see migration 0022 for why that is not negotiable).
 */
import { createScopedLogger } from '~/utils/logger';
import { createAdminClient, isSupabaseConfigured } from '~/lib/.server/supabase/client';
import { LOCAL_USER } from '~/lib/.server/supabase/auth';
import { getLedger } from '~/lib/.server/billing/ledger';
import { findActiveSubscription } from '~/lib/.server/billing/stripe';
import { decideSubscriptionAccess, type SubscriptionAccess } from './subscription-access';

const logger = createScopedLogger('licensing.subscriber-status');

/**
 * Resolve an email to a platform user id, or `null` when we have never seen it.
 *
 * In local mode (Supabase unconfigured) there is exactly one user, so the only address that resolves
 * is theirs. That keeps the endpoint genuinely testable before a Supabase project exists (§1.3
 * principle 0) rather than being a feature that only works in production — which is the state every
 * live-fidelity defect in this codebase was found in.
 *
 * ⚠️ The caller must pass an ALREADY-NORMALIZED address (`normalizeSubscriberEmail`). The SQL lowers
 * and trims defensively too, because two normalizers that can disagree is the drift this repo keeps
 * rediscovering — but the validity gate belongs at the boundary, before a round trip is spent.
 */
export async function findUserIdByEmail(email: string, context?: unknown): Promise<string | null> {
  if (!isSupabaseConfigured(context)) {
    return email === LOCAL_USER.email ? LOCAL_USER.id : null;
  }

  const admin = await createAdminClient(context);
  const { data, error } = await admin.rpc('user_id_for_email', { p_email: email });

  if (error) {
    logger.error(`user_id_for_email failed: ${error.message}`);
    throw new Error('Subscriber lookup failed');
  }

  return typeof data === 'string' && data ? data : null;
}

/**
 * The subscription status Stripe reports for this user, or `null` when it cannot be consulted.
 *
 * 🔴 **Every failure here degrades to `null`, never to an exception and never to "active".** Stripe
 * being unconfigured, rate-limiting us, or having an incident must not decide that an entire Unity
 * install base has no licence — and it must not decide the opposite either. `null` hands the question
 * to the credits branch, which is answerable from our own database, so a pack buyer is unaffected by a
 * Stripe outage and a subscriber falls back to whatever balance they hold.
 *
 * Stripe's subscription Search is eventually consistent (~a minute for a brand-new object), which is
 * why it is not what grants credits — `invoice.paid` is (§4.6). For a read-only entitlement check a
 * minute of lag is acceptable and is documented on `findActiveSubscription` itself.
 */
async function subscriptionStatusFor(userId: string, context?: unknown): Promise<string | null> {
  try {
    const subscription = await findActiveSubscription(userId, context);
    return subscription?.status ?? null;
  } catch (error) {
    logger.warn(`Stripe subscription lookup failed; falling back to the credit balance: ${String(error)}`);
    return null;
  }
}

export interface SubscriberStatus extends SubscriptionAccess {
  /** The normalized address we were asked about, echoed so the Editor can confirm what was checked. */
  email: string;
}

/**
 * The whole check for one email.
 *
 * An unknown address returns the SAME body as a known address with no entitlement — `active: false`,
 * `reason: 'none'`. That symmetry is load-bearing: this endpoint is reachable with a key that ships
 * inside a distributed Editor package, and a response that distinguished "no account" from "account,
 * nothing bought" would turn it into an account-existence oracle on top of a subscription one.
 *
 * A ledger failure is deliberately allowed to throw. We cannot answer, and answering `false` would
 * silently deny paying customers with nothing anywhere reporting it — a 500 at least tells the Editor
 * that the question went unanswered rather than answered "no" (`spec/fail-loud.md`).
 */
export async function checkSubscriptionByEmail(email: string, context?: unknown): Promise<SubscriberStatus> {
  const userId = await findUserIdByEmail(email, context);

  if (!userId) {
    return { email, active: false, reason: 'none' };
  }

  const [subscriptionStatus, creditBalance] = await Promise.all([
    subscriptionStatusFor(userId, context),
    getLedger(context).balance(userId),
  ]);

  return { email, ...decideSubscriptionAccess({ subscriptionStatus, creditBalance }) };
}
