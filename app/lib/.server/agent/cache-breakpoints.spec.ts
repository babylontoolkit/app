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

  /**
   * The 2026-07-30 restructure — the file context split into a starter entry (shared per template
   * pin, ahead of the per-conversation blocks) and a game-code entry (the per-turn one). The freed
   * position came from docs + skills sharing ONE breakpoint, which rides on the skills block when
   * one exists, else on the last doc block. These arrays mirror `proxy.ts` step 8 exactly; if the
   * assembly grows a block, this arithmetic must be redone HERE, where it can fail.
   */
  describe('the split-file-context assembly (2026-07-30)', () => {
    it('the fullest turn — docs AND skills AND both file halves — is exactly four', () => {
      const system = [
        block('base prompt', true),
        block('# Current Project Files (1/2) — starter framework', true),
        block('routed doc block 1', false),
        block('routed doc block 2', false), // docs carry NO breakpoint when a skills block follows
        block('slash skill + preloaded + carried, ONE block', true),
        block('# Current Project Files (2/2) — game code', true),
        block('mcp note', false), // notes moved PAST the last breakpoint (the flagged 2026-07-19 defect)
        block('discuss note', false),
      ];

      expect(countCacheBreakpoints(system)).toBe(MAX_CACHE_BREAKPOINTS);
    });

    it('with no skills block, the docs set carries the shared breakpoint — still four', () => {
      const system = [
        block('base prompt', true),
        block('# Current Project Files (1/2) — starter framework', true),
        block('routed doc block 1', false),
        block('routed doc block 2', true), // last doc inherits the shared breakpoint
        block('# Current Project Files (2/2) — game code', true),
      ];

      expect(countCacheBreakpoints(system)).toBe(MAX_CACHE_BREAKPOINTS);
    });

    /**
     * The regression this layout must never allow back: docs keeping their OWN breakpoint beside a
     * skills block. With the starter entry that is five — the assembly the API kills with HTTP 400.
     */
    it('catches the regression: docs breakpoint + skills breakpoint + starter entry is five', () => {
      const system = [
        block('base prompt', true),
        block('starter framework files', true),
        block('routed doc block', true), // <- the breakpoint the merge removed
        block('skills', true),
        block('game code files', true),
      ];

      expect(countCacheBreakpoints(system)).toBeGreaterThan(MAX_CACHE_BREAKPOINTS);
    });

    it('an imported project with no framework zones simply has no starter entry — three', () => {
      const system = [
        block('base prompt', true),
        block('routed doc block', true),
        block('# Current Project Files (2/2) — game code', true),
      ];

      expect(countCacheBreakpoints(system)).toBe(3);
    });
  });
});
