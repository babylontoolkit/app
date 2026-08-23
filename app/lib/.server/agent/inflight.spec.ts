/**
 * One in-flight generation per project (§4.12).
 *
 * The failure this prevents is SILENT: two generations against one project interleave their file
 * actions and leave a working tree that is a mix of two different ideas. Nothing throws, nothing logs,
 * and the user reports "it broke my game".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetClaims, claimProject, GenerationInFlightError, isProjectClaimed, shouldClaimProject } from './inflight';

/*
 * The takeover LOGS are the only externally visible difference between "the map still held a dead
 * claim" and "something swept it" — see the `isProjectClaimed` block at the foot of this file, where
 * that difference is the whole test.
 */
const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() }));

vi.mock('~/utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/logger')>()),
  createScopedLogger: () => log,
}));

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

/**
 * 🔴 THE LOCK IS SCOPED TO BUILD TURNS (owner, 2026-08-09).
 *
 * *"I am not in build mode and don't ever hold me because it thinks I am."* Plan mode exists to think
 * about a project without touching it, and it was both taking this lock and being refused by it — with
 * an error announcing that the project "is already building" to someone who had switched building off.
 *
 * The two directions are one rule, which is why the predicate is pure and shared rather than a boolean
 * written at the call site: a Plan turn takes no claim (so it cannot block the build that follows it)
 * and makes no claim request (so a build in flight cannot refuse it).
 */
describe('shouldClaimProject — the lock covers builds, not plans', () => {
  it('claims for an ordinary build turn', () => {
    expect(shouldClaimProject({ projectId: 'prj_1', chatMode: 'build' })).toBe(true);
  });

  /* 🔴 The reported bug. Read-only by guarantee (§4.2.9), so there is nothing to serialise. */
  it('does NOT claim for a Plan-mode turn', () => {
    expect(shouldClaimProject({ projectId: 'prj_1', chatMode: 'discuss' })).toBe(false);
  });

  /*
   * The safe default, and the direction that matters: an older client, a dropped field or a value
   * nobody recognised is a turn that MIGHT write files, so it must stay behind the lock. Getting this
   * backwards re-opens the interleaved-writes corruption silently.
   */
  it.each([
    ['absent', undefined],
    ['an unrecognised value from a stale client', 'planning' as unknown as 'build'],
  ])('claims when chatMode is %s', (_label, chatMode) => {
    expect(shouldClaimProject({ projectId: 'prj_1', chatMode })).toBe(true);
  });

  /* A generation with no project locks nothing — there is no tree for it to corrupt. */
  it.each([
    ['build', 'build' as const],
    ['discuss', 'discuss' as const],
  ])('does not claim without a project (%s)', (_label, chatMode) => {
    expect(shouldClaimProject({ chatMode })).toBe(false);
  });
});

/**
 * The behaviour the predicate buys, asserted through the lock itself rather than only as a boolean —
 * a predicate that returns the right answer while the caller ignores it is the failure this pins.
 */
describe('a Plan turn and a build turn do not block each other', () => {
  beforeEach(() => {
    _resetClaims();
  });

  /** Route-shaped: claim only when the rule says to. */
  const send = (projectId: string, chatMode: 'discuss' | 'build') =>
    shouldClaimProject({ projectId, chatMode }) ? claimProject(projectId, USER) : undefined;

  it('lets a Plan turn through while a build is running', () => {
    send('prj_1', 'build');
    expect(() => send('prj_1', 'discuss')).not.toThrow();
  });

  it('lets a build start after a Plan turn that never released', () => {
    send('prj_1', 'discuss');
    expect(() => send('prj_1', 'build')).not.toThrow();
  });

  it('runs any number of Plan turns at once', () => {
    send('prj_1', 'discuss');
    send('prj_1', 'discuss');
    expect(() => send('prj_1', 'discuss')).not.toThrow();
  });

  /*
   * CONTROL — without this the whole block passes for a lock that was simply deleted, which is the
   * cheerful way to make a "stop blocking me" bug go green while restoring the tree corruption.
   */
  it('still refuses a second BUILD turn', () => {
    send('prj_1', 'build');
    expect(() => send('prj_1', 'build')).toThrow(GenerationInFlightError);
  });
});

/**
 * 🔴 `isProjectClaimed` IS A READ, AND HALF OF WHAT IS WORTH PINNING IS WHAT IT DOES NOT DO.
 *
 * The tree-replacing git operations (§4.13a) — a branch switch, a discard — overwrite the whole
 * working tree, which is precisely the interleaving this lock exists to prevent. They are not
 * generations, so they must be able to ASK whether a build holds the project rather than taking the
 * lock in order to find out.
 *
 * The tempting implementation deletes an expired entry on the way past ("tidy up as you go"), and that
 * silently changes `claimProject` one layer away: a takeover of a stale claim is a WARN-logged event
 * reporting that something failed to release its `finally`, and a reader that swept the corpse first
 * turns that signal off — the takeover becomes indistinguishable from an ordinary first claim, and the
 * leak it was reporting stops being visible in the logs forever. It also runs on a REFUSAL path, so a
 * mutating read is a refusal that behaves differently depending on how many times the user pressed the
 * button. Hence the no-side-effect tests below carry as much weight as the return-value ones.
 *
 * Both liveness rules come from the single private `isClaimLive`, shared with `claimProject` — two
 * private copies drift the first time the TTL or the abort rule moves, and the two failure directions
 * are opposite and both silent (a reader that thinks a live claim is dead lets a branch switch replace
 * files under a running generation; one that thinks a dead claim is live strands the user behind a wall
 * nothing can clear).
 */
describe('isProjectClaimed — a read, never a claim', () => {
  beforeEach(() => {
    _resetClaims();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /** Did `claimProject` announce it was taking over a corpse, rather than claiming an empty slot? */
  const sawStaleTakeover = () => log.warn.mock.calls.some(([message]) => /Stale in-flight claim/.test(String(message)));
  const sawAbortedTakeover = () => log.info.mock.calls.some(([message]) => /was aborted/.test(String(message)));

  it('is false for a project nobody has claimed', () => {
    expect(isProjectClaimed('prj_never_seen')).toBe(false);
  });

  it('is true while a generation holds the project', () => {
    claimProject('prj_1', USER);
    expect(isProjectClaimed('prj_1')).toBe(true);
  });

  it('is false once the holder releases', () => {
    const release = claimProject('prj_1', USER);
    release();
    expect(isProjectClaimed('prj_1')).toBe(false);
  });

  it('does not report one project’s claim on another', () => {
    claimProject('prj_1', USER);
    expect(isProjectClaimed('prj_2')).toBe(false);
  });

  /*
   * The same rule `claimProject` yields on: a STOPPED generation can emit no further file actions, so
   * the tree is already free even though the release in the stream's `finally` has not run yet. A
   * reader that said `true` here would refuse a branch switch for however long the provider tail and
   * settlement take to unwind — a wall with nothing behind it, which is the bug the abort signal was
   * added to close in the first place.
   */
  it('is false when the holder’s request was aborted (Stop)', () => {
    const controller = new AbortController();
    claimProject('prj_1', USER, controller.signal);

    expect(isProjectClaimed('prj_1')).toBe(true);

    controller.abort(); // the Stop button

    expect(isProjectClaimed('prj_1')).toBe(false);
  });

  /* The TTL half of the same rule: a claim nothing ever released must not brick the project forever. */
  it('is false for a claim older than the TTL', () => {
    vi.useFakeTimers();

    claimProject('prj_1', USER);
    expect(isProjectClaimed('prj_1')).toBe(true);

    vi.advanceTimersByTime(16 * 60 * 1000); // past the 15-minute TTL

    expect(isProjectClaimed('prj_1')).toBe(false);
  });

  /**
   * 🔴 THE CONTROL THAT MATTERS: reading an EXPIRED claim must not evict it.
   *
   * A read that tidied up would return the same `false` and pass every assertion above it — the only
   * evidence is what happens NEXT. `claimProject` distinguishes the two states loudly: taking over a
   * stale claim WARNs (something leaked its `finally` and we want to see that), while claiming a slot
   * nobody holds says nothing at all. So the log is the observable, and it is the only one.
   */
  it('does NOT evict an expired claim — the next claim is still a stale TAKEOVER', () => {
    vi.useFakeTimers();

    claimProject('prj_1', USER);
    vi.advanceTimersByTime(16 * 60 * 1000);

    expect(isProjectClaimed('prj_1')).toBe(false);

    log.warn.mockClear();

    // A different user starts a build. The corpse must still be in the map for it to step over.
    expect(() => claimProject('prj_1', 'user_2')).not.toThrow();
    expect(sawStaleTakeover()).toBe(true);
  });

  /** The same property on the other dead-claim rule. */
  it('does NOT evict an aborted claim — the next claim is still a takeover', () => {
    const controller = new AbortController();
    claimProject('prj_1', USER, controller.signal);
    controller.abort();

    expect(isProjectClaimed('prj_1')).toBe(false);

    log.info.mockClear();

    claimProject('prj_1', 'user_2', new AbortController().signal);
    expect(sawAbortedTakeover()).toBe(true);
  });

  /*
   * CONTROL for the two controls above. Without it they pass for a `sawStaleTakeover` that is simply
   * always true — a log matcher that cannot distinguish the two cases is not evidence of anything, and
   * that is exactly the shape of vacuous test this codebase keeps catching by mutation.
   */
  it('CONTROL: claiming a project nobody holds announces no takeover of either kind', () => {
    claimProject('prj_1', USER);

    expect(sawStaleTakeover()).toBe(false);
    expect(sawAbortedTakeover()).toBe(false);
  });

  /* And the live case: asking must not release the lock the asker was refused by. */
  it('leaves a LIVE claim standing, however many times it is asked', () => {
    claimProject('prj_1', USER);

    expect(isProjectClaimed('prj_1')).toBe(true);
    expect(isProjectClaimed('prj_1')).toBe(true);
    expect(isProjectClaimed('prj_1')).toBe(true);

    expect(() => claimProject('prj_1', 'user_2')).toThrow(GenerationInFlightError);
  });
});
