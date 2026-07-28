/**
 * The fork ceiling (`spec/sandbox-codesandbox.md` §11 M2).
 *
 * Two failure directions, and both are silent. Too permissive and a `{ reset: true }` loop from one
 * browser tab drains a PLATFORM-wide provider budget — an outage for every other user, arriving
 * looking exactly like an enthusiastic customer pressing a button. Too strict and it refuses a real
 * user mid-session, which is the worse of the two because the product simply stops working for
 * somebody who did nothing wrong.
 *
 * Pure, so it is tested without a clock — the same reason `failure-rate.ts`'s judgement is separated
 * from its ring.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CREATE_LIMIT_WINDOW_MS,
  DEFAULT_SANDBOX_CREATES_PER_HOUR,
  decideCreateAllowed,
  recentSandboxCreates,
  recordSandboxCreate,
  resetSandboxCreateLimits,
} from './create-limit';

const NOW = 1_700_000_000_000;

/** `n` creates spread through the window, newest last. */
const spread = (n: number, now = NOW, spacingMs = 60_000) =>
  Array.from({ length: n }, (_, i) => now - (n - i) * spacingMs);

afterEach(() => {
  resetSandboxCreateLimits();
});

describe('decideCreateAllowed', () => {
  it('allows the first create of a fresh account and reports the whole budget', () => {
    expect(decideCreateAllowed([], NOW, 5)).toEqual({ allowed: true, remaining: 5 });
  });

  it('allows while under the limit and counts down', () => {
    expect(decideCreateAllowed(spread(3), NOW, 5)).toEqual({ allowed: true, remaining: 2 });
    expect(decideCreateAllowed(spread(4), NOW, 5)).toEqual({ allowed: true, remaining: 1 });
  });

  it('refuses AT the limit, not one past it', () => {
    /* The boundary is the whole test: `<` vs `<=` here is one free extra VM per user per hour. */
    const decision = decideCreateAllowed(spread(5), NOW, 5);

    expect(decision.allowed).toBe(false);
    expect(decision).toMatchObject({ limit: 5 });
  });

  it('ignores creates that have aged out of the window', () => {
    /*
     * Pruning is not assumed to have happened elsewhere. A caller that never prunes still gets the
     * right answer — otherwise the ceiling silently becomes permanent for a long-lived process.
     */
    const stale = [NOW - CREATE_LIMIT_WINDOW_MS - 1, NOW - CREATE_LIMIT_WINDOW_MS * 3];

    expect(decideCreateAllowed([...stale, ...spread(2)], NOW, 5)).toEqual({ allowed: true, remaining: 3 });
  });

  it('treats an entry exactly at the window edge as expired', () => {
    expect(decideCreateAllowed([NOW - CREATE_LIMIT_WINDOW_MS], NOW, 1)).toEqual({ allowed: true, remaining: 1 });
    expect(decideCreateAllowed([NOW - CREATE_LIMIT_WINDOW_MS + 1], NOW, 1).allowed).toBe(false);
  });

  it('derives retryAfterSeconds from the OLDEST in-window create', () => {
    /*
     * That is the moment the window first has room again. A refusal that cannot say when to come back
     * is indistinguishable from a stall, and the client would either hammer or give up.
     */
    const oldest = NOW - 10 * 60_000;
    const decision = decideCreateAllowed([oldest, NOW - 60_000], NOW, 2);

    expect(decision.allowed).toBe(false);
    expect(decision).toMatchObject({ retryAfterSeconds: (CREATE_LIMIT_WINDOW_MS - 10 * 60_000) / 1000 });
  });

  it('never advertises a retry of zero seconds', () => {
    /* A `Retry-After: 0` invites an immediate retry that refuses again — a hot loop we asked for. */
    const decision = decideCreateAllowed([NOW - CREATE_LIMIT_WINDOW_MS + 1], NOW, 1);

    expect(decision.allowed).toBe(false);
    expect((decision as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('ignores a nonsensical limit rather than obeying it', () => {
    /*
     * Obeying `0` or `NaN` would refuse every sandbox on the platform from one typo in an env var —
     * the same "a bad override is ignored, not honoured" rule as `sandboxHibernationSeconds`.
     */
    for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(decideCreateAllowed([], NOW, limit)).toEqual({
        allowed: true,
        remaining: DEFAULT_SANDBOX_CREATES_PER_HOUR,
      });
    }

    expect(decideCreateAllowed(spread(DEFAULT_SANDBOX_CREATES_PER_HOUR), NOW, 0).allowed).toBe(false);
  });

  it('floors a fractional limit rather than comparing against a fraction', () => {
    expect(decideCreateAllowed(spread(2), NOW, 2.9)).toMatchObject({ allowed: false, limit: 2 });
  });

  it('ignores unusable timestamps in the ring', () => {
    expect(decideCreateAllowed([Number.NaN, Number.POSITIVE_INFINITY, NOW - 1000], NOW, 2)).toEqual({
      allowed: true,
      remaining: 1,
    });
  });

  it('defaults to the configured per-hour budget when no limit is passed', () => {
    expect(decideCreateAllowed(spread(DEFAULT_SANDBOX_CREATES_PER_HOUR - 1), NOW)).toMatchObject({ allowed: true });
    expect(decideCreateAllowed(spread(DEFAULT_SANDBOX_CREATES_PER_HOUR), NOW).allowed).toBe(false);
  });
});

describe('the in-process ring', () => {
  it('records per user and never mixes two accounts', () => {
    recordSandboxCreate('user-a', NOW);
    recordSandboxCreate('user-a', NOW + 1);
    recordSandboxCreate('user-b', NOW);

    expect(recentSandboxCreates('user-a', NOW + 2)).toHaveLength(2);
    expect(recentSandboxCreates('user-b', NOW + 2)).toHaveLength(1);
    expect(recentSandboxCreates('user-c', NOW + 2)).toEqual([]);
  });

  it('prunes as it reads, so an idle account stops occupying memory', () => {
    recordSandboxCreate('user-a', NOW);

    expect(recentSandboxCreates('user-a', NOW + CREATE_LIMIT_WINDOW_MS + 1)).toEqual([]);
  });

  it('starts empty after a reset — a rate that leaks between tests is not a rate', () => {
    recordSandboxCreate('user-a', NOW);
    resetSandboxCreateLimits();

    expect(recentSandboxCreates('user-a', NOW)).toEqual([]);
  });
});
