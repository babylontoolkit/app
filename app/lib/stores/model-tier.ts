/**
 * The MODEL TIER PICKER's presentation state (SPEC §4.6.1a) — the client half of the ladder.
 *
 * The SELECTION lives in `settings.ts` (`modelTierStore`, persisted) and the LADDER ITSELF comes from
 * the server on `/api/me` (`session.ts`). What lives here is the third thing: what the picker is
 * currently doing, and the words it says about each rung.
 *
 * ## Labels come from the SERVER; descriptions are ours
 *
 * A rung's `label` and `model` are facts about the operator's configuration, so they ride the wire and
 * are never re-typed here — that is what stops the picker naming "Fable 5" on a deploy whose SuperMax
 * rung was moved to something else. What the wire cannot carry is the CONSEQUENCE of choosing a rung in
 * the terms a user actually cares about, which is credits per turn. That copy is here, in one place, so
 * the pill's tooltip and the picker rows cannot say different things about the same choice — the
 * `EFFORT_LABELS`/`EFFORT_DESCRIPTIONS` precedent (`effort.ts`), for the same reason.
 */
import { atom } from 'nanostores';
import type { ModelTierId } from './settings';

/** The picker is opened by clicking the model pill. Closed by Escape, by a choice, or by the X. */
export const modelTierPanelOpen = atom<boolean>(false);

/**
 * What choosing each rung actually buys, stated in credits rather than in model marketing.
 *
 * Honest about the expensive rungs: they are the same product at a higher burn rate, not a different
 * one. §4.6 makes credits cost-proportional, so a more expensive model does not change the margin — it
 * changes how fast the user's balance moves, and that is the only thing worth saying to them.
 */
export const MODEL_TIER_DESCRIPTIONS: Record<ModelTierId, string> = {
  standard: 'Default. Best value — full-quality builds and edits at the lowest credit burn.',
  premium: 'A stronger model for harder problems. Burns credits several times faster per turn.',
  supermax: 'The most capable model available. The highest credit burn — reach for it deliberately.',
};

/**
 * Is there a CHOICE to present at all?
 *
 * On a deploy running `ENABLE_EXTENDED_MODELS=false` the server sends one rung, and a picker offering a
 * single option is a control that cannot do anything — it opens a panel whose only row is the one
 * already in use. Worse, the pill's tooltip would go on saying "Click to choose a different model",
 * which is a promise the deploy has deliberately withdrawn.
 *
 * The pill itself stays: naming the model actually in use is its whole job (§4.6.1a), and that matters
 * MORE when there is no choice, not less — the user still needs to know what they are spending on.
 *
 * Counts `serveable`, not rows: a rung the platform will refuse is not an option, so a ladder of three
 * with two unpriceable selectors is correctly "no choice" — the same fact the picker would otherwise
 * render as two rows nobody can pick.
 */
export function hasModelChoice(tiers: readonly { serveable: boolean }[]): boolean {
  return tiers.filter((tier) => tier.serveable).length > 1;
}

/**
 * `claude-fable-5` → `{ short: 'Fable', full: 'Fable 5' }`.
 *
 * PARSED, never a lookup table: `LLM_MODEL` and the rung selectors are operator config that can name a
 * model this build has never heard of (§4.2a — swapping the platform model is a config operation, no
 * redeploy), and a table would render that as a raw id or, worse, as the wrong name. A model id names
 * itself.
 */
export function parseModel(model: string): { short: string; full: string } {
  const match = model.match(/^claude-([a-z]+)-(.+)$/i);

  if (!match) {
    return { short: model, full: model };
  }

  const short = match[1].charAt(0).toUpperCase() + match[1].slice(1);
  const version = match[2].replace(/-/g, '.'); // 4-8 → 4.8, 5 → 5

  return { short, full: `${short} ${version}` };
}
