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
import { useState } from 'react';
import { toast } from 'react-toastify';
import { classNames } from '~/utils/classNames';
import { sessionStore } from '~/lib/stores/session';

export function CreditsIndicator() {
  const session = useStore(sessionStore);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

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

  const { balance, enforced, purchasable, packs } = session.credits;
  const empty = balance <= 0;

  const buy = async (packId: string) => {
    setBusy(true);

    try {
      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packId }),
      });

      const data = (await response.json()) as { url?: string; message?: string };

      if (!response.ok || !data.url) {
        throw new Error(data.message || 'Could not start checkout.');
      }

      // Stripe Checkout is a full redirect — cards, Apple/Google Pay and Link come with it.
      window.location.href = data.url;
    } catch (error) {
      toast.error((error as Error).message);
      setBusy(false);
    }
  };

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
