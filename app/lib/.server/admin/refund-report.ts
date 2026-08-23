/**
 * The admin refund audit (SPEC §4.10; `spec/fail-loud.md`) — "am I refunding people, and WHY?"
 *
 * Every refund is the platform eating a real bill: the provider charged us for the tokens or the
 * render, the user got their credits back, and the difference came out of the operator's pocket. A
 * refund RATE is therefore a direct cost line AND the best available proxy for "generations are
 * failing in a way users can feel" — which is exactly the §5A alerting number, seen from the money
 * side. Until this report existed the only way to answer "am I refunding people?" was grepping ledger
 * files, i.e. the answer was effectively "nobody is checking".
 *
 * Pure and tested, like `buildUsageReport` beside it: it is the lens the operator diagnoses refunds
 * through, and a wrong CAUSE grouping sends the fix to the wrong subsystem. The join to generation
 * records is where the WHY lives (`finishReason`, `error`, model); a refund whose generation record is
 * missing still appears — an audit that silently drops the rows it cannot explain is the fail-loud
 * anti-pattern wearing an audit's clothes.
 */
import type { LedgerEntry } from '~/lib/.server/billing/ledger';
import { generationKind } from './generation-kind';
import type { GenerationRecord } from '~/lib/.server/billing/generations';

/** Derived from the anchor id's prefix — `gen_` LLM, `med_` media (§4.16); anything else is 'other'. */
export type RefundKind = 'generation' | 'media' | 'other';

export interface RefundRow {
  id: string;
  createdAt: string;
  userId: string;
  credits: number;
  kind: RefundKind;
  generationId?: string;

  /** The ledger note — the human sentence written when the refund was appended. */
  note?: string;

  /** From the joined generation record, when it exists. */
  model?: string;

  /**
   * The best available answer to "why was this refunded" — the generation's `error` first (the
   * actual failure), its `finishReason` second, the ledger note last. Never empty: an inexplicable
   * refund reads "unknown", loudly, rather than blank.
   */
  cause: string;

  /** What the failure cost US in raw provider spend (the refund does not claw this back). */
  rawCostUsd?: number;
}

export interface CauseBucket {
  cause: string;
  refunds: number;
  credits: number;
}

export interface RefundReport {
  /** Refund rows in the sample (the audit list below carries the same rows). */
  refunds: number;

  /** Credits handed back — the user-side total. */
  creditsRefunded: number;

  /**
   * Raw provider spend on the refunded generations we could join — the money that came out of the
   * operator's pocket with nothing to show for it. A LOWER BOUND: refunds with no joined record
   * contribute zero here, and `unjoined` says how many those were.
   */
  rawCostEatenUsd: number;

  /** Refund rows whose generation record could not be found (counted, never dropped). */
  unjoined: number;

  /**
   * Refunds / generations in the paired sample — the headline "is this getting worse" number.
   * Only meaningful when `sampledGenerations` > 0; 0 otherwise.
   */
  refundRate: number;
  sampledGenerations: number;

  byKind: Record<RefundKind, { refunds: number; credits: number }>;

  /** Grouped causes, biggest first — the "what do I fix" list. */
  byCause: CauseBucket[];

  rows: RefundRow[];
}

/**
 * Group key for `byCause`: the first line of the error, truncated — error strings carry ids and
 * token counts that would make every failure its own bucket, so a light normalization (numbers →
 * `#`) lets "the same failure" land in the same bucket without a taxonomy nobody maintains.
 */
export function causeKey(cause: string): string {
  const firstLine = cause.split('\n')[0].trim();

  return (firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine).replace(/\d[\d,.]*/g, '#');
}

/**
 * ⚠️ A DELEGATE. The prefix rule moved to `generation-kind.ts` when `buildUsageReport` turned out to
 * need it too — and had been counting media renders as generations for want of it. Two copies of one
 * rule is the `isSecretPath` mistake; this stays as the refund report's own vocabulary.
 */
export function refundKind(generationId: string | undefined): RefundKind {
  return generationKind(generationId);
}

export function buildRefundReport(refundEntries: LedgerEntry[], generations: GenerationRecord[]): RefundReport {
  const byId = new Map(generations.map((g) => [g.id, g]));

  const report: RefundReport = {
    refunds: refundEntries.length,
    creditsRefunded: 0,
    rawCostEatenUsd: 0,
    unjoined: 0,
    refundRate: 0,
    sampledGenerations: generations.length,
    byKind: {
      generation: { refunds: 0, credits: 0 },
      media: { refunds: 0, credits: 0 },
      other: { refunds: 0, credits: 0 },
    },
    byCause: [],
    rows: [],
  };

  const causes = new Map<string, CauseBucket>();

  for (const entry of refundEntries) {
    const generation = entry.generationId ? byId.get(entry.generationId) : undefined;
    const kind = refundKind(entry.generationId);
    const cause = generation?.error || generation?.finishReason || entry.note || 'unknown';

    report.creditsRefunded += entry.delta;
    report.byKind[kind].refunds++;
    report.byKind[kind].credits += entry.delta;

    if (generation) {
      report.rawCostEatenUsd += generation.rawCostUsd ?? 0;
    } else {
      report.unjoined++;
    }

    const key = causeKey(cause);
    const bucket = causes.get(key) ?? { cause: key, refunds: 0, credits: 0 };
    bucket.refunds++;
    bucket.credits += entry.delta;
    causes.set(key, bucket);

    report.rows.push({
      id: entry.id,
      createdAt: entry.createdAt,
      userId: entry.userId,
      credits: entry.delta,
      kind,
      generationId: entry.generationId,
      note: entry.note,
      model: generation?.model,
      cause,
      rawCostUsd: generation?.rawCostUsd,
    });
  }

  report.refundRate = generations.length ? refundEntries.length / generations.length : 0;
  report.byCause = [...causes.values()].sort((a, b) => b.refunds - a.refunds || b.credits - a.credits);

  return report;
}

/**
 * One CSV cell — quoted, quote-escaped, and FORMULA-GUARDED.
 *
 * The cause/note columns carry model error text, which is attacker-influenced by construction (a
 * prompt can steer what an error says). A cell starting with `=`, `+`, `-`, `@` or a tab executes as
 * a formula the moment the operator opens the export in Excel/Sheets — so those get a leading `'`,
 * the standard spreadsheet neutralizer. An audit export must never be the thing that runs code on the
 * auditor's machine.
 */
function csvCell(value: string | number | undefined): string {
  const raw = value === undefined ? '' : String(value);
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;

  return `"${guarded.replace(/"/g, '""')}"`;
}

/**
 * The FULL audit as a CSV — "see them all", in the tool an operator actually reconciles money in.
 * Columns mirror `RefundRow`; one line per refund, newest first, however many there are.
 */
export function refundRowsToCsv(rows: RefundRow[]): string {
  const header = [
    'createdAt',
    'credits',
    'kind',
    'model',
    'cause',
    'userId',
    'generationId',
    'rawCostUsd',
    'note',
    'ledgerId',
  ];

  const lines = rows.map((row) =>
    [
      csvCell(row.createdAt),
      csvCell(row.credits),
      csvCell(row.kind),
      csvCell(row.model),
      csvCell(row.cause),
      csvCell(row.userId),
      csvCell(row.generationId),
      csvCell(row.rawCostUsd),
      csvCell(row.note),
      csvCell(row.id),
    ].join(','),
  );

  return [header.join(','), ...lines].join('\r\n');
}
