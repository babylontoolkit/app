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
 * The pill shows the EFFECTIVE rung, never the stored preference. A user who selected Premium and then
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
import { useByokUnlocked } from '~/lib/hooks/useSession';
import { EFFORT_LABELS, baseEffortStore } from '~/lib/stores/effort';
import { hasModelChoice, modelTierPanelOpen, parseModel } from '~/lib/stores/model-tier';

export function ModelTierPill() {
  /*
   * ⚠️ EVERY hook runs before the early returns below — a hook after a conditional return once crashed
   * the whole chat ("Rendered more hooks than during the previous render") when a store subscription was
   * added mid-component. Rules of Hooks: unconditional, top of the component, always.
   */
  const session = useStore(sessionStore);
  const selected = useStore(modelTierStore);
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
   * A paid rung is dropped whenever the live balance no longer clears its threshold.
   *
   * 🔴 The first-build drop is GONE (owner, 2026-08-03) — a rung you can afford runs on every turn,
   * including the largest one. Mirrored here because the pill's whole job is naming what will ACTUALLY
   * run; leaving it would have shown "Standard" on a turn the server now serves Premium.
   */
  const selectedRow = tiers.find((tier) => tier.id === selected);
  const eligible = selected !== 'standard' && canUseTier(session, selected);
  const effective = eligible && selectedRow ? parseModel(selectedRow.model) : standard;
  const active = eligible;

  /*
   * "The rung you SELECTED is not what will run" — a mismatch, not a state of the pill itself. A user
   * on Standard by choice has nothing withheld; a user who picked Premium and cannot currently have
   * it does, and the pill is where they find that out.
   *
   * 🔴 IT NO LONGER RENDERS A PADLOCK (owner, 2026-08-04). The row is crowded and the model NAME is
   * this control's entire reason to exist (§4.1a) — a glyph that is absent on the common path was
   * taking width from the one thing that is always needed. The state is still carried, by the dimming
   * and by the tooltip, which says which rung is unavailable and that a click will explain; the picker
   * itself spells out the threshold. Do NOT re-add a glyph here to "make it more visible" without
   * taking the width from somewhere else.
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
      ? `Running ${effective.full}. ${selectedLabel} is not available right now. Click to change.`
      : `Running ${effective.full} (${selectedLabel}). Click to choose a different model.`;

  /*
   * 🔴 `px-1`, NOT `px-1.5` — the pill is the LAST child of the composer row, so its own padding IS the
   * row's right-hand margin (owner, 2026-08-04).
   *
   * The row is `p-4` on both sides. On the left the first control is a stock `IconButton`, whose base
   * class is `p-1`, so its glyph sits 16 + 4 = 20px from the border. The pill was overriding to
   * `px-1.5`, putting its glyph at 16 + 6 = 22px — the row read off-centre by 2px with nothing in the
   * layout to blame it on. Anything that changes this must change `IconButton`'s base padding with it,
   * or the asymmetry comes straight back. Pinned in `ModelTierPill.spec.tsx`.
   */
  return (
    <IconButton
      title={title + effortLine}
      className={classNames('transition-all flex items-center gap-1 px-1', {
        '!bg-bolt-elements-item-backgroundAccent !text-bolt-elements-item-contentAccent': active,
        'opacity-50': locked,

        // No choice → a readout, not a button. The cursor must not promise otherwise.
        'cursor-default': !choosable,
      })}
      onClick={choosable ? () => modelTierPanelOpen.set(!modelTierPanelOpen.get()) : undefined}
    >
      {/*
       * Name first, glyph after (owner, 2026-08-04). The model NAME is what this control exists to
       * report — leading with a decorative bolt put the one piece of information behind an icon that
       * says nothing, and at the right end of the row the text now starts where the eye arrives.
       */}
      <>
        <span className="text-xs whitespace-nowrap">{effective.full}</span>
        <div className="i-ph:lightning-fill text-lg" />
      </>
    </IconButton>
  );
}
