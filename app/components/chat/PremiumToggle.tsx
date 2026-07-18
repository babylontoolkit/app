import { useStore } from '@nanostores/react';
import { toast } from 'react-toastify';
import { IconButton } from '~/components/ui/IconButton';
import { classNames } from '~/utils/classNames';
import { canUsePremium, sessionStore } from '~/lib/stores/session';
import { premiumModelStore, updatePremiumModel } from '~/lib/stores/settings';
import { useByokUnlocked } from '~/lib/hooks/useSession';

/**
 * `claude-fable-5` → `{ short: 'Fable', full: 'Fable 5' }`. The pill shows `short` (the family), the
 * tooltip shows `full` (family + version). Parsed, not a lookup table, so a new model id names itself.
 */
function parseModel(model: string): { short: string; full: string } {
  const match = model.match(/^claude-([a-z]+)-(.+)$/i);

  if (!match) {
    return { short: model, full: model };
  }

  const short = match[1].charAt(0).toUpperCase() + match[1].slice(1);
  const version = match[2].replace(/-/g, '.'); // 4-8 → 4.8, 5 → 5

  return { short, full: `${short} ${version}` };
}

/**
 * The PREMIUM model toggle (SPEC §4.6.1) — the one user-facing model choice in credits mode.
 *
 * Unlike the Pro `ModelSelector` (BYOK, a free-form model list), this is a single boolean: standard
 * (the operator default) vs the one configured premium model. It renders ONLY for credits users — BYOK
 * users pick a model directly, so it would be redundant for them.
 *
 * The pill ALWAYS names the model actually in use, with its version (`Opus 4.8`, `Fable 5`); the
 * burn-rate note and the switch hint live in the tooltip. Three states:
 *  - **Eligible + off** — shows the standard model's name; click to switch to premium (warning toast).
 *  - **Eligible + on** — accented, shows the premium model's name. Click to switch back to standard.
 *  - **Locked** — the user holds fewer than `PREMIUM_MINIMUM_CREDITS`. Shows the standard model dimmed
 *    with a lock; a click explains the threshold rather than toggling. This is what protects a fresh
 *    500-credit grant from a 2× model out the gate.
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

  const { minimumCredits, model, standardModel } = session.credits.premium;
  const premium = parseModel(model);
  const standard = parseModel(standardModel);
  const eligible = canUsePremium(session);
  const active = enabled && eligible;

  // The pill always names the model actually in use: premium when on, the standard model otherwise.
  const current = active ? premium : standard;

  const onClick = () => {
    if (!eligible) {
      toast.info(
        `The premium model (${premium.full}) unlocks at ${minimumCredits.toLocaleString()} credits. Add credits to enable it.`,
      );
      return;
    }

    const next = !enabled;
    updatePremiumModel(next);

    if (next) {
      toast.warning(`Premium model (${premium.full}) on — builds now burn credits about 2× faster.`);
    } else {
      toast.info(`Switched to the standard model (${standard.full}).`);
    }
  };

  // Version detail lives here (the pill shows only the family): "Fable 5", "Opus 4.8".
  const title = !eligible
    ? `${standard.full} (standard). Premium (${premium.full}) unlocks at ${minimumCredits.toLocaleString()} credits.`
    : active
      ? `Premium model: ${premium.full} — burns credits ~2× faster. Click to switch to ${standard.full}.`
      : `Standard model: ${standard.full}. Click to switch to the premium model (${premium.full}) — burns credits ~2× faster.`;

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
        <span className="text-xs whitespace-nowrap">{current.full}</span>
        {!eligible ? <div className="i-ph:lock-simple text-sm" /> : null}
      </>
    </IconButton>
  );
}
