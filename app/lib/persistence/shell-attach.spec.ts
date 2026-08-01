/**
 * The wait that stands between a resumed project and an empty terminal (`shell-attach.ts`).
 *
 * 🔴 Both wrong answers are SILENT, and they fail in opposite directions:
 *
 *   - not waiting at all → `executeCommand` returns `undefined`, the install is skipped, and the
 *     project mounts complete, correct and dead: no `node_modules`, no dev server, no preview, no
 *     error (MEASURED live 2026-07-31 on Nodepod, 90s with nothing happening);
 *   - waiting forever → a terminal that never attaches (the workbench can stay closed) hangs the
 *     whole mount, trading a project that does not RUN for a project that does not OPEN.
 *
 * The clock is injected so this is exhaustive and instant. Timers here would make the suite slow and
 * flaky, and a flaky test on a silent defect is worse than none.
 */
import { describe, expect, it, vi } from 'vitest';
import { SHELL_ATTACH_POLL_MS, SHELL_ATTACH_TIMEOUT_MS, awaitShellAttached } from './shell-attach';

/** A clock whose time only advances when the code under test actually waits. */
function fakeClock() {
  let time = 0;
  const waits: number[] = [];

  return {
    now: () => time,
    wait: async (ms: number) => {
      waits.push(ms);
      time += ms;
    },
    waits,
    elapsed: () => time,
  };
}

describe('awaitShellAttached', () => {
  /* The common case: the workbench already rendered, so this must not cost a single tick. */
  it('answers immediately when the shell is already attached', async () => {
    const clock = fakeClock();

    await expect(awaitShellAttached({ attached: () => true, wait: clock.wait, now: clock.now })).resolves.toBe(true);

    expect(clock.waits).toEqual([]);
    expect(clock.elapsed()).toBe(0);
  });

  it('resolves true once the shell attaches part-way through the wait', async () => {
    const clock = fakeClock();
    let attached = false;

    const promise = awaitShellAttached({
      attached: () => {
        const answer = attached;
        attached = true; // attaches on the second poll

        return answer;
      },
      wait: clock.wait,
      now: clock.now,
    });

    await expect(promise).resolves.toBe(true);
    expect(clock.elapsed()).toBeLessThan(SHELL_ATTACH_TIMEOUT_MS);
  });

  /*
   * 🔴 The bound. A terminal that never attaches must not hang the mount — the mount is what makes
   * the project openable at all, and an unopenable project is strictly worse than a non-running one.
   */
  it('gives up rather than waiting forever when the terminal never attaches', async () => {
    const clock = fakeClock();

    await expect(awaitShellAttached({ attached: () => false, wait: clock.wait, now: clock.now })).resolves.toBe(false);

    expect(clock.elapsed()).toBeGreaterThanOrEqual(SHELL_ATTACH_TIMEOUT_MS);
  });

  it('bounds the total wait to the timeout, not to the number of polls', async () => {
    const clock = fakeClock();

    await awaitShellAttached({ attached: () => false, wait: clock.wait, now: clock.now });

    // Every wait is one poll interval, and they stop as soon as the budget is spent.
    expect(clock.waits.every((ms) => ms === SHELL_ATTACH_POLL_MS)).toBe(true);
    expect(clock.elapsed()).toBeLessThanOrEqual(SHELL_ATTACH_TIMEOUT_MS + SHELL_ATTACH_POLL_MS);
  });

  it('honours caller-supplied bounds', async () => {
    const clock = fakeClock();

    await awaitShellAttached({
      attached: () => false,
      wait: clock.wait,
      now: clock.now,
      timeoutMs: 500,
      pollMs: 100,
    });

    expect(clock.waits).toEqual([100, 100, 100, 100, 100]);
  });

  /*
   * The predicate is polled, never cached: a shell that attaches is observed on the NEXT poll. This
   * asserts it is actually called more than once, because a version that read it into a variable once
   * would pass every test above that starts attached and hang forever on the real path.
   */
  it('re-reads the predicate on every poll', async () => {
    const clock = fakeClock();
    const attached = vi.fn(() => false);

    await awaitShellAttached({ attached, wait: clock.wait, now: clock.now, timeoutMs: 300, pollMs: 100 });

    expect(attached.mock.calls.length).toBeGreaterThan(1);
  });

  /* A timeout of zero means "check once and do not wait" — not "wait forever". */
  it('checks exactly once with a zero timeout', async () => {
    const clock = fakeClock();

    await expect(
      awaitShellAttached({ attached: () => false, wait: clock.wait, now: clock.now, timeoutMs: 0 }),
    ).resolves.toBe(false);

    expect(clock.waits).toEqual([]);
  });

  /*
   * 🔴 The budget must clear a full project RESTORE, not just a React render.
   *
   * The terminal cannot attach until the workbench renders, and the workbench does not render until
   * the mount finishes — MEASURED live on a 76-file resume: workbench, xterm and shell process all
   * appeared at 22,433 ms, the same millisecond, because they are one event. The first version of
   * this bound was 20s and lost that race by 2.4 seconds, silently. A bigger project loses by more,
   * so the floor here is deliberately several times the measured figure.
   *
   * It stays bounded only so a terminal that never attaches (the workbench can stay closed) cannot
   * leak a task that waits forever — the wait no longer blocks the mount, so being generous is cheap.
   */
  it('defaults to a budget several times the measured worst case, but still bounded', () => {
    expect(SHELL_ATTACH_TIMEOUT_MS).toBeGreaterThanOrEqual(90_000);
    expect(SHELL_ATTACH_TIMEOUT_MS).toBeLessThanOrEqual(10 * 60_000);
  });
});
