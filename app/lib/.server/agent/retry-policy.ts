/**
 * Should a generation that BROKE be attempted once more? (SPEC §4.2, §4.6)
 *
 * A PURE function, like `shouldForceContinuation` / `decidePremium` / the auto-repair gate, and for
 * the same reason: a `true` here re-runs a generation the user did not ask for, so both failure modes
 * cost real money. Retrying what should not be retried double-bills; refusing what should be retried
 * hands the user a 146-second wait and an error where the product should have worked.
 *
 * ## The failure this exists for, measured live
 *
 * `/bt-landing redesign the landing page …` — step 1 commissioned four images (99s), step 2 thought
 * for 47s, and then the PROVIDER returned `Internal error, please try again later`. The generation
 * died at 146s having recorded `0 in / 0 out`, `finish=error`, and the user saw three dots and then
 * a failure. The same run was the only one in the log served by a backend reporting NEITHER a cache
 * read NOR a cache write, at 14 tok/s against a normal 42–57 — i.e. an unhealthy backend, nothing to
 * do with the request. It is exactly the class of failure a retry is for.
 *
 * ## Why retrying is nearly free here, and why that is load-bearing
 *
 * `drain` accumulates usage only AFTER its `fullStream` loop completes, so a generation that throws
 * mid-stream records ZERO tokens. `outTokens === 0` therefore means "we billed the user nothing",
 * which is what makes a second attempt honest rather than a double charge.
 *
 * ⚠️ It does NOT mean "nothing was spent" — the provider still consumed step 1. That cost is ours
 * either way; the point is that the LEDGER has nothing to reverse and the user cannot be charged twice.
 *
 * ⚠️ **NOR does it mean the user's screen is empty** — an earlier draft of this comment claimed it
 * did, and a live creation disproved it: the model streamed a reasoning trace AND a design paragraph,
 * the socket died, and `outTokens` was still `0` because no step had completed. `outTokens` is a
 * LEDGER signal, never a screen signal. Retrying anyway is the deliberate choice: the alternative on
 * that run was an error message and a project with no landing page, and a slightly repeated preamble
 * is a far better outcome than a dead generation. The guard still does its real job — it refuses a
 * retry once a step has completed and been billed.
 *
 * ## The conditions, each of which has to be there
 *
 *  - **An abort is never retried.** A Stop is a user decision (§4.12) and a closed tab is a user
 *    leaving. Re-running either spends credits for someone who is no longer watching.
 *  - **Zero output only.** If the model already streamed part of an artifact, the user has half a
 *    file on screen; a retry would append a second, different attempt to it.
 *  - **Bounded, not once.** See `MAX_PROVIDER_RETRY_ATTEMPTS` — the original "once" was calibrated for
 *    a provider having an occasional bad minute, and the measured failure is not that.
 *  - **Provider-side errors only.** A 4xx is our request being wrong and will be wrong again;
 *    `429` in particular needs backoff, not an immediate second helping of the same request.
 */

/**
 * Retryable provider-side failures. Matched on the message because `ai@4` erases most error types.
 *
 * Two families, and the second was missing until a live creation died on it:
 *
 *  - **The provider answered with a failure** — `internal error`, `overloaded`, a 5xx.
 *  - **The provider stopped answering mid-body** — undici's `TypeError: terminated`, plus the
 *    socket-level errors that mean the same thing. This is NOT a variant of the first: nothing is
 *    returned to match on, the HTTP response was already `200`, and the stream simply ends. A
 *    creation that had commissioned three images and streamed 139s of an artifact died exactly here,
 *    and the retry sat it out because the word `terminated` resembles nothing above.
 */
const RETRYABLE = [
  /internal error/i,
  /overloaded/i,
  /service unavailable/i,
  /bad gateway/i,
  /\b5\d\d\b/,
  /terminated/i,
  /socket hang up/i,
  /premature close/i,
  /connection closed/i,
  /ECONNRESET/,
  /EPIPE/,
  /fetch failed/i,

  /*
   * 🔴 HARVESTED FROM LIVE KIE PROBES, 2026-08-04 (T11) — and NOT reachable via the `\b5\d\d\b` rule.
   *
   * KIE's gateway reports faults with **HTTP 200 and a JSON envelope** — `{"code":500,"msg":"..."}` —
   * so the status line carries no 5xx and the digits live in a `code` field, not in the message text.
   * Every pattern above would miss these:
   *
   *   "Server exception, please try again later"                          (the dominant fault; seen on
   *                                                                        claude AND gemini surfaces)
   *   "The server is currently being maintained, please try again later~" (codex; note the trailing ~)
   *   "Internal error, please try again later"                            (already matched, above)
   *
   * Checked against FATAL below, as the plan requires: neither new string contains `invalid` or
   * `not found`, so neither is swallowed by those broad patterns.
   */
  /server exception/i,
  /being maintained/i,

  /*
   * ⚠️ OUR OWN message (`EMPTY_RESPONSE_ERROR`), and — stated plainly — **UNREACHABLE FROM PRODUCTION
   * TODAY**. Defence-in-depth, exactly like `/does not exist/i` below, not a live behaviour change.
   *
   * Measured 2026-08-04 by replaying KIE's exact 200-plus-envelope shape through the real SDKs: on
   * ALL THREE families it **raises no error at all**. The SDK sees a 200, finds no SSE events in the
   * body, and finishes cleanly with empty text and `finishReason: 'unknown'`. So the two patterns
   * above are never consulted for the most common KIE failure there is; what catches it is the
   * `!producedText` guard in `proxy.ts`, which throws this sentence, marks the generation `failed`
   * and refunds.
   *
   * 🔴 **But that throw sits AFTER the retry loop closes**, so `shouldRetryGeneration` never sees it.
   * An earlier draft of this comment claimed matching it here "upgrades the outcome from an error card
   * to a quiet retry" — that was FALSE as wired, and a false claim in a comment is how a defect
   * survives review in this repo (the shell-strip and `/does not exist/i` are the same lesson).
   *
   * It is kept because the CLASSIFICATION is correct and worth pinning: an empty response that billed
   * nothing is a transient provider fault. **Moving the `!producedText` check inside the retry loop is
   * a real behaviour change with its own money implications and belongs in its own task**, not here.
   *
   * 🔴 If that is ever done, it is safe ONLY because of the `outTokens > 0` gate in
   * `shouldRetryGeneration`. The other generation that produces this message is the one in `proxy.ts`'s
   * comment — a clean `stop` with no text and **10,054 output tokens billed**. That one has
   * `outTokens > 0`, so it would still be refused a retry and refunded. The distinction is not in the
   * message; it is in whether anything was billed.
   */
  /returned an empty response/i,
];

/**
 * Never retryable, whatever else the message says — checked FIRST so `429` can't match a 5xx pattern.
 *
 * `does not exist` is the 2026-08-04 harvest's fatal shape: KIE answers an UNKNOWN MODEL ID (or an
 * unknown endpoint) with `{"code":500,"msg":"The page does not exist"}` — a 500 code on a request that
 * will be wrong every time. It matches neither `not found` nor `\b4\d\d\b`.
 *
 * ⚠️ **DEFENCE-IN-DEPTH, not load-bearing today — mutation-verified, so the comment says so.** Deleting
 * this entry currently fails NO test, because no RETRYABLE pattern matches the string either: the 500
 * lives in the envelope's `code` field and never in the message text, so the function already returns
 * false by falling off the end. An earlier draft of this comment claimed a typo in `LLM_MODEL` would
 * otherwise burn all three attempts; that was wrong, and a false claim in a comment is how a defect
 * survives review here. What the entry actually buys is protection against a FUTURE broader transient
 * pattern — most obviously anyone matching the envelope's numeric `code`, which is the exact trap the
 * harvested-strings note above describes.
 */
const FATAL = [
  /\b4\d\d\b/i,
  /rate limit/i,
  /too many requests/i,
  /invalid/i,
  /not found/i,
  /unauthorized/i,
  /does not exist/i,
];

/**
 * How many times a generation may be re-attempted after a provider-side failure that billed nothing.
 *
 * ## Why this is 3 and not 1 — measured 2026-07-27, three failures in half an hour
 *
 * The step log says exactly what is happening, and it is not "the provider had a bad minute":
 *
 *     step 1:  28,956ms ·      0 out                        → Internal error
 *     step 1:  31,532ms ·      0 out                        → Internal error
 *     step 3:  30,058ms ·      0 out                        → Internal error
 *     step 2: 114,765ms ·    615 out · 4 tool calls         → fine
 *     step 2: 161,768ms · 12,215 out                        → fine
 *
 * **Every step that emitted no bytes for ~30s died; every step that emitted anything ran for minutes.**
 * That is a gateway killing a silent stream, not a sick model — and it compounds with KIE's own
 * empty-thinking regression (`kie-wire.ts`): their adapter returns thinking text EMPTY, so during a
 * long think there are literally no bytes on the wire, and their timeout fires on the request they are
 * themselves buffering. A creation turn thinks the longest, which is why it is hit the hardest.
 *
 * A single retry therefore fails against a ~30s coin flip that lands the wrong way often. Each attempt
 * costs ~30 seconds and **zero credits** (`outTokens === 0` is the gate — a step that completed and
 * billed is never re-run), so the honest trade is a few more tries rather than handing the user an
 * error on a project that is otherwise fine.
 *
 * ⚠️ This is a MITIGATION for someone else's defect, not a fix, and it must stay bounded: three
 * attempts is ~90s of dead time in the worst case, which is the most a user should ever wait to be
 * told it did not work. Raise it only with a measurement, never on a hunch.
 */
export const MAX_PROVIDER_RETRY_ATTEMPTS = 3;

/**
 * The sentence `proxy.ts` throws when a generation produced no text at all (its `!producedText` guard).
 *
 * Exported as a CONSTANT because `RETRYABLE` matches a substring of it, and the two used to be
 * independently-typed literals in two files: a reword in `proxy.ts` would have silently stopped the
 * pattern matching, and no test would have failed — the specs asserted against their own copies of the
 * string, so all three could drift apart while staying green. One writer, imported by the thrower and
 * by the spec.
 *
 * ⚠️ It is USER-FACING copy (it renders on the error card with Retry), so it is worded for a person,
 * not for a matcher. `RETRYABLE`'s pattern deliberately keys on the stable middle clause rather than
 * the whole sentence, so the surrounding reassurance can be reworded without breaking the match.
 */
export const EMPTY_RESPONSE_ERROR =
  'The model returned an empty response. You have not been charged for this generation — please try again.';

export interface RetryDecisionInput {
  /** The error that killed the stream. */
  error: unknown;

  /** Output tokens RECORDED for this generation. Non-zero means the user already has partial work. */
  outTokens: number;

  /** The user stopped it, or closed the tab (§4.12) — never our call to re-run. */
  aborted: boolean;

  /** How many times this generation has already been retried. */
  attempts: number;
}

/**
 * What the RETRY may use — and why this is not simply "tool-free, always" (2026-07-27, measured live).
 *
 * The tool-free retry exists to stop a second attempt re-commissioning media that the FIRST attempt
 * already debited and started. That reason is real, and it is also **conditional on renders having
 * actually started** — which the original code never checked. Observed on a live creation: KIE answered
 * `Internal error, please try again later` at 29s, before a single tool call, so nothing had been
 * commissioned and there was nothing to protect. The retry withdrew the media tools anyway, and the
 * model — mid-creation, holding a brief that tells it to generate the hero art first — did the only
 * thing it could: it narrated the absence ("I don't have the generate_image or generate_video tools
 * available in this session") and wrote 12,215 tokens of prose describing a landing page instead of
 * building one. The user paid 50 credits for an essay, and the project never built.
 *
 * So the rule is: **strip capabilities only to protect money already spent.**
 *
 *  - Nothing started → retry with EXACTLY the first attempt's policy. Nothing has been paid for, so
 *    there is nothing to double-buy, and a creation turn that cannot generate art is not the turn the
 *    user asked for.
 *  - Something started → genuinely tool-free, and the caller passes the already-started paths in a
 *    system note so the model can reference them without asking for them again.
 *
 * ⚠️ "Tool-free" must mean the definitions are GONE, not merely forbidden. Passing the tool set with
 * `toolChoice: 'none'` leaves `generate_image` visible in the request while refusing every call — which
 * is precisely the state that produced the narration above. A model can see a tool it may not call, and
 * it will tell the user about it.
 */
/**
 * Should THIS retry run with extended thinking disabled? (§4.2a, measured 2026-07-27)
 *
 * ## The mechanism, not the symptom
 *
 * KIE kills any step that emits no bytes for ~30s. An extended think IS that silence: their adapter
 * forwards thinking text on only ~14% of requests (both models — it tracks the BACKEND, not the model),
 * so on the other 86% a long think puts literally nothing on the wire and their own gateway times out
 * the request they are buffering. Retrying is a dice roll against the same window. Disabling thinking is
 * not: the model starts emitting text within a second or two, the stream is never quiet, and the timeout
 * cannot fire.
 *
 * ## Why the end of the ladder and not everywhere
 *
 * Because thinking is worth having, and the reasoning text — when a backend does forward it — is worth
 * reading. The tempting version of this idea is "if the stream goes quiet, drop thinking", and that would
 * eat the reasoning on exactly the long thinks whose reasoning has the most in it, on every generation.
 * Scoped to the end rather than everywhere, so the common path keeps its reasoning: a turn that loses
 * thinking is one where the silent think has ALREADY killed the generation more than once. You cannot
 * lose reasoning text on a turn that was about to die.
 *
 * ⚠️ HOW MANY retries keep thinking is NOT stated here, and that is deliberate. Every wrong version of
 * this comment was a count: "attempts 1 and 2 are byte-identical", then "the earlier retries are
 * byte-identical", which is the same claim with the digits removed and was written by the pass that
 * corrected the first one. `retry-policy.spec.ts` holds the sequence — including the one the CALL SITE
 * produces — because a sequence in a test can fail and a sequence in a sentence cannot.
 *
 * 🔴 **THE PARAMETER IS A 1-BASED RETRY NUMBER, AND THE UNITS ARE WHY THIS WAS WRONG UNTIL 2026-08-21.**
 *
 * It shipped as `attempt >= maxAttempts - 1` reading a 0-based index, while `proxy.ts` called it with
 * `attempt + 1` from a loop counting the attempt that had just FAILED — so the values were 1,2,3 against
 * a threshold of 2, and the modes were adaptive, **disabled, disabled**: the last TWO retries rather than
 * the last one, on a mitigation whose entire justification is that the common path keeps its reasoning.
 * Nobody chose that. It fell out of two functions disagreeing about what the number COUNTED, and every
 * document describing the behaviour was accurate about the intent and false about the code — which is
 * how eight copies of one sentence were all wrong in the same way.
 *
 * Fixed by making the unit explicit rather than by moving the `+ 1`: `retryNumber` is which retry is
 * about to run (1st, 2nd, 3rd) and `maxRetries` is how many there are, so the comparison is between two
 * numbers of the same kind and there is no `- 1` left for an off-by-one to live in. ⚠️ The call site is
 * pinned as well as the function — a contract this one satisfied while its only caller did not is
 * exactly what a function-only spec cannot see.
 *
 * The trade on that last retry is real and deliberate: no extended thinking is a weaker build (that is
 * why `low` effort is banned outright — an under-thinking model returns a confident WRONG answer, not a
 * smaller correct one). It is still better than a red error card and no game, which is the alternative it
 * replaces — and it never runs on a healthy generation.
 *
 * ⚠️ The caller MUST clamp with `canDisableThinking(model, effort)`: Fable 5 rejects `{type:'disabled'}`
 * outright and Opus 5 rejects it above `high`, so an unclamped "disabled" trades one failure for a 400 on
 * the retry that had already failed twice — the worst possible moment, exactly as
 * `THINKING_DISABLED_EFFORT_CEILING` warns.
 */
export function retryThinkingMode(
  retryNumber: number,
  maxRetries = MAX_PROVIDER_RETRY_ATTEMPTS,
): 'adaptive' | 'disabled' {
  return retryNumber >= maxRetries ? 'disabled' : 'adaptive';
}

export type RetryToolMode = 'same-as-first' | 'tool-free';

export function retryToolMode(startedMediaCount: number): RetryToolMode {
  return startedMediaCount > 0 ? 'tool-free' : 'same-as-first';
}

export function shouldRetryGeneration(input: RetryDecisionInput): boolean {
  if (input.aborted || input.attempts >= MAX_PROVIDER_RETRY_ATTEMPTS || input.outTokens > 0) {
    return false;
  }

  const message = (input.error as Error)?.message ?? String(input.error ?? '');

  if (!message || FATAL.some((pattern) => pattern.test(message))) {
    return false;
  }

  return RETRYABLE.some((pattern) => pattern.test(message));
}
