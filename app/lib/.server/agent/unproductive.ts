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
}

/**
 * Should this generation get ONE more pass to actually do what it announced?
 *
 * Pure and exhaustively tested, like `decidePremium` / `decideAutoRepair` / `shouldForceContinuation`:
 * a `true` here spends the user's credits without them asking for it.
 */
export function shouldRescueUnproductiveTurn(input: UnproductiveTurnInput): boolean {
  if (input.aborted || input.alreadyContinued || input.emittedAction) {
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
