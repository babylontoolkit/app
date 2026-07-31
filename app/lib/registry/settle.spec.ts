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
import {
  settleAfterCreation,
  IMPORT_SETTLE_OPTIONS,
  MOUNT_SETTLE_OPTIONS,
  SETTLE_MAX_MS,
  SETTLE_MIN_MS,
  SETTLE_QUIET_MS,
} from './settle';

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

/**
 * `minCount` — the second half of the floor, added when this primitive was reused for the MOUNT tail.
 *
 * The floor answers "has enough time passed"; this answers "has anything actually arrived". Creation
 * only ever needed the first because it has just written the entire starter itself, so the map is full
 * before the wait begins. A mount is not like that: the branch that restores nothing (no local
 * checkpoint, no working copy, no seed) leaves the watcher as the map's only writer, and a watcher
 * whose first event lands after the floor is quiet for precisely the reason the floor exists —
 * nothing has started. Without this the wait would end on an EMPTY workspace and hand the user the
 * file-by-file trickle it was added to hide.
 */
describe('settleAfterCreation — minCount', () => {
  it('never calls an empty map quiet, however long it has been still', async () => {
    const clock = fakeClock();

    const result = await settleAfterCreation({
      readCount: () => 0,
      minCount: 1,
      now: clock.now,
      sleep: clock.sleep,
    });

    // Only the ceiling could have ended this — quiescence was not available at any point.
    expect(result.quiesced).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(SETTLE_MAX_MS);
  });

  /**
   * The wait must survive a watcher that starts LATE, which is the whole scenario. Files begin arriving
   * at 6s — past the default floor — so a `minCount`-less settle would have returned at 5s reporting a
   * successful, quiesced, completely empty workspace.
   */
  it('waits for a late watcher and then settles normally', async () => {
    const clock = fakeClock();

    const result = await settleAfterCreation({
      readCount: () => (clock.now() < 6_000 ? 0 : 88),
      minCount: 1,
      maxMs: 30_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.quiesced).toBe(true);
    expect(result.finalCount).toBe(88);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(6_000);
  });

  /**
   * CONTROL — the same late-watcher timeline WITHOUT `minCount` returns early on an empty map. Without
   * this the test above passes just as happily against a build where `minCount` does nothing at all.
   */
  it('CONTROL: the same timeline returns empty at the floor when minCount is not set', async () => {
    const clock = fakeClock();

    const result = await settleAfterCreation({
      readCount: () => (clock.now() < 6_000 ? 0 : 88),
      maxMs: 30_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.quiesced).toBe(true);
    expect(result.finalCount).toBe(0);
    expect(result.elapsedMs).toBeLessThan(6_000);
  });

  /** Creation passes no `minCount`, so its behaviour must be byte-identical to before. */
  it('defaults to 0, leaving the creation profile unchanged', async () => {
    const clock = fakeClock();
    const result = await settleAfterCreation({ readCount: () => 0, now: clock.now, sleep: clock.sleep });

    expect(result.quiesced).toBe(true);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(SETTLE_MIN_MS);
    expect(result.elapsedMs).toBeLessThan(SETTLE_MAX_MS);
  });
});

/**
 * The two reused profiles. Their NUMBERS are judgement calls and not worth pinning; their SHAPE is
 * not — each one exists because a specific wrong answer was measured, and each of these assertions is
 * the one that would fail if the profile were quietly reverted to the creation defaults.
 */
describe('the mount and import profiles', () => {
  it('gives the mount tail a shorter floor than creation, and a count minimum', async () => {
    expect(MOUNT_SETTLE_OPTIONS.minMs).toBeLessThan(SETTLE_MIN_MS);
    expect(MOUNT_SETTLE_OPTIONS.minCount).toBeGreaterThan(0);
    expect(MOUNT_SETTLE_OPTIONS.maxMs).toBeGreaterThan(MOUNT_SETTLE_OPTIONS.minMs);
  });

  /**
   * The import floor is the LONGEST of the three, and deliberately so: on that door the map is often
   * already filling from disk when the wait starts, while the artifact replay that writes the imported
   * files cannot begin until the chat has rendered. A short floor would settle in the gap between them.
   */
  it('gives the import tail the longest floor and the most patient ceiling', async () => {
    expect(IMPORT_SETTLE_OPTIONS.minMs).toBeGreaterThan(MOUNT_SETTLE_OPTIONS.minMs);
    expect(IMPORT_SETTLE_OPTIONS.quietMs).toBeGreaterThan(MOUNT_SETTLE_OPTIONS.quietMs);
    expect(IMPORT_SETTLE_OPTIONS.maxMs).toBeGreaterThan(MOUNT_SETTLE_OPTIONS.maxMs);
    expect(IMPORT_SETTLE_OPTIONS.minCount).toBeGreaterThan(0);
  });

  /** Every profile is bounded. An unbounded one is a permanent splash over a usable workspace. */
  it('bounds both profiles', async () => {
    for (const profile of [MOUNT_SETTLE_OPTIONS, IMPORT_SETTLE_OPTIONS]) {
      expect(Number.isFinite(profile.maxMs)).toBe(true);
      expect(profile.maxMs).toBeGreaterThan(profile.minMs);
      expect(profile.maxMs).toBeLessThanOrEqual(60_000);
    }
  });
});
