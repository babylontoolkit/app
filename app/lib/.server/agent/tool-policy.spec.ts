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

  it('media tools alone do NOT force the loop open on ordinary turns — the panel covers those', () => {
    expect(toolPolicyForTurn({ ...base, preloadedCount: 2, hasMediaTools: true }).allowTools).toBe(false);
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
