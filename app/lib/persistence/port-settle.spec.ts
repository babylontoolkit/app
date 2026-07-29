/**
 * The wake path's bounded wait for a resumed sandbox's replayed ports (plan T6).
 *
 * This function decides whether the mount path starts a second `npm run dev`, and BOTH wrong answers
 * are silent on the machine that has them:
 *
 *   - answering too early (ports replay a beat later) starts a second dev server into a VM that
 *     already has one bound to 5173 — the new project is then served by the previous process;
 *   - answering `true` when nothing is listening leaves a dead preview with nothing restarting it.
 *
 * So the properties pinned here are the BOUNDS, not the shape of the loop: it must be free when the
 * answer is already known, it must survive ports arriving late, and above all it must TERMINATE —
 * an unbounded version hangs the mount forever and looks exactly like a broken product.
 */
import { describe, expect, it } from 'vitest';
import { PORT_SETTLE_POLL_MS, PORT_SETTLE_TIMEOUT_MS, awaitRunningPreview } from './port-settle';

/**
 * A fake sleeper that records the ms it was asked for and never actually sleeps.
 *
 * Elapsed time in the implementation is the SUM OF THE POLLS rather than `Date.now()`, which is what
 * makes the bound assertable at all — a wall clock here would make every assertion below a timing
 * flake. `waits` is therefore the real elapsed clock, exactly as the production code counts it.
 */
function harness(previewsOverTime: number[]) {
  const waits: number[] = [];
  let reads = 0;

  return {
    waits,
    get reads() {
      return reads;
    },
    get totalWaited() {
      return waits.reduce((sum, ms) => sum + ms, 0);
    },
    runningPreviews: () => {
      const value = previewsOverTime[Math.min(reads, previewsOverTime.length - 1)];
      reads++;

      return value;
    },
    wait: async (ms: number) => {
      waits.push(ms);
    },
  };
}

describe('awaitRunningPreview', () => {
  /**
   * The healthy resume — the overwhelmingly common case. A VM whose ports have already been replayed
   * must cost ZERO dead time: this runs inside the boot screen's `prepare` phase, where every
   * millisecond is a millisecond the user watches a spinner for nothing.
   */
  it('returns true with no waits at all when a preview is already present', async () => {
    const h = harness([1]);

    await expect(awaitRunningPreview(h)).resolves.toBe(true);
    expect(h.waits).toEqual([]);
  });

  /**
   * The defect this whole module exists for. The provider replays open ports with a sweep at
   * registration and a re-check ~3s later; reading `previews.length` before either lands says zero.
   * Here the ports show up on the 4th read (three polls in) and the answer must still be "leave it
   * alone" — and it must not burn the rest of the window once it knows.
   */
  it('returns true when ports appear late, and stops polling the moment they do', async () => {
    const h = harness([0, 0, 0, 1]);

    await expect(awaitRunningPreview(h)).resolves.toBe(true);
    expect(h.waits).toEqual([PORT_SETTLE_POLL_MS, PORT_SETTLE_POLL_MS, PORT_SETTLE_POLL_MS]);
    expect(h.totalWaited).toBeLessThan(PORT_SETTLE_TIMEOUT_MS);
  });

  /**
   * The other half of the decision: hibernation killed the dev server, or the user killed it in a
   * terminal. Nothing will ever appear, so the wait must expire and hand back `false` so the mount
   * path starts a server exactly once.
   */
  it('returns false when ports never appear', async () => {
    const h = harness([0]);

    await expect(awaitRunningPreview(h)).resolves.toBe(false);
  });

  /**
   * TERMINATION. A loop that forgets to advance its counter (or compares the wrong operand) polls
   * forever and hangs the mount with no error anywhere — the worst failure shape this path has. The
   * poll count is pinned to the exact ceiling so an unbounded mutation cannot pass by running "a bit
   * longer"; the harness never really sleeps, so an unbounded version hangs THIS test, which is
   * itself the signal.
   */
  it('terminates in a bounded number of polls when ports never appear', async () => {
    const h = harness([0]);

    await awaitRunningPreview(h);

    expect(h.waits.length).toBe(Math.ceil(PORT_SETTLE_TIMEOUT_MS / PORT_SETTLE_POLL_MS));
  });

  /**
   * The window is a ceiling, not a target. `wait` is asked for `min(pollMs, remaining)` precisely so
   * a poll interval that does not divide the window cannot spill past it — a mount path that
   * overshoots its own advertised bound is a bound nobody can reason about.
   */
  it('never overshoots the window, even when pollMs does not divide it', async () => {
    const h = harness([0]);

    await awaitRunningPreview({ ...h, timeoutMs: 1000, pollMs: 300 });

    expect(h.totalWaited).toBeLessThanOrEqual(1000);
    expect(h.waits).toEqual([300, 300, 300, 100]);
  });

  it('honours a custom timeoutMs and pollMs', async () => {
    const h = harness([0]);

    await expect(awaitRunningPreview({ ...h, timeoutMs: 400, pollMs: 100 })).resolves.toBe(false);
    expect(h.waits).toEqual([100, 100, 100, 100]);
  });

  /**
   * A zero or negative poll interval is a busy-loop that never advances `elapsed` — i.e. an infinite
   * loop reached through a config typo rather than a code change. Clamped to >= 1, so the window
   * still expires; it just costs more iterations. Asserting termination matters far more than the
   * exact count.
   */
  it.each([0, -1, -250])('does not hang when pollMs is %i', async (pollMs) => {
    const h = harness([0]);

    await expect(awaitRunningPreview({ ...h, timeoutMs: 10, pollMs })).resolves.toBe(false);
    expect(h.waits.length).toBe(10);
    expect(h.totalWaited).toBeLessThanOrEqual(10);
  });

  /**
   * A degenerate window must be an immediate answer, not an immediate wait: the caller asked for no
   * grace period, so it gets none — and crucially it still gets an ANSWER rather than one stray poll.
   */
  it('answers immediately with no waits when the window is zero', async () => {
    const h = harness([0]);

    await expect(awaitRunningPreview({ ...h, timeoutMs: 0 })).resolves.toBe(false);
    expect(h.waits).toEqual([]);
  });

  /**
   * The counter is re-read on every poll rather than captured once — that IS the mechanism. Pinned
   * as a property so a "cache the count" simplification, which would make the late-arrival case
   * unreachable, fails here as well as above.
   */
  it('re-reads the preview count on every poll', async () => {
    const h = harness([0, 0, 1]);

    await awaitRunningPreview(h);

    expect(h.reads).toBe(3);
  });

  /** Defaults are the provider's replay schedule, not arbitrary numbers — pin them so a drift is visible. */
  it('exposes the sizes the wake path was tuned to', () => {
    expect(PORT_SETTLE_TIMEOUT_MS).toBe(5_000);
    expect(PORT_SETTLE_POLL_MS).toBe(250);
    expect(PORT_SETTLE_TIMEOUT_MS / PORT_SETTLE_POLL_MS).toBeGreaterThanOrEqual(4);
  });
});
