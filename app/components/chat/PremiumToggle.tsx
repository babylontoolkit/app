import { useStore } from '@nanostores/react';
import { toast } from 'react-toastify';
import { IconButton } from '~/components/ui/IconButton';
import { classNames } from '~/utils/classNames';
import { canUsePremium, sessionStore } from '~/lib/stores/session';
import { premiumModelStore, updatePremiumModel } from '~/lib/stores/settings';
import { creationTurnStore } from '~/lib/stores/chat';
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
  /*
   * ⚠️ EVERY hook runs before the early returns below — a hook after a conditional return crashed the
   * whole chat ("Rendered more hooks than during the previous render") when `creationTurn` was first
   * added mid-component. Rules of Hooks: unconditional, top of the component, always.
   */
  const session = useStore(sessionStore);
  const enabled = useStore(premiumModelStore);
  const creationTurn = useStore(creationTurnStore);
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

  /*
   * Premium is EDIT-ONLY: locked during creation exactly like being under the credit threshold
   * (`decidePremium` `reason: 'creation_turn'` — KIE-buffered Fable 5 cannot flush a creation-sized
   * artifact before the gateway timeout, §4.6.1). `creationTurn` covers the landing page (the next
   * send creates a project) and a freshly created project until the user's first edit message.
   */
  const eligible = canUsePremium(session) && !creationTurn;
  const active = enabled && eligible;

  // The pill always names the model actually in use: premium when on, the standard model otherwise.
  const current = active ? premium : standard;

  const onClick = () => {
    if (!eligible) {
      toast.info(
        creationTurn
          ? `Project creation always runs ${standard.full}. The premium model (${premium.full}) unlocks once your project is created.`
          : `The premium model (${premium.full}) unlocks at ${minimumCredits.toLocaleString()} credits. Add credits to enable it.`,
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
    ? creationTurn
      ? `${standard.full} (standard). Project creation always runs the standard model; premium (${premium.full}) unlocks after creation.`
      : `${standard.full} (standard). Premium (${premium.full}) unlocks at ${minimumCredits.toLocaleString()} credits.`
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
