/**
 * 🔴 A CREATION IS NEVER ALLOWED TO END HALF-WRITTEN (2026-08-08, owner-driven).
 *
 * ## The failure this exists to make impossible
 *
 * Measured on a real "mario kart racer clone" creation:
 *
 *   step 4: 23,597ms · 3,211 out · 7,165 chars text · ANSWER
 *
 * The model wrote a design note, ONE file (`src/scripts/KartController.ts`), the sentence *"Writing the
 * full project now."* — and ended the turn. No landing page. No chrome. No second game file. The turn
 * was billed as a success and the user was left looking at a stock starter with one orphan class in it.
 *
 * Every existing guard passed it, and each for a defensible reason:
 *
 *  - `shouldForceContinuation` — needs `finishReason: 'tool-calls'`. This finished `stop`.
 *  - `shouldRescueUnproductiveTurn` — needs `emittedAction: false`. It emitted ONE action.
 *  - `!producedText` — there were 7,165 characters of text.
 *
 * **That is the whole lesson: every completeness check in the system asked "did it do ANYTHING?", and
 * none asked "did it FINISH?".** One file out of fifteen satisfies all three. A creation is the most
 * expensive generation in the product and the only one the user cannot proceed without, so it is the
 * one turn where "it did some of it" must not be an accepted outcome.
 *
 * ## Why this pass is unconditional
 *
 * The tempting version is to fire only when the build "looks" incomplete — count the files, check for
 * `Home.tsx`, look for an unfinished sentence. Every one of those is a classifier over model output,
 * which this codebase has now been burned by three separate times (skill routing, doc routing, genre
 * inference — `no-prompt-classifier.spec.ts` exists to keep the third one dead). A classifier that
 * guesses "complete" wrong re-opens exactly this bug, silently, and a file-count floor cannot tell a
 * finished narrow request ("just add a rotating cube" — correctly one file) from an abandoned game.
 *
 * So the model is asked. It has just written the project and it has the brief; it is the only party
 * that knows what it intended to write. A complete build answers in a sentence against a WARM prefix
 * (0.1x) and costs almost nothing; an incomplete one finishes the job the user already paid for.
 * That asymmetry is the entire argument: the cheap outcome is common, and the expensive outcome is
 * the one where the alternative is a broken project.
 *
 * ## Never regress
 *
 *  - **Bounded to ONE pass**, and mutually exclusive with the other two rescues (`alreadyContinued`).
 *    No turn may ever run three streams — that is how a "safety net" becomes a runaway bill.
 *  - **Never fires on a turn that emitted NO action.** That is `shouldRescueUnproductiveTurn`'s job and
 *    its prompt is the right one for that case; two rescues racing on one turn is the two-writers
 *    problem this repo keeps rediscovering.
 *  - **Never fires on a plan/discuss turn.** Those are prose by guarantee (§4.2.9) and owe no files.
 *  - **Never fires on an abort.** A Stop is the user's decision and is charged for what it consumed.
 *  - The prompt must forbid rewriting files that are already correct, or a complete build pays to
 *    re-emit itself — turning the cheap common case into the expensive one.
 */

export interface CreationCompletenessInput {
  /** The expensive one-shot that writes the whole project (§4.4a). Only this turn owes a whole project. */
  isFirstBuildTurn: boolean;

  /** Plan/discuss turns are read-only by guarantee (§4.2.9) and owe no files. */
  isDiscussTurn: boolean;

  /** The user pressed Stop. Their decision, charged for what it consumed — never "rescued". */
  aborted: boolean;

  /** A forced continuation or unproductive rescue already ran. One extra stream per turn, ever. */
  alreadyContinued: boolean;

  /**
   * The turn wrote at least one file. When it wrote NONE, `shouldRescueUnproductiveTurn` owns the
   * failure and has the correct prompt for it — this pass would be a second writer on one decision.
   */
  emittedAction: boolean;
}

/**
 * PURE, exported and tested for the same reason as `auto-repair` and `decideCredits`: it spends the
 * user's credits without them asking. A `true` here buys a stream; a `false` ships a half-built game.
 */
export function shouldVerifyCreationCompleteness(input: CreationCompletenessInput): boolean {
  if (!input.isFirstBuildTurn || input.isDiscussTurn) {
    return false;
  }

  if (input.aborted || input.alreadyContinued) {
    return false;
  }

  return input.emittedAction;
}

/**
 * The continuation prompt.
 *
 * Written so the COMPLETE case is cheap (a short closing message — which the brief already asks the
 * model to end with, so it reads as the natural end of the turn rather than as a bolted-on check) and
 * the INCOMPLETE case is unambiguous about finishing rather than re-explaining.
 *
 * ⚠️ The "do not rewrite files that are already correct" clause is load-bearing, not politeness: a
 * creation that re-emits its whole project costs a second creation's worth of output tokens (5x input
 * rate, decoded serially) and is the exact waste this pass is supposed to prevent elsewhere.
 */
export const CREATION_COMPLETION_PROMPT = [
  'Before you finish: check the project you just wrote against the brief, and against your own message.',
  '',
  'If anything you intended is missing or unfinished — the landing page, the game chrome, further game',
  'code, a registration you did not add, an import that resolves to nothing — write it NOW, in this',
  'reply. Do not describe it, do not apologise for it, and do not ask whether to continue: just finish',
  'the project. If one part cannot be completed, write everything else, then say plainly in one line',
  'what you could not do and why, so the user knows what is left.',
  '',
  'Do NOT rewrite files that are already correct — emit only what is missing or wrong.',
  '',
  'If the project is genuinely complete, write no files at all. Close the turn as the brief asks: two or',
  'three concrete next steps the user could take, plus the specific pieces of art this design would',
  'benefit from, so they know what to ask for next.',
].join('\n');
