/**
 * The refund audit is the operator's answer to "am I refunding people, and why — that money comes out
 * of my pocket" (`spec/fail-loud.md`). A wrong grouping sends the fix to the wrong subsystem, and a
 * dropped row is a refund nobody audits — so both directions are pinned, like `usage-report.spec.ts`.
 */
import { describe, expect, it } from 'vitest';
import { buildRefundReport, causeKey, refundKind, refundRowsToCsv } from './refund-report';
import type { LedgerEntry } from '~/lib/.server/billing/ledger';
import type { GenerationRecord } from '~/lib/.server/billing/generations';

function refund(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    id: 'led_1',
    userId: 'user-a',
    delta: 316,
    reason: 'refund',
    balanceAfter: 1000,
    createdAt: '2026-07-25T12:00:00.000Z',
    ...overrides,
  } as LedgerEntry;
}

function generation(overrides: Partial<GenerationRecord>): GenerationRecord {
  return {
    id: 'gen_1',
    createdAt: '2026-07-25T11:59:00.000Z',
    model: 'claude-opus-4-8',
    provider: 'KIE',
    promptVersionId: null,
    skillsLoaded: [],
    blocksLoaded: [],
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...overrides,
  } as GenerationRecord;
}

describe('buildRefundReport', () => {
  it('joins a refund to its generation and surfaces the WHY', () => {
    const report = buildRefundReport(
      [refund({ generationId: 'gen_1', delta: 316 })],
      [generation({ id: 'gen_1', error: 'The model returned an empty response.', rawCostUsd: 0.79 })],
    );

    expect(report.refunds).toBe(1);
    expect(report.creditsRefunded).toBe(316);
    expect(report.rawCostEatenUsd).toBeCloseTo(0.79);
    expect(report.rows[0].cause).toBe('The model returned an empty response.');
    expect(report.rows[0].model).toBe('claude-opus-4-8');
  });

  /* An audit that silently drops what it cannot explain is not an audit. */
  it('keeps a refund whose generation record is MISSING, counted as unjoined', () => {
    const report = buildRefundReport([refund({ generationId: 'gen_gone', note: 'auto-refund' })], []);

    expect(report.refunds).toBe(1);
    expect(report.unjoined).toBe(1);
    expect(report.rows[0].cause).toBe('auto-refund');
  });

  it('a refund with no cause anywhere reads "unknown", never blank', () => {
    const report = buildRefundReport([refund({ generationId: undefined, note: undefined })], []);

    expect(report.rows[0].cause).toBe('unknown');
  });

  it('splits kinds by anchor prefix: gen_ / med_ / other', () => {
    expect(refundKind('gen_abc')).toBe('generation');
    expect(refundKind('med_abc')).toBe('media');
    expect(refundKind(undefined)).toBe('other');

    const report = buildRefundReport(
      [
        refund({ id: 'l1', generationId: 'gen_1', delta: 300 }),
        refund({ id: 'l2', generationId: 'med_1', delta: 24 }),
        refund({ id: 'l3', generationId: undefined, delta: 500 }),
      ],
      [],
    );

    expect(report.byKind.generation).toEqual({ refunds: 1, credits: 300 });
    expect(report.byKind.media).toEqual({ refunds: 1, credits: 24 });
    expect(report.byKind.other).toEqual({ refunds: 1, credits: 500 });
  });

  it('groups the same failure into ONE cause bucket despite differing numbers', () => {
    const report = buildRefundReport(
      [
        refund({ id: 'l1', generationId: 'gen_1' }),
        refund({ id: 'l2', generationId: 'gen_2' }),
        refund({ id: 'l3', generationId: 'gen_3' }),
      ],
      [
        generation({ id: 'gen_1', error: 'Stream broke after 12000ms' }),
        generation({ id: 'gen_2', error: 'Stream broke after 45071ms' }),
        generation({ id: 'gen_3', error: 'KIE refused the task' }),
      ],
    );

    expect(report.byCause[0]).toMatchObject({ cause: 'Stream broke after #ms', refunds: 2 });
    expect(report.byCause[1]).toMatchObject({ cause: 'KIE refused the task', refunds: 1 });
  });

  it('computes the refund RATE against the paired generation sample', () => {
    const report = buildRefundReport(
      [refund({ generationId: 'gen_1' })],
      [
        generation({ id: 'gen_1' }),
        generation({ id: 'gen_2' }),
        generation({ id: 'gen_3' }),
        generation({ id: 'gen_4' }),
      ],
    );

    expect(report.refundRate).toBe(0.25);
  });

  it('zero refunds is a real answer: everything zero, nothing NaN', () => {
    const report = buildRefundReport([], [generation({ id: 'gen_1' })]);

    expect(report.refunds).toBe(0);
    expect(report.creditsRefunded).toBe(0);
    expect(report.refundRate).toBe(0);
    expect(report.byCause).toEqual([]);
    expect(Number.isNaN(report.rawCostEatenUsd)).toBe(false);
  });
});

describe('causeKey', () => {
  it('takes the first line, truncates at 120, and masks numbers', () => {
    expect(causeKey('Timeout after 449s\nstack: …')).toBe('Timeout after #s');
    expect(causeKey(`${'x'.repeat(200)}`)).toHaveLength(121); // 120 + ellipsis
  });
});

describe('refundRowsToCsv — the "see them ALL" export', () => {
  const row = (overrides: object) => buildRefundReport([refund(overrides as Partial<LedgerEntry>)], []).rows[0];

  it('emits a header plus one line per refund', () => {
    const csv = refundRowsToCsv([row({ id: 'l1' }), row({ id: 'l2' })]);
    const lines = csv.split('\r\n');

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('createdAt');
    expect(lines[0]).toContain('cause');
  });

  it('escapes quotes and keeps commas inside cells', () => {
    const csv = refundRowsToCsv([row({ note: 'said "no", twice' })]);

    expect(csv).toContain('"said ""no"", twice"');
  });

  /*
   * The cause column carries MODEL ERROR TEXT — attacker-influenced by construction. A cell starting
   * with = + - @ executes as a formula when the operator opens the export in Excel/Sheets; the audit
   * must never be the thing that runs code on the auditor's machine.
   */
  it('neutralizes spreadsheet formulas in attacker-influenced cells', () => {
    const csv = refundRowsToCsv([row({ note: '=HYPERLINK("http://evil","click")' })]);

    expect(csv).toContain(`"'=HYPERLINK`);
    expect(csv).not.toContain('"=HYPERLINK');
  });

  it('zero rows is a header-only file, not an empty one', () => {
    expect(refundRowsToCsv([]).split('\r\n')).toHaveLength(1);
  });
});
