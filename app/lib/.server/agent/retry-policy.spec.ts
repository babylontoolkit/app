/**
 * Money tests. A `true` here re-runs a generation nobody asked for; a `false` hands the user a long
 * wait and an error where the product should have worked.
 */
import { describe, expect, it } from 'vitest';
import { MAX_PROVIDER_RETRY_ATTEMPTS, retryThinkingMode, retryToolMode, shouldRetryGeneration } from './retry-policy';

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
describe('retryThinkingMode', () => {
  /**
   * THE LOAD-BEARING ONE — the reasoning text is worth keeping, and the tempting version of this idea
   * ("if it goes quiet, drop thinking") would eat it on every long think. The common path must be
   * byte-identical to a build with no retry logic at all.
   */
  it('keeps thinking on the early attempts — a healthy generation never loses its reasoning', () => {
    expect(retryThinkingMode(0)).toBe('adaptive');
    expect(retryThinkingMode(1)).toBe('adaptive');
  });

  /** Only the final attempt trades depth for a stream that cannot go quiet. */
  it('disables thinking on the last attempt', () => {
    expect(retryThinkingMode(MAX_PROVIDER_RETRY_ATTEMPTS - 1)).toBe('disabled');
    expect(retryThinkingMode(MAX_PROVIDER_RETRY_ATTEMPTS)).toBe('disabled');
  });

  /** It tracks the BOUND, so raising the retry cap cannot silently move which attempt goes thinking-free. */
  it('follows the configured bound rather than a hardcoded attempt number', () => {
    expect(retryThinkingMode(1, 5)).toBe('adaptive');
    expect(retryThinkingMode(3, 5)).toBe('adaptive');
    expect(retryThinkingMode(4, 5)).toBe('disabled');
  });

  /** A single-attempt configuration has no "early" attempt to protect — the one try is the last one. */
  it('degrades sanely at a bound of one', () => {
    expect(retryThinkingMode(0, 1)).toBe('disabled');
  });
});
