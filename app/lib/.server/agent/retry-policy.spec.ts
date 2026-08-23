/**
 * Money tests. A `true` here re-runs a generation nobody asked for; a `false` hands the user a long
 * wait and an error where the product should have worked.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_RESPONSE_ERROR,
  MAX_PROVIDER_RETRY_ATTEMPTS,
  retryThinkingMode,
  retryToolMode,
  shouldRetryGeneration,
} from './retry-policy';

const base = { error: new Error('Internal error, please try again later'), outTokens: 0, aborted: false, attempts: 0 };

describe('shouldRetryGeneration', () => {
  /* The measured failure: /bt-landing died at 146s with 0 tokens on a provider internal error. */
  it('retries a provider internal error that produced nothing', () => {
    expect(shouldRetryGeneration(base)).toBe(true);
  });

  it.each(['Overloaded', 'Service Unavailable', 'Bad Gateway', 'upstream returned 503'])(
    'retries the other provider-side failures (%s)',
    (message) => {
      expect(shouldRetryGeneration({ ...base, error: new Error(message) })).toBe(true);
    },
  );

  /*
   * The live creation failure this family was added for: three images commissioned, 139s of artifact
   * streamed, then KIE dropped the socket. `TypeError: terminated` resembles none of the messages
   * above — the HTTP response was already 200 and there is no provider error text to match — so the
   * retry sat it out and the user got "Custom error: terminated" and no landing page.
   */
  it.each(['terminated', 'socket hang up', 'Premature close', 'read ECONNRESET', 'fetch failed'])(
    'retries a connection that died mid-stream (%s)',
    (message) => {
      expect(shouldRetryGeneration({ ...base, error: new Error(message) })).toBe(true);
    },
  );

  /* undici throws a bare `TypeError`, not an `Error` — the message is all we get. */
  it('retries undici TypeError: terminated exactly as thrown', () => {
    expect(shouldRetryGeneration({ ...base, error: new TypeError('terminated') })).toBe(true);
  });

  /*
   * A Stop is a user decision (§4.12), and a closed tab is a user who left. Re-running either spends
   * credits on behalf of someone who is not watching.
   */
  it('never retries an abort', () => {
    expect(shouldRetryGeneration({ ...base, aborted: true })).toBe(false);
  });

  /*
   * Partial output means the user already has half an artifact on screen; a retry would append a
   * second, different attempt to it — and those tokens were recorded, so they were billed.
   */
  it('never retries once output was recorded', () => {
    expect(shouldRetryGeneration({ ...base, outTokens: 1 })).toBe(false);
  });

  /**
   * Bounded, not once (2026-07-27). The measured failure is a gateway killing any step that emits no
   * bytes for ~30s (28.9s / 31.5s / 30.1s, all zero-output, while every step that emitted something ran
   * for minutes) — a coin flip that one retry loses too often. Each attempt costs ~30s and zero credits.
   */
  it('keeps retrying up to the bound while nothing has been billed', () => {
    expect(shouldRetryGeneration({ ...base, attempts: 1 })).toBe(true);
    expect(shouldRetryGeneration({ ...base, attempts: MAX_PROVIDER_RETRY_ATTEMPTS - 1 })).toBe(true);
  });

  /** …and stops there. Three attempts is ~90s of dead time, the most a user should wait to be told no. */
  it('stops at the bound — a sick provider must not be retried forever', () => {
    expect(shouldRetryGeneration({ ...base, attempts: MAX_PROVIDER_RETRY_ATTEMPTS })).toBe(false);
    expect(shouldRetryGeneration({ ...base, attempts: MAX_PROVIDER_RETRY_ATTEMPTS + 5 })).toBe(false);
  });

  /**
   * THE MONEY GATE, and it outranks the bound: the moment a step has completed and been billed, a
   * retry would charge the user twice for one request. Zero output is what makes retrying honest.
   */
  it('never retries once output has been billed, at any attempt count', () => {
    expect(shouldRetryGeneration({ ...base, attempts: 0, outTokens: 1 })).toBe(false);
    expect(shouldRetryGeneration({ ...base, attempts: 1, outTokens: 615 })).toBe(false);
  });

  /*
   * 429 is the one that must NOT slip through: it contains a 3-digit number and would otherwise match
   * the 5xx pattern. It needs backoff, not an immediate identical retry. Hence FATAL is checked first.
   */
  it('never retries a rate limit or any 4xx', () => {
    expect(shouldRetryGeneration({ ...base, error: new Error('HTTP 429 Too Many Requests') })).toBe(false);
    expect(shouldRetryGeneration({ ...base, error: new Error('rate limit exceeded') })).toBe(false);
    expect(shouldRetryGeneration({ ...base, error: new Error('400 invalid request') })).toBe(false);
    expect(shouldRetryGeneration({ ...base, error: new Error('401 unauthorized') })).toBe(false);
  });

  /*
   * The new connection family must not become a bypass for FATAL. A rate-limited request whose socket
   * is then closed still needs backoff, not an immediate second helping.
   */
  it('still refuses a 4xx even when the message also mentions a dead connection', () => {
    expect(shouldRetryGeneration({ ...base, error: new Error('HTTP 429 — connection closed') })).toBe(false);
    expect(shouldRetryGeneration({ ...base, error: new Error('401 unauthorized, socket hang up') })).toBe(false);
  });

  it('does not retry an unrecognised error — retry is opt-in, never the default', () => {
    expect(shouldRetryGeneration({ ...base, error: new Error('something weird happened') })).toBe(false);
    expect(shouldRetryGeneration({ ...base, error: undefined })).toBe(false);
    expect(shouldRetryGeneration({ ...base, error: new Error('') })).toBe(false);
  });
});

/**
 * HARVESTED FROM LIVE KIE PROBES, 2026-08-04 (T10/T11) — real measured strings, not documentation.
 *
 * KIE's gateway reports faults with **HTTP 200 and a JSON envelope** (`{"code":N,"msg":"…"}`), so the
 * status line carries no 5xx and the digits sit in a `code` field the message text never shows. Every
 * status-shaped pattern in `RETRYABLE` misses them, which is why they are matched on their own words.
 */
const HARVESTED_TRANSIENT = [
  /* The dominant fault — seen on the claude AND gemini surfaces. */
  'Server exception, please try again later',

  /* codex; note the trailing tilde, which is theirs and must not be relied on. */
  'The server is currently being maintained, please try again later~',

  /* Already covered by /internal error/i — kept here so the harvest is asserted in full. */
  'Internal error, please try again later',
];

/**
 * The fatal half of the same harvest. Both are requests that will be exactly as wrong next time.
 *
 * `The page does not exist` is KIE's answer to an UNKNOWN MODEL ID, and its envelope `code` is **500** —
 * so anything reasoning from "5xx means transient" would burn every retry attempt on a typo in
 * `LLM_MODEL`. It is fatal because of what it says, never because of the number beside it.
 */
const HARVESTED_FATAL = [
  'The page does not exist',
  'Unauthorized – Authentication failed. Please check that your Authorization and Content-Type headers are correctly set.',
];

describe('shouldRetryGeneration — the 2026-08-04 KIE harvest', () => {
  it.each(HARVESTED_TRANSIENT)('retries the harvested transient fault (%s)', (message) => {
    expect(
      shouldRetryGeneration({ ...base, error: new Error(message), outTokens: 0, aborted: false, attempts: 0 }),
    ).toBe(true);
  });

  it.each(HARVESTED_FATAL)('never retries the harvested fatal fault (%s)', (message) => {
    expect(
      shouldRetryGeneration({ ...base, error: new Error(message), outTokens: 0, aborted: false, attempts: 0 }),
    ).toBe(false);
  });

  /**
   * FATAL is checked FIRST and holds two deliberately broad patterns, `/invalid/i` and `/not found/i`.
   * A transient string that happened to contain either word would be silently refused a retry forever —
   * so the harvest is asserted against those two patterns directly, not merely by outcome.
   */
  it.each(HARVESTED_TRANSIENT)("is not swallowed by FATAL's broad patterns (%s)", (message) => {
    expect(/invalid/i.test(message)).toBe(false);
    expect(/not found/i.test(message)).toBe(false);
  });

  /* The pre-existing refusals still outrank a harvested transient string — nothing here is a bypass. */
  it('still refuses a harvested transient fault when aborted or out of attempts', () => {
    const error = new Error('Server exception, please try again later');
    expect(shouldRetryGeneration({ ...base, error, aborted: true })).toBe(false);
    expect(shouldRetryGeneration({ ...base, error, attempts: MAX_PROVIDER_RETRY_ATTEMPTS })).toBe(false);
  });
});

/**
 * THE `outTokens` DISCRIMINATOR — the safety property that makes `/returned an empty response/i` safe.
 *
 * One sentence, thrown by `proxy.ts`'s `!producedText` guard, covers two completely different events:
 *
 *  - KIE answered 200 with a fault envelope and no SSE body at all. The SDK raises nothing, finishes
 *    cleanly with empty text, and **nothing was billed**.
 *  - The model returned a clean `stop` with no text and **10,054 output tokens billed** — the pathology
 *    in `proxy.ts`'s comment, which must be refunded and never re-run.
 *
 * The distinction is NOT in the message; the two are byte-identical. It is entirely in whether anything
 * was billed, which is the one question that decides whether a second attempt is honest or a double charge.
 */
describe('shouldRetryGeneration — the empty-response message is decided by billing, not by wording', () => {
  const EMPTY_RESPONSE = EMPTY_RESPONSE_ERROR;

  it('retries when nothing was billed (the KIE 200-envelope case)', () => {
    expect(shouldRetryGeneration({ error: new Error(EMPTY_RESPONSE), outTokens: 0, aborted: false, attempts: 0 })).toBe(
      true,
    );
  });

  it('refuses the SAME message once output was billed (the clean-stop case — refund, never re-run)', () => {
    expect(
      shouldRetryGeneration({ error: new Error(EMPTY_RESPONSE), outTokens: 10054, aborted: false, attempts: 0 }),
    ).toBe(false);
  });
});

/**
 * What the retry is ALLOWED to use. This is the half that was wrong in production (2026-07-27).
 *
 * A creation turn hit `Internal error, please try again later` at 29s — before a single tool call —
 * and the retry withdrew the media tools anyway, because "tool-free" was unconditional. The model,
 * holding a brief that tells it to generate the hero art first, announced that it did not have
 * `generate_image`/`generate_video` and wrote 12,215 tokens of prose about a landing page instead of
 * building one. The user paid 50 credits and got no project.
 */
describe('retryToolMode', () => {
  /**
   * THE LOAD-BEARING ONE. Nothing was commissioned, so nothing can be double-bought — the protection
   * has no subject, and applying it anyway silently downgrades the turn the user paid for.
   */
  it("keeps the first attempt's tools when no render was ever started", () => {
    expect(retryToolMode(0)).toBe('same-as-first');
  });

  /**
   * The reason the tool-free path exists at all: those renders are DEBITED and running, so re-offering
   * the tools buys the whole set a second time. One started render is enough to justify it.
   */
  it('goes tool-free the moment a render has been paid for', () => {
    expect(retryToolMode(1)).toBe('tool-free');
    expect(retryToolMode(4)).toBe('tool-free');
  });
});

/**
 * The last-resort attempt drops extended thinking, because the SILENCE is the failure (§4.2a).
 *
 * KIE kills any step that emits no bytes for ~30s; their adapter forwards thinking text on only ~14% of
 * requests (measured across 28 generations, both models), so on the rest a long think is pure silence
 * into their own timeout. Disabling thinking makes text start flowing immediately, which the timeout
 * cannot fire against.
 */
/**
 * 🔴 THE SEQUENCE THE CALL SITE ACTUALLY PRODUCES — because every prose copy of this got it wrong.
 *
 * `retryThinkingMode` takes a 1-BASED retry number, which is what `proxy.ts` passes (`attempt + 1`,
 * where `attempt` is the 0-based index of the attempt that just failed). Those two disagreed about
 * the unit until 2026-08-21 — a 0-based reader against a 1-based caller — and the product silently
 * ran `adaptive, disabled, disabled`: thinking off for the last TWO retries, on a mitigation whose
 * whole justification is that the common path keeps its reasoning.
 *
 * The function's own spec was green throughout, because it asserted the contract the function
 * implemented; nothing asserted the sequence the ONLY CALLER produced. That is the generalisable
 * part — **a function-only spec cannot see a caller whose units are wrong**, and this defect is
 * precisely a units disagreement across a seam that both sides documented correctly in isolation.
 *
 * Many places said "only the last", all copied from one doc comment: `retry-policy.ts`, `proxy.ts`,
 * `CLAUDE.md`, `spec/anthropic-models.md`, `base-provider.ts`, `providers/anthropic.ts`, this file
 * and two `_specs` documents. Nine rounds of adversarial review corrected them one at a time and
 * each sweep missed the copy that had reworded itself — including one "fix" that removed the digits
 * and kept the claim. So the sequence is asserted HERE, where it can fail, and the prose says none
 * of it.
 */
describe('the sequence the CALL SITE produces (proxy.ts passes attempt + 1)', () => {
  /** Exactly `proxy.ts`'s expression, so this describe fails if the call site's units drift again. */
  const asCalledByProxy = (loopAttempt: number) => retryThinkingMode(loopAttempt + 1);

  it('keeps thinking until the final retry', () => {
    expect([0, 1, 2].map(asCalledByProxy)).toEqual(['adaptive', 'adaptive', 'disabled']);
  });

  /*
   * THE REGRESSION, recorded as the thing this is NOT. A 0-indexed reader (`>= max - 1`) against
   * this 1-based caller is what shipped, and it is the single most likely way to reintroduce the
   * defect — so it is asserted as false rather than described in a sentence.
   */
  it('is NOT adaptive, disabled, disabled — that was the units bug, not a policy', () => {
    expect([0, 1, 2].map(asCalledByProxy)).not.toEqual(['adaptive', 'disabled', 'disabled']);
  });

  /*
   * THE CONTROL. Without it, "keeps thinking until the final retry" also passes for a function that
   * returns `adaptive` for everything — i.e. for the mitigation having been deleted outright, which
   * is the cheerful way a fix in this direction goes green while removing the guard.
   */
  it('CONTROL — the final retry really does turn thinking off', () => {
    expect(asCalledByProxy(MAX_PROVIDER_RETRY_ATTEMPTS - 1)).toBe('disabled');
  });

  /*
   * 🔴 AND THE CALL SITE IS READ FROM SOURCE, not re-typed above.
   *
   * `asCalledByProxy` is a COPY of `proxy.ts`'s expression, so on its own it pins a sequence this
   * file believes the caller produces — which is the same shape as the defect: a contract asserted
   * on one side of a seam while the other side quietly disagrees. Reading the real line is what
   * makes the pin about the product rather than about this file's memory of it.
   */
  it('proxy.ts really passes attempt + 1 — the units this describe assumes', () => {
    const proxy = readFileSync(join(process.cwd(), 'app/lib/.server/agent/proxy.ts'), 'utf8');

    /* The CONTROL: if the symbol ever moves or is renamed, the assertion below must not go vacuous. */
    expect(proxy).toContain('retryThinkingMode');
    expect(proxy).toContain('retryThinkingMode(attempt + 1)');
  });
});

describe('retryThinkingMode', () => {
  /**
   * THE LOAD-BEARING ONE — the reasoning text is worth keeping, and the tempting version of this idea
   * ("if it goes quiet, drop thinking") would eat it on every long think. The common path must be
   * byte-identical to a build with no retry logic at all.
   */
  it('keeps thinking on the earlier retries — a healthy generation never loses its reasoning', () => {
    expect(retryThinkingMode(1)).toBe('adaptive');
    expect(retryThinkingMode(MAX_PROVIDER_RETRY_ATTEMPTS - 1)).toBe('adaptive');
  });

  /**
   * The end of the ladder trades depth for a stream that cannot go quiet. ⚠️ The COUNT is asserted by
   * the call-site describe above, never restated here — every wrong version of this rule was a number.
   */
  it('disables thinking once the retry number reaches the bound', () => {
    expect(retryThinkingMode(MAX_PROVIDER_RETRY_ATTEMPTS)).toBe('disabled');
  });

  /**
   * 🔴 THE UNITS, asserted rather than described. `retryNumber` counts retries from ONE, so a `0` is
   * not "the first retry" — it is a value the call site never produces, and reading it as an index is
   * exactly the mistake that shipped. It must not be at or past the bound.
   */
  it('takes a 1-based retry number, so zero is below the bound rather than at it', () => {
    expect(retryThinkingMode(0)).toBe('adaptive');
  });

  /** It tracks the BOUND, so raising the retry cap cannot silently move which retry goes thinking-free. */
  it('follows the configured bound rather than a hardcoded retry number', () => {
    expect(retryThinkingMode(1, 5)).toBe('adaptive');
    expect(retryThinkingMode(4, 5)).toBe('adaptive');
    expect(retryThinkingMode(5, 5)).toBe('disabled');
  });

  /** A single-retry configuration has no earlier retry to protect — the one retry is the last one. */
  it('degrades sanely at a bound of one', () => {
    expect(retryThinkingMode(1, 1)).toBe('disabled');
  });
});
