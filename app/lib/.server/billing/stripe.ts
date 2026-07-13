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

const logger = createScopedLogger('stripe');

/**
 * Credit packs. Config, not code (§4.6) — retail pricing is a launch decision and these are tuned
 * without a schema change. Sized against the measured ~450-credit cost of one real project creation.
 */
export interface CreditPack {
  id: string;
  name: string;
  credits: number;
  priceCents: number;
  isActive: boolean;
}

export const CREDIT_PACKS: CreditPack[] = [
  { id: 'hobby', name: 'Hobby', credits: 5000, priceCents: 1500, isActive: true },
  { id: 'pro', name: 'Pro', credits: 15000, priceCents: 4000, isActive: true },
  { id: 'studio', name: 'Studio', credits: 40000, priceCents: 10000, isActive: true },
];

export function getCreditPack(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find((pack) => pack.id === id && pack.isActive);
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

  if (event.type !== 'checkout.session.completed') {
    return { applied: false, reason: `Ignored event type ${event.type}` };
  }

  const session = event.data.object as Stripe.Checkout.Session;

  if (session.payment_status !== 'paid') {
    return { applied: false, reason: `Session ${session.id} is not paid (${session.payment_status})` };
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
