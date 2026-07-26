/**
 * Every string the credits-history rows show comes from here (`describeSaveStatus` discipline), and
 * the case this exists for is the REFUND row: `spec/fail-loud.md` rule 5 — "you were not charged" is
 * only believable if the refund is visible where the user looks.
 */
import { describe, expect, it } from 'vitest';
import { compactAge, describeLedgerEntry } from './ledger-display';

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
