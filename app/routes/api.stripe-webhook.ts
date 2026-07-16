/**
 * Stripe webhook (SPEC §4.6).
 *
 * **This is a public, unauthenticated URL that grants credits.** Three things keep it honest, and all
 * three are load-bearing:
 *
 * 1. **The signature.** `handleWebhook` verifies the HMAC before trusting a single field. Without it,
 *    anyone who can POST here can mint themselves an unlimited balance.
 * 2. **The raw body.** We read `request.text()` and pass the bytes through UNPARSED. Parsing and
 *    re-serializing the JSON changes the bytes, the HMAC no longer matches, and every real payment
 *    starts failing — a bug that only ever shows up in production, against real money.
 * 3. **2xx on a duplicate.** Stripe retries deliveries. The ledger's unique index on `payment_ref`
 *    catches the replay, and we must answer 200 — a 500 makes Stripe retry the same event forever.
 *
 * There is no session here: Stripe is the caller, not the user. The user id comes from the checkout
 * session's metadata, which the SERVER put there.
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { createScopedLogger } from '~/utils/logger';
import { handleWebhook } from '~/lib/.server/billing/stripe';
import { getMonitor, FUNNEL_EVENTS, ALERT_SIGNALS } from '~/lib/.server/monitoring';

const logger = createScopedLogger('api.stripe-webhook');

export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return json({ error: true, message: 'Method not allowed.' }, { status: 405 });
  }

  const signature = request.headers.get('stripe-signature');

  if (!signature) {
    return json({ error: true, message: 'Missing signature.' }, { status: 400 });
  }

  // RAW bytes. Never `request.json()` — re-serializing breaks the HMAC.
  const rawBody = await request.text();

  try {
    const result = await handleWebhook(rawBody, signature, context);

    // Purchase funnel event (§5A) — only on the delivery that actually credited, never on a duplicate.
    if (result.applied) {
      getMonitor(context).track(FUNNEL_EVENTS.PURCHASE_COMPLETED);
    }

    // 200 either way: "already credited" is a success, and anything else makes Stripe retry forever.
    return json({ received: true, ...result });
  } catch (error) {
    const message = (error as Error).message;

    /*
     * A bad signature is the one case we answer 4xx: it is not a transient failure, retrying will not
     * help, and it means someone is poking at the endpoint.
     */
    if (message.includes('signature')) {
      /*
       * A bad signature means someone is POKING at a credit-granting endpoint — an operational signal,
       * not a transient failure. Alert on it so a probing attempt is visible in ops (§5A).
       */
      getMonitor(context).alert(ALERT_SIGNALS.WEBHOOK_FAILURE, 'Stripe webhook rejected: invalid signature', {
        severity: 'warning',
      });

      return json({ error: true, message: 'Invalid signature.' }, { status: 400 });
    }

    /*
     * A real failure (the ledger was unreachable). Answer 5xx SO THAT Stripe retries — the customer
     * has paid, and dropping the event here would take their money and give them nothing.
     */
    logger.error(`Webhook processing failed, asking Stripe to retry: ${message}`);

    /*
     * A real processing failure on a PAID event (the ledger was unreachable). The customer's money is
     * in limbo until Stripe's retry succeeds — critical, because dropping it silently takes their money
     * and gives them nothing (§5A alerting on webhook failures).
     */
    getMonitor(context).alert(ALERT_SIGNALS.WEBHOOK_FAILURE, `Stripe webhook processing failed: ${message}`, {
      severity: 'critical',
    });

    return json({ error: true, message: 'Could not process the event.' }, { status: 500 });
  }
}
