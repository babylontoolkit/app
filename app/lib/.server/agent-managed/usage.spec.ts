/**
 * The managed engine's usage arithmetic (`usage.ts`, managed-agents-engine T7). Pure.
 */
import { describe, expect, it } from 'vitest';
import {
  addModelUsage,
  budgetAmountCents,
  ceilingUsdForCredits,
  emptyUsage,
  isAfterCursor,
  parseCursor,
  serializeCursor,
  sessionHoursCostUsd,
  unsettledUsage,
} from './usage';

const span = (id: string, at: string, u: Record<string, number>) => ({
  id,
  type: 'span.model_request_end',
  processed_at: at,
  model_usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...u },
});

describe('addModelUsage', () => {
  it('maps the four counters; input is UNCACHED (Anthropic reports the cache classes as siblings)', () => {
    const total = addModelUsage(emptyUsage(), {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 40,
    });

    expect(total).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      cacheReadTokens: 300,
      cacheCreationTokens: 40,
    });
  });
});

describe('the settlement cursor', () => {
  it('round-trips, and reads a bare timestamp or garbage safely', () => {
    const cursor = { at: '2026-10-01T00:00:05.000Z', activeSeconds: 42 };

    expect(parseCursor(serializeCursor(cursor))).toEqual(cursor);
    expect(parseCursor('2026-10-01T00:00:05Z')).toEqual({ at: '2026-10-01T00:00:05Z', activeSeconds: 0 });
    expect(parseCursor('not json')).toEqual({ at: null, activeSeconds: 0 });
    expect(parseCursor(null)).toEqual({ at: null, activeSeconds: 0 });
  });

  it('compares timestamps PARSED, not as text', () => {
    /* As text "…05.5Z" > "…05Z" would be false (".5" < "Z"); parsed it is half a second later. */
    expect(isAfterCursor('2026-10-01T00:00:05.500Z', '2026-10-01T00:00:05Z')).toBe(true);
    expect(isAfterCursor('2026-10-01T00:00:05+00:00', '2026-10-01T00:00:05.000Z')).toBe(false);
  });

  it('sums only the events after the cursor, and a second pass over the same events finds nothing', () => {
    const events = [
      span('a', '2026-10-01T00:00:01Z', { input_tokens: 5, output_tokens: 7 }),
      span('b', '2026-10-01T00:00:02Z', { input_tokens: 1, cache_read_input_tokens: 100 }),
      span('b', '2026-10-01T00:00:02Z', { input_tokens: 1, cache_read_input_tokens: 100 }),
    ];

    const first = unsettledUsage(events, { at: null, activeSeconds: 0 });

    expect(first.requests).toBe(2);
    expect(first.usage).toMatchObject({ promptTokens: 6, completionTokens: 7, cacheReadTokens: 100 });
    expect(first.latestAt).toBe('2026-10-01T00:00:02Z');

    const again = unsettledUsage(events, { at: first.latestAt, activeSeconds: 0 });

    expect(again.requests).toBe(0);
    expect(again.usage).toEqual(emptyUsage());

    /* CONTROL: an event after the cursor IS counted. */
    expect(unsettledUsage(events, { at: '2026-10-01T00:00:01Z', activeSeconds: 0 }).requests).toBe(1);
  });
});

describe('session hours and the budget', () => {
  it('charges only the active seconds added since the cursor, never negative', () => {
    expect(sessionHoursCostUsd(3600 + 1800, { at: null, activeSeconds: 1800 }, 0.08)).toBeCloseTo(0.08);
    expect(sessionHoursCostUsd(100, { at: null, activeSeconds: 500 }, 0.08)).toBe(0);
  });

  it('turns a credit ceiling into USD with the inverse formula, and a budget in integer cents rounded UP', () => {
    expect(ceilingUsdForCredits(400, 0.01, 4)).toBeCloseTo(1);
    expect(budgetAmountCents(250, 1.234)).toBe('374');
    expect(budgetAmountCents(0, 0.001)).toBe('1');
  });
});
