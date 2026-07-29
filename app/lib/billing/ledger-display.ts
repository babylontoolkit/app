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
  /** Short human label for the reason ("Generation", "Refund", …). */
  label: string;

  /** Signed, localized amount — "+800" / "−316". The sign is always explicit. */
  amount: string;

  /** Drives the row's color: refunds stand out, debits are quiet, credits are positive. */
  tone: LedgerTone;
}

const LABELS: Record<string, string> = {
  grant: 'Free credits',
  purchase: 'Purchase',
  generation: 'Generation',
  media: 'Media render',
  search: 'Web search',
  license: 'Unity license',
  project_create: 'New project',
  refund: 'Refund',
  promo: 'Promo',
  adjustment: 'Adjustment',
};

export function describeLedgerEntry(entry: { delta: number; reason: string }): LedgerRowView {
  // An unknown reason renders as itself — a future server reason must never blank or crash a row.
  const label = LABELS[entry.reason] ?? entry.reason.charAt(0).toUpperCase() + entry.reason.slice(1);

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
