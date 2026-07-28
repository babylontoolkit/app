/**
 * The snapshot storm (SPEC §4.5.5, §4.16) — measured live on CodeSandbox 2026-07-27.
 *
 * `takeSnapshot` serializes the WHOLE project (every binary read + base64) and was called from the
 * 50ms message sampler, i.e. several times a second while a generation streamed. On a server sandbox
 * each read is a round trip, so passes piled up on top of each other until the sandbox's message
 * channel timed out — hundreds of `Pitcher message fs/readFile timed out` errors, an 870MB heap, and
 * a tab that crawled. Every test below is one way that storm comes back.
 */
import { describe, expect, it, vi } from 'vitest';
import { CoalescedTask } from './coalesce';

/** A controllable timer set, so the tests pin ordering rather than waiting on real time. */
function fakeTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;

  return {
    setTimer: (fn: () => void) => {
      const id = next++;
      pending.set(id, fn);

      return id;
    },
    clearTimer: (handle: unknown) => {
      pending.delete(handle as number);
    },

    /** Fire everything currently armed. */
    flush: () => {
      const fns = [...pending.values()];
      pending.clear();
      fns.forEach((fn) => fn());
    },
    count: () => pending.size,
  };
}

describe('CoalescedTask', () => {
  it('collapses a burst of requests into ONE run — the storm, directly', async () => {
    const timers = fakeTimers();
    const run = vi.fn().mockResolvedValue(undefined);

    const task = new CoalescedTask({ delayMs: 100, isBusy: () => false, run, ...timers });

    for (let i = 0; i < 200; i++) {
      task.request();
    }

    expect(run).not.toHaveBeenCalled();

    timers.flush();
    await Promise.resolve();

    expect(run).toHaveBeenCalledTimes(1);
  });

  /**
   * A timer alone cannot express "not while the stream is running": the trailing edge would fire
   * mid-generation and put the storm back. A busy tick must RE-ARM, never run.
   */
  it('defers while busy and runs once busy clears', async () => {
    const timers = fakeTimers();
    const run = vi.fn().mockResolvedValue(undefined);
    let busy = true;

    const task = new CoalescedTask({ delayMs: 100, isBusy: () => busy, run, ...timers });

    task.request();
    timers.flush();
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    expect(timers.count()).toBe(1); // re-armed, not dropped

    timers.flush();
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();

    busy = false;
    timers.flush();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 The re-entrancy guard. `run` is SLOWER than the window that schedules it — that is the entire
   * defect. A plain debounce still lets pass N+1 start while pass N is awaiting, which for a project
   * serialization means two full binary sweeps competing for one channel.
   */
  it('never starts a second run while the first is still in flight', async () => {
    const timers = fakeTimers();

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const run = vi.fn().mockReturnValue(blocked);
    const task = new CoalescedTask({ delayMs: 100, isBusy: () => false, run, ...timers });

    task.request();
    timers.flush();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);

    // Requests arriving mid-run must not start another pass.
    task.request();
    task.request();
    timers.flush();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);

    release();
    await Promise.resolve();
    await Promise.resolve();

    // ...but they are not LOST either: one more run is armed to serve them.
    expect(timers.count()).toBe(1);

    timers.flush();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('reports a failing run without throwing at the caller', async () => {
    const timers = fakeTimers();
    const onError = vi.fn();
    const run = vi.fn().mockRejectedValue(new Error('serialize failed'));

    const task = new CoalescedTask({ delayMs: 100, isBusy: () => false, run, onError, ...timers });

    task.request();
    expect(() => timers.flush()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'serialize failed' }));
  });

  /** Teardown: a pending write from an unmounted chat must not land on the one that replaced it. */
  it('cancel drops a pending run', async () => {
    const timers = fakeTimers();
    const run = vi.fn().mockResolvedValue(undefined);

    const task = new CoalescedTask({ delayMs: 100, isBusy: () => false, run, ...timers });

    task.request();
    task.cancel();
    timers.flush();
    await Promise.resolve();

    expect(run).not.toHaveBeenCalled();
  });
});
