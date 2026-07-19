/**
 * Stripe checkout and webhooks (SPEC §4.6).
 *
 * **Stripe is the platform's sole payment processor.** There is no PayPal integration anywhere in
 * this system: Pro Tools subscriptions are validated exclusively through the license service (§4.6.1),
 * and how that service verifies them internally is outside our boundary. The ledger keeps
 * provider-agnostic `paymentProvider`/`paymentRef` fields purely as cheap insurance against a future
 * Merchant-of-Record move — not because a second integration is planned.
 *
 * Two rules protect the money:
 *
 * 1. **The user id is SERVER-ASSERTED, never client-supplied.** The checkout session is created
 *    server-side with the authenticated user's id in its metadata, and the webhook credits THAT id.
 *    A payment can therefore never credit the wrong account, no matter what the browser sends.
 * 2. **The webhook is idempotent on `payment_ref`.** Stripe retries deliveries — that is a feature,
 *    not a bug — and a webhook handler that credits on every delivery hands out free credits to
 *    anyone who can make us return a 500. The unique index on `payment_ref` is the real guard;
 *    `DuplicatePaymentError` is the expected, successful outcome of a retry.
 */
import type Stripe from 'stripe';
import { createScopedLogger } from '~/utils/logger';
import { NotConfiguredError } from '~/lib/.server/env';
import { DuplicatePaymentError, getLedger } from './ledger';
import { getBillingConfig } from './rates';
import { findCatalogItem } from '~/lib/.server/assets/catalog';
import { getAssetEntitlementStore } from '~/lib/.server/assets/entitlements';

const logger = createScopedLogger('stripe');

/**
 * Credit packs. Config, not code (§4.6) — retail pricing is a launch decision and these are tuned
 * without a schema change.
 *
 * ⚠️ **A PACK'S PRICE AND `CREDIT_MARGIN` ARE ONE NUMBER, SPLIT ACROSS TWO FILES.**
 *
 * `rates.ts` charges `ceil(raw / CREDIT_UNIT_COST_USD * CREDIT_MARGIN)` credits — which only yields
 * `CREDIT_MARGIN` if a credit actually RETAILS at `CREDIT_UNIT_COST_USD` ($0.01). The real margin is:
 *
 *     effective margin = CREDIT_MARGIN x (pack $/credit ÷ CREDIT_UNIT_COST_USD)
 *
 * Price a credit below $0.01 and the multiplier silently shrinks. The packs shipped at $0.003/credit
 * (5,000 for $15) against a 3.34x setting — an effective **1.01x on Hobby and 0.84x on Studio**, i.e.
 * every generation on the largest pack LOST ~19% before Stripe's cut, and the bigger the customer the
 * worse it got. Nothing threw: two files, each internally sensible, disagreeing about what a credit is
 * worth. `packMargin()` + `billing.spec.ts` now make that arithmetic assert itself.
 *
 * Sized against the MEASURED cost of real work on KIE at margin 4.0 (`rates.ts`): a cold creation is
 * ~231 credits (optimized reference; harder games have measured up to ~500), a warm creation ~170, an
 * edit ~15–80. So Starter (3,000) ≈ one game + ~50 edits, or ~10 fresh builds; Pro (9,500) ≈ heavy
 * multi-game iteration; Studio (25,000) ≈ ~40 cold builds.
 *
 * Benchmarked against the market as a PREMIUM specialty game platform, NOT a website builder. The base
 * is $0.01/credit (Starter $30/3,000), with a shallow volume discount to $0.009 (Studio $225/25,000) —
 * mirroring the market's own shape: Lovable charges a flat $0.25/message and discounts only 2–10% even
 * at 5,000 credits; Seele.ai sells koins at $0.010/$0.0083/$0.0080. At margin 4.0 a single edit costs
 * ~$0.41 vs Lovable's $0.25 — already premium per unit of (heavier) work, so we do not compete on
 * price, we bank the KIE cost advantage as margin. `packMargin()` asserts every pack clears the floor.
 */
export interface CreditPack {
  id: string;
  name: string;
  credits: number;
  priceCents: number;
  isActive: boolean;
}

export const CREDIT_PACKS: CreditPack[] = [
  { id: 'starter', name: 'Starter', credits: 3000, priceCents: 3000, isActive: true },
  { id: 'pro', name: 'Pro', credits: 9500, priceCents: 9000, isActive: true },
  { id: 'studio', name: 'Studio', credits: 25000, priceCents: 22500, isActive: true },
];

/**
 * What a pack ACTUALLY earns, once the pack price and the credit-charging formula are reconciled.
 *
 * The one number nobody could see: `CREDIT_MARGIN` is aspirational, this is real. A volume discount
 * legitimately lowers it (bigger pack, cheaper credit) — dropping it toward 1.0 does not.
 */
export function packMargin(pack: CreditPack, config: { creditUnitCostUsd: number; margin: number }): number {
  const pricePerCredit = pack.priceCents / 100 / pack.credits;
  return (pricePerCredit / config.creditUnitCostUsd) * config.margin;
}

/**
 * The floor a pack may never price below. Not break-even (1.0) — Stripe takes ~2.9% + 30¢, refunds and
 * failed generations are on us (§4.6), and the signup grant is pure cost. A pack at 1.0x is a slow loss.
 */
export const MIN_PACK_MARGIN = 2;

export function getCreditPack(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find((pack) => pack.id === id && pack.isActive);
}

/**
 * Monthly credit subscriptions (SPEC §4.6 "optional platform subscription auto-grant").
 *
 * The comparable market sells this way — Seele.ai is $20/$50/$200 **per month** for koins, Lovable is a
 * monthly seat. A one-time pack and a subscription are not two prices for the same thing; they are two
 * businesses. This is the recurring one.
 *
 * **These are NOT Pro Tools (§4.6.1).** Pro is BYOK-only, validated exclusively by the license service,
 * and remains the one Pro-gated capability. A credit subscription buys credits and nothing else — no
 * feature is behind it, ever.
 *
 * Per-credit pricing matches the packs on purpose, so a subscriber is never worse off than someone
 * buying the same volume a la carte; the subscription's value is that it arrives every month without
 * being asked for. Margins are asserted by the same `packMargin()` floor.
 */
export interface SubscriptionPlan {
  id: string;
  name: string;

  /** Credits granted on EVERY paid invoice — i.e. monthly, for as long as it renews. */
  creditsPerMonth: number;
  priceCents: number;
  isActive: boolean;
}

export const SUBSCRIPTION_PLANS: SubscriptionPlan[] = [
  { id: 'sub_starter', name: 'Starter', creditsPerMonth: 3000, priceCents: 3000, isActive: true },
  { id: 'sub_pro', name: 'Pro', creditsPerMonth: 9500, priceCents: 9000, isActive: true },
  { id: 'sub_studio', name: 'Studio', creditsPerMonth: 25000, priceCents: 22500, isActive: true },
];

export function getSubscriptionPlan(id: string): SubscriptionPlan | undefined {
  return SUBSCRIPTION_PLANS.find((plan) => plan.id === id && plan.isActive);
}

/** A plan priced as a pack, so one margin floor covers both revenue shapes. */
export function planAsPack(plan: SubscriptionPlan): CreditPack {
  return {
    id: plan.id,
    name: plan.name,
    credits: plan.creditsPerMonth,
    priceCents: plan.priceCents,
    isActive: plan.isActive,
  };
}

async function getStripe(context?: unknown): Promise<Stripe> {
  const config = getBillingConfig(context);

  if (!config.stripeSecretKey) {
    throw new NotConfiguredError(
      'Stripe',
      'Set STRIPE_SECRET_KEY in the server environment to enable credit purchases.',
    );
  }

  const stripeSdk = await import('stripe');

  return new stripeSdk.default(config.stripeSecretKey);
}

export function isStripeConfigured(context?: unknown): boolean {
  return Boolean(getBillingConfig(context).stripeSecretKey);
}

export interface CheckoutInput {
  userId: string;
  userEmail: string;
  packId: string;
  successUrl: string;
  cancelUrl: string;
  context?: unknown;
}

/** Create a Checkout session. Cards + Apple/Google Pay + Link come free with Stripe Checkout. */
export async function createCheckoutSession(input: CheckoutInput): Promise<{ url: string; sessionId: string }> {
  const pack = getCreditPack(input.packId);

  if (!pack) {
    throw new Error(`Unknown credit pack: ${input.packId}`);
  }

  const stripe = await getStripe(input.context);

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: input.userEmail,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: pack.priceCents,
          product_data: {
            name: `${pack.name} — ${pack.credits.toLocaleString()} credits`,
            description: 'Credits never expire.',
          },
        },
      },
    ],

    /*
     * The binding between a payment and a user. The webhook reads THIS, not anything the browser
     * sends back — which is what makes it impossible for a payment to credit the wrong account.
     */
    metadata: { userId: input.userId, packId: pack.id, credits: String(pack.credits) },

    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  });

  if (!session.url) {
    throw new Error('Stripe did not return a checkout URL.');
  }

  logger.info(`Checkout session ${session.id} created for ${input.userId} (${pack.id})`);

  return { url: session.url, sessionId: session.id };
}

export interface SubscriptionCheckoutInput {
  userId: string;
  userEmail: string;
  planId: string;
  successUrl: string;
  cancelUrl: string;
  context?: unknown;
}

/**
 * Start a monthly credit subscription.
 *
 * `price_data.recurring` creates the price inline, so plans stay CONFIG in this file — no Stripe
 * dashboard products to create, and no price ids to keep in sync with code (a class of drift that just
 * cost us a 0.84x margin in two files that could not see each other).
 *
 * **`subscription_data.metadata` is the load-bearing line.** Renewal invoices carry no checkout session,
 * so the *subscription's* metadata is the only durable binding between Stripe and our user id. Put it on
 * the session alone and month two credits nobody.
 */
export async function createSubscriptionCheckout(
  input: SubscriptionCheckoutInput,
): Promise<{ url: string; sessionId: string }> {
  const plan = getSubscriptionPlan(input.planId);

  if (!plan) {
    throw new Error(`Unknown subscription plan: ${input.planId}`);
  }

  const stripe = await getStripe(input.context);

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: input.userEmail,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: plan.priceCents,
          recurring: { interval: 'month' },
          product_data: {
            name: `${plan.name} — ${plan.creditsPerMonth.toLocaleString()} credits/month`,
            description: 'Credits are added every month and never expire.',
          },
        },
      },
    ],

    // Rides on the SUBSCRIPTION, so every future renewal invoice can still be attributed to this user.
    subscription_data: {
      metadata: { userId: input.userId, planId: plan.id, credits: String(plan.creditsPerMonth) },
    },

    /*
     * Deliberately NOT the grant trigger. Credits are granted on `invoice.paid` only — which fires for
     * the first invoice too. Granting here as well would double-credit month one under a different
     * idempotency key, and the unique index could not catch it (see `handleWebhook`).
     */
    metadata: { userId: input.userId, planId: plan.id, kind: 'subscription' },

    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  });

  if (!session.url) {
    throw new Error('Stripe did not return a checkout URL.');
  }

  logger.info(`Subscription checkout ${session.id} created for ${input.userId} (${plan.id})`);

  return { url: session.url, sessionId: session.id };
}

export interface ActiveSubscription {
  subscriptionId: string;
  customerId: string;
  planId: string;
  creditsPerMonth: number;

  /** Stripe's own status: active, trialing, past_due, canceled… Shown as-is; we never re-interpret it. */
  status: string;

  /** Set when the user has cancelled but the period they paid for has not ended yet. */
  cancelAtPeriodEnd: boolean;
}

/**
 * Find a user's subscription — by OUR user id, not their email.
 *
 * Stripe's Search API queries the `userId` we stamped on the subscription at checkout, which is the
 * only identifier we control. Looking it up by `customer_email` would break the moment someone changes
 * their platform email, and would silently match the WRONG customer if two accounts ever shared one.
 *
 * Returns null rather than throwing when there is nothing: "no subscription" is the normal state for
 * almost every user, not an error. Search is eventually consistent (~a minute for a brand-new object),
 * which is fine for a management screen and is why it is NOT what grants credits — `invoice.paid` is.
 */
export async function findActiveSubscription(userId: string, context?: unknown): Promise<ActiveSubscription | null> {
  const stripe = await getStripe(context);

  const found = await stripe.subscriptions.search({
    query: `metadata['userId']:'${userId.replace(/'/g, '')}'`,
    limit: 1,
  });

  const sub = found.data[0];

  if (!sub) {
    return null;
  }

  return {
    subscriptionId: sub.id,
    customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
    planId: sub.metadata?.planId ?? 'unknown',
    creditsPerMonth: Number(sub.metadata?.credits ?? 0),
    status: sub.status,
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
  };
}

/**
 * A Stripe-hosted billing portal session — cancel, change card, download invoices.
 *
 * Deliberately NOT our own cancel button. Cancellation, proration, dunning and invoice history are
 * Stripe's job and they do it correctly; a hand-rolled cancel is a payments bug waiting to happen, and
 * card details must never come near our server. The portal also means cancellation needs no code on our
 * side at all: Stripe stops issuing invoices, and `invoice.paid` simply stops firing.
 */
export async function createBillingPortalSession(input: {
  userId: string;
  returnUrl: string;
  context?: unknown;
}): Promise<{ url: string }> {
  const subscription = await findActiveSubscription(input.userId, input.context);

  if (!subscription) {
    throw new Error('No subscription found for this account.');
  }

  const stripe = await getStripe(input.context);
  const session = await stripe.billingPortal.sessions.create({
    customer: subscription.customerId,
    return_url: input.returnUrl,
  });

  return { url: session.url };
}

export interface AssetCheckoutInput {
  userId: string;
  userEmail: string;
  assetId: string;
  successUrl: string;
  cancelUrl: string;
  context?: unknown;
}

/**
 * Start a ONE-TIME purchase of a premium store asset (§4.9).
 *
 * Same money rules as a credit pack: the price is looked up server-side from the catalog (never from
 * the client), and the webhook grants ownership to the SERVER-ASSERTED user id in the metadata. The
 * `kind: 'asset'` marker is what routes the webhook to the entitlement grant instead of the ledger.
 */
export async function createAssetCheckoutSession(
  input: AssetCheckoutInput,
): Promise<{ url: string; sessionId: string }> {
  const item = findCatalogItem(input.assetId);

  if (!item) {
    throw new Error(`Unknown catalog asset: ${input.assetId}`);
  }

  if (!item.premium || !item.priceCents) {
    throw new Error(`Asset ${input.assetId} is not a premium purchasable item.`);
  }

  const stripe = await getStripe(input.context);

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: input.userEmail,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: item.priceCents,
          product_data: { name: item.title, description: item.description ?? 'Premium store asset.' },
        },
      },
    ],

    // The webhook reads THIS (not the browser) — a purchase can never grant on the wrong account.
    metadata: { userId: input.userId, assetId: item.id, kind: 'asset' },

    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  });

  if (!session.url) {
    throw new Error('Stripe did not return a checkout URL.');
  }

  logger.info(`Asset checkout ${session.id} created for ${input.userId} (${item.id})`);

  return { url: session.url, sessionId: session.id };
}

/**
 * Verify and apply a webhook.
 *
 * The signature check is not optional and not a formality: this endpoint is a public URL that grants
 * credits. Without `constructEvent`, anyone who can POST to it can mint themselves an unlimited
 * balance. The raw body must be passed through UNPARSED — re-serializing the JSON changes the bytes
 * and the HMAC will not match.
 */
export async function handleWebhook(
  rawBody: string,
  signature: string,
  context?: unknown,
): Promise<{ applied: boolean; reason: string }> {
  const config = getBillingConfig(context);

  if (!config.stripeWebhookSecret) {
    throw new NotConfiguredError('The Stripe webhook secret', 'Set STRIPE_WEBHOOK_SECRET in the server environment.');
  }

  const stripe = await getStripe(context);

  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, config.stripeWebhookSecret);
  } catch (error) {
    logger.error(`Rejected a webhook with a bad signature: ${(error as Error).message}`);
    throw new Error('Invalid webhook signature.');
  }

  /*
   * A paid subscription invoice — the FIRST one and every renewal (SPEC §4.6).
   *
   * This is the only place a subscription grants credits, and the asymmetry with packs is the whole
   * point. A renewal never produces a checkout session, so `checkout.session.completed` cannot be the
   * trigger; and because `invoice.paid` ALSO fires for month one, granting in both places would credit
   * month one twice under two different idempotency keys (`session.id` and `invoice.id`) — two distinct
   * rows, both valid, the unique index powerless to notice. That is the classic Stripe subscription bug
   * and it hands out free credits forever, quietly.
   */
  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') {
    return grantSubscriptionInvoice(event, stripe, context);
  }

  if (event.type !== 'checkout.session.completed') {
    return { applied: false, reason: `Ignored event type ${event.type}` };
  }

  const session = event.data.object as Stripe.Checkout.Session;

  /*
   * A subscription's checkout session. Acknowledged, never granted — `invoice.paid` owns that (above).
   * Returning applied:false here is the correct, load-bearing no-op.
   */
  if (session.mode === 'subscription' || session.metadata?.kind === 'subscription') {
    return { applied: false, reason: 'Subscription checkout — credits are granted on invoice.paid.' };
  }

  if (session.payment_status !== 'paid') {
    return { applied: false, reason: `Session ${session.id} is not paid (${session.payment_status})` };
  }

  /*
   * A premium ASSET purchase (§4.9) rather than a credit pack. Marked by `kind: 'asset'` in the
   * metadata the SERVER set at checkout. Grants durable ownership (idempotent on payment_ref via the DB
   * unique index) instead of consumable credits.
   */
  if (session.metadata?.kind === 'asset') {
    const assetUserId = session.metadata?.userId;
    const assetId = session.metadata?.assetId;

    if (!assetUserId || !assetId) {
      logger.error(`Paid asset session ${session.id} is missing usable metadata — cannot grant`);
      return { applied: false, reason: 'Asset session metadata is missing a user or asset id.' };
    }

    const { granted } = await getAssetEntitlementStore(context).grant(assetUserId, assetId, session.id);

    if (granted) {
      logger.info(`Granted asset ${assetId} to ${assetUserId} for ${session.id}`);
      return { applied: true, reason: `Granted asset ${assetId}.` };
    }

    // Replayed delivery / already owned — 2xx so Stripe stops retrying.
    return { applied: false, reason: 'Asset already granted (duplicate delivery).' };
  }

  const userId = session.metadata?.userId;
  const credits = Number(session.metadata?.credits ?? 0);
  const packId = session.metadata?.packId ?? 'unknown';

  if (!userId || !Number.isFinite(credits) || credits <= 0) {
    logger.error(`Paid session ${session.id} is missing usable metadata — cannot credit anyone`);
    return { applied: false, reason: 'Session metadata is missing a user or credit amount.' };
  }

  try {
    const entry = await getLedger(context).append({
      userId,
      delta: credits,
      reason: 'purchase',
      paymentProvider: 'stripe',

      // The idempotency key. A retried delivery lands on the unique index and is refused.
      paymentRef: session.id,
      note: `${packId} pack`,
    });

    logger.info(`Credited ${credits} to ${userId} for ${session.id} (balance ${entry.balanceAfter})`);

    return { applied: true, reason: `Credited ${credits} credits.` };
  } catch (error) {
    /*
     * The expected outcome of a Stripe retry, and a SUCCESS: the credits are already there. Returning
     * 2xx is what stops Stripe from retrying forever.
     */
    if (error instanceof DuplicatePaymentError) {
      logger.info(`Webhook for ${session.id} replayed — already credited, ignoring`);
      return { applied: false, reason: 'Already credited (duplicate delivery).' };
    }

    throw error;
  }
}

/**
 * Grant a subscription invoice's credits — the monthly auto-grant (SPEC §4.6).
 *
 * Idempotent on the INVOICE id, which is what makes "one grant per billing period" true: Stripe issues
 * exactly one invoice per period, retries deliver the same id, and the ledger's unique index refuses the
 * second write. A cancelled subscription simply stops producing invoices, so it stops granting with no
 * code path of its own — nothing to forget to call.
 *
 * The user id comes from the SUBSCRIPTION's metadata (set at checkout), never from the invoice or
 * anything a browser could touch — the same server-asserted rule that protects pack purchases.
 */
async function grantSubscriptionInvoice(
  event: Stripe.Event,
  stripe: Stripe,
  context?: unknown,
): Promise<{ applied: boolean; reason: string }> {
  const invoice = event.data.object as Stripe.Invoice & { subscription?: string | Stripe.Subscription };

  // `status` is the field, not the legacy `paid` boolean (removed in recent API versions).
  if (invoice.status !== 'paid') {
    return { applied: false, reason: `Invoice ${invoice.id} is not paid (${invoice.status}).` };
  }

  const subRef = invoice.subscription;

  if (!subRef) {
    // A one-off invoice, not a subscription renewal. Packs are handled by checkout.session.completed.
    return { applied: false, reason: 'Invoice has no subscription — not a plan renewal.' };
  }

  const subscription =
    typeof subRef === 'string' ? await stripe.subscriptions.retrieve(subRef) : (subRef as Stripe.Subscription);

  const userId = subscription.metadata?.userId;
  const planId = subscription.metadata?.planId ?? 'unknown';
  const credits = Number(subscription.metadata?.credits ?? 0);

  if (!userId || !Number.isFinite(credits) || credits <= 0) {
    /*
     * Loud, not silent: a paid invoice we cannot attribute is money taken with nothing given. It must
     * never 500 (Stripe would retry forever, and the retry cannot fix missing metadata) — but it must
     * be findable in the logs.
     */
    logger.error(`Paid invoice ${invoice.id} on subscription ${subscription.id} has no usable metadata — cannot grant`);
    return { applied: false, reason: 'Subscription metadata is missing a user or credit amount.' };
  }

  try {
    const entry = await getLedger(context).append({
      userId,
      delta: credits,
      reason: 'purchase',
      paymentProvider: 'stripe',

      // One invoice, one grant. This is what makes a renewal grant exactly once, forever.
      paymentRef: invoice.id,
      note: `${planId} subscription`,
    });

    logger.info(`Granted ${credits} to ${userId} for invoice ${invoice.id} (balance ${entry.balanceAfter})`);

    return { applied: true, reason: `Credited ${credits} credits.` };
  } catch (error) {
    if (error instanceof DuplicatePaymentError) {
      logger.info(`Invoice ${invoice.id} replayed — already granted, ignoring`);
      return { applied: false, reason: 'Already credited (duplicate delivery).' };
    }

    throw error;
  }
}
