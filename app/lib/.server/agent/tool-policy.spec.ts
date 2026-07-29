/**
 * The per-turn tool policy (§4.2.8, §4.16) — money-path tests.
 *
 * Both wrong answers are silent money bugs: opening the loop where it should be closed re-buys the
 * measured six-round / 29k-redraft creation pathology; closing it where the creation brief advertises
 * media tools makes the model draft around tools it cannot call. Every case here is a turn shape that
 * actually occurs.
 */
import { describe, expect, it } from 'vitest';
import { CREATION_MEDIA_STEPS, toolPolicyForTurn } from './tool-policy';
import { MAX_TOOL_ROUNDS } from './tools';

const base = { isFirstBuildTurn: false, hasMcpTools: false, hasMediaTools: false, preloadedCount: 0, isSlash: false };

describe('toolPolicyForTurn — first build turns', () => {
  it('opens a MEDIA-ONLY loop with a small cap when media tools exist (§4.16 design art)', () => {
    expect(toolPolicyForTurn({ ...base, isFirstBuildTurn: true, hasMediaTools: true })).toEqual({
      allowTools: true,
      toolset: 'media-only',
      maxSteps: CREATION_MEDIA_STEPS,
    });
  });

  it('keeps the historic one-shot when the platform cannot render (no KIE key / no project)', () => {
    expect(toolPolicyForTurn({ ...base, isFirstBuildTurn: true })).toEqual({
      allowTools: false,
      toolset: 'all',
      maxSteps: 1,
    });
  });

  /*
   * Skill tools must NEVER be offered on a creation turn — that is the six-tool-round pathology the
   * one-shot fix removed (§4.2.8: 29,173 redrafted output tokens to load ONE skill). MCP presence must
   * not widen the set either: the creation brief routes design art, nothing else.
   */
  it('never offers the full toolset on a first build turn, even with MCP tools present', () => {
    const policy = toolPolicyForTurn({ ...base, isFirstBuildTurn: true, hasMediaTools: true, hasMcpTools: true });
    expect(policy.toolset).toBe('media-only');

    const noMedia = toolPolicyForTurn({ ...base, isFirstBuildTurn: true, hasMcpTools: true });
    expect(noMedia.allowTools).toBe(false);
  });

  it('caps the media loop far below the ordinary tool cap — one round + answer + slack', () => {
    expect(CREATION_MEDIA_STEPS).toBeLessThan(MAX_TOOL_ROUNDS + 1);
    expect(CREATION_MEDIA_STEPS).toBeGreaterThanOrEqual(2); // a tool round with no answer step is a truncation
  });
});

describe('toolPolicyForTurn — ordinary turns: the skill tools are ALWAYS offered (2026-07-26)', () => {
  /*
   * 🔴 The rule this replaced was `hasMcpTools || (preloadedCount === 0 && !isSlash)` — the keyword
   * router decided, and the instant it fired, `load_skill` was withdrawn. The cached prompt still
   * listed ten skills and still said "Call load_skill(name) to load one of these", so the model was
   * holding an instruction for a tool that was not in its tool set, and a wrong routing decision could
   * never be corrected on any turn. Skills are now chosen by the MODEL from the index; the six-round
   * thrash is bounded by MAX_SKILL_LOADS inside the tool, not by removing the tool.
   */
  it('opens the full loop on a plain turn', () => {
    expect(toolPolicyForTurn({ ...base })).toEqual({
      allowTools: true,
      toolset: 'all',
      maxSteps: MAX_TOOL_ROUNDS + 1,
    });
  });

  it('still opens it when a skill is inlined or a /slash skill was invoked — the model may need a SIBLING skill', () => {
    expect(toolPolicyForTurn({ ...base, preloadedCount: 2 })).toEqual({
      allowTools: true,
      toolset: 'all',
      maxSteps: MAX_TOOL_ROUNDS + 1,
    });
    expect(toolPolicyForTurn({ ...base, isSlash: true })).toEqual({
      allowTools: true,
      toolset: 'all',
      maxSteps: MAX_TOOL_ROUNDS + 1,
    });
  });

  it('MCP tools change nothing on an ordinary turn any more (§4.14)', () => {
    expect(toolPolicyForTurn({ ...base, preloadedCount: 2, hasMcpTools: true })).toEqual({
      allowTools: true,
      toolset: 'all',
      maxSteps: MAX_TOOL_ROUNDS + 1,
    });
  });

  /*
   * The regression that produced the old media-only branch: media tools were unreachable on any turn
   * that routed a skill, and the router fired on `design`/`landing`/`art`/`theme` — exactly the prompts
   * that ask for art. The model narrated the absence and drew the art in CSS. With the full toolset on
   * every ordinary turn, media is reachable by construction rather than by a special case (§4.16).
   */
  it('media generation is reachable on every ordinary turn, whatever else the turn is doing', () => {
    for (const extra of [{}, { preloadedCount: 2 }, { isSlash: true }, { hasMcpTools: true }]) {
      const policy = toolPolicyForTurn({ ...base, ...extra, hasMediaTools: true });
      expect(policy.allowTools).toBe(true);
      expect(policy.toolset).toBe('all');
    }
  });

  it('never closes an ordinary turn — there is no input combination that leaves the model tool-less', () => {
    for (const hasMcpTools of [false, true]) {
      for (const hasMediaTools of [false, true]) {
        for (const preloadedCount of [0, 1, 2]) {
          for (const isSlash of [false, true]) {
            const policy = toolPolicyForTurn({
              isFirstBuildTurn: false,
              hasMcpTools,
              hasMediaTools,
              preloadedCount,
              isSlash,
            });
            expect(policy.allowTools).toBe(true);
            expect(policy.toolset).toBe('all');
          }
        }
      }
    }
  });
});

/*
 * Unity Editor bridge tools (§4.17) reach the policy as ORDINARY MCP tools — they arrive on the same
 * `hasMcpTools` flag, and the policy has no notion of where an MCP tool came from. These cases exist to
 * pin that ABSENCE: a Unity tool drives the user's local Editor (slow, mutating, off-machine), which is
 * exactly the kind of thing someone later special-cases "just this once". The inherited rules are the
 * right ones, and each is load-bearing for Unity specifically.
 */
describe('toolPolicyForTurn — Unity bridge tools inherit MCP policy exactly (§4.17)', () => {
  /*
   * Creation is the one-shot that writes the whole game (§4.2.8). Offering editor tools there re-opens
   * the six-round pathology AND points the model at a Unity project it was not asked to touch.
   */
  it('never offers Unity/MCP tools on a first build turn', () => {
    /*
     * Two shapes express "not offered", and the property is the CONJUNCTION — `toolset` is meaningless
     * when `allowTools` is false, so asserting the field alone would pass on a policy that offered them.
     */
    const noMedia = toolPolicyForTurn({ ...base, isFirstBuildTurn: true, hasMcpTools: true });
    expect(noMedia.allowTools).toBe(false);
    expect(noMedia.maxSteps).toBe(1);

    expect(toolPolicyForTurn({ ...base, isFirstBuildTurn: true, hasMcpTools: true, hasMediaTools: true })).toEqual({
      allowTools: true,
      toolset: 'media-only',
      maxSteps: CREATION_MEDIA_STEPS,
    });
  });

  /*
   * Discuss mode is read-only BY GUARANTEE (§4.2.9), and a Unity tool mutates the user's Editor — the
   * strongest case for the toolset wall rather than an instruction not to use them.
   */
  it('never offers Unity/MCP tools on a discuss turn — the Editor is mutable state', () => {
    expect(toolPolicyForTurn({ ...base, isDiscussTurn: true, hasMcpTools: true }).toolset).toBe('skills-only');
    expect(toolPolicyForTurn({ ...base, isDiscussTurn: true, hasMcpTools: true, preloadedCount: 2 })).toEqual({
      allowTools: false,
      toolset: 'skills-only',
      maxSteps: 1,
    });
  });

  /* On an ordinary turn the loop must OPEN, or the model is told it has Editor tools it cannot call. */
  it('opens the full loop on an ordinary turn, with the +1 answer step', () => {
    expect(toolPolicyForTurn({ ...base, hasMcpTools: true })).toEqual({
      allowTools: true,
      toolset: 'all',
      maxSteps: MAX_TOOL_ROUNDS + 1,
    });
  });
});

describe('toolPolicyForTurn — discussion turns (§4.2.9, read-only by TOOLSET, never just by instruction)', () => {
  it('offers skills only — media (a debit) and MCP (can mutate the sandbox) are never offered', () => {
    expect(toolPolicyForTurn({ ...base, isDiscussTurn: true })).toEqual({
      allowTools: true,
      toolset: 'skills-only',
      maxSteps: MAX_TOOL_ROUNDS + 1,
    });
  });

  it('closes the loop when skills are preloaded — the toolset stays skills-only regardless', () => {
    expect(toolPolicyForTurn({ ...base, isDiscussTurn: true, preloadedCount: 2 })).toEqual({
      allowTools: false,
      toolset: 'skills-only',
      maxSteps: 1,
    });
  });

  it('MCP tools do NOT force the loop open on a discuss turn — they are not offered, so forced rounds would be unusable', () => {
    expect(toolPolicyForTurn({ ...base, isDiscussTurn: true, preloadedCount: 2, hasMcpTools: true }).allowTools).toBe(
      false,
    );
  });

  it('media tools never change a discuss turn', () => {
    expect(toolPolicyForTurn({ ...base, isDiscussTurn: true, hasMediaTools: true }).toolset).toBe('skills-only');
  });

  /*
   * The caller guarantees isDiscussTurn is creation-guarded (`discussModeNote` returns null on a
   * creation turn) — but if both flags ever arrive, creation MUST win: the user asked for a game.
   */
  it('the first build turn outranks discuss if both flags are ever set', () => {
    const policy = toolPolicyForTurn({ ...base, isFirstBuildTurn: true, isDiscussTurn: true, hasMediaTools: true });
    expect(policy.toolset).toBe('media-only');
  });
});
