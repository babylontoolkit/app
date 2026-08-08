/**
 * The per-turn tool policy (§4.2.8, §4.16) — money-path tests.
 *
 * Both wrong answers are silent money bugs: opening the loop where it should be closed re-buys the
 * measured six-round / 29k-redraft creation pathology; closing it where the creation brief advertises
 * media tools makes the model draft around tools it cannot call. Every case here is a turn shape that
 * actually occurs.
 */
import { describe, expect, it } from 'vitest';
import {
  CREATION_ALLOWS_MEDIA,
  CREATION_FILE_READ_ROUNDS,
  CREATION_MEDIA_STEPS,
  CREATION_TOOL_ROUNDS,
  MEDIA_IMAGE_ROUNDS,
  toolPolicyForTurn,
} from './tool-policy';
import { MAX_REFERENCE_LOADS } from './reference-tools';
import { MAX_TOOL_ROUNDS } from './tools';

const base = { isFirstBuildTurn: false, hasMcpTools: false, hasMediaTools: false, preloadedCount: 0, isSlash: false };

describe('toolPolicyForTurn — first build turns', () => {
  it('opens the CREATION loop with a derived cap PLUS a reserved answer step (§4.16, Phase 2)', () => {
    /*
     * The `+ 1` is the answer step, and it is load-bearing: without it a model that tool-calls on
     * every step (measured, gen_msixapaq_i871b6 — 3+1+1 sequential images) ends the generation with
     * the game unwritten and hands the work to the forced continuation, which re-bills the whole
     * prefix at 2x. The budgets in the tools' execute are what keep the extra step unspendable.
     */
    expect(toolPolicyForTurn({ ...base, isFirstBuildTurn: true, hasMediaTools: true })).toEqual({
      allowTools: true,
      toolset: 'creation',
      maxSteps: CREATION_TOOL_ROUNDS + 1,
    });
  });

  /*
   * 🔴 The historic one-shot is GONE, and that is Phase 2's most consequential single change.
   *
   * `{ allowTools: false, maxSteps: 1 }` was correct while ~106KB of Babylon Toolkit documentation was
   * welded into every prompt: the model already had everything, so a tool could only cost rounds. With
   * the docs unbaked, a tool-less creation would be asked to write a whole game holding the platform's
   * rules, the router index, the reference INDEX — and none of the API documentation the index
   * describes. Nothing would throw; the token count would go DOWN; the game would just be worse.
   */
  it('gives a creation the reference tools even when the platform cannot render', () => {
    expect(toolPolicyForTurn({ ...base, isFirstBuildTurn: true })).toEqual({
      allowTools: true,
      toolset: 'creation',
      maxSteps: CREATION_TOOL_ROUNDS + 1,
    });
  });

  /*
   * Skill tools must NEVER be offered on a creation turn — that is the six-tool-round pathology the
   * one-shot fix removed (§4.2.8: 29,173 redrafted output tokens to load ONE skill), and the state
   * that produced every recorded thrash was a skill INLINED while the tool was offered. MCP presence
   * must not widen the set either.
   */
  it('never offers the full toolset on a first build turn, even with MCP tools present', () => {
    const policy = toolPolicyForTurn({ ...base, isFirstBuildTurn: true, hasMediaTools: true, hasMcpTools: true });
    expect(policy.toolset).toBe('creation');

    const noMedia = toolPolicyForTurn({ ...base, isFirstBuildTurn: true, hasMcpTools: true });
    expect(noMedia.toolset).toBe('creation');
  });

  /*
   * 🔴 THE PAIRING, asserted as a RELATIONSHIP rather than as a literal.
   *
   * `maxSteps` is only a true statement about the worst case if it exceeds every tool round the turn
   * can actually buy. Raising a budget without re-deriving the cap is exactly how a creation spent
   * 1,489 credits and shipped nothing, so this fails if either number moves alone.
   */
  it('reserves a step the tool budgets cannot consume, whatever those budgets are', () => {
    const withMedia = toolPolicyForTurn({ ...base, isFirstBuildTurn: true, hasMediaTools: true });
    const withoutMedia = toolPolicyForTurn({ ...base, isFirstBuildTurn: true });

    expect(withMedia.maxSteps).toBeGreaterThan(MAX_REFERENCE_LOADS);
    expect(withoutMedia.maxSteps).toBeGreaterThan(MAX_REFERENCE_LOADS);
  });

  /*
   * 🔴 MEDIA IS OFF THE CREATION TURN (2026-08-08) — `CREATION_ALLOWS_MEDIA`, and the live step log in
   * `tool-policy.ts` explaining why. `hasMediaTools` is the platform saying "a KIE key exists"; it must
   * no longer widen this turn in ANY way, because a creation that renders art is a creation that spent
   * its attention on art. Asserted as an equality between the two branches rather than against a
   * literal: a literal passes if someone re-adds media and re-derives the cap to match.
   */
  it('does not let media widen the creation turn — the two branches are identical', () => {
    const withMedia = toolPolicyForTurn({ ...base, isFirstBuildTurn: true, hasMediaTools: true });
    const withoutMedia = toolPolicyForTurn({ ...base, isFirstBuildTurn: true });

    expect(withMedia).toEqual(withoutMedia);
    expect(CREATION_ALLOWS_MEDIA).toBe(false);
    expect(CREATION_TOOL_ROUNDS).toBe(MAX_REFERENCE_LOADS + CREATION_FILE_READ_ROUNDS);
  });

  it('caps the creation loop below the ordinary tool cap', () => {
    expect(CREATION_TOOL_ROUNDS + 1).toBeLessThanOrEqual(MAX_TOOL_ROUNDS + 1);
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
     * A creation turn always has tools now (it must read files and load documentation), so "MCP is not
     * offered" is carried entirely by the TOOLSET — `creation` is read_file + references + the repair
     * bounce, and `proxy.ts` builds that set from this value.
     */
    const noMedia = toolPolicyForTurn({ ...base, isFirstBuildTurn: true, hasMcpTools: true });
    expect(noMedia.toolset).toBe('creation');
    expect(noMedia.maxSteps).toBe(CREATION_TOOL_ROUNDS + 1);

    expect(toolPolicyForTurn({ ...base, isFirstBuildTurn: true, hasMcpTools: true, hasMediaTools: true })).toEqual({
      allowTools: true,
      toolset: 'creation',
      maxSteps: CREATION_TOOL_ROUNDS + 1,
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
    expect(policy.toolset).toBe('creation');
  });
});

describe('an ordinary MEDIA turn has room for its images (2026-08-08)', () => {
  /*
   * 🔴 THE PAIRING, and the reason this file asserts relationships rather than literals.
   *
   * `MAX_MEDIA_ROUNDS` is gone: the model asks for ONE image per call, when the design needs it, and
   * is never refused. But one image per round means six images cost six steps, and an ordinary turn
   * had `MAX_TOOL_ROUNDS + 1` = 7 in total — which also has to cover `read_file` rounds, a reference
   * load, and the step that writes the files.
   *
   * Removing a budget without raising its ceiling trades a refusal for a STARVED turn, which is
   * worse: the model spends every step on art and never writes the project. That is the exact bug
   * shipped hours earlier when `read_file` joined the creation toolset and `CREATION_TOOL_ROUNDS` was
   * not re-derived — 74,524 cache tokens written, `finish=length`, 1,175 credits.
   */
  it('gives a media turn enough steps for its images AND the reserved answer step', () => {
    const media = toolPolicyForTurn({ ...base, hasMediaTools: true });

    expect(media.maxSteps).toBeGreaterThan(MEDIA_IMAGE_ROUNDS);
    expect(media.maxSteps).toBeGreaterThan(MAX_TOOL_ROUNDS);
    expect(media.maxSteps).toBe(MAX_TOOL_ROUNDS + MEDIA_IMAGE_ROUNDS + 1);
  });

  /*
   * The CONTROL. Without it, "a media turn gets more steps" passes for a policy that hands EVERY turn
   * the media headroom — buying rounds a turn with no media tools can never spend, on every request.
   */
  it('CONTROL: a turn without media tools does not buy the headroom', () => {
    expect(toolPolicyForTurn({ ...base }).maxSteps).toBe(MAX_TOOL_ROUNDS + 1);
  });

  /*
   * Creation is unaffected — media is off that turn entirely (`CREATION_ALLOWS_MEDIA`), so the
   * headroom must not leak into the most expensive and most fragile turn in the product.
   */
  it('never widens the creation turn', () => {
    const creation = toolPolicyForTurn({ ...base, isFirstBuildTurn: true, hasMediaTools: true });

    expect(creation.maxSteps).toBe(CREATION_TOOL_ROUNDS + 1);
  });
});
