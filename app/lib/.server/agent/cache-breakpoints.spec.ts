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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
   * 🔴 THE ASSEMBLY AS IT ACTUALLY IS, 2026-08-21 — and the arrays this replaced described one that
   * had not existed for weeks.
   *
   * They modelled the 2026-07-30 "split file context": a starter entry and a game-code entry, two
   * breakpoints between them, arithmetic that came to exactly four. `proxy.ts` carries the tombstone
   * for that split in as many words — *"THE TWO-PART SPLIT IS GONE, DELIBERATELY … the block is now
   * 704 tokens, so the whole apparatus is machinery for a number that no longer exists"* — because
   * the file DUMP became a 704-token MANIFEST and there is nothing left to split. So this file went
   * on asserting `MAX_CACHE_BREAKPOINTS` against a layout with one more block than the product
   * builds: green, precise, and about a shape nobody ships.
   *
   * ⚠️ That is worse than an untested budget. A test pinned to a layout the code does not have
   * cannot notice the layout it does — and this is the file whose header says a sentence in a doc
   * comment cannot fail while this can.
   *
   * `proxy.ts` sets `providerOptions` in exactly FOUR places,
   * and the last two are MUTUALLY EXCLUSIVE — the carried-reference block takes the shared breakpoint
   * only `if (skillBlocks.length === 0)`. So the real maximum today is **three**, against a ceiling of
   * four: one spare. Recording `breakpointCount` on every request (`request-fingerprint.ts`) is how a
   * regression back over the limit becomes visible before it is an HTTP 400 and a dead generation.
   *
   * The maintenance contract is unchanged and is the reason these are literals: if the assembly grows
   * a block, this arithmetic must be redone HERE, where it can fail.
   */
  describe('the manifest assembly as it is on 2026-08-21 (the split retired 2026-08-08)', () => {
    it('an ordinary edit turn is two — the base prompt and the file manifest', () => {
      const system = [
        block('base prompt', true),
        block('# Project files (the manifest)', true),
        block('asset library index', false),
        block('toolkit systems note', false),
        block('mcp note', false),
        block('discuss note', false),
      ];

      expect(countCacheBreakpoints(system)).toBe(2);
    });

    it('a slash turn adds the skills block — three, with one to spare', () => {
      const system = [
        block('base prompt', true),
        block('# Project files (the manifest)', true),
        block('asset library index', false),
        block('slash skill + preloaded + carried, ONE block', true),
        block('phase note', false),
      ];

      expect(countCacheBreakpoints(system)).toBe(3);
      expect(countCacheBreakpoints(system)).toBeLessThan(MAX_CACHE_BREAKPOINTS);
    });

    /*
     * The carried-reference block takes the shared breakpoint ONLY when there is no skills block
     * (the carried-reference push). Same total, different carrier — which is exactly why the two can never both
     * spend one.
     */
    it('carried references take the shared breakpoint when no skills block follows — still three', () => {
      const system = [
        block('base prompt', true),
        block('# Project files (the manifest)', true),
        block('# Babylon Toolkit Reference: babylon-gui', false),
        block('# Babylon Toolkit Reference: racing-system', true),
      ];

      expect(countCacheBreakpoints(system)).toBe(3);
    });

    it('an empty project has no manifest block at all — one', () => {
      const system = [block('base prompt', true), block('discuss note', false)];

      expect(countCacheBreakpoints(system)).toBe(1);
    });

    /**
     * 🔴 THE REGRESSION CASE, kept and re-anchored to the current shape.
     *
     * Five is what the API kills with `HTTP 400 "A maximum of 4 blocks with cache_control may be
     * provided"` — 0 in, 0 out, a whole dead generation before a single token. It shipped once,
     * because `CACHE_CONTROL`'s doc comment said "we spend all four — there are none spare", which
     * was true when written, and the fifth was added later by someone who did not re-count.
     */
    it('catches the regression: every optional block keeping its OWN breakpoint is over budget', () => {
      const system = [
        block('base prompt', true),
        block('# Project files (the manifest)', true),
        block('asset library index', true),
        block('routed doc block', true),
        block('skills', true),
      ];

      expect(countCacheBreakpoints(system)).toBeGreaterThan(MAX_CACHE_BREAKPOINTS);
    });

    /*
     * ⚠️ THE SPARE IS ONE, and this is what says so. `MAX_CACHE_BREAKPOINTS` is the API's ceiling, not
     * our usage; conflating the two is how "there are none spare" became a false sentence that cost a
     * release. If the assembly ever grows a fourth carrier, THIS test fails first — deliberately, and
     * before anything reaches the wire.
     */
    it('records that exactly one breakpoint is currently spare', () => {
      const fullestTurn = [
        block('base prompt', true),
        block('# Project files (the manifest)', true),
        block('skills', true),
      ];

      expect(MAX_CACHE_BREAKPOINTS - countCacheBreakpoints(fullestTurn)).toBe(1);
    });
  });
});

/**
 * 🔴 THE HALF THAT KEEPS THE FIXTURES HONEST.
 *
 * Every array above is a hand-written model of `proxy.ts`'s assembly, and the previous set of them
 * modelled a layout the product had stopped building weeks earlier — green the whole time. Literals
 * are the right tool for the arithmetic (they FAIL when the assembly grows a block, which is the
 * maintenance contract this file exists for), but nothing was checking that the model still matched
 * the thing modelled. This does: it counts the breakpoint carriers in the source.
 */
describe('the fixtures still describe the assembly proxy.ts actually builds', () => {
  const proxy = () =>
    readFileSync(join(process.cwd(), 'app/lib/.server/agent/proxy.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n');

  it('sets providerOptions in exactly four places', () => {
    expect(proxy().match(/providerOptions: CACHE_CONTROL/g)).toHaveLength(4);
  });

  /*
   * ⚠️ TWO OF THE FOUR ARE MUTUALLY EXCLUSIVE, which is the whole reason the real maximum is three
   * rather than four. The carried-reference block takes the shared breakpoint only when no skills
   * block follows it. Delete that condition and the ceiling is reachable again — silently, until a
   * turn with both sends five and 400s before a single token.
   */
  it('makes the carried-reference and skills breakpoints mutually exclusive', () => {
    expect(proxy()).toMatch(/skillBlocks\.length === 0 \? \{ providerOptions: CACHE_CONTROL \}/);
  });

  it('CONTROL — the scanner reads the real proxy and its pattern can fail', () => {
    const source = proxy();

    expect(source.length).toBeGreaterThan(30_000);
    expect(source).toContain('runAgentGeneration');
    expect(source).not.toMatch(/providerOptions: NOT_A_REAL_CONSTANT/);
  });
});
