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
});
