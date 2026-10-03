/**
 * `ENABLE_MAX_EFFORT` (D11) — the switch that decides whether a browser may buy `max`.
 *
 * ⚠️ `env()` falls back to `process.env`, and vitest loads `.env.local` — so every "off" case scrubs the
 * variable first, or a developer who enabled Max locally sees this spec fail on code they did not touch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isMaxEffortEnabled, offeredUserEffortLevels } from './effort-offer';
import { parseUserEffort } from '~/lib/modules/llm/capabilities';

const ctx = (vars: Record<string, string>) => ({ cloudflare: { env: vars } });

beforeEach(() => {
  vi.stubEnv('ENABLE_MAX_EFFORT', undefined as unknown as string);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('offeredUserEffortLevels — Max ships OFF', () => {
  it('unset → Medium · High · Extra high (no Max)', () => {
    expect(isMaxEffortEnabled(ctx({}))).toBe(false);
    expect([...offeredUserEffortLevels(ctx({}))]).toEqual(['medium', 'high', 'xhigh']);
  });

  it('"true" (any case, trimmed) → all four levels', () => {
    for (const value of ['true', 'TRUE', ' True ']) {
      expect([...offeredUserEffortLevels(ctx({ ENABLE_MAX_EFFORT: value }))]).toEqual([
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
    }
  });

  it('anything else is OFF — "1", "yes", "on", "false", ""', () => {
    for (const value of ['1', 'yes', 'on', 'false', '']) {
      expect(isMaxEffortEnabled(ctx({ ENABLE_MAX_EFFORT: value }))).toBe(false);
    }
  });

  it('the process env is honoured too (a deploy sets it there)', () => {
    vi.stubEnv('ENABLE_MAX_EFFORT', 'true');
    expect(isMaxEffortEnabled(ctx({}))).toBe(true);
  });

  it('a browser asking for max: refused with the switch off, accepted with it on (pinned both ways)', () => {
    expect(parseUserEffort('max', offeredUserEffortLevels(ctx({})))).toBeUndefined();
    expect(parseUserEffort('max', offeredUserEffortLevels(ctx({ ENABLE_MAX_EFFORT: 'true' })))).toBe('max');
  });

  it('CONTROL: xhigh is offered either way', () => {
    expect(parseUserEffort('xhigh', offeredUserEffortLevels(ctx({})))).toBe('xhigh');
    expect(parseUserEffort('xhigh', offeredUserEffortLevels(ctx({ ENABLE_MAX_EFFORT: 'true' })))).toBe('xhigh');
  });
});
