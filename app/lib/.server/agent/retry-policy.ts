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
];

/** Never retryable, whatever else the message says — checked FIRST so `429` can't match a 5xx pattern. */
const FATAL = [/\b4\d\d\b/i, /rate limit/i, /too many requests/i, /invalid/i, /not found/i, /unauthorized/i];

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
 * Should THIS retry attempt run with extended thinking disabled? (§4.2a, measured 2026-07-27)
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
 * ## Why ONLY the last attempt
 *
 * Because thinking is worth having, and the reasoning text — when a backend does forward it — is worth
 * reading. The tempting version of this idea is "if the stream goes quiet, drop thinking", and that would
 * eat the reasoning on exactly the long thinks whose reasoning has the most in it, on every generation.
 * Scoped to the final attempt, the common path is untouched: attempts 1 and 2 are byte-identical to what
 * ships today, and the only turn that loses thinking is one where the silent think has ALREADY killed the
 * generation twice. You cannot lose reasoning text on a turn that was about to die.
 *
 * The trade on that last attempt is real and deliberate: no extended thinking is a weaker build (that is
 * why `low` effort is banned outright — an under-thinking model returns a confident WRONG answer, not a
 * smaller correct one). It is still better than a red error card and no game, which is the alternative it
 * replaces — and it never runs on a healthy generation.
 *
 * ⚠️ The caller MUST clamp with `canDisableThinking(model, effort)`: Fable 5 rejects `{type:'disabled'}`
 * outright and Opus 5 rejects it above `high`, so an unclamped "disabled" trades one failure for a 400 on
 * the attempt that had already failed twice — the worst possible moment, exactly as
 * `THINKING_DISABLED_EFFORT_CEILING` warns.
 */
export function retryThinkingMode(attempt: number, maxAttempts = MAX_PROVIDER_RETRY_ATTEMPTS): 'adaptive' | 'disabled' {
  return attempt >= maxAttempts - 1 ? 'disabled' : 'adaptive';
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
