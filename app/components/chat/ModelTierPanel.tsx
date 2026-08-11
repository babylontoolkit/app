/**
 * The MODEL TIER picker (SPEC §4.6.1a) — choose which class of model this project's builds run on.
 *
 * Cloned from the `/effort` panel (`EffortPanel.tsx`), which is this codebase's existing precedent for
 * "a user picks a setting that costs money": the same anchor/popup shape, the same Escape handling, the
 * same one-source-for-labels rule. It differs in one way that matters — this panel is opened by
 * CLICKING the model pill rather than by a typed command, because unlike effort the current rung is
 * already the most visible thing in the toolbar and users will reach for it directly.
 *
 * ## A locked row EXPLAINS; it is never HTML-`disabled`
 *
 * §4.1a's dead-end rule. A greyed-out row that does nothing when clicked tells a user they cannot have
 * something and nothing about why or what would change it — and the two reasons a rung is locked here
 * need completely different actions from them (add credits, or simply wait until the first build is
 * done). So every row is a real button, and a locked one answers.
 *
 * ## The three lock reasons, and why they are told apart
 *
 * - **First build** — every paid rung is locked on the creation turn (§4.4a). Nothing the user can do;
 *   it clears by itself. Telling them "add credits" here would be a lie that costs them money.
 * - **Below the threshold** — they need more credits, and the row names the number.
 * - **Unserveable** — the OPERATOR's selector for that rung cannot be priced. No amount of credits
 *   helps, so the row must not quote a threshold; it says the rung is unavailable right now.
 */
import { useEffect } from 'react';
import { useStore } from '@nanostores/react';
import { classNames } from '~/utils/classNames';
import { IconButton } from '~/components/ui/IconButton';
import { canUseTier, sessionStore, type ModelTierState } from '~/lib/stores/session';
import { MODEL_TIER_IDS, modelTierStore, updateModelTier, type ModelTierId } from '~/lib/stores/settings';
import { MODEL_TIER_DESCRIPTIONS, hasModelChoice, modelTierPanelOpen, parseModel } from '~/lib/stores/model-tier';

/**
 * Why a row cannot be chosen right now — `null` means it can.
 *
 * 🔴 `creation_turn` is GONE (owner, 2026-08-03): a rung you can afford is a rung you get, including on
 * the first build. The server's `firstBuildLocked` flag survives for a future per-rung re-lock, but it
 * is `false` for every rung and is NOT on the wire — so if one is ever re-locked, this mirror needs the
 * field sent to it rather than a re-hardcoded turn rule. A hardcoded one is what made the client claim
 * a lock the server no longer applies.
 */
type LockReason = 'unserveable' | 'below_minimum' | null;

/**
 * The client's read of the server's `decideModelTier`, in the same order and for the same reasons.
 *
 * Exported and pure so the rows and the pill cannot disagree about whether a rung is pickable. It is a
 * MIRROR, never an authority: the server re-derives on every generation, so being wrong here can only
 * ever offer a rung the server then declines to Standard — the safe direction.
 */
export function lockReasonFor(tier: ModelTierState, session: ReturnType<typeof sessionStore.get>): LockReason {
  if (tier.id === 'standard') {
    return null;
  }

  if (!tier.serveable) {
    return 'unserveable';
  }

  return canUseTier(session, tier.id) ? null : 'below_minimum';
}

/** The sentence a locked row shows. Never quotes a threshold for a lock credits cannot open. */
function lockCopy(reason: Exclude<LockReason, null>, tier: ModelTierState): string {
  switch (reason) {
    case 'unserveable':
      return 'Unavailable right now — this platform has no price configured for it.';
    default:
      return `Unlocks at ${tier.minimumCredits.toLocaleString()} credits.`;
  }
}

export function ModelTierPanel() {
  const open = useStore(modelTierPanelOpen);
  const session = useStore(sessionStore);
  const selected = useStore(modelTierStore);

  /*
   * Escape closes it — the same reasoning as the effort panel: a popup with only an X reads as stuck.
   * Bound while open only, so it never competes with anything else for the key.
   */
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        modelTierPanelOpen.set(false);
      }
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  /*
   * `standardModel` is no longer read here: the only copy that named it was the retired first-build
   * lock ("your first build always runs <model>"). The pill is where the running model is named.
   */
  const { tiers } = session.credits.modelTiers;

  /*
   * Belt to the pill's braces: with one serveable rung there is nothing to choose, so the popup never
   * shows even if the atom is somehow true — a stale `true` surviving a session change (a deploy that
   * turns `ENABLE_EXTENDED_MODELS` off while a tab is open, a future keyboard shortcut) would otherwise
   * render a one-row picker whose only row is the model already running.
   *
   * The ANCHOR is still rendered unconditionally — see below; that is a layout rule, not a state one.
   */
  const choosable = hasModelChoice(tiers);

  /*
   * 🔴 THE ANCHOR IS ALWAYS RENDERED; only the POPUP is conditional (§4.1a — "a right-aligned toolbar
   * must not RESIZE"). Returning `null` when closed removes a flex child, so opening the picker inserts
   * one `gap-1` and shifts every control to its right by exactly 4px — measured live in Chrome on the
   * effort panel, and the same defect class as the preview-gated buttons that render disabled rather
   * than absent. Holding the space from first paint costs nothing (the anchor is zero-width).
   */
  return (
    <div className="relative">
      {open && choosable && (
        <div className="absolute bottom-full right-0 mb-2 w-80 z-50 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 shadow-lg p-4 text-sm text-bolt-elements-textPrimary">
          <div className="flex items-center justify-between mb-3">
            <span className="font-medium">Model</span>
            <IconButton title="Close" className="transition-all" onClick={() => modelTierPanelOpen.set(false)}>
              <div className="i-ph:x text-base" />
            </IconButton>
          </div>
          <div className="space-y-2">
            {tiers.map((tier) => {
              const active = tier.id === selected;
              const reason = lockReasonFor(tier, session);
              const model = parseModel(tier.model);

              return (
                <button
                  key={tier.id}
                  type="button"
                  aria-pressed={active}
                  className={classNames(
                    'w-full text-left rounded-md border px-3 py-2 transition-all',
                    active
                      ? 'border-bolt-elements-item-contentAccent bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent'
                      : 'border-bolt-elements-borderColor hover:bg-bolt-elements-background-depth-3',
                    reason ? 'opacity-60' : '',
                  )}
                  onClick={() => {
                    /*
                     * A locked row EXPLAINS rather than selecting — and it does NOT close the panel,
                     * because the explanation it just revealed is the whole point of the click.
                     */
                    if (reason) {
                      return;
                    }

                    /*
                     * `tier.id` is a SERVER-supplied string, so it is narrowed here rather than cast.
                     * T10's rule ("a stored value must not select a rung this build does not know")
                     * with the source swapped: a rung id from a newer server would otherwise be
                     * persisted, render a blank description, and silently reset to Standard on the
                     * next reload — a selection that appears to take and then quietly does not.
                     */
                    if (!(MODEL_TIER_IDS as readonly string[]).includes(tier.id)) {
                      return;
                    }

                    updateModelTier(tier.id as ModelTierId);
                    modelTierPanelOpen.set(false);
                  }}
                >
                  <div className="flex items-center gap-2">
                    <div className={active ? 'i-ph:check-circle-fill text-base' : 'i-ph:circle text-base opacity-50'} />
                    <span className="text-xs font-medium">{tier.label}</span>
                    <span className="ml-auto text-[11px] text-bolt-elements-textSecondary">{model.full}</span>
                    {reason ? <div className="i-ph:lock-simple text-sm" /> : null}
                  </div>
                  <div className="mt-1 text-[11px] leading-snug text-bolt-elements-textSecondary">
                    {reason ? lockCopy(reason, tier) : (MODEL_TIER_DESCRIPTIONS[tier.id as ModelTierId] ?? '')}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="mt-3 pt-2 border-t border-bolt-elements-borderColor text-[11px] leading-snug text-bolt-elements-textSecondary">
            Your choice is remembered for this browser. Credits are charged for what a build actually costs, so a
            stronger model spends your balance faster rather than changing what you pay per token.
          </div>
        </div>
      )}
    </div>
  );
}
