/**
 * The MODEL PILL (SPEC §4.6.1a) — the always-visible readout of which model this build will actually run.
 *
 * Replaces `PremiumToggle`. Its job is unchanged and is the reason it exists at all: **name the model
 * actually in use**, at all times, so a user is never guessing what they are spending on. What changed
 * is that there are now three rungs rather than two, so clicking it OPENS THE PICKER instead of
 * toggling — a two-state control cannot express a three-state choice, and the alternative (cycling
 * through rungs on each click) makes the most expensive one reachable by an accidental double-click.
 *
 * It renders ONLY for credits users — BYOK users pick a model directly (§4.6.1), so it would be
 * redundant for them.
 *
 * The pill shows the EFFECTIVE rung, never the stored preference. A user who selected SuperMax and then
 * spent down below its threshold sees Standard, because Standard is what their next build will run.
 * Showing the preference instead would be the one thing this control must never do: report a model that
 * is not going to be used.
 *
 * Authority still lives on the server: `decideModelTier` re-derives on every generation, so a tampered
 * store only ever reveals a rung the server will decline.
 */
import { useStore } from '@nanostores/react';
import { IconButton } from '~/components/ui/IconButton';
import { classNames } from '~/utils/classNames';
import { canUseTier, sessionStore } from '~/lib/stores/session';
import { modelTierStore } from '~/lib/stores/settings';
import { creationTurnStore } from '~/lib/stores/chat';
import { useByokUnlocked } from '~/lib/hooks/useSession';
import { EFFORT_LABELS, baseEffortStore } from '~/lib/stores/effort';
import { hasModelChoice, modelTierPanelOpen, parseModel } from '~/lib/stores/model-tier';

export function ModelTierPill() {
  /*
   * ⚠️ EVERY hook runs before the early returns below — a hook after a conditional return crashed the
   * whole chat ("Rendered more hooks than during the previous render") when `creationTurn` was first
   * added mid-component. Rules of Hooks: unconditional, top of the component, always.
   */
  const session = useStore(sessionStore);
  const selected = useStore(modelTierStore);
  const creationTurn = useStore(creationTurnStore);
  const effort = useStore(baseEffortStore);
  const byokUnlocked = useByokUnlocked();

  // BYOK users choose a model directly; nothing to show until we know who the user is.
  if (byokUnlocked || session.loading) {
    return null;
  }

  // A signed-out visitor on an accounts-enabled deploy cannot generate anyway.
  if (session.accountsEnabled && !session.authenticated) {
    return null;
  }

  const { standardModel, tiers } = session.credits.modelTiers;
  const standard = parseModel(standardModel);

  /*
   * The EFFECTIVE rung: what the server would actually run for this turn, mirroring `decideModelTier`.
   * A paid rung is dropped on the first build turn (§4.4a) and whenever the live balance no longer
   * clears its threshold — the same two rules, in the same order, as the server's decision.
   */
  const selectedRow = tiers.find((tier) => tier.id === selected);
  const eligible = selected !== 'standard' && !creationTurn && canUseTier(session, selected);
  const effective = eligible && selectedRow ? parseModel(selectedRow.model) : standard;
  const active = eligible;

  /*
   * The lock glyph means "the rung you SELECTED is not what will run" — it is about a mismatch, not
   * about the pill's own state. A user on Standard by choice has nothing locked; a user who picked
   * SuperMax and cannot currently have it does, and the pill is where they find that out.
   */
  const locked = selected !== 'standard' && !eligible;

  /*
   * The session's thinking effort rides in this tooltip (§4.2.9). It has no pill of its own — the row is
   * crowded and effort is a rarely-changed setting — but a raised floor costs credits on every turn, so
   * it must be READABLE somewhere the user already looks. This pill and the `/context` report are that
   * somewhere; the control itself is `/effort`.
   */
  const effortLine = ` Thinking effort: ${EFFORT_LABELS[effort]} — type /effort to change.`;

  const selectedLabel = selectedRow?.label ?? 'Standard';

  /*
   * A deploy with `ENABLE_EXTENDED_MODELS=false` sends ONE rung, so there is nothing to pick. The pill
   * still renders — naming the model in use is its job, and that is if anything more useful when the
   * user has no say in it — but it stops behaving like a control: no picker, and a tooltip that does
   * not invite a click it will not honour.
   */
  const choosable = hasModelChoice(tiers);

  // Version detail lives here (the pill shows only the family): "Fable 5", "Opus 4.8".
  const title = !choosable
    ? `Running ${effective.full} — the model this platform serves.`
    : locked
      ? creationTurn
        ? `Running ${effective.full}. Your first build always runs the standard model; ${selectedLabel} unlocks once your project exists. Click to change.`
        : `Running ${effective.full}. ${selectedLabel} is not available right now. Click to change.`
      : `Running ${effective.full} (${selectedLabel}). Click to choose a different model.`;

  return (
    <IconButton
      title={title + effortLine}
      className={classNames('transition-all flex items-center gap-1 px-1.5', {
        '!bg-bolt-elements-item-backgroundAccent !text-bolt-elements-item-contentAccent': active,
        'opacity-50': locked,

        // No choice → a readout, not a button. The cursor must not promise otherwise.
        'cursor-default': !choosable,
      })}
      onClick={choosable ? () => modelTierPanelOpen.set(!modelTierPanelOpen.get()) : undefined}
    >
      <>
        <div className="i-ph:lightning-fill text-lg" />
        <span className="text-xs whitespace-nowrap">{effective.full}</span>
        {locked ? <div className="i-ph:lock-simple text-sm" /> : null}
      </>
    </IconButton>
  );
}
