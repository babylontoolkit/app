/**
 * Credit balance + upsell (SPEC §4.6, §4.6.1).
 *
 * The whole surface a credits user gets for "what is this costing me" — a balance, a history, and a
 * way to buy more. Deliberately NOT a model picker, a token counter, or a provider name: the promise
 * of credits mode is that none of that is your problem (§4.1).
 *
 * Renders nothing at all when there is nothing to say (local dev with billing off), rather than
 * showing a meaningless "∞".
 */
import { useStore } from '@nanostores/react';
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { classNames } from '~/utils/classNames';
import { sessionStore } from '~/lib/stores/session';

interface MySubscription {
  planId: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  creditsPerMonth: number;
}

export function CreditsIndicator() {
  const session = useStore(sessionStore);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [subscription, setSubscription] = useState<MySubscription | null>(null);

  /*
   * Resolved only when the panel is actually opened. "Am I subscribed?" costs a Stripe API call, so it
   * is not in the session — paying for it on every page load, for every user, to answer a question
   * nobody asked, is exactly the kind of tax that never shows up in a profiler as one big number.
   */
  useEffect(() => {
    if (!open) {
      return;
    }

    fetch('/api/credits')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => data && setSubscription((data as { subscription: MySubscription | null }).subscription))
      .catch(() => undefined);
  }, [open]);

  if (session.loading || !session.authenticated) {
    return null;
  }

  /*
   * BYOK users pay with their own key — a credit balance is meaningless to them, and showing one
   * would imply we are metering something we are not (§4.6.1).
   */
  if (session.pro.byokUnlocked) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-bolt-elements-textSecondary">
        <div className="i-ph:key-duotone text-sm" />
        <span>Pro — your key</span>
      </div>
    );
  }

  const { balance, enforced, purchasable, packs, plans } = session.credits;
  const empty = balance <= 0;

  /** Every payment path is the same shape: ask the server for a Stripe URL, then hand over the browser. */
  const redirectToStripe = async (endpoint: string, body?: Record<string, string>) => {
    setBusy(true);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });

      const data = (await response.json()) as { url?: string; message?: string };

      if (!response.ok || !data.url) {
        throw new Error(data.message || 'Could not reach Stripe.');
      }

      // Stripe Checkout/Portal is a full redirect — cards, Apple/Google Pay and Link come with it.
      window.location.href = data.url;
    } catch (error) {
      toast.error((error as Error).message);
      setBusy(false);
    }
  };

  const buy = (packId: string) => redirectToStripe('/api/checkout', { packId });
  const subscribe = (planId: string) => redirectToStripe('/api/subscribe', { planId });
  const manage = () => redirectToStripe('/api/billing-portal');

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={classNames(
          'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors',
          'hover:bg-bolt-elements-item-backgroundActive',
          empty && enforced
            ? 'text-bolt-elements-icon-error bg-bolt-elements-item-backgroundDanger'
            : 'text-bolt-elements-textSecondary',
        )}
        title={enforced ? 'Credits remaining' : 'Usage (credits are not enforced on this server)'}
      >
        <div className="i-ph:lightning-duotone text-sm" />
        <span className="font-medium">{balance.toLocaleString()}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-64 z-50 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 shadow-lg p-3">
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-sm font-medium text-bolt-elements-textPrimary">
              {balance.toLocaleString()} credits
            </span>
            {!enforced && <span className="text-[10px] text-bolt-elements-textTertiary">not enforced</span>}
          </div>

          {empty && enforced && (
            <p className="text-xs text-bolt-elements-icon-error mb-2">
              You are out of credits. Add more to keep building.
            </p>
          )}

          {purchasable ? (
            <div className="flex flex-col gap-1">
              {/*
               * A subscriber sees their plan and a way OUT of it — never another subscribe button. Making
               * cancellation easy to find is not a concession; a plan you cannot see how to leave is the
               * kind of thing that produces chargebacks instead of churn.
               */}
              {subscription ? (
                <>
                  <div className="flex items-center justify-between px-2 py-1.5 rounded text-xs bg-bolt-elements-background-depth-3">
                    <span className="text-bolt-elements-textPrimary">
                      {subscription.creditsPerMonth.toLocaleString()}/mo
                    </span>
                    <span className="text-bolt-elements-textSecondary">
                      {subscription.cancelAtPeriodEnd ? 'ends this period' : subscription.status}
                    </span>
                  </div>
                  <button
                    disabled={busy}
                    onClick={manage}
                    className="px-2 py-1.5 rounded text-xs text-left
                      bg-bolt-elements-background-depth-3 hover:bg-bolt-elements-item-backgroundActive
                      text-bolt-elements-textSecondary disabled:opacity-50"
                  >
                    Manage subscription
                  </button>
                </>
              ) : (
                plans.length > 0 && (
                  <>
                    <p className="text-[10px] text-bolt-elements-textTertiary uppercase tracking-wide">Monthly</p>
                    {plans.map((plan) => (
                      <button
                        key={plan.id}
                        disabled={busy}
                        onClick={() => subscribe(plan.id)}
                        className="flex items-center justify-between px-2 py-1.5 rounded text-xs
                          bg-bolt-elements-background-depth-3 hover:bg-bolt-elements-item-backgroundActive
                          text-bolt-elements-textPrimary disabled:opacity-50"
                      >
                        <span>
                          {plan.name} — {plan.creditsPerMonth.toLocaleString()}/mo
                        </span>
                        <span className="text-bolt-elements-textSecondary">
                          ${(plan.priceCents / 100).toFixed(0)}/mo
                        </span>
                      </button>
                    ))}
                  </>
                )
              )}

              <p className="text-[10px] text-bolt-elements-textTertiary uppercase tracking-wide mt-1">One-time</p>
              {packs.map((pack) => (
                <button
                  key={pack.id}
                  disabled={busy}
                  onClick={() => buy(pack.id)}
                  className="flex items-center justify-between px-2 py-1.5 rounded text-xs
                    bg-bolt-elements-background-depth-3 hover:bg-bolt-elements-item-backgroundActive
                    text-bolt-elements-textPrimary disabled:opacity-50"
                >
                  <span>
                    {pack.name} — {pack.credits.toLocaleString()}
                  </span>
                  <span className="text-bolt-elements-textSecondary">${(pack.priceCents / 100).toFixed(0)}</span>
                </button>
              ))}
              <p className="text-[10px] text-bolt-elements-textTertiary mt-1">Credits never expire.</p>
            </div>
          ) : (
            <p className="text-xs text-bolt-elements-textTertiary">
              {/* Not configured is a describable state, never a crash and never a dead button (§1.3). */}
              Purchasing is not configured on this server.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
