/**
 * The ledger as the CREDITS PANEL shows it (SPEC §4.6; `spec/fail-loud.md` rule 5).
 *
 * Two decorations on rows the ledger already holds, both read-time and both derived from the
 * `generations` row a debit already points at:
 *
 * 1. **What the turn WAS** — `status_kind`, so a creation build, an edit, an auto-repair and a plan
 *    stop rendering as four identical rows labelled "Generation" (see `ledger-display.ts`).
 * 2. **What the gateway SAVED** — the same comparison the `/context` panel makes per turn, summed
 *    across the page so the balance can carry a headline figure.
 *
 * ## Read-time, never stored — and that is the point
 *
 * The ledger is append-only and written by a locked SQL function under an advisory lock. Neither of
 * these is a money fact: they are ways of DESCRIBING a money fact that is already recorded and
 * immutable. Widening the ledger writer to carry a display label would put a cosmetic concern on the
 * one path in this codebase that must never grow a new way to fail, and it would leave every existing
 * row undecorated forever. Deriving instead means historical rows light up too.
 *
 * ## Everything here degrades to the plain ledger
 *
 * A missing generation row, a swept generation, an unpriceable model, an unreadable billing config —
 * every one of them yields a row with no `kind` and no `savedCredits`, which renders exactly as the
 * panel rendered before any of this existed. The balance and the history are what that panel is FOR;
 * a decoration must never be able to take them down.
 */
import { describeSavings } from './savings';
import type { LedgerEntry } from './ledger';
import type { GenerationRecord } from './generations';

/** One history row on the wire — the ledger's own fields, plus the two decorations. */
export interface LedgerHistoryRow {
  id: string;
  delta: number;
  reason: string;
  balanceAfter: number;
  note?: string;
  createdAt: string;

  /** `creation` | `edit` | `repair` | `plan`, when the generation row knows. Often absent. */
  kind?: string;

  /** Credits this row's gateway saved against Anthropic list. Absent when there is nothing to claim. */
  savedCredits?: number;
}

/**
 * The headline figure, and the scope it is honest over.
 *
 * ⚠️ `comparedRows` is not decoration. This sums the page it was handed — the last ~100 ledger
 * entries, not the account's lifetime — so a UI that prints the total without saying what it covers
 * is making a claim the data does not support. The panel renders the scope with the number.
 */
export interface LedgerSavingsSummary {
  savedCredits: number;

  /** What those same turns would have cost at Anthropic list. */
  referenceCredits: number;

  /** 0-100, rounded. Zero when nothing could be compared. */
  percent: number;

  /** How many charges the figures above actually cover. */
  comparedRows: number;
}

export interface LedgerView {
  rows: LedgerHistoryRow[];
  savings: LedgerSavingsSummary;
}

/**
 * Decorate a page of ledger entries with turn kinds and per-row savings.
 *
 * `generations` is whatever `listByIds` returned — ids it could not find are simply absent, and the
 * corresponding rows come back undecorated.
 */
export function buildLedgerView(entries: LedgerEntry[], generations: GenerationRecord[]): LedgerView {
  const byId = new Map(generations.map((g) => [g.id, g]));

  /*
   * 🔴 A REFUNDED GENERATION SAVED NOBODY ANYTHING. A failed turn is debited and then handed straight
   * back (§4.6), so its debit row is still in the history — correctly, it happened — and claiming a
   * discount on a charge the user did not ultimately pay would inflate the headline with our own
   * failures. Refunds are appended in the same `finally` as the debit, so within any page that
   * contains the debit the refund is essentially always present too; a refund that fell outside the
   * page is the one case this cannot see, and it errs toward over-reporting by at most one row.
   */
  const refunded = new Set(
    entries.filter((e) => e.reason === 'refund' && e.generationId).map((e) => e.generationId as string),
  );

  let savedCredits = 0;
  let referenceCredits = 0;
  let comparedRows = 0;

  const rows = entries.map((entry): LedgerHistoryRow => {
    const row: LedgerHistoryRow = {
      id: entry.id,
      delta: entry.delta,
      reason: entry.reason,
      balanceAfter: entry.balanceAfter,
      note: entry.note,
      createdAt: entry.createdAt,
    };

    if (entry.reason !== 'generation' || !entry.generationId) {
      return row;
    }

    const record = byId.get(entry.generationId);

    if (!record) {
      return row;
    }

    row.kind = record.statusKind;

    if (refunded.has(entry.generationId)) {
      return row;
    }

    /*
     * The charge comes from the LEDGER ROW, not from `generations.credits_charged`. They should agree,
     * and when they do not the ledger is the one that moved the user's balance — a savings figure
     * derived from the other number would be describing a charge that never happened.
     */
    const savings = describeSavings({
      usage: {
        promptTokens: record.promptTokens,
        completionTokens: record.completionTokens,
        cacheReadTokens: record.cacheReadTokens,
        cacheCreationTokens: record.cacheCreationTokens,
      },
      model: record.model,

      /*
       * The raw USD RECORDED with the turn. An older row that predates the column has none, and
       * `describeSavings` answers null for it rather than re-pricing the turn against today's
       * marketplace list and today's gateway — neither of which is what the user was billed against.
       */
      actualCostUsd: record.rawCostUsd ?? 0,
      creditsCharged: Math.abs(entry.delta),
    });

    if (!savings) {
      return row;
    }

    comparedRows += 1;
    referenceCredits += savings.referenceCredits;
    savedCredits += savings.savedCredits;

    if (savings.savedCredits > 0) {
      row.savedCredits = savings.savedCredits;
    }

    return row;
  });

  return {
    rows,
    savings: {
      savedCredits,
      referenceCredits,
      percent: referenceCredits > 0 ? Math.round((savedCredits / referenceCredits) * 100) : 0,
      comparedRows,
    },
  };
}
