/**
 * The cache-breakpoint budget (SPEC §4.2.8) — a money AND availability path.
 *
 * Anthropic allows exactly FOUR blocks with `cache_control`. A fifth is not degraded caching, it is:
 *
 *   HTTP 400 — "A maximum of 4 blocks with cache_control may be provided. Found 5."
 *
 * verified against the live API on 2026-07-17. That is a HARD failure before a single token: 0 in,
 * 0 out, the generation dead — the same shape as the edit-turn `thinking.signature` bug, which also
 * lived on a path every test drove around.
 *
 * It shipped. `CACHE_CONTROL`'s own doc comment said "we spend all four ... there are none spare",
 * which was TRUE WHEN WRITTEN — base, routed blocks, invoked skill, project files. Then the
 * pre-loaded-skills block was added with its own breakpoint and nobody re-counted, so any `/slash`
 * turn that also routed a doc block sent five and 400'd. A sentence in a doc comment cannot fail.
 * This file can.
 */
import { describe, expect, it } from 'vitest';
import type { CoreMessage } from 'ai';
import { countCacheBreakpoints, MAX_CACHE_BREAKPOINTS } from './proxy';

const CACHE = { anthropic: { cacheControl: { type: 'ephemeral' as const, ttl: '1h' as const } } };

const block = (content: string, cached: boolean): CoreMessage =>
  ({ role: 'system', content, ...(cached ? { providerOptions: CACHE } : {}) }) as CoreMessage;

describe('the cache breakpoint budget', () => {
  it('is four — the number the API enforces, not a preference', () => {
    expect(MAX_CACHE_BREAKPOINTS).toBe(4);
  });

  it('counts only the blocks that carry a breakpoint', () => {
    const system = [
      block('base', true),
      block('routed doc block 1', false), // only the LAST routed block is a breakpoint
      block('routed doc block 2', true),
      block('skills', true),
      block('files', true),
    ];

    expect(countCacheBreakpoints(system)).toBe(4);
  });

  /**
   * 🔴 THE WORST CASE, WHICH IS ALSO THE ONE THAT SHIPPED.
   *
   * `/slash` + routed blocks + pre-loaded skills + files. The invoked skill and the pre-loaded skills
   * now SHARE one breakpoint, so this assembly is 4 and not 5 — and it is 4 by construction (two
   * blocks joined into one string), not by arithmetic someone has to redo every time a block is added.
   */
  it('stays within budget for the assembly that used to 400: slash + blocks + skills + files', () => {
    const system = [
      block('base prompt', true),
      block('routed doc block', true),
      block('slash skill + preloaded skills, ONE block', true),
      block('# Current Project Files', true),
    ];

    expect(countCacheBreakpoints(system)).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
  });

  it('catches the regression: splitting the skill blocks apart again is five', () => {
    const system = [
      block('base prompt', true),
      block('routed doc block', true),
      block('slash skill', true), // <- the split this fix removed
      block('preloaded skills', true),
      block('# Current Project Files', true),
    ];

    expect(countCacheBreakpoints(system), 'this is the exact assembly the API rejects with HTTP 400').toBeGreaterThan(
      MAX_CACHE_BREAKPOINTS,
    );
  });

  it('a conversation with no slash and no skills is well under budget', () => {
    const system = [block('base prompt', true), block('# Current Project Files', true)];
    expect(countCacheBreakpoints(system)).toBe(2);
  });
});
