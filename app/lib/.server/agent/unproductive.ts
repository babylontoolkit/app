/**
 * The turn that promised work and did none (SPEC §4.2.8 pathology 2, §4.6).
 *
 * ## The generation this exists for
 *
 * Measured live, `gen_ms0vcgq8_68vf4c` (2026-07-25), during an investor demo:
 *
 *     finishReason: "stop" · toolRounds: 0 · outTokens: 524 · textChars: 83 · 316 credits · "completed"
 *     "I'll load the bt-spec skill workflow so I follow it precisely, then draft the spec."
 *
 * The model announced a `load_skill` call, had no such tool (a preloaded turn closes the loop), and
 * stopped. 524 output tokens bought 83 characters — **0.16 chars per output token** — and the ledger
 * recorded a clean success. The user saw a chat that "just sits there", because the turn was not hung:
 * it was FINISHED, and it had done nothing.
 *
 * `!producedText` does not catch this: the model DID produce text. It produced a promise.
 *
 * ## Why this rescues rather than refunds
 *
 * A refund gives the user their credits and no spec. A second pass against an already-warm cached
 * prefix is cheap (a warm edit measures ~11 credits, `spec/billing.md`) and gives them the thing they
 * asked for. That is the same trade `shouldForceContinuation` already makes for the tool-cap case, and
 * this is its sibling: "the model stopped without answering" reached by a different road.
 *
 * It is bounded to ONE extra pass, and it never stacks with the forced continuation.
 *
 * ## Why these signals and NOT a prose classifier
 *
 * "Did the model merely promise?" is a question about English, and this repo does not let a language
 * model decide what a turn costs (`effort-policy.ts`: decide by turn KIND, never by reading the
 * prompt). Every signal below is mechanical and already measured for the step log:
 *
 *   - **no action tag** — a turn that wrote a file or ran a command did work, whatever it said;
 *   - **no tool calls** — a tool call is work, and the cap case belongs to `shouldForceContinuation`;
 *   - **tiny visible text** — below any plausible answer;
 *   - **density far below the floor** — `textChars / outTokens`, the metric §"The metric that went
 *     blind" was rewritten around. Real code runs ~2.0–2.9 ch/tok and prose ~3.5–4, so **under 1.0
 *     means the output was bought and not delivered**. This is the number that separates "a short
 *     correct answer" (few tokens, few chars, healthy ratio) from "we paid for thinking and got a
 *     sentence".
 *
 * ⚠️ **All four must hold.** Each alone has a legitimate shape: a one-line answer is short; a
 * think-heavy answer is dense-poor; a discussion turn writes no files. Only the conjunction describes
 * a turn that spent real money and delivered nothing.
 *
 * ⚠️ **A false positive costs one cheap continuation. A false NEGATIVE costs the user a whole
 * generation.** The thresholds are therefore set to fire late and rarely — a genuinely short answer
 * ("Yes — `globals.ts` already exports it.") stays under `MIN_BILLED_OUTPUT_TOKENS` and is left alone.
 * When in doubt this must do NOTHING: the turn is already billed either way, and a needless second
 * pass on every terse answer would be its own waste.
 */

/**
 * Visible text below this cannot be a delivered answer. Deliberately low — a real short answer must
 * pass, and the density test below is what actually discriminates.
 */
export const MIN_PRODUCTIVE_TEXT_CHARS = 240;

/**
 * Below this the turn is too cheap to be worth a second pass. It is also what keeps a terse-but-real
 * answer out: 30 output tokens of "Yes, that's already handled" is a fine turn, not a waste.
 */
export const MIN_BILLED_OUTPUT_TOKENS = 200;

/**
 * `textChars / outTokens`. Code measures ~2.0–2.9, prose ~3.5–4 (§"MEASURED"), so 1.0 sits far below
 * anything healthy — well clear of the code baseline, and nowhere near the 0.16 that triggered this.
 */
export const UNPRODUCTIVE_DENSITY = 1.0;

export interface UnproductiveTurnInput {
  /** A Stop is a user decision (§4.12) — never spend their credits again on top of it. */
  aborted: boolean;

  /** A forced continuation (or an earlier rescue) already ran. One extra pass per generation, ever. */
  alreadyContinued: boolean;

  /** The visible text contained a `<boltAction …>` — files written or a command run, i.e. real work. */
  emittedAction: boolean;

  /** Tool calls across every step. A tool call is work; the tool-CAP case is not ours. */
  toolCalls: number;

  /** Visible text characters, summed from the step log (`step.text`), not the raw stream. */
  textChars: number;

  /** Billed output tokens: thinking + tool JSON + text, as the provider reports them. */
  outTokens: number;

  /**
   * This turn is only complete if it WROTE something — a creation turn (§4.4b).
   *
   * The density/length test below asks "did the model announce work and stop"; it cannot see a turn
   * that did plenty of *writing* and none of it to disk. Measured 2026-07-27: a creation answered a
   * provider retry with **31,852 chars of prose and zero `<boltAction>`** — a full essay describing the
   * landing page, the code included, as text. Density 2.6 and length 31k both read as healthy, so the
   * rescue sat it out, the project never built, and the user was billed 50 credits for a description of
   * a game. Every existing signal said "productive"; the disk said otherwise.
   *
   * False for ordinary edits and plan turns, where a prose-only answer is often exactly right (and for
   * plan mode it is guaranteed — the §4.2.9 wall makes writing impossible).
   */
  requiresAction: boolean;

  /**
   * 🔴 THE MODEL WAS CUT OFF MID-ACTION — it opened `<boltAction` and never closed it.
   *
   * Measured live 2026-08-10 (`gen_msn0zl5h_44wpni`, 240 credits, $0.696): a Pac-Man rebuild wrote
   * 7,695 chars, opened exactly one artifact and one action, closed NEITHER, and ended mid-diff on the
   * literal text `>>>>>>> REPLACE`. The action runner only executes a CLOSED action, so no file was
   * touched. On screen: an artifact card with a title and no rows under it — indistinguishable from
   * "still thinking", except it was over.
   *
   * It was billed and not rescued, because `emittedAction` is `text.includes('<boltAction')` — the
   * OPENING tag. So the guard that exists to catch "announced work and did nothing" was switched off
   * by the announcement itself. This is the third or fourth time the owner has seen it, and it is
   * exactly the failure `spec/fail-loud.md` forbids: money spent, nothing delivered, nothing said.
   *
   * A truncated action is the STRONGEST possible signal for a second pass — stronger than the density
   * heuristics below, because there is no interpretation involved. The model did not decide to stop.
   */
  truncatedAction: boolean;
}

/**
 * Should this generation get ONE more pass to actually do what it announced?
 *
 * Pure and exhaustively tested, like `decidePremium` / `decideAutoRepair` / `shouldForceContinuation`:
 * a `true` here spends the user's credits without them asking for it.
 */
export function shouldRescueUnproductiveTurn(input: UnproductiveTurnInput): boolean {
  if (input.aborted || input.alreadyContinued) {
    return false;
  }

  /*
   * 🔴 AN OPENED-BUT-UNCLOSED ACTION IS THE OPPOSITE OF PRODUCTIVE — check it BEFORE `emittedAction`.
   *
   * `emittedAction` is `includes('<boltAction')`, so a truncated action sets it and used to return
   * false right here: the turn that most needs rescuing was the one the guard trusted most. Order
   * matters, and this must stay above the `emittedAction` bail — see `truncatedAction`.
   *
   * No density or length test: they ask "did it announce and stop?", and a cut-off action IS the
   * answer to that, mechanically and without interpretation.
   */
  if (input.truncatedAction) {
    return true;
  }

  if (input.emittedAction) {
    return false;
  }

  // Zero text is the EXISTING hard failure (refund, §4.6) — do not spend a second pass on silence.
  if (input.textChars <= 0 || input.outTokens < MIN_BILLED_OUTPUT_TOKENS) {
    return false;
  }

  /*
   * A turn that MUST write and wrote nothing is unproductive however eloquent it was, so the density
   * and length tests are skipped — they measure "announced and stopped", and this failure looks like
   * its opposite from the outside: long, dense, confident, and entirely on the floor.
   *
   * The tool-call exemption is skipped too, deliberately: a creation that called `generate_image` and
   * then described the page instead of building it has spent MORE, not less. A media call is not a
   * file write, and it must not buy the turn a pass.
   */
  if (input.requiresAction) {
    return true;
  }

  if (input.toolCalls > 0) {
    return false;
  }

  return input.textChars < MIN_PRODUCTIVE_TEXT_CHARS && input.textChars / input.outTokens < UNPRODUCTIVE_DENSITY;
}

/**
 * The corrective turn.
 *
 * Deliberately MODE-NEUTRAL: it says "complete the request", never "write the files". A plan-mode turn
 * (§4.2.9) is prose by guarantee and must stay prose — the tool policy and the `NO_REPLAY` annotation
 * still hold, and an instruction to write here would be arguing with a wall we deliberately built.
 *
 * It names the failure mode explicitly, because the observed behaviour is a model narrating a tool it
 * does not have: everything it needs is already in its context.
 */
export const UNPRODUCTIVE_RESCUE_PROMPT =
  'Your last response announced what you were going to do but did not do it, and the turn ended. ' +
  'You have no skill-loading tools this turn — everything you need is already in the context above, ' +
  'including any invoked skill. Do not describe your plan or say you are about to start: carry out ' +
  'the request now, completely, in this response.';

/**
 * 🔴 A BUILD TURN THAT WROTE NO FILES IS A FAILURE, EVEN AFTER THE RESCUES RAN (2026-08-07, §4.6).
 *
 * The rescue above is a SECOND CHANCE. This is the verdict when the second chance is gone, and the two
 * are not the same question — which is exactly how `gen_msixapaq_i871b6` billed **1,489 credits for
 * zero files** and recorded a clean `completed`:
 *
 *   1. the media tools consumed every step of a first build turn (fixed — `MAX_MEDIA_ROUNDS`);
 *   2. `shouldForceContinuation` fired and re-billed the whole ~212k prefix at the 2x write rate;
 *   3. the continuation returned 31 tokens and stopped;
 *   4. `shouldRescueUnproductiveTurn` refused — correctly! — because `alreadyContinued` was true;
 *   5. `!producedText` refused too, because text HAD been produced.
 *
 * Every guard behaved exactly as designed and the turn still settled as a success. `spec/fail-loud.md`
 * allows four terminal states for a paid request; "billed in full, wrote nothing, reported fine" is not
 * one of them.
 *
 * ⚠️ **Scoped to `requiresAction` turns and nothing else.** An ordinary edit may legitimately answer in
 * prose ("`globals.ts` already exports it"), a plan turn is prose *by guarantee* (§4.2.9 makes writing
 * impossible), and refunding either would be paying people to ask questions. It is the same predicate
 * the rescue already uses — `isFirstBuildTurn && !discussNote` — so the two can never disagree about
 * which turns owe files.
 *
 * ⚠️ **A Stop is not a failure** (§4.12): the user chose to end it, and the tokens burned to that point
 * are genuinely owed. Aborting is checked first for the same reason it is in the rescue.
 *
 * ⚠️ The false-positive direction here is REFUNDING A GENERATION THAT DID BUILD — the opposite of the
 * rescue's, whose worst case is one cheap extra pass. Hence `emittedAction` is tracked as a sticky flag
 * over the raw stream rather than sniffed from the length-capped recovery buffer.
 *
 * ## 🔴 `attemptedBuild` — why "this turn owed files" is not enough on its own
 *
 * `isFirstBuildTurn` means "this message carries the creation brief", and the brief is appended to
 * WHATEVER the user types first out of New Project mode. So the very first thing someone types can
 * legitimately be a QUESTION — *"can I use my own 3D models?"*, *"what does the play contract mean?"* —
 * and a correct prose answer to it writes no files by design. `requiresAction` alone cannot tell that
 * apart from a build that failed, and firing there would throw *"the build finished without writing any
 * project files"* over a good answer the user is looking straight at.
 *
 * The rescue tolerates that ambiguity because its worst case is one cheap pass. A terminal verdict
 * cannot, so this needs positive evidence the model was BUILDING:
 *
 *   - it opened a `<boltArtifact>` — a commitment to produce files, present in every build;
 *   - it called a tool — on a first build turn the only tools are the §4.16 media ones, i.e. it
 *     commissioned art for a game it then did not write (the more expensive failure, not a lesser one);
 *   - a forced continuation ran — which fires only when the model's last act was a tool call
 *     (`shouldForceContinuation`), so it is build-shaped by construction.
 *
 * ⚠️ **`unproductiveRescue` is deliberately NOT evidence.** It fires on any first-turn prose, questions
 * included — so counting it would let the rescue manufacture the very proof this test demands, and the
 * question case would fail on the second pass instead of the first. Evidence has to come from the
 * MODEL's behaviour, never from our own reaction to it.
 */
export function isFailedBuildTurn(input: {
  aborted: boolean;
  requiresAction: boolean;
  emittedAction: boolean;
  attemptedBuild: boolean;
}): boolean {
  return !input.aborted && input.requiresAction && input.attemptedBuild && !input.emittedAction;
}

/**
 * What the user is told, and it has to be honest about the money.
 *
 * `failed` routes this to the §4.6 auto-refund, so by the time anyone reads it the credits are already
 * back. Saying so is the whole point: the failure this describes previously presented as a completed
 * generation, and a user who has just watched a build produce nothing needs to know the charge did not
 * stick before they go looking at their balance.
 *
 * ⚠️ Worded so it does NOT match `retry-policy.ts`'s `/returned an empty response/i` — deliberately, and
 * pinned. A turn reaching here has already had a forced continuation AND a rescue; a third automatic
 * stream against the same prompt is precisely the waste this whole change exists to stop. Retrying is
 * the user's call, and it is one click.
 */
export const NO_FILES_WRITTEN_ERROR =
  'The build finished without writing any project files, so nothing was created. ' +
  'You have not been charged for this attempt — the credits have been refunded. Please try again.';
