/**
 * The settle window between "project created" and "start building" (SPEC §4.4b, §4.2.8).
 *
 * This decides when the MOST EXPENSIVE generation in the product is allowed to start, so its two
 * failure modes are the familiar pair: too early hands the model a project that is still arriving (a
 * §4.2.8 context regression — throws nothing, costs nothing, just makes the build worse), and too late
 * is dead time on a spinner, or a New Project button that never returns.
 *
 * Driven with an INJECTED clock so the rules are asserted in milliseconds without waiting any.
 */
import { describe, expect, it } from 'vitest';
import { settleAfterCreation, SETTLE_MAX_MS, SETTLE_MIN_MS, SETTLE_QUIET_MS } from './settle';

/**
 * A fake clock whose `sleep` simply advances time. Every timing rule here is about ORDERING and
 * DURATION, neither of which needs a real timer — and a spec that actually slept would take 10s.
 */
function fakeClock() {
  let t = 0;

  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('settleAfterCreation', () => {
  /**
   * THE FLOOR. A watcher that has not delivered its first callback yet reports a count that is not
   * changing — indistinguishable from "finished" without a minimum. This is the exact shape of the
   * `waitForMountVisible` bug one step later: quiet because nothing has started, read as quiet because
   * everything is done.
   */
  it('never returns before the floor, even when the count never moves', async () => {
    const clock = fakeClock();
    const result = await settleAfterCreation({ readCount: () => 78, now: clock.now, sleep: clock.sleep });

    expect(result.elapsedMs).toBeGreaterThanOrEqual(SETTLE_MIN_MS);
    expect(result.quiesced).toBe(true);
  });

  /**
   * THE CEILING. A tree that keeps changing — a dev server writing into it, a chatty provider watcher —
   * must not hold the build forever. Degrade, never refuse (§1.3 principle 0): the files are already
   * VISIBLE by this point, so building is safe; waiting indefinitely is what is not.
   */
  it('gives up at the ceiling when the count never stops changing', async () => {
    const clock = fakeClock();
    let count = 0;

    const result = await settleAfterCreation({
      readCount: () => ++count,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.quiesced).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(SETTLE_MAX_MS);
    expect(result.elapsedMs).toBeLessThan(SETTLE_MAX_MS + 1_000);
  });

  /**
   * The point of quiescence over a fixed sleep: a tree still arriving at the floor keeps the wait open.
   * Files land until 7s here, so returning at the 5s floor would start the build mid-mount.
   */
  it('keeps waiting past the floor while files are still arriving', async () => {
    const clock = fakeClock();
    const result = await settleAfterCreation({
      readCount: () => (clock.now() < 7_000 ? Math.floor(clock.now() / 100) : 70),
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.elapsedMs).toBeGreaterThanOrEqual(7_000 + SETTLE_QUIET_MS);
    expect(result.quiesced).toBe(true);
    expect(result.finalCount).toBe(70);
  });

  /**
   * A late arrival RESTARTS the quiet window, so the wait outlives the floor.
   *
   * The change has to land BEFORE the floor to be observable at all — a file arriving after the floor
   * on an otherwise-quiet tree is a file that arrives after the build has already started, which is
   * what the floor accepts by design. One file at 4.5s therefore pushes the return to 4.5s + quiet,
   * not to the 5s floor.
   */
  it('resets the quiet window when the count changes again', async () => {
    const clock = fakeClock();

    const result = await settleAfterCreation({
      readCount: () => (clock.now() < 4_500 ? 40 : 41),
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.elapsedMs).toBeGreaterThanOrEqual(4_500 + SETTLE_QUIET_MS);
    expect(result.quiesced).toBe(true);
    expect(result.finalCount).toBe(41);
  });

  /** The caller narrates the wait from these ticks; a silent settle is a spinner with no story. */
  it('reports progress on every sample', async () => {
    const clock = fakeClock();
    const ticks: number[] = [];

    await settleAfterCreation({
      readCount: () => 12,
      now: clock.now,
      sleep: clock.sleep,
      onTick: (elapsed) => ticks.push(elapsed),
    });

    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks[0]).toBeLessThan(ticks[ticks.length - 1]);
  });

  /** The bounds are configurable so a test — or a future provider — is not stuck with the defaults. */
  it('honours explicit bounds', async () => {
    const clock = fakeClock();
    const result = await settleAfterCreation({
      readCount: () => 5,
      minMs: 500,
      maxMs: 2_000,
      quietMs: 200,
      pollMs: 100,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.elapsedMs).toBeGreaterThanOrEqual(500);
    expect(result.elapsedMs).toBeLessThan(2_000);
  });
});
