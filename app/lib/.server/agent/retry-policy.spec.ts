/**
 * Money tests. A `true` here re-runs a generation nobody asked for; a `false` hands the user a long
 * wait and an error where the product should have worked.
 */
import { describe, expect, it } from 'vitest';
import { shouldRetryGeneration } from './retry-policy';

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

  it('retries at most once — a genuinely sick provider fails twice', () => {
    expect(shouldRetryGeneration({ ...base, attempts: 1 })).toBe(false);
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
