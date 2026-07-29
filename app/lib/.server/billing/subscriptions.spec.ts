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

const {
  effectivePackMargin,
  packsUnderVmAdjustedFloor,
  vmOverheadUsdPerCredit,
  DEFAULT_SANDBOX_VM_USD_PER_HOUR,
  DEFAULT_SANDBOX_EST_VM_HOURS_PER_KCREDIT,
  MEASURED_VM_TIER_USD_PER_HOUR,
} = await import('./vm-cost');

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

  /*
   * 🔴 The SAME floor, after sandbox compute (T11) — because a plan is a SECOND, independently
   * editable price array, which is the entire reason this file has its own floor test at all
   * (`planAsPack`'s comment: "so one margin floor covers both revenue shapes").
   *
   * T11 added a second floor and, in its first draft, covered only the packs. Plans mirror the packs
   * exactly today, so nothing was underwater — but a promo month or a repriced plan would clear the
   * LLM floor and never meet the VM-adjusted one, silently, which is precisely the failure T11 exists
   * to end. Two price arrays, two floors, or the second floor is decorative.
   */
  it.each(SUBSCRIPTION_PLANS.filter((p) => p.isActive).map((p) => [p.id, p] as const))(
    '%s still clears the floor once sandbox compute is paid out of it',
    (_id, plan) => {
      const withVm = {
        ...config,
        vmOverheadUsdPerCredit: vmOverheadUsdPerCredit({
          usdPerHour: DEFAULT_SANDBOX_VM_USD_PER_HOUR,
          estHoursPerKCredit: DEFAULT_SANDBOX_EST_VM_HOURS_PER_KCREDIT,
        }),
      };

      expect(effectivePackMargin(planAsPack(plan), withVm)).toBeGreaterThanOrEqual(MIN_PACK_MARGIN);
    },
  );

  /*
   * The same plan floor at every MEASURED tier, not only the default one (2026-07-28).
   *
   * The hourly rate now derives from `CODESANDBOX_VM_TIER`, so an operator doubles the compute cost of
   * every plan by editing one env var — and the floor above, graded at Pico, would keep passing.
   * Two price arrays, two floors; two tiers, both graded.
   */
  it.each(Object.entries(MEASURED_VM_TIER_USD_PER_HOUR))(
    'every active plan clears the floor on the %s tier ($%s/hr)',
    (_tier, usdPerHour) => {
      const withVm = {
        ...config,
        vmOverheadUsdPerCredit: vmOverheadUsdPerCredit({
          usdPerHour,
          estHoursPerKCredit: DEFAULT_SANDBOX_EST_VM_HOURS_PER_KCREDIT,
        }),
      };

      const active = SUBSCRIPTION_PLANS.filter((plan) => plan.isActive).map(planAsPack);

      expect(active.length).toBeGreaterThan(0);
      expect(packsUnderVmAdjustedFloor(withVm, MIN_PACK_MARGIN, active)).toEqual([]);
    },
  );

  /*
   * The CEILING on plans too: Micro ($0.298/hr, derived) puts EVERY plan under the floor.
   *
   * Plans are the weaker of the two revenue shapes here (margin 3.34 against the packs' 4.0), so where
   * Micro leaves `starter` clinging on at 2.01x in `billing.spec.ts`, not one plan survives. That
   * asymmetry is the reason both files carry the test: an operator raising `CODESANDBOX_VM_TIER` breaks
   * subscriptions first, and nothing in the product refuses the env var.
   */
  it('CEILING: the next tier up (Micro) puts every plan under the floor', () => {
    const micro = {
      ...config,
      vmOverheadUsdPerCredit: vmOverheadUsdPerCredit({
        usdPerHour: 0.298,
        estHoursPerKCredit: DEFAULT_SANDBOX_EST_VM_HOURS_PER_KCREDIT,
      }),
    };

    const active = SUBSCRIPTION_PLANS.filter((plan) => plan.isActive).map(planAsPack);

    expect(packsUnderVmAdjustedFloor(micro, MIN_PACK_MARGIN, active)).toHaveLength(active.length);
  });

  /** The floor BINDS on plans too — an absurd hours estimate must put them underwater, not pass. */
  it('reports plans as underwater when the VM estimate says they are', () => {
    const absurd = {
      ...config,
      vmOverheadUsdPerCredit: vmOverheadUsdPerCredit({
        usdPerHour: DEFAULT_SANDBOX_VM_USD_PER_HOUR,
        estHoursPerKCredit: 200,
      }),
    };

    const active = SUBSCRIPTION_PLANS.filter((plan) => plan.isActive).map(planAsPack);
    const underwater = packsUnderVmAdjustedFloor(absurd, MIN_PACK_MARGIN, active);

    expect(underwater).toHaveLength(active.length);
    expect(underwater.every(({ effectiveMargin }) => effectiveMargin < 1)).toBe(true);
  });
});
