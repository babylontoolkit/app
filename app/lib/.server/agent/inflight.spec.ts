/**
 * One in-flight generation per project (§4.12).
 *
 * The failure this prevents is SILENT: two generations against one project interleave their file
 * actions and leave a working tree that is a mix of two different ideas. Nothing throws, nothing logs,
 * and the user reports "it broke my game".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetClaims, claimProject, GenerationInFlightError } from './inflight';

const USER = 'user_1';

describe('claimProject', () => {
  beforeEach(() => {
    _resetClaims();
    vi.useRealTimers();
  });

  it('lets the first generation through', () => {
    expect(() => claimProject('prj_1', USER)).not.toThrow();
  });

  it('refuses a second generation on the same project', () => {
    claimProject('prj_1', USER);
    expect(() => claimProject('prj_1', USER)).toThrow(GenerationInFlightError);
  });

  it('reports 409 with a message a human can act on', () => {
    claimProject('prj_1', USER);

    try {
      claimProject('prj_1', USER);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as GenerationInFlightError).statusCode).toBe(409);
      expect((error as Error).message).toMatch(/already building/i);
    }
  });

  it('does not block a DIFFERENT project', () => {
    claimProject('prj_1', USER);
    expect(() => claimProject('prj_2', USER)).not.toThrow();
  });

  it('frees the project when the generation releases', () => {
    const release = claimProject('prj_1', USER);
    release();
    expect(() => claimProject('prj_1', USER)).not.toThrow();
  });

  /**
   * The proxy releases in a `finally`, so a crashed or stopped generation frees its project. If that
   * ever regressed, a single failure would lock the project until the TTL — worth pinning.
   */
  it('is idempotent: releasing twice does not free someone else’s claim', () => {
    const releaseFirst = claimProject('prj_1', USER);
    releaseFirst();

    claimProject('prj_1', 'user_2');

    // The first generation's `finally` fires again (double-release). It must not steal the new claim.
    releaseFirst();

    expect(() => claimProject('prj_1', USER)).toThrow(GenerationInFlightError);
  });

  /**
   * A claim that is never released (a hung provider call, a lost `finally`) must not brick the project
   * forever — the user would have no way to recover it.
   */
  it('takes over a claim that has gone stale', () => {
    vi.useFakeTimers();

    claimProject('prj_1', USER);
    expect(() => claimProject('prj_1', USER)).toThrow(GenerationInFlightError);

    vi.advanceTimersByTime(16 * 60 * 1000); // past the 15-minute TTL

    expect(() => claimProject('prj_1', USER)).not.toThrow();
  });

  /**
   * 🔴 A STOPPED generation must never refuse the next send (found live, 2026-08-08).
   *
   * The error's own copy says "press Stop, before starting another change" — and the user did, and was
   * refused anyway: the release lives in the stream's `finally`, which can lag the abort by however
   * long the provider tail and settlement take. The claim carries its request's abort signal precisely
   * so that a holder whose request is DEAD yields immediately.
   */
  it('yields to a new send when the holder’s request was aborted (Stop)', () => {
    const controller = new AbortController();
    claimProject('prj_1', USER, controller.signal);

    // Still running → still refused.
    expect(() => claimProject('prj_1', USER, new AbortController().signal)).toThrow(GenerationInFlightError);

    controller.abort(); // the Stop button

    expect(() => claimProject('prj_1', USER, new AbortController().signal)).not.toThrow();
  });

  /** The takeover half of idempotent-release: the STOPPED generation's late `finally` must not free the new claim. */
  it('a stopped holder’s late release does not free the takeover claim', () => {
    const controller = new AbortController();
    const releaseStopped = claimProject('prj_1', USER, controller.signal);

    controller.abort();
    claimProject('prj_1', USER, new AbortController().signal); // the takeover

    releaseStopped(); // the stopped generation's settlement tail finally finishes

    // The takeover's claim must still be standing.
    expect(() => claimProject('prj_1', USER, new AbortController().signal)).toThrow(GenerationInFlightError);
  });
});
