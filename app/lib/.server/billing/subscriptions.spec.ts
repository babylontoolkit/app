/**
 * Monthly credit subscriptions (SPEC §4.6).
 *
 * A subscription is not "a pack that repeats" — its money path is shaped differently, and the shape is
 * where the bugs are:
 *
 *  - A renewal produces **no checkout session**, so `checkout.session.completed` cannot be the trigger.
 *  - `invoice.paid` fires for month ONE as well. Grant in both places and month one is credited twice,
 *    under two different idempotency keys (`session.id` and `invoice.id`) — two legitimate-looking rows
 *    that the `payment_ref` unique index is powerless to reconcile. Free credits, forever, silently.
 *  - Cancellation has no code path: Stripe stops issuing invoices, so we stop granting. Nothing to call,
 *    nothing to forget.
 *
 * These drive the REAL `handleWebhook` with a stubbed Stripe SDK, so the guard is tested where it lives.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const subscriptions = new Map<string, any>();
const createdSessions: any[] = [];

vi.mock('stripe', () => {
  class FakeStripe {
    webhooks = {
      // Signature verification is Stripe's; the fixture IS the verified event.
      constructEventAsync: async (raw: string) => JSON.parse(raw),
    };
    subscriptions = {
      retrieve: async (id: string) => {
        const sub = subscriptions.get(id);

        if (!sub) {
          throw new Error(`no such subscription ${id}`);
        }

        return sub;
      },
    };
    checkout = {
      sessions: {
        create: async (params: any) => {
          createdSessions.push(params);
          return { id: 'cs_test_1', url: 'https://checkout.stripe.test/cs_test_1' };
        },
      },
    };
  }

  return { default: FakeStripe };
});

/*
 * Imported after `vi.mock('stripe')` so the stub is in place; a namespace import because destructuring
 * the `FsLedger` class trips the naming-convention rule.
 */
const ledgerModule = await import('./ledger');
const { setLedger, getLedger } = ledgerModule;
const { handleWebhook, createSubscriptionCheckout, SUBSCRIPTION_PLANS, planAsPack, packMargin, MIN_PACK_MARGIN } =
  await import('./stripe');

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'subs-'));
  setLedger(new ledgerModule.FsLedger(tmp));
  subscriptions.clear();
  createdSessions.length = 0;
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_x');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_x');
});

afterEach(async () => {
  setLedger(undefined);
  await fs.rm(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** A subscription carrying the metadata `createSubscriptionCheckout` sets. */
function sub(id: string, over: Record<string, string> = {}) {
  const s = { id, metadata: { userId: 'u1', planId: 'sub_pro', credits: '9500', ...over } };
  subscriptions.set(id, s);

  return s;
}

const invoicePaid = (id: string, subId: string | undefined, status = 'paid') =>
  JSON.stringify({
    type: 'invoice.paid',
    data: { object: { id, status, subscription: subId } },
  });

describe('subscription checkout', () => {
  it('puts the user binding on the SUBSCRIPTION, not just the session', async () => {
    await createSubscriptionCheckout({
      userId: 'u1',
      userEmail: 'a@b.c',
      planId: 'sub_pro',
      successUrl: 'https://app/ok',
      cancelUrl: 'https://app/no',
    });

    const params = createdSessions[0];
    expect(params.mode).toBe('subscription');

    /*
     * The load-bearing assertion. A renewal invoice has no session, so subscription metadata is the ONLY
     * durable link back to our user. Put it on the session alone and month two credits nobody.
     */
    expect(params.subscription_data.metadata).toEqual({ userId: 'u1', planId: 'sub_pro', credits: '9500' });
    expect(params.line_items[0].price_data.recurring).toEqual({ interval: 'month' });
  });

  it('refuses an unknown plan', async () => {
    await expect(
      createSubscriptionCheckout({
        userId: 'u1',
        userEmail: 'a@b.c',
        planId: 'nope',
        successUrl: 'x',
        cancelUrl: 'y',
      }),
    ).rejects.toThrow(/Unknown subscription plan/);
  });
});

describe('the monthly grant', () => {
  it('credits the plan on a paid invoice', async () => {
    sub('sub_1');

    const result = await handleWebhook(invoicePaid('in_1', 'sub_1'), 'sig');

    expect(result.applied).toBe(true);
    expect(await getLedger().balance('u1')).toBe(9500);
  });

  it('grants again next month — a different invoice is a different grant', async () => {
    sub('sub_1');
    await handleWebhook(invoicePaid('in_1', 'sub_1'), 'sig');
    await handleWebhook(invoicePaid('in_2', 'sub_1'), 'sig');

    expect(await getLedger().balance('u1')).toBe(19_000);
  });

  it('is idempotent on the invoice id — a Stripe retry cannot double-credit', async () => {
    sub('sub_1');
    await handleWebhook(invoicePaid('in_1', 'sub_1'), 'sig');

    const replay = await handleWebhook(invoicePaid('in_1', 'sub_1'), 'sig');

    // Not an error: a replay is Stripe working correctly. 2xx is what stops the retries.
    expect(replay.applied).toBe(false);
    expect(replay.reason).toMatch(/duplicate/i);
    expect(await getLedger().balance('u1')).toBe(9500);
  });

  /**
   * THE DOUBLE-GRANT. Month one fires BOTH events. Only `invoice.paid` may grant.
   */
  it('does NOT grant on a subscription checkout session', async () => {
    sub('sub_1');

    const session = JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_1',
          mode: 'subscription',
          payment_status: 'paid',
          metadata: { userId: 'u1', planId: 'sub_pro', kind: 'subscription', credits: '9500' },
        },
      },
    });

    const fromSession = await handleWebhook(session, 'sig');
    expect(fromSession.applied).toBe(false);
    expect(await getLedger().balance('u1')).toBe(0);

    // ...and the invoice for that same first month grants exactly once.
    await handleWebhook(invoicePaid('in_1', 'sub_1'), 'sig');
    expect(await getLedger().balance('u1')).toBe(9500);
  });

  it('ignores an unpaid invoice', async () => {
    sub('sub_1');

    const result = await handleWebhook(invoicePaid('in_1', 'sub_1', 'open'), 'sig');

    expect(result.applied).toBe(false);
    expect(await getLedger().balance('u1')).toBe(0);
  });

  it('ignores a one-off invoice with no subscription', async () => {
    const result = await handleWebhook(invoicePaid('in_1', undefined), 'sig');

    expect(result.applied).toBe(false);
    expect(await getLedger().balance('u1')).toBe(0);
  });

  /*
   * A paid invoice we cannot attribute is money taken with nothing given. It must not 500 (Stripe would
   * retry forever and a retry cannot invent metadata) — but it must never credit a guess either.
   */
  it('refuses to guess when the subscription has no user metadata', async () => {
    subscriptions.set('sub_1', { id: 'sub_1', metadata: {} });

    const result = await handleWebhook(invoicePaid('in_1', 'sub_1'), 'sig');

    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/missing a user/i);
  });

  it('credits the user the SUBSCRIPTION names, never one from the event body', async () => {
    sub('sub_1', { userId: 'victim' });
    await handleWebhook(invoicePaid('in_1', 'sub_1'), 'sig');

    expect(await getLedger().balance('victim')).toBe(9500);
    expect(await getLedger().balance('u1')).toBe(0);
  });
});

describe('subscription plan pricing', () => {
  const config = { creditUnitCostUsd: 0.01, margin: 3.34 };

  it.each(SUBSCRIPTION_PLANS.filter((p) => p.isActive).map((p) => [p.id, p] as const))(
    '%s clears the margin floor',
    (_id, plan) => {
      expect(packMargin(planAsPack(plan), config)).toBeGreaterThanOrEqual(MIN_PACK_MARGIN);
    },
  );
});
