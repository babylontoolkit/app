/**
 * The creation completeness pass (`creation-completion.ts`) — a money-path decision.
 *
 * `true` buys an extra stream on the user's credits; `false` ships a half-written project. Both
 * directions are silent, so every branch is pinned here and the file's guard clauses are asserted
 * independently (a single "happy path" test passes for a function that returns `true` unconditionally,
 * which would rescue Stops and discussion turns).
 */
import { describe, expect, it } from 'vitest';
import { CREATION_COMPLETION_PROMPT, shouldVerifyCreationCompleteness } from './creation-completion';

const base = {
  isFirstBuildTurn: true,
  isDiscussTurn: false,
  aborted: false,
  alreadyContinued: false,
  truncatedByLength: false,
  emittedAction: true,
};

describe('shouldVerifyCreationCompleteness', () => {
  /*
   * 🔴 THE MEASURED FAILURE, as a test.
   *
   * A real creation wrote ONE file (`src/scripts/KartController.ts`), said "Writing the full project
   * now.", and ended `stop` with 7,165 chars of text — no landing page, no chrome, no further game
   * code. It passed `shouldForceContinuation` (needs `tool-calls`), `shouldRescueUnproductiveTurn`
   * (needs zero actions) and the `!producedText` check (there was text), and billed as a success.
   * This is the turn shape that must never close unchecked again.
   */
  it('runs on a first build turn that wrote files and ended normally', () => {
    expect(shouldVerifyCreationCompleteness(base)).toBe(true);
  });

  /*
   * The pass is scoped to creations. An ordinary edit that writes one file is a COMPLETE edit — asking
   * "did you finish?" after every edit in the product buys a stream per turn forever, which is a
   * standing tax rather than a safety net.
   */
  it('never runs on an ordinary turn', () => {
    expect(shouldVerifyCreationCompleteness({ ...base, isFirstBuildTurn: false })).toBe(false);
  });

  /*
   * Plan/discuss turns are read-only BY GUARANTEE (§4.2.9) — they owe no files, so "is the project
   * finished?" has no meaning for them and the prompt would invite exactly the writes the plan wall
   * exists to prevent.
   */
  it('never runs on a plan or discussion turn', () => {
    expect(shouldVerifyCreationCompleteness({ ...base, isDiscussTurn: true })).toBe(false);
  });

  /*
   * A Stop is the user's decision, not a failure (§4.6) — it is charged for what it consumed. Buying
   * an extra stream after someone presses Stop spends money they explicitly asked us to stop spending.
   */
  it('never runs after the user pressed Stop', () => {
    expect(shouldVerifyCreationCompleteness({ ...base, aborted: true })).toBe(false);
  });

  /*
   * 🔴 ONE extra stream per turn, ever. `forcedContinuation || unproductiveRescue` is passed in as
   * `alreadyContinued`; without this a creation that was already rescued would run a THIRD stream, and
   * a safety net that can compound is a runaway bill rather than a safety net.
   */
  it('never runs when another rescue already ran', () => {
    expect(shouldVerifyCreationCompleteness({ ...base, alreadyContinued: true })).toBe(false);
  });

  /*
   * A creation that wrote NOTHING belongs to `shouldRescueUnproductiveTurn`, which has the correct
   * prompt for it ("you announced work you did not do"). Two rescues racing on one turn is the
   * two-writers drift this codebase keeps rediscovering — and this one's prompt says "emit only what
   * is missing", which is the wrong instruction for a turn where everything is missing.
   */
  it('defers to the unproductive rescue when the turn wrote no files at all', () => {
    expect(shouldVerifyCreationCompleteness({ ...base, emittedAction: false })).toBe(false);
  });
});

describe('truncation overrides every other guard', () => {
  /*
   * 🔴 MEASURED LIVE: step 5 ran 655,957ms and stopped at exactly 64,000 output tokens with
   * finish=length+forced-continuation, mid-project. The forced continuation is usually WHERE the
   * project gets written, so suppressing this pass after one means a truncated build ships — having
   * already been charged 1,175 credits.
   */
  it('runs after a forced continuation when the output ceiling was hit', () => {
    expect(shouldVerifyCreationCompleteness({ ...base, alreadyContinued: true, truncatedByLength: true })).toBe(true);
  });

  /*
   * The CONTROL for the assertion above: without it, "length overrides alreadyContinued" passes for a
   * function that ignores `alreadyContinued` entirely.
   */
  it('CONTROL: still defers to alreadyContinued when the turn was NOT truncated', () => {
    expect(shouldVerifyCreationCompleteness({ ...base, alreadyContinued: true, truncatedByLength: false })).toBe(false);
  });

  /*
   * A Stop still wins. The user asked us to stop spending; a truncated output is not a reason to
   * spend more against their explicit instruction.
   */
  it('never overrides a user Stop, even on a truncated turn', () => {
    expect(shouldVerifyCreationCompleteness({ ...base, aborted: true, truncatedByLength: true })).toBe(false);
  });

  it('never overrides the discuss-turn guarantee', () => {
    expect(shouldVerifyCreationCompleteness({ ...base, isDiscussTurn: true, truncatedByLength: true })).toBe(false);
  });
});

describe('CREATION_COMPLETION_PROMPT', () => {
  /*
   * The cost control, asserted because it is the difference between a cheap pass and a second whole
   * creation: without it a complete build re-emits its entire project at the 5x output rate, decoded
   * serially — the exact waste this pass exists to prevent elsewhere.
   */
  it('forbids rewriting files that are already correct', () => {
    expect(CREATION_COMPLETION_PROMPT).toMatch(/do NOT rewrite files that are already correct/i);
  });

  /*
   * The complete case must be able to cost almost nothing. If the prompt does not say "write no files",
   * a model asked to "check your work" reliably produces a diff of something.
   */
  it('gives the complete case an explicit zero-write exit', () => {
    expect(CREATION_COMPLETION_PROMPT).toMatch(/write no files at all/i);
  });

  /*
   * The owner's actual instruction: "MARK EM, LOG EM, SOMETHING AND MOVE ON — don't just stop in the
   * middle." A part that cannot be finished must not abort the rest and must not be silent; it is
   * reported in one line and everything else still ships.
   */
  it('requires finishing the rest and naming what could not be done', () => {
    expect(CREATION_COMPLETION_PROMPT).toMatch(/write everything else/i);
    expect(CREATION_COMPLETION_PROMPT).toMatch(/what you could not do and why/i);
  });

  /*
   * It must not offer the model the option of asking permission — a creation that ends with "shall I
   * continue?" is the half-written turn wearing a question mark.
   */
  it('tells a truncated turn to resume where it stopped', () => {
    expect(CREATION_COMPLETION_PROMPT).toMatch(/cut off mid-sentence or mid-file/i);
    expect(CREATION_COMPLETION_PROMPT).toMatch(/pick up exactly/i);
  });

  it('forbids asking whether to continue', () => {
    expect(CREATION_COMPLETION_PROMPT).toMatch(/do not ask whether to continue/i);
  });
});
