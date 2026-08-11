/**
 * Every string the credits-history rows show comes from here (`describeSaveStatus` discipline), and
 * the case this exists for is the REFUND row: `spec/fail-loud.md` rule 5 — "you were not charged" is
 * only believable if the refund is visible where the user looks.
 */
import { describe, expect, it } from 'vitest';
import { compactAge, describeLedgerEntry, formatSavings } from './ledger-display';

describe('describeLedgerEntry', () => {
  it('renders a refund with its own tone — the row this feature exists for', () => {
    const view = describeLedgerEntry({ delta: 316, reason: 'refund' });

    expect(view).toEqual({ label: 'Refund', amount: '+316', tone: 'refund' });
  });

  it('renders every known reason with a human label', () => {
    expect(describeLedgerEntry({ delta: 800, reason: 'grant' }).label).toBe('Free credits');
    expect(describeLedgerEntry({ delta: 3000, reason: 'purchase' }).label).toBe('Purchase');
    expect(describeLedgerEntry({ delta: -316, reason: 'generation' }).label).toBe('Generation');
    expect(describeLedgerEntry({ delta: -24, reason: 'media' }).label).toBe('Media render');
    expect(describeLedgerEntry({ delta: -2, reason: 'search' }).label).toBe('Web search');
    expect(describeLedgerEntry({ delta: -500, reason: 'license' }).label).toBe('Unity license');
    expect(describeLedgerEntry({ delta: 100, reason: 'promo' }).label).toBe('Promo');
    expect(describeLedgerEntry({ delta: 50000, reason: 'adjustment' }).label).toBe('Adjustment');
  });

  it('signs are ALWAYS explicit, with a true minus sign for debits', () => {
    expect(describeLedgerEntry({ delta: -316, reason: 'generation' }).amount).toBe('−316');
    expect(describeLedgerEntry({ delta: 9500, reason: 'purchase' }).amount).toBe('+9,500');
  });

  it('tones: credits positive, debits quiet, refund distinct', () => {
    expect(describeLedgerEntry({ delta: 800, reason: 'grant' }).tone).toBe('credit');
    expect(describeLedgerEntry({ delta: -24, reason: 'media' }).tone).toBe('debit');
    expect(describeLedgerEntry({ delta: 0, reason: 'adjustment' }).tone).toBe('neutral');
  });

  /* A reason added server-side next month must render as itself — never crash or blank the row. */
  it('renders an unknown reason capitalized, not blank', () => {
    const view = describeLedgerEntry({ delta: -5, reason: 'boost' });

    expect(view.label).toBe('Boost');
    expect(view.tone).toBe('debit');
  });
});

/**
 * WHAT THE TURN ACTUALLY WAS (`generations.status_kind`, migration 0019).
 *
 * Every LLM turn debits under the one ledger reason `generation` — that vocabulary is owned by a SQL
 * `CHECK` constraint and is about the kind of MONEY MOVEMENT, not the kind of work. So a five-minute
 * creation build, a one-line edit, an auto-repair nobody asked for and a read-only plan all rendered
 * as four identical rows reading "Generation", i.e. the panel that exists to answer "where did my
 * credits go?" answered "generations", which the user already knew.
 */
describe('describeLedgerEntry names the turn when the generation row knows it', () => {
  it.each([
    ['creation', 'Creation build'],
    ['edit', 'Edit'],
    ['repair', 'Auto-repair'],
    ['plan', 'Plan'],
  ])('a %s generation reads "%s"', (kind, label) => {
    expect(describeLedgerEntry({ delta: -316, reason: 'generation', kind }).label).toBe(label);
  });

  /*
   * 🔴 A REFUND OF A CREATION BUILD IS A REFUND. The kind is decorated onto every ledger row that
   * names a generation — including the refund row, which names the same one — so labelling it
   * "Creation build" would put two identically-titled rows next to each other, one of which gave money
   * back. That is the single distinction this panel most has to make (`spec/fail-loud.md` rule 5), and
   * the failure is silent: the row still renders, it just quietly stops being identifiable as a refund.
   */
  it('never lets the kind rename a REFUND row', () => {
    const view = describeLedgerEntry({ delta: 316, reason: 'refund', kind: 'creation' });

    expect(view).toEqual({ label: 'Refund', amount: '+316', tone: 'refund' });
  });

  /* Same rule, a reason that is not a generation at all — the kind must never leak sideways. */
  it('never lets the kind rename a non-generation row', () => {
    expect(describeLedgerEntry({ delta: -24, reason: 'media', kind: 'edit' }).label).toBe('Media render');
  });

  /*
   * Migration 0019 is nullable WITH NO BACKFILL, on purpose — every row written before it genuinely
   * does not know its kind. Absent is the expected state, not an exceptional one, and an unrecognised
   * FUTURE kind has to render too. Both fall back to "Generation", which is exactly as specific as
   * what we actually know.
   */
  it('falls back to "Generation" for an absent kind and for an unrecognised future one', () => {
    expect(describeLedgerEntry({ delta: -316, reason: 'generation' }).label).toBe('Generation');
    expect(describeLedgerEntry({ delta: -316, reason: 'generation', kind: 'gauntlet' }).label).toBe('Generation');
    expect(describeLedgerEntry({ delta: -316, reason: 'generation', kind: '' }).label).toBe('Generation');
  });

  /* The kind changes only the LABEL — sign and tone are the ledger's facts and are untouched. */
  it('leaves amount and tone alone', () => {
    expect(describeLedgerEntry({ delta: -1_017, reason: 'generation', kind: 'creation' })).toEqual({
      label: 'Creation build',
      amount: '−1,017',
      tone: 'debit',
    });
  });
});

/**
 * `formatSavings` — the sentence the `/context` panel and the credits panel BOTH print.
 *
 * It is shared rather than inlined twice because two copies of a money sentence drift, and it is
 * tested rather than eyeballed because both rules below are invisible in a hand-run: nobody
 * deliberately produces a 1-credit saving or a 0.4% one, so the first time either appears is in front
 * of a user.
 *
 * ⚠️ `percent` arrives ALREADY ROUNDED — `savings.ts` computes it as
 * `Math.round((savedCredits / referenceCredits) * 100)` — so `0` here does not mean "no saving", it
 * means "a saving smaller than half a percent". That distinction is the whole reason the `<1` clause
 * exists, and it is why this formatter cannot simply print the number it was handed.
 */
describe('formatSavings', () => {
  it('renders the ordinary case — credits and a rounded percent', () => {
    expect(formatSavings({ savedCredits: 214, percent: 38 })).toBe('214 credits (38%)');
  });

  /* The panels quote four- and five-figure totals; an unseparated "1240" reads as a different number. */
  it('groups thousands', () => {
    expect(formatSavings({ savedCredits: 1_240, percent: 12 })).toBe('1,240 credits (12%)');
    expect(formatSavings({ savedCredits: 1_000_000, percent: 61 })).toBe('1,000,000 credits (61%)');
  });

  /*
   * 🔴 A one-credit saving is real and reachable on a cheap turn (the credits panel renders the row
   * for any `savedCredits > 0`). "Saved 1 credits vs full price" reads as a bug in the NUMBER rather
   * than in the grammar, on the one panel whose entire value is that its figures can be trusted.
   */
  it('says "1 credit", never "1 credits"', () => {
    expect(formatSavings({ savedCredits: 1, percent: 3 })).toBe('1 credit (3%)');
  });

  /* CONTROL for the singular: every other count keeps the plural, including the boundary at 2. */
  it('CONTROL — 0 and 2 stay plural, so the rule is a singular case and not a rewrite', () => {
    expect(formatSavings({ savedCredits: 2, percent: 3 })).toBe('2 credits (3%)');
    expect(formatSavings({ savedCredits: 0, percent: 0 })).toBe('0 credits (<1%)');
  });

  /*
   * 🔴 A GENUINE SAVING MUST NEVER PRINT "(0%)". The credits shown immediately beside it assert that
   * money was saved; a rounded zero in the same sentence denies it. The panel must not state a saving
   * and its absence in one breath.
   */
  it('renders a sub-half-percent saving as "<1%", never "0%"', () => {
    expect(formatSavings({ savedCredits: 7, percent: 0 })).toBe('7 credits (<1%)');
    expect(formatSavings({ savedCredits: 7, percent: 0 })).not.toContain('(0%)');
  });

  /*
   * CONTROL for the clause above — it must be a floor, not a blanket. `1%` is a real, printable
   * figure, and a `<= 1` boundary would silently relabel every 1% saving as "less than one percent",
   * i.e. under-report a saving on the panel that exists to report it.
   */
  it('CONTROL — 1% prints as "1%", so the floor is exclusive', () => {
    expect(formatSavings({ savedCredits: 12, percent: 1 })).toBe('12 credits (1%)');
  });

  it('leaves ordinary percentages alone', () => {
    expect(formatSavings({ savedCredits: 500, percent: 100 })).toBe('500 credits (100%)');
    expect(formatSavings({ savedCredits: 3, percent: 2 })).toBe('3 credits (2%)');
  });
});

describe('compactAge', () => {
  const now = new Date('2026-07-25T12:00:00.000Z');

  it.each([
    ['now', '2026-07-25T11:59:30.000Z'],
    ['5m', '2026-07-25T11:55:00.000Z'],
    ['3h', '2026-07-25T09:00:00.000Z'],
    ['2d', '2026-07-23T11:00:00.000Z'],
  ])('renders %s', (expected, createdAt) => {
    expect(compactAge(createdAt, now)).toBe(expected);
  });

  it('falls to a locale date beyond a week', () => {
    expect(compactAge('2026-07-01T12:00:00.000Z', now)).toBe(new Date('2026-07-01T12:00:00.000Z').toLocaleDateString());
  });

  it('never renders garbage for a bad timestamp', () => {
    expect(compactAge('not-a-date', now)).toBe('');
  });

  it('clamps a client-clock skew to "now" instead of a negative age', () => {
    expect(compactAge('2026-07-25T12:00:05.000Z', now)).toBe('now');
  });
});
