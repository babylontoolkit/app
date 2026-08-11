/**
 * `shouldRescueUnproductiveTurn` spends the user's credits without them asking, so it is tested the
 * way `decidePremium` and `decideAutoRepair` are: every guard is a way this could go wrong, and each
 * one gets a case proving it holds ALONE (flip one field on an otherwise-firing input).
 *
 * The anchor case is the real generation this was written for — `gen_ms0vcgq8_68vf4c`, pinned to its
 * measured numbers so the arithmetic is tied to a fact rather than to the thresholds' own definition.
 */
import { describe, expect, it } from 'vitest';
import {
  isFailedBuildTurn,
  MIN_BILLED_OUTPUT_TOKENS,
  MIN_PRODUCTIVE_TEXT_CHARS,
  NO_FILES_WRITTEN_ERROR,
  UNPRODUCTIVE_DENSITY,
  shouldRescueUnproductiveTurn,
  UNPRODUCTIVE_RESCUE_PROMPT,
  type UnproductiveTurnInput,
} from './unproductive';
import { shouldRetryGeneration } from './retry-policy';

/** The demo failure, verbatim: 524 output tokens bought 83 characters and stopped. */
const DEMO_FAILURE: UnproductiveTurnInput = {
  aborted: false,
  alreadyContinued: false,
  emittedAction: false,
  truncatedAction: false,
  toolCalls: 0,
  textChars: 83,
  outTokens: 524,
  requiresAction: false,
};

describe('shouldRescueUnproductiveTurn', () => {
  it('fires on the generation that failed the investor demo', () => {
    expect(shouldRescueUnproductiveTurn(DEMO_FAILURE)).toBe(true);
  });

  describe('every guard holds on its own', () => {
    it("never on a user Stop — those tokens were the user's own decision", () => {
      expect(shouldRescueUnproductiveTurn({ ...DEMO_FAILURE, aborted: true })).toBe(false);
    });

    it('never twice — one extra pass per generation, ever', () => {
      expect(shouldRescueUnproductiveTurn({ ...DEMO_FAILURE, alreadyContinued: true })).toBe(false);
    });

    it('never when an action was emitted — writing a file IS the work', () => {
      expect(shouldRescueUnproductiveTurn({ ...DEMO_FAILURE, emittedAction: true })).toBe(false);
    });

    it('never when a tool was called — that is the tool-cap case, not this one', () => {
      expect(shouldRescueUnproductiveTurn({ ...DEMO_FAILURE, toolCalls: 1 })).toBe(false);
    });

    it('never on zero text — that is the existing hard failure, which refunds', () => {
      expect(shouldRescueUnproductiveTurn({ ...DEMO_FAILURE, textChars: 0 })).toBe(false);
    });
  });

  describe('the shapes that are legitimate and must be left alone', () => {
    it('a terse but real answer — few tokens, few chars, healthy ratio', () => {
      // "Yes — `globals.ts` already exports it." — 38 chars on ~20 output tokens.
      expect(shouldRescueUnproductiveTurn({ ...DEMO_FAILURE, textChars: 38, outTokens: 20 })).toBe(false);
    });

    it('a long prose answer that wrote no files (a plan-mode turn)', () => {
      expect(shouldRescueUnproductiveTurn({ ...DEMO_FAILURE, textChars: 4_000, outTokens: 1_200 })).toBe(false);
    });

    it('a think-heavy turn that STILL delivered a real answer', () => {
      // Density 0.8 — under the floor — but 2,000 chars is a delivered answer, so the length gate saves it.
      expect(shouldRescueUnproductiveTurn({ ...DEMO_FAILURE, textChars: 2_000, outTokens: 2_500 })).toBe(false);
    });

    it('a code artifact at the measured code density (~2.0 ch/tok)', () => {
      expect(shouldRescueUnproductiveTurn({ ...DEMO_FAILURE, textChars: 15_049, outTokens: 8_037 })).toBe(false);
    });
  });

  describe('the thresholds themselves', () => {
    it('leaves a short answer alone until it is billing real output', () => {
      const justUnder = { ...DEMO_FAILURE, textChars: 100, outTokens: MIN_BILLED_OUTPUT_TOKENS - 1 };
      const atFloor = { ...DEMO_FAILURE, textChars: 100, outTokens: MIN_BILLED_OUTPUT_TOKENS };

      expect(shouldRescueUnproductiveTurn(justUnder)).toBe(false);
      expect(shouldRescueUnproductiveTurn(atFloor)).toBe(true);
    });

    it('needs BOTH a short answer and a poor density, never one alone', () => {
      // Short enough, but the ratio says the tokens became text: a real (if brief) answer.
      const dense = { ...DEMO_FAILURE, textChars: MIN_PRODUCTIVE_TEXT_CHARS - 1, outTokens: 220 };

      expect(dense.textChars / dense.outTokens).toBeGreaterThan(1);
      expect(shouldRescueUnproductiveTurn(dense)).toBe(false);
    });
  });
});

describe('UNPRODUCTIVE_RESCUE_PROMPT', () => {
  it('is mode-neutral — a plan turn is prose by GUARANTEE and must not be told to write files', () => {
    expect(UNPRODUCTIVE_RESCUE_PROMPT).not.toMatch(/\bwrite the files?\b|boltAction|boltArtifact/i);
  });

  it('names the failure so the model does not repeat it', () => {
    expect(UNPRODUCTIVE_RESCUE_PROMPT).toMatch(/announced/i);
    expect(UNPRODUCTIVE_RESCUE_PROMPT).toMatch(/no skill-loading tools/i);
  });
});

/**
 * The CREATION case (2026-07-27, measured live). A creation retried after a KIE `Internal error`
 * answered with 31,852 characters of prose — the whole landing page written out as text, code and all —
 * and **zero `<boltAction>`**. Every existing signal read healthy: long, dense (2.6 ch/tok), confident,
 * `finish=stop`. The rescue sat it out, the project never built, and the user was billed 50 credits for
 * a description of a game.
 */
describe('shouldRescueUnproductiveTurn — a turn that had to WRITE', () => {
  const CREATION_PROSE: UnproductiveTurnInput = {
    aborted: false,
    alreadyContinued: false,
    emittedAction: false,
    truncatedAction: false,
    toolCalls: 0,
    textChars: 31_852,
    outTokens: 12_215,
    requiresAction: true,
  };

  it('rescues a creation that wrote 31k chars of prose and no files', () => {
    expect(shouldRescueUnproductiveTurn(CREATION_PROSE)).toBe(true);
  });

  /** The control: the identical turn on an ordinary edit is a perfectly good prose answer. */
  it('leaves the same turn alone when the turn did not have to write', () => {
    expect(shouldRescueUnproductiveTurn({ ...CREATION_PROSE, requiresAction: false })).toBe(false);
  });

  /**
   * A media call is not a file write. Exempting on `toolCalls` here would let the MORE expensive
   * failure — commissioned art, then a description instead of a build — buy itself a pass.
   */
  it('still rescues when the creation called a tool but wrote nothing', () => {
    expect(shouldRescueUnproductiveTurn({ ...CREATION_PROSE, toolCalls: 3 })).toBe(true);
  });

  /** The turn DID write — nothing to rescue, whatever else it did. */
  it('never fires once an action was emitted', () => {
    expect(shouldRescueUnproductiveTurn({ ...CREATION_PROSE, emittedAction: true })).toBe(false);
  });

  /** Silence is the existing hard failure (refund, §4.6) — never a second paid pass. */
  it('does not spend a pass on a creation that produced no text at all', () => {
    expect(shouldRescueUnproductiveTurn({ ...CREATION_PROSE, textChars: 0 })).toBe(false);
  });

  /** A Stop is a user decision, and one corrective pass per generation is the hard limit. */
  it('respects abort and the one-pass cap on a creation', () => {
    expect(shouldRescueUnproductiveTurn({ ...CREATION_PROSE, aborted: true })).toBe(false);
    expect(shouldRescueUnproductiveTurn({ ...CREATION_PROSE, alreadyContinued: true })).toBe(false);
  });
});

/**
 * `isFailedBuildTurn` — the VERDICT after every second chance is spent (2026-08-07).
 *
 * The generation it exists for is `gen_msixapaq_i871b6`: 1,489 credits, zero files, recorded
 * `completed`. Every existing guard behaved correctly and the turn still billed as a success, so these
 * tests are written around the exact combination that walked through all of them.
 *
 * ⚠️ The false-positive direction is the expensive one here — a wrong `true` REFUNDS a build that
 * worked. Hence a case per guard, plus the pairing test that stops this and the rescue drifting apart.
 */
describe('isFailedBuildTurn', () => {
  const FAILED_BUILD = { aborted: false, requiresAction: true, emittedAction: false, attemptedBuild: true };

  /** The build turn that owed files and produced prose — same shape the rescue is tested against. */
  const BUILD_PROSE: UnproductiveTurnInput = {
    aborted: false,
    alreadyContinued: false,
    emittedAction: false,
    truncatedAction: false,
    toolCalls: 0,
    textChars: 31_852,
    outTokens: 12_215,
    requiresAction: true,
  };

  it('fires on the shape that billed 1,489 credits for nothing', () => {
    expect(isFailedBuildTurn(FAILED_BUILD)).toBe(true);
  });

  it('fires even after a forced continuation AND a rescue have run — it is the verdict, not a retry', () => {
    /*
     * The whole point. `shouldRescueUnproductiveTurn` correctly refuses once `alreadyContinued` is set;
     * this must NOT, or the pipeline's own exhaustion becomes the reason the user is billed.
     */
    expect(shouldRescueUnproductiveTurn({ ...BUILD_PROSE, alreadyContinued: true })).toBe(false);
    expect(isFailedBuildTurn(FAILED_BUILD)).toBe(true);
  });

  it('never on a user Stop — §4.12 says those tokens are genuinely owed', () => {
    expect(isFailedBuildTurn({ ...FAILED_BUILD, aborted: true })).toBe(false);
  });

  it('never once a file was written, however little else happened', () => {
    expect(isFailedBuildTurn({ ...FAILED_BUILD, emittedAction: true })).toBe(false);
  });

  it('never on a turn that owes no files — an edit may answer in prose, a plan turn must', () => {
    expect(isFailedBuildTurn({ ...FAILED_BUILD, requiresAction: false })).toBe(false);
  });

  /**
   * 🔴 THE QUESTION CASE — the false positive that `attemptedBuild` exists for.
   *
   * The creation brief is appended to WHATEVER the user types first out of New Project mode, so
   * `isFirstBuildTurn` is true even when that first message is *"can I use my own 3D models?"*. A
   * correct prose answer writes no files by design, and firing here would throw "the build finished
   * without writing any project files" over an answer the user is looking straight at — and refund a
   * turn that did exactly what was asked.
   */
  describe('a question asked as the first message is not a failed build', () => {
    const FIRST_TURN_QUESTION = { aborted: false, requiresAction: true, emittedAction: false, attemptedBuild: false };

    it('does NOT fire when the model never tried to build', () => {
      expect(isFailedBuildTurn(FIRST_TURN_QUESTION)).toBe(false);
    });

    it('still fires the moment there is evidence of a build attempt', () => {
      expect(isFailedBuildTurn({ ...FIRST_TURN_QUESTION, attemptedBuild: true })).toBe(true);
    });
  });

  it('shares the rescue\'s notion of "owes files" — the two must never disagree', () => {
    /*
     * The rescue reads `requiresAction`; this reads the same field, fed from the same `owesFiles`
     * expression in the proxy. Pinned as a PROPERTY over the whole cube, because the failure mode of a
     * divergence is invisible: a turn rescued for not writing, then billed as a success for it.
     */
    for (const emittedAction of [true, false]) {
      for (const requiresAction of [true, false]) {
        for (const attemptedBuild of [true, false]) {
          const rescued = shouldRescueUnproductiveTurn({ ...BUILD_PROSE, emittedAction, requiresAction });
          const failedVerdict = isFailedBuildTurn({ aborted: false, requiresAction, emittedAction, attemptedBuild });

          /* Where the rescue fires on the "owes files" ground AND the model was building, so must this. */
          if (rescued && requiresAction && attemptedBuild) {
            expect(failedVerdict).toBe(true);
          }

          /* A turn that wrote something is never either. */
          if (emittedAction) {
            expect(failedVerdict).toBe(false);
          }

          /* And the verdict is never STRICTER than the rescue: it cannot fire where the rescue would not. */
          if (!requiresAction) {
            expect(failedVerdict).toBe(false);
          }
        }
      }
    }
  });
});

describe('NO_FILES_WRITTEN_ERROR', () => {
  it('tells the user the money came back — the charge is settled before they read this', () => {
    expect(NO_FILES_WRITTEN_ERROR).toMatch(/refunded/i);
  });

  it('does NOT trigger the automatic retry ladder', () => {
    /*
     * Load-bearing wording. A turn reaching this point has already had a forced continuation and a
     * rescue; a third automatic stream against the same prompt is exactly the waste being fixed. If
     * someone later rewords this to contain "returned an empty response", the ladder silently starts
     * re-running the most expensive turn in the product.
     */
    expect(NO_FILES_WRITTEN_ERROR).not.toMatch(/returned an empty response/i);

    expect(
      shouldRetryGeneration({
        error: new Error(NO_FILES_WRITTEN_ERROR),
        outTokens: 0,
        aborted: false,
        attempts: 0,
      }),
    ).toBe(false);
  });
});

/**
 * 🔴 THE PAC-MAN FAILURE — measured live 2026-08-10, `gen_msn0zl5h_44wpni`.
 *
 * The owner asked for the Pac-Man player to be rebuilt. The model answered, opened an artifact titled
 * "Authentic Pac-Man: upper/lower jaw wedge, black eyes", opened one `<boltAction type="edit">`, and
 * the stream ENDED mid-diff on the literal text `>>>>>>> REPLACE`. Closes of both tags: zero.
 *
 * The action runner only executes a CLOSED action, so no file was touched. On screen: an artifact card
 * with a title and nothing under it. Billed 240 credits / $0.696, `status: completed`, no rescue and
 * no refund — reported by the owner as the third or fourth occurrence, and as the thing that would
 * stop them shipping.
 *
 * It escaped because `emittedAction` is `includes('<boltAction')` — the OPENING tag — so the guard
 * against "announced work and did nothing" was disarmed by the announcement. The same truncation is
 * where the stray `=======` / `>>>>>>>` conflict markers in shipped source came from.
 */
describe('a turn cut off mid-action is rescued, not billed as a success', () => {
  const PACMAN_TRUNCATION: UnproductiveTurnInput = {
    aborted: false,
    alreadyContinued: false,

    /* Both true at once: it DID emit an opening tag, and that action never closed. */
    emittedAction: true,
    truncatedAction: true,

    toolCalls: 1,
    textChars: 7_695,
    outTokens: 13_436,
    requiresAction: false,
  };

  it('rescues the measured Pac-Man turn', () => {
    expect(shouldRescueUnproductiveTurn(PACMAN_TRUNCATION)).toBe(true);
  });

  /*
   * 🔴 Order matters: `truncatedAction` is checked BEFORE the `emittedAction` bail. Moving it after
   * restores the bug exactly, and every other test in this file still passes.
   */
  it('rescues even though the turn was long, dense and confident', () => {
    expect(PACMAN_TRUNCATION.textChars).toBeGreaterThan(MIN_PRODUCTIVE_TEXT_CHARS);
    expect(PACMAN_TRUNCATION.textChars / PACMAN_TRUNCATION.outTokens).toBeLessThan(UNPRODUCTIVE_DENSITY);
    expect(shouldRescueUnproductiveTurn(PACMAN_TRUNCATION)).toBe(true);
  });

  /* A tool call does not buy a truncated action a pass — the file still is not there. */
  it('rescues regardless of how many tools were called', () => {
    expect(shouldRescueUnproductiveTurn({ ...PACMAN_TRUNCATION, toolCalls: 6 })).toBe(true);
  });

  /* Still bounded to ONE pass, and still never fights a Stop. */
  it('does not stack with a continuation that already ran', () => {
    expect(shouldRescueUnproductiveTurn({ ...PACMAN_TRUNCATION, alreadyContinued: true })).toBe(false);
  });

  it('does not fire when the user pressed Stop', () => {
    expect(shouldRescueUnproductiveTurn({ ...PACMAN_TRUNCATION, aborted: true })).toBe(false);
  });

  /*
   * CONTROL — a healthy turn that opened AND closed its actions must still be left alone. Without
   * this, "always rescue when an action was emitted" passes every test above and doubles the cost of
   * every successful build in the product.
   */
  it('CONTROL: a complete action is not rescued', () => {
    expect(shouldRescueUnproductiveTurn({ ...PACMAN_TRUNCATION, truncatedAction: false })).toBe(false);
  });
});
