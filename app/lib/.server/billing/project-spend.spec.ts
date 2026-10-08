/**
 * The first build's total (`project-spend.ts`, owner 2026-10-04): everything the ledger charged ONE
 * project — create fee, build turns, renders — net of refunds, and nothing that belongs to anything else.
 */
import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from './ledger';
import { sumProjectSpend } from './project-spend';

let n = 0;

const row = (fields: Partial<LedgerEntry> & Pick<LedgerEntry, 'delta' | 'reason'>): LedgerEntry => ({
  id: `row-${++n}`,
  userId: 'u1',
  balanceAfter: 0,
  createdAt: '2026-10-04T00:00:00Z',
  ...fields,
});

const PROJECT = 'p1';
const MINE = new Set(['gen-a', 'med-b', 'gen-c']);

describe('sumProjectSpend', () => {
  it('adds the create fee, build turns and renders, minus their refunds', () => {
    const entries = [
      row({ delta: -150, reason: 'project_create', note: `project_create:${PROJECT}` }),
      row({ delta: -900, reason: 'generation', generationId: 'gen-a' }),
      row({ delta: -26, reason: 'media', generationId: 'med-b' }),
      row({ delta: -40, reason: 'generation', generationId: 'gen-c' }),
      row({ delta: 40, reason: 'refund', generationId: 'gen-c' }),
    ];

    expect(sumProjectSpend({ entries, projectId: PROJECT, projectGenerationIds: MINE })).toBe(1076);
  });

  it('CONTROL: another project, grants, purchases and adjustments never count', () => {
    const entries = [
      row({ delta: -900, reason: 'generation', generationId: 'gen-a' }),
      row({ delta: -150, reason: 'project_create', note: 'project_create:p2' }),
      row({ delta: -500, reason: 'generation', generationId: 'gen-other' }),
      row({ delta: 1000, reason: 'grant' }),
      row({ delta: 6000, reason: 'purchase', paymentRef: 'pi_1' }),
    ];

    expect(sumProjectSpend({ entries, projectId: PROJECT, projectGenerationIds: MINE })).toBe(900);
  });

  it('never reports a negative total', () => {
    const entries = [row({ delta: 50, reason: 'refund', generationId: 'gen-a' })];

    expect(sumProjectSpend({ entries, projectId: PROJECT, projectGenerationIds: MINE })).toBe(0);
  });
});
