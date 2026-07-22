/**
 * The per-turn tool policy (§4.2.8, §4.16) — money-path tests.
 *
 * Both wrong answers are silent money bugs: opening the loop where it should be closed re-buys the
 * measured six-round / 29k-redraft creation pathology; closing it where the creation brief advertises
 * media tools makes the model draft around tools it cannot call. Every case here is a turn shape that
 * actually occurs.
 */
import { describe, expect, it } from 'vitest';
import { CREATION_MEDIA_STEPS, MEDIA_TURN_STEPS, toolPolicyForTurn } from './tool-policy';
import { MAX_TOOL_ROUNDS } from './tools';

const base = { isCreationTurn: false, hasMcpTools: false, hasMediaTools: false, preloadedCount: 0, isSlash: false };

describe('toolPolicyForTurn — creation turns', () => {
  it('opens a MEDIA-ONLY loop with a small cap when media tools exist (§4.16 design art)', () => {
    expect(toolPolicyForTurn({ ...base, isCreationTurn: true, hasMediaTools: true })).toEqual({
      allowTools: true,
      toolset: 'media-only',
      maxSteps: CREATION_MEDIA_STEPS,
    });
  });

  it('keeps the historic one-shot when the platform cannot render (no KIE key / no project)', () => {
    expect(toolPolicyForTurn({ ...base, isCreationTurn: true })).toEqual({
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
  it('never offers the full toolset on a creation turn, even with MCP tools present', () => {
    const policy = toolPolicyForTurn({ ...base, isCreationTurn: true, hasMediaTools: true, hasMcpTools: true });
    expect(policy.toolset).toBe('media-only');

    const noMedia = toolPolicyForTurn({ ...base, isCreationTurn: true, hasMcpTools: true });
    expect(noMedia.allowTools).toBe(false);
  });

  it('caps the media loop far below the ordinary tool cap — one round + answer + slack', () => {
    expect(CREATION_MEDIA_STEPS).toBeLessThan(MAX_TOOL_ROUNDS + 1);
    expect(CREATION_MEDIA_STEPS).toBeGreaterThanOrEqual(2); // a tool round with no answer step is a truncation
  });
});

describe('toolPolicyForTurn — ordinary turns (the pre-existing behaviour, now pinned)', () => {
  it('opens the full loop when nothing is preloaded and no slash was invoked', () => {
    expect(toolPolicyForTurn({ ...base })).toEqual({
      allowTools: true,
      toolset: 'all',
      maxSteps: MAX_TOOL_ROUNDS + 1,
    });
  });

  it('closes the loop when skills are preloaded or a /slash skill is invoked', () => {
    expect(toolPolicyForTurn({ ...base, preloadedCount: 2 }).allowTools).toBe(false);
    expect(toolPolicyForTurn({ ...base, isSlash: true }).allowTools).toBe(false);
  });

  it('MCP tools force the loop open even with skills preloaded (§4.14)', () => {
    expect(toolPolicyForTurn({ ...base, preloadedCount: 2, hasMcpTools: true })).toEqual({
      allowTools: true,
      toolset: 'all',
      maxSteps: MAX_TOOL_ROUNDS + 1,
    });
  });

  /*
   * The regression this replaces: media tools were unreachable on any turn that routed a skill, and the
   * skill router fires on `design`/`landing`/`art`/`theme` — i.e. on exactly the prompts that ask for
   * art. Creation worked (media-only loop), every later turn was toolless, and the model narrated the
   * absence and drew the art in CSS. Generation must be reachable from the chat on EVERY turn (§4.16).
   */
  it('opens a bounded media-only loop when media is the only reason to open it', () => {
    expect(toolPolicyForTurn({ ...base, preloadedCount: 2, hasMediaTools: true })).toEqual({
      allowTools: true,
      toolset: 'media-only',
      maxSteps: MEDIA_TURN_STEPS,
    });
    expect(toolPolicyForTurn({ ...base, isSlash: true, hasMediaTools: true })).toEqual({
      allowTools: true,
      toolset: 'media-only',
      maxSteps: MEDIA_TURN_STEPS,
    });
  });

  /*
   * The bound is the point — a media-only turn must never be a door back to the §4.2.8 skill-thrash
   * pathology (six rounds, 29k redrafted output tokens, to load ONE skill).
   */
  it('the media-only loop offers no skill tools and is capped well under MAX_TOOL_ROUNDS', () => {
    expect(MEDIA_TURN_STEPS).toBeLessThan(MAX_TOOL_ROUNDS + 1);
  });

  /* When something else already opened the full loop, media rides along in `all` — no separate branch. */
  it('keeps the full toolset when MCP already opened the loop', () => {
    expect(toolPolicyForTurn({ ...base, preloadedCount: 2, hasMcpTools: true, hasMediaTools: true }).toolset).toBe(
      'all',
    );
  });

  it('stays closed when there are no media tools to reach', () => {
    expect(toolPolicyForTurn({ ...base, preloadedCount: 2 })).toEqual({
      allowTools: false,
      toolset: 'all',
      maxSteps: 1,
    });
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
  it('never offers Unity/MCP tools on a creation turn', () => {
    /*
     * Two shapes express "not offered", and the property is the CONJUNCTION — `toolset` is meaningless
     * when `allowTools` is false, so asserting the field alone would pass on a policy that offered them.
     */
    const noMedia = toolPolicyForTurn({ ...base, isCreationTurn: true, hasMcpTools: true });
    expect(noMedia.allowTools).toBe(false);
    expect(noMedia.maxSteps).toBe(1);

    expect(toolPolicyForTurn({ ...base, isCreationTurn: true, hasMcpTools: true, hasMediaTools: true })).toEqual({
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
  it('creation outranks discuss if both flags are ever set', () => {
    const policy = toolPolicyForTurn({ ...base, isCreationTurn: true, isDiscussTurn: true, hasMediaTools: true });
    expect(policy.toolset).toBe('media-only');
  });
});
