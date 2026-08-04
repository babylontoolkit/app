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
 * `claude-fable-5` → `{ short: 'Fable', full: 'Fable 5' }`, `gpt-5-6-sol` → `'GPT 5.6 Sol'`,
 * `gemini-3-5-flash` → `'Gemini 3.5 Flash'`.
 *
 * PARSED, never a lookup table: `LLM_MODEL` and the rung selectors are operator config that can name a
 * model this build has never heard of (§4.2a — swapping the platform model is a config operation, no
 * redeploy), and a table would render that as a raw id or, worse, as the wrong name. A model id names
 * itself. That rule got MORE load-bearing with the tri-family ladder (§4.6.1a T11): a rung's `model`
 * now arrives from `modelTiersSessionHint` and may belong to any of three families, so a client-side
 * id table would have to be edited every time KIE ships a model and would silently mis-render — or
 * blank — every id it had not been taught yet.
 *
 * The whole derivation is two structural conventions that every one of these vendors already follows:
 *
 * 1. **Dashes stand in for dots in a version.** `gpt-5-6-sol` is marketed "GPT 5.6 Sol" and
 *    `claude-opus-4-8` is "Opus 4.8" — an API id cannot carry a `.`, so a RUN of numeric segments is
 *    one version number and is rejoined with dots.
 * 2. **A word segment is a word.** Capitalised normally (`sol` → `Sol`, `flash` → `Flash`), UPPERCASED
 *    when it has no vowel and is therefore an initialism (`gpt` → `GPT`). Deriving that from the
 *    letters rather than from a list of known acronyms is what keeps the next `gpt`-shaped family from
 *    needing a code change.
 *
 * Claude keeps its own branch, unchanged and pinned: its ids lead with a vendor word the ladder never
 * varies (`claude-`), and dropping it is the difference between "Opus 5" and "Claude Opus 5" on a pill
 * whose width is the toolbar's scarcest resource. The other families put the family word IN the
 * marketing name, so theirs is kept.
 *
 * 🔴 An id this shape-parser cannot read is returned VERBATIM — never blanked, never guessed at. The
 * pill's entire job is naming the model in use; showing a raw id is honest, showing nothing is not.
 */
export function parseModel(model: string): { short: string; full: string } {
  const claude = model.match(/^claude-([a-z]+)-(.+)$/i);

  if (claude) {
    const short = claude[1].charAt(0).toUpperCase() + claude[1].slice(1);
    const version = claude[2].replace(/-/g, '.'); // 4-8 → 4.8, 5 → 5

    return { short, full: `${short} ${version}` };
  }

  const words = parseDashedId(model);

  return words ? { short: words[0], full: words.join(' ') } : { short: model, full: model };
}

/**
 * `gpt-5-6-sol` → `['GPT', '5.6', 'Sol']`, or `null` when the id is not this shape at all.
 *
 * The `null` cases are the guard that keeps rule 1 above from inventing a version out of something
 * that is not one: an id must be at least two dash-separated segments, every segment alphanumeric, the
 * first a word, and at least one segment purely numeric. A provider-qualified id (`some-vendor/model:1`),
 * a bare family word (`claude`), or an empty string therefore falls straight through to itself.
 */
function parseDashedId(model: string): string[] | null {
  const segments = model.split('-');

  if (segments.length < 2 || !/^[a-z]+$/i.test(segments[0]) || !segments.every((s) => /^[a-z0-9]+$/i.test(s))) {
    return null;
  }

  if (!segments.some((s) => /^[0-9]+$/.test(s))) {
    return null;
  }

  const words: string[] = [];

  for (const segment of segments) {
    // A RUN of numeric segments is one version number: `5`,`6` → `5.6`. This is the dash-to-dot rule.
    if (/^[0-9]+$/.test(segment)) {
      const last = words.length - 1;

      if (last >= 0 && /^[0-9]+(\.[0-9]+)*$/.test(words[last])) {
        words[last] = `${words[last]}.${segment}`;
        continue;
      }

      words.push(segment);
      continue;
    }

    words.push(displayWord(segment));
  }

  return words;
}

/** `gpt` → `GPT` (no vowel, so an initialism), `sol` → `Sol`. Mixed segments (`4o`) are left alone. */
function displayWord(segment: string): string {
  if (!/^[a-z]+$/i.test(segment)) {
    return segment;
  }

  if (!/[aeiou]/i.test(segment)) {
    return segment.toUpperCase();
  }

  return segment.charAt(0).toUpperCase() + segment.slice(1);
}
