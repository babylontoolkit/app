/**
 * How a ledger row reads on screen (SPEC §4.6; `spec/fail-loud.md` rule 5).
 *
 * The credits panel renders the user's ledger history — the payoff of an append-only ledger is that
 * "where did my credits go?" always has an answer, and until 2026-07-25 the client fetched that
 * answer and rendered none of it. Refunds especially must be VISIBLE: a refund the user cannot see
 * is half of fail-loud's rule 5 ("a settled charge the UI cannot see is a defect"), because the loud
 * failure story is "you were not charged — try again", and that sentence is only believable if the
 * refund row is where the user can find it.
 *
 * Pure and client-safe (no I/O, no server imports), like `describeSaveStatus`: every user-facing
 * string comes from here so it is tested, and the component only lays it out.
 *
 * ⚠️ `reason` is typed as `string`, not the server's `LedgerReason` union, ON PURPOSE: this module
 * must not import from `~/lib/.server/**`, and a NEW reason added server-side must render as itself
 * rather than crash or blank a row (the same open-set posture as `capabilities.ts` — unknown means
 * future, not invalid).
 */

export type LedgerTone = 'credit' | 'debit' | 'refund' | 'neutral';

export interface LedgerRowView {
  /** Short human label — the TURN KIND where we know it, else the reason ("Refund", "Purchase", …). */
  label: string;

  /** Signed, localized amount — "+800" / "−316". The sign is always explicit. */
  amount: string;

  /** Drives the row's color: refunds stand out, debits are quiet, credits are positive. */
  tone: LedgerTone;
}

/**
 * WHAT THE TURN ACTUALLY WAS — `generations.status_kind` (migration 0019), which nothing read until now.
 *
 * Every LLM turn debits under the single ledger reason `'generation'`, because that vocabulary is
 * owned by a SQL `CHECK` constraint and is about the KIND OF MONEY MOVEMENT, not the kind of work.
 * That is right for the ledger and useless on screen: a five-minute creation build, a one-line edit,
 * an auto-repair the user never asked for, and a read-only plan all rendered as four identical rows
 * reading "Generation", so the panel that exists to answer "where did my credits go?" answered
 * "generations" — which the user already knew.
 *
 * The kind is decorated on at READ time from the generation row, never stored on the ledger: the
 * ledger is append-only and its writer is a locked SQL function, so widening it to carry a display
 * label would put a cosmetic concern on the one path in this codebase that must never grow a reason
 * to fail.
 *
 * ⚠️ Absent is EXPECTED, not exceptional — migration 0019 is nullable with no backfill on purpose, so
 * every row written before it genuinely does not know its kind, and an unrecognised future kind must
 * render rather than blank. Both fall back to "Generation", which is exactly as specific as what we
 * actually know.
 *
 * ⚠️ **ONE WORD EACH, and that is what makes the width guard able to fail** (owner, 2026-08-11 —
 * "Creation build" → "Creation", "Auto-repair" → "Repair", "Enhance prompt" → "Prompt"). The column is
 * ~11px in a 288px dropdown, so a label that wraps is a layout defect wearing a copy defect's clothes.
 * While the table held two-word entries the obvious guard was VACUOUS: the offending "Enhance prompt"
 * was character-for-character the same shape as the legitimate "Creation build", so a width check
 * passed for the exact regression it was named for (drafted, mutation-run and deleted the same day).
 * Collapsing the set is what gave the property teeth. Keep new kinds to one word, or delete the guard
 * in `ledger-display.spec.ts` knowingly rather than widening it until it stops biting.
 */
const KIND_LABELS: Record<string, string> = {
  creation: 'Creation',
  edit: 'Edit',
  repair: 'Repair',
  plan: 'Plan',

  /*
   * "Prompt", not "Enhance prompt" (owner, 2026-08-11). The tie to the ✨ button it names is carried by
   * the NOUN, not the whole button title: nothing else in this panel is about a prompt, so the verb
   * added width and no information.
   */
  enhance: 'Prompt',
};

const LABELS: Record<string, string> = {
  grant: 'Free credits',
  purchase: 'Purchase',
  generation: 'Generation',
  media: 'Media render',
  search: 'Web search',
  project_create: 'New project',
  refund: 'Refund',
  promo: 'Promo',
  adjustment: 'Adjustment',
};

export function describeLedgerEntry(entry: { delta: number; reason: string; kind?: string }): LedgerRowView {
  /*
   * The kind wins ONLY for a `generation` row. A refund of a creation build is a REFUND — labelling it
   * "Creation" because it names the same generation would put two rows reading the same thing
   * next to each other, one of which gave money back, which is the one distinction this panel most
   * has to make (`spec/fail-loud.md` rule 5).
   */
  const kindLabel = entry.reason === 'generation' && entry.kind ? KIND_LABELS[entry.kind] : undefined;

  // An unknown reason renders as itself — a future server reason must never blank or crash a row.
  const label = kindLabel ?? LABELS[entry.reason] ?? entry.reason.charAt(0).toUpperCase() + entry.reason.slice(1);

  /*
   * U+2212 (minus sign), not the ASCII hyphen: at the panel's 11px a hyphen reads as a dash of
   * punctuation, and the whole point of the column is that debits and credits are unmistakable.
   */
  const amount = `${entry.delta < 0 ? '−' : '+'}${Math.abs(entry.delta).toLocaleString()}`;

  const tone: LedgerTone =
    entry.reason === 'refund' ? 'refund' : entry.delta > 0 ? 'credit' : entry.delta < 0 ? 'debit' : 'neutral';

  return { label, amount, tone };
}

/**
 * How a savings figure READS — a PERCENTAGE, e.g. "38%" (owner, 2026-08-11; `billing/savings.ts`).
 *
 * ## Why a percentage and not the credits
 *
 * It printed "214 credits (38%)", and the owner asked what a row saying `saved 7` next to `-8` meant.
 * That question is the finding: the two numbers sit on DIFFERENT AXES — one is what you paid, the
 * other is what you did not — and side by side they read as two charges. A percentage cannot be
 * mistaken for an amount, so it needs no mental subtraction and no second glance to interpret.
 *
 * It also travels better. The credits figure is only meaningful against a reference the panel does not
 * show, so "saved 7" is uninterpretable without "of 15"; a percentage carries its own denominator.
 *
 * ## The one edge case, which now matters MORE
 *
 * **`<1%` instead of `0%`.** `percent` is rounded, so a genuine saving under half a percent prints
 * "0%". That was already wrong beside a credits figure; with the percentage as the ONLY signal it is
 * worse — the panel would render a savings badge whose text says there were no savings. This is the
 * whole reason the formatter is shared rather than inlined at the three call sites.
 *
 * ⚠️ Pluralisation logic was removed with the credits figure. If a caller ever prints credits again it
 * needs to come back: "saved 1 credits" on a money panel reads as a bug in the number, not the grammar.
 */
export function formatSavings(savings: { percent: number }): string {
  return savings.percent < 1 ? '<1%' : `${savings.percent}%`;
}

/**
 * Compact time-ago for the history rows ("2m", "3h", "5d"; older → a locale date).
 *
 * Pure over an injected `now` so it is testable — a Date.now() inside would make every assertion a
 * race. The strings are deliberately terse: the column is 11px wide in a 288px dropdown.
 */
export function compactAge(createdAt: string, now: Date): string {
  const then = new Date(createdAt).getTime();

  if (!Number.isFinite(then)) {
    return '';
  }

  const seconds = Math.max(0, Math.floor((now.getTime() - then) / 1000));

  if (seconds < 60) {
    return 'now';
  }

  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  }

  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h`;
  }

  if (seconds < 7 * 86400) {
    return `${Math.floor(seconds / 86400)}d`;
  }

  return new Date(then).toLocaleDateString();
}
