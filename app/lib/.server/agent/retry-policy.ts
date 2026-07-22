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
 *  - **Once.** A provider having a genuinely bad time will fail twice, and the second failure costs
 *    the user another wait for the same error.
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

export function shouldRetryGeneration(input: RetryDecisionInput): boolean {
  if (input.aborted || input.attempts >= 1 || input.outTokens > 0) {
    return false;
  }

  const message = (input.error as Error)?.message ?? String(input.error ?? '');

  if (!message || FATAL.some((pattern) => pattern.test(message))) {
    return false;
  }

  return RETRYABLE.some((pattern) => pattern.test(message));
}
