/**
 * The media dispatch queue (`dispatch.ts`) — one render at a time, spaced, retried.
 *
 * Money-adjacent: the debit happens BEFORE this runs, so a retry that re-entered the debit path would
 * charge twice, and a queue that poisons itself would silently stop dispatching every later render in
 * the process (the measured `execution-queue.ts` bug).
 *
 * ⚠️ Every timing assertion drives an INJECTED clock. A spacing test against a real timer either takes
 * real seconds or is written with the spacing effectively disabled — and one that never advances a
 * clock passes with the spacing deleted, which is the vacuous-test trap this repo keeps re-learning.
 */
import { describe, expect, it, vi } from 'vitest';
import { createDispatchQueue, MEDIA_MAX_ATTEMPTS, MEDIA_RETRY_DELAYS_MS, MEDIA_SPACING_MS } from './dispatch';

/** A controllable clock: `sleep` advances it, so elapsed time is exactly what the queue asked for. */
function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];

  return {
    deps: {
      now: () => t,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
      },
    },
    sleeps,
    at: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('one at a time', () => {
  /*
   * 🔴 THE HEADLINE. Before this queue, N parallel generate_image calls meant N simultaneous POSTs to
   * KIE. The owner asked for one at a time; this asserts it as a fact about overlap, not about order.
   */
  it('never runs two creates concurrently', async () => {
    const clock = fakeClock();
    const dispatch = createDispatchQueue(clock.deps);

    let inFlight = 0;
    let maxInFlight = 0;

    const create = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;

      return 'ok';
    };

    await Promise.all([1, 2, 3, 4, 5].map((n) => dispatch(`t${n}`, create)));

    expect(maxInFlight).toBe(1);
  });

  it('dispatches in the order the calls arrived', async () => {
    const clock = fakeClock();
    const dispatch = createDispatchQueue(clock.deps);
    const order: string[] = [];

    await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        dispatch(id, async () => {
          order.push(id);
          return id;
        }),
      ),
    );

    expect(order).toEqual(['a', 'b', 'c']);
  });
});

describe('spaced out', () => {
  /*
   * The gap the owner asked for. Asserted on the injected clock, so it fails if the sleep is removed.
   */
  it('leaves at least MEDIA_SPACING_MS between dispatches', async () => {
    const clock = fakeClock();
    const dispatch = createDispatchQueue(clock.deps);
    const times: number[] = [];

    await Promise.all(
      [1, 2, 3].map((n) =>
        dispatch(`t${n}`, async () => {
          times.push(clock.at());
          return n;
        }),
      ),
    );

    expect(times[1] - times[0]).toBeGreaterThanOrEqual(MEDIA_SPACING_MS);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(MEDIA_SPACING_MS);
  });

  /*
   * Spacing is a DEADLINE, not a trailing delay: a create that already took longer than the gap owes
   * nothing. Without this the last render in a burst pays for spacing nobody needs, and a slow
   * provider compounds the wait on every image.
   */
  it('waits nothing when the previous create already outlasted the gap', async () => {
    const clock = fakeClock();
    const dispatch = createDispatchQueue(clock.deps);

    await dispatch('slow', async () => {
      clock.advance(MEDIA_SPACING_MS * 5);
      return 1;
    });

    const before = clock.at();
    await dispatch('next', async () => 2);

    expect(clock.at() - before).toBe(0);
  });

  it('does not sleep before the very first dispatch', async () => {
    const clock = fakeClock();
    const dispatch = createDispatchQueue(clock.deps);

    await dispatch('first', async () => 'x');

    expect(clock.sleeps).toEqual([]);
  });
});

describe('per-image retry', () => {
  /*
   * 🔴 Before this, a `create` that threw refunded and killed that image PERMANENTLY — one blip, one
   * lost render, no second attempt. Retries are per IMAGE, not per batch.
   */
  it('retries a failing create and succeeds on a later attempt', async () => {
    const clock = fakeClock();
    const dispatch = createDispatchQueue(clock.deps);
    const create = vi.fn().mockRejectedValueOnce(new Error('KIE blip')).mockResolvedValueOnce('task-123');

    await expect(dispatch('img', create)).resolves.toBe('task-123');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('gives up after MEDIA_MAX_ATTEMPTS and rethrows the LAST error, so the caller refunds', async () => {
    const clock = fakeClock();
    const dispatch = createDispatchQueue(clock.deps);
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockRejectedValueOnce(new Error('final'));

    await expect(dispatch('img', create)).rejects.toThrow('final');
    expect(create).toHaveBeenCalledTimes(MEDIA_MAX_ATTEMPTS);
  });

  it('backs off between attempts', async () => {
    const clock = fakeClock();
    const dispatch = createDispatchQueue(clock.deps);

    await dispatch('img', vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce('ok'));

    expect(clock.sleeps).toContain(MEDIA_RETRY_DELAYS_MS[0]);
  });
});

describe('a failure never poisons the queue', () => {
  /*
   * 🔴 `execution-queue.ts`'s measured bug, one character away: `.then(work)` on a rejected chain
   * forwards the rejection, and every later dispatch in the process is then never invoked AT ALL —
   * not delayed, not retried. Silent, permanent, and it would look exactly like "renders stopped
   * working after a while".
   */
  it('keeps dispatching after a task exhausts its retries', async () => {
    const clock = fakeClock();
    const dispatch = createDispatchQueue(clock.deps);

    await expect(dispatch('doomed', vi.fn().mockRejectedValue(new Error('always')))).rejects.toThrow('always');

    await expect(dispatch('after', async () => 'still works')).resolves.toBe('still works');
    await expect(dispatch('after2', async () => 'and again')).resolves.toBe('and again');
  });

  /*
   * The CONTROL for the test above: with several queued at once, a failure in the middle must not
   * take the ones behind it. A queue that only recovers when the failure is the LAST call would pass
   * the previous test.
   */
  it('CONTROL: a failure mid-queue does not drop the calls behind it', async () => {
    const clock = fakeClock();
    const dispatch = createDispatchQueue(clock.deps);
    const done: string[] = [];

    const results = await Promise.allSettled([
      dispatch('a', async () => {
        done.push('a');
        return 'a';
      }),
      dispatch('b', vi.fn().mockRejectedValue(new Error('boom'))),
      dispatch('c', async () => {
        done.push('c');
        return 'c';
      }),
    ]);

    expect(done).toEqual(['a', 'c']);
    expect(results[1].status).toBe('rejected');
    expect(results[2].status).toBe('fulfilled');
  });
});

describe('isolation', () => {
  /*
   * `createDispatchQueue` exists so tests do not share the module-level production queue. If they did,
   * one spec's spacing deadline would leak into the next and the failures would be order-dependent.
   */
  it('gives each queue its own state', async () => {
    const a = fakeClock();
    const b = fakeClock();

    await createDispatchQueue(a.deps)('x', async () => 1);
    await createDispatchQueue(b.deps)('y', async () => 2);

    expect(a.sleeps).toEqual([]);
    expect(b.sleeps).toEqual([]);
  });
});
