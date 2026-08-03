/**
 * PER-USER RATE LIMITING (SPEC §5, §10 item 20).
 *
 * Every property here fails SILENTLY and in the expensive direction. A window that does not roll locks
 * an honest user out permanently with no error anywhere; a key that is not per-user turns one abusive
 * account into an outage for everybody; a key that is not per-bucket makes ten imports spend somebody
 * else's unrelated budget; and a sweep that drops a LIVE window resets the limit for exactly the caller
 * who was hammering hard enough to grow the map past its threshold — i.e. the limiter switches itself
 * off under precisely the load it exists to bound.
 *
 * The clock is INJECTED throughout. `enforceUserRateLimit` takes `now` for this reason: a limiter tested
 * with real timers is either slow or flaky, and usually both, and a one-hour window cannot be tested at
 * all without either faking time or waiting an hour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLONE_RATE_LIMIT,
  MemoryUserRateLimitStore,
  RateLimitedError,
  enforceUserRateLimit,
  getUserRateLimitStore,
  setUserRateLimitStore,
  type UserRateLimitDecision,
  type UserRateLimitRule,
  type UserRateLimitStore,
} from './user-rate-limit';

/** A small, fast rule — the shape is what is under test, never the production numbers. */
const RULE: UserRateLimitRule = { windowMs: 1_000, max: 3 };

const T0 = 1_700_000_000_000;

/** Count one call, and report whether it was allowed — the throw is the refusal. */
async function tryCall(input: { userId: string; bucket?: string; rule?: UserRateLimitRule; now: number }) {
  try {
    await enforceUserRateLimit({
      userId: input.userId,
      bucket: input.bucket ?? 'git-clone',
      rule: input.rule ?? RULE,
      now: input.now,
    });

    return { allowed: true as const };
  } catch (error) {
    return { allowed: false as const, error: error as RateLimitedError };
  }
}

beforeEach(() => {
  setUserRateLimitStore(new MemoryUserRateLimitStore());
});

afterEach(() => {
  setUserRateLimitStore(undefined);
});

describe('the window', () => {
  it('allows exactly `max` calls and refuses the next', async () => {
    for (let i = 0; i < RULE.max; i++) {
      expect((await tryCall({ userId: 'u1', now: T0 + i })).allowed).toBe(true);
    }

    expect((await tryCall({ userId: 'u1', now: T0 + RULE.max })).allowed).toBe(false);
  });

  /**
   * 🔴 The window must ROLL. Without this, the first refusal is permanent: the map entry is never
   * cleared, so an honest user who imported ten repositories once is locked out of the feature forever,
   * with the only trace a server-side `logger.warn` nobody reads.
   */
  it('allows the same user again once the window has passed', async () => {
    for (let i = 0; i < RULE.max; i++) {
      await tryCall({ userId: 'u1', now: T0 });
    }

    expect((await tryCall({ userId: 'u1', now: T0 + RULE.windowMs - 1 })).allowed).toBe(false);
    expect((await tryCall({ userId: 'u1', now: T0 + RULE.windowMs })).allowed).toBe(true);

    // …and the fresh window is a FULL one, not a single borrowed call.
    expect((await tryCall({ userId: 'u1', now: T0 + RULE.windowMs })).allowed).toBe(true);
    expect((await tryCall({ userId: 'u1', now: T0 + RULE.windowMs })).allowed).toBe(true);
    expect((await tryCall({ userId: 'u1', now: T0 + RULE.windowMs })).allowed).toBe(false);
  });

  /**
   * The key is the USER, which is the whole reason this file exists rather than reusing the inherited
   * per-IP limiter. If the key collapsed, one account exhausting its budget would refuse everybody.
   */
  it('is per user — A exhausting the limit does not touch B', async () => {
    for (let i = 0; i < RULE.max; i++) {
      await tryCall({ userId: 'user-a', now: T0 });
    }

    expect((await tryCall({ userId: 'user-a', now: T0 })).allowed).toBe(false);
    expect((await tryCall({ userId: 'user-b', now: T0 })).allowed).toBe(true);
  });

  /**
   * And per BUCKET. Sharing one counter across operations means an import spends the budget of whatever
   * unrelated path is added next, and the refusal names the wrong thing.
   */
  it('is per bucket — the same user in another bucket is independent', async () => {
    for (let i = 0; i < RULE.max; i++) {
      await tryCall({ userId: 'u1', bucket: 'git-clone', now: T0 });
    }

    expect((await tryCall({ userId: 'u1', bucket: 'git-clone', now: T0 })).allowed).toBe(false);
    expect((await tryCall({ userId: 'u1', bucket: 'media-render', now: T0 })).allowed).toBe(true);
  });

  /**
   * A user id containing the separator must not be able to reach into another bucket's counter.
   * `${bucket}:${userId}` is unambiguous only while the bucket is a constant chosen by us — this pins
   * that a hostile-looking id is still counted as itself.
   */
  it('does not let a colon in a user id borrow another key', async () => {
    for (let i = 0; i < RULE.max; i++) {
      await tryCall({ userId: 'u1', bucket: 'git-clone', now: T0 });
    }

    expect((await tryCall({ userId: 'clone:u1', bucket: 'git', now: T0 })).allowed).toBe(true);
  });
});

describe('the refusal a caller can act on', () => {
  it('is a 429 that is retryable and names a wait', async () => {
    for (let i = 0; i < RULE.max; i++) {
      await tryCall({ userId: 'u1', now: T0 });
    }

    const { allowed, error } = await tryCall({ userId: 'u1', now: T0 });

    expect(allowed).toBe(false);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error!.name).toBe('RateLimitedError');
    expect(error!.statusCode).toBe(429);
    expect(error!.isRetryable).toBe(true);
    expect(error!.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(error!.message).toMatch(/try again in about/i);
  });

  /**
   * ⚠️ `Retry-After: 0` is a refusal that invites an immediate retry — an infinite loop for any client
   * that honours it. A window with a millisecond left still has to say "1 second".
   */
  it('never reports a zero wait, even one millisecond before the reset', () => {
    const error = new RateLimitedError(T0 + 1, T0);

    expect(error.retryAfterSeconds).toBe(1);
    expect(error.message).toContain('1 minute');
    expect(error.message).not.toContain('1 minutes');
  });

  it('rounds a real wait up to whole minutes, plural', () => {
    const error = new RateLimitedError(T0 + 20 * 60 * 1000, T0);

    expect(error.retryAfterSeconds).toBe(20 * 60);
    expect(error.message).toContain('20 minutes');
  });

  /** The production rule: one import is an act, a catalogue is not. Ten an hour, per user. */
  it('CLONE_RATE_LIMIT is ten calls an hour', () => {
    expect(CLONE_RATE_LIMIT).toEqual({ windowMs: 60 * 60 * 1000, max: 10 });
  });
});

describe('the store seam', () => {
  /**
   * The header's whole honesty argument rests on this: the in-process default is a stated weakening and
   * `setUserRateLimitStore` is where a shared Redis/Postgres implementation plugs in. A seam nothing can
   * be swapped through is documentation, not a seam.
   */
  it('routes every decision through the injected store', async () => {
    const hit = vi.fn(
      async (): Promise<UserRateLimitDecision> => ({ allowed: false, remaining: 0, resetAt: T0 + 90_000 }),
    );
    const fake: UserRateLimitStore = { hit };

    setUserRateLimitStore(fake);

    const { allowed, error } = await tryCall({ userId: 'u1', bucket: 'git-clone', now: T0 });

    expect(allowed).toBe(false);
    expect(hit).toHaveBeenCalledWith('git-clone:u1', RULE, T0);

    // The wait comes from the STORE's `resetAt`, not from a locally re-derived guess.
    expect(error!.retryAfterSeconds).toBe(90);
  });

  it('falls back to the in-process store when none is set', () => {
    setUserRateLimitStore(undefined);

    const store = getUserRateLimitStore();

    expect(store).toBeInstanceOf(MemoryUserRateLimitStore);

    // …and it is the same instance next time, or every request would start a fresh empty map.
    expect(getUserRateLimitStore()).toBe(store);
  });

  it('defaults `now` to the wall clock when the caller does not inject one', async () => {
    const hit = vi.fn(async (): Promise<UserRateLimitDecision> => ({ allowed: true, remaining: 1, resetAt: 0 }));
    setUserRateLimitStore({ hit });

    const clock = vi.spyOn(Date, 'now').mockReturnValue(T0);

    try {
      await enforceUserRateLimit({ userId: 'u1', bucket: 'git-clone', rule: RULE });
    } finally {
      // Only this spy — `vi.restoreAllMocks()` would also clear `hit`'s recorded calls.
      clock.mockRestore();
    }

    expect(hit).toHaveBeenCalledWith('git-clone:u1', RULE, T0);
  });
});

/**
 * 🔴 THE SWEEP — the branch with a correctness risk hiding inside a memory-hygiene optimisation.
 *
 * It runs only on a window ROLL and only once the map is large, so it is unreachable in ordinary tests
 * and reachable in production by exactly one caller: a busy instance. Dropping a live window there would
 * hand a full fresh budget back to whoever was still inside theirs — the limiter turning itself off
 * under load, silently.
 */
describe('the expired-key sweep', () => {
  /** Short-lived filler traffic — expired by the time the sweep runs. */
  const SHORT: UserRateLimitRule = { windowMs: 1_000, max: 2 };

  /** A genuinely long window, so the live key is unambiguously still inside its own. */
  const LONG: UserRateLimitRule = { windowMs: 10_000, max: 2 };

  const fill = async (s: MemoryUserRateLimitStore, from: number, to: number, at: number) => {
    for (let i = from; i < to; i++) {
      await s.hit(`filler:${i}`, SHORT, at);
    }
  };

  /**
   * 🔴 The mutation this exists for: `delete(k)` without its `resetAt <= now` guard.
   *
   * ⚠️ The ORDER of the three phases is load-bearing, and the first draft of this test got it wrong in a
   * way only mutation testing could show. Every NEW key goes through the roll branch, so the sweep fires
   * during the FILL as well — an unguarded delete therefore empties the map before the live key is ever
   * inserted, the threshold is never crossed again, and the sweep the test is about never runs. The test
   * passed against the broken store while asserting nothing. Hence: fill BELOW the threshold, insert the
   * live key, and only then cross it.
   */
  it('keeps a LIVE window intact while clearing expired ones', async () => {
    const s = new MemoryUserRateLimitStore();

    // 700 keys, all expired by T0 + 1000 — the sweep's legitimate work. Below the threshold, so quiet.
    await fill(s, 0, 700, T0);

    // A user who is exhausted and whose window runs to T0 + 10000.
    await s.hit('live-user', LONG, T0);
    await s.hit('live-user', LONG, T0);
    expect((await s.hit('live-user', LONG, T0)).allowed).toBe(false);

    // Now cross 1,000 at T0 + 1000: the sweep fires with the 700 expired and `live-user` still live.
    await fill(s, 700, 1_100, T0 + 1_000);

    // 🔴 Still exhausted, and on its ORIGINAL window. Sweeping it hands back a whole fresh budget.
    const after = await s.hit('live-user', LONG, T0 + 1_000);
    expect(after.allowed).toBe(false);
    expect(after.resetAt).toBe(T0 + LONG.windowMs);
  });

  /**
   * The CONTROL: the roll itself really does forget an expired window, so the test above is about the
   * sweep DISCRIMINATING rather than about nothing ever being cleared.
   */
  it('does clear a window that has genuinely expired', async () => {
    const s = new MemoryUserRateLimitStore();

    await s.hit('old-user', SHORT, T0);
    await s.hit('old-user', SHORT, T0);
    expect((await s.hit('old-user', SHORT, T0)).allowed).toBe(false);

    expect((await s.hit('old-user', SHORT, T0 + SHORT.windowMs)).allowed).toBe(true);
  });

  it('reports the remaining budget as it counts down', async () => {
    const s = new MemoryUserRateLimitStore();
    const rule: UserRateLimitRule = { windowMs: 1_000, max: 3 };

    expect(await s.hit('u1', rule, T0)).toMatchObject({ allowed: true, remaining: 2 });
    expect(await s.hit('u1', rule, T0)).toMatchObject({ allowed: true, remaining: 1 });
    expect(await s.hit('u1', rule, T0)).toMatchObject({ allowed: true, remaining: 0 });
    expect(await s.hit('u1', rule, T0)).toMatchObject({ allowed: false, remaining: 0 });
  });
});
