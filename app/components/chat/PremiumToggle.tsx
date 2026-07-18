import { useStore } from '@nanostores/react';
import { toast } from 'react-toastify';
import { IconButton } from '~/components/ui/IconButton';
import { classNames } from '~/utils/classNames';
import { canUsePremium, sessionStore } from '~/lib/stores/session';
import { premiumModelStore, updatePremiumModel } from '~/lib/stores/settings';
import { useByokUnlocked } from '~/lib/hooks/useSession';

/** `claude-fable-5` → `Fable 5`. A friendly label for the toggle; falls back to the raw id. */
function premiumModelLabel(model: string): string {
  const known: Record<string, string> = {
    'claude-fable-5': 'Fable 5',
    'claude-opus-4-8': 'Opus 4.8',
    'claude-opus-4-7': 'Opus 4.7',
    'claude-sonnet-5': 'Sonnet 5',
  };

  return known[model] ?? model;
}

/**
 * The PREMIUM model toggle (SPEC §4.6.1) — the one user-facing model choice in credits mode.
 *
 * Unlike the Pro `ModelSelector` (BYOK, a free-form model list), this is a single boolean: standard
 * (the operator default) vs the one configured premium model. It renders ONLY for credits users — BYOK
 * users pick a model directly, so it would be redundant for them.
 *
 * Three states, and the locked one is the point:
 *  - **Eligible + off** — a lightning affordance; click to opt in (with a "~2× credits" warning toast).
 *  - **Eligible + on** — an accented pill reading "Premium · ~2×", the persistent burn-rate warning the
 *    owner asked for (§4.6.1). Click to drop back to the standard model.
 *  - **Locked** — the user holds fewer than `PREMIUM_MINIMUM_CREDITS`. Dimmed, with a lock, and a click
 *    explains the threshold rather than toggling. This is what protects a fresh 500-credit grant from a
 *    2× model out the gate.
 *
 * Authority still lives on the server: `decidePremium` re-checks the threshold on every generation, so
 * a tampered store only ever reveals a toggle the server will decline.
 */
export function PremiumToggle() {
  const session = useStore(sessionStore);
  const enabled = useStore(premiumModelStore);
  const byokUnlocked = useByokUnlocked();

  // BYOK users choose a model directly; nothing to show until we know who the user is.
  if (byokUnlocked || session.loading) {
    return null;
  }

  // A signed-out visitor on an accounts-enabled deploy cannot generate anyway.
  if (session.accountsEnabled && !session.authenticated) {
    return null;
  }

  const { minimumCredits, model } = session.credits.premium;
  const label = premiumModelLabel(model);
  const eligible = canUsePremium(session);
  const active = enabled && eligible;

  const onClick = () => {
    if (!eligible) {
      toast.info(
        `The premium model (${label}) unlocks at ${minimumCredits.toLocaleString()} credits. Add credits to enable it.`,
      );
      return;
    }

    const next = !enabled;
    updatePremiumModel(next);

    if (next) {
      toast.warning(`Premium model (${label}) on — builds now burn credits about 2× faster.`);
    }
  };

  const title = !eligible
    ? `Premium model (${label}) unlocks at ${minimumCredits.toLocaleString()} credits`
    : active
      ? `Premium (${label}) is ON — burns credits ~2× faster. Click to use the standard model.`
      : `Use the premium model (${label}) — burns credits ~2× faster`;

  return (
    <IconButton
      title={title}
      className={classNames('transition-all flex items-center gap-1 px-1.5', {
        '!bg-bolt-elements-item-backgroundAccent !text-bolt-elements-item-contentAccent': active,
        'opacity-50': !eligible,
      })}
      onClick={onClick}
    >
      <>
        <div className="i-ph:lightning-fill text-lg" />
        {active ? (
          <span className="text-xs whitespace-nowrap">Premium · ~2×</span>
        ) : !eligible ? (
          <div className="i-ph:lock-simple text-sm" />
        ) : null}
      </>
    </IconButton>
  );
}
