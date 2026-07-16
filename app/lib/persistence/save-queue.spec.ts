/**
 * The save queue (SPEC §4.5.4b).
 *
 * Auto-push saves the user's work without being asked, which is what makes silence the enemy: once we
 * save for them, they stop saving for themselves. So every path below ends in a state the UI can show,
 * and the tests are mostly about the paths that could end in nothing.
 *
 * The queue spends no money and touches no bytes, which is exactly why it needs tests — nothing about
 * it breaks loudly. It just quietly stops saving.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { RETRY_DELAYS_MS, SaveQueue, saveState } from './save-queue';
import type { SaveOutcome } from './projects';

/** Runs backoff instantly, and records what the delays WOULD have been. */
function harness(outcomes: SaveOutcome[]) {
  const slept: number[] = [];
  const pushes: number[] = [];
  let clock = 1_000;

  const queue = new SaveQueue({
    push: async () => {
      pushes.push(clock);
      return outcomes[Math.min(pushes.length - 1, outcomes.length - 1)];
    },
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    now: () => clock,
  });

  return { queue, slept, pushes };
}

const ok: SaveOutcome = { ok: true, commitSha: 'abc123' };

/** Backoff, instantly. These tests assert on control flow, not on wall-clock. */
const noSleep = async () => undefined;

beforeEach(() => {
  saveState.set({ status: 'idle' });
});

describe('the happy path', () => {
  it('saves once and lands back at idle', async () => {
    const h = harness([ok]);

    expect(await h.queue.request()).toMatchObject({ ok: true });
    expect(h.pushes).toHaveLength(1);
    expect(saveState.get()).toEqual({ status: 'idle' });
    expect(h.slept).toEqual([]);
  });
});

describe('retryable failures', () => {
  it('retries and succeeds, ending idle', async () => {
    const h = harness([{ ok: false, retryable: true, message: 'rate limited' }, ok]);

    expect(await h.queue.request()).toMatchObject({ ok: true });
    expect(h.pushes).toHaveLength(2);
    expect(saveState.get()).toEqual({ status: 'idle' });
  });

  it('backs off progressively rather than hammering', async () => {
    const h = harness([{ ok: false, retryable: true }]);
    await h.queue.request();

    expect(h.slept).toEqual(RETRY_DELAYS_MS);
  });

  /**
   * 🔴 The one that matters. After the retries are exhausted the user MUST be able to see that their
   * work is not saved — a queue that gives up quietly is worse than never having auto-saved.
   */
  it('ends in a VISIBLE failure rather than giving up quietly', async () => {
    const h = harness([{ ok: false, retryable: true, message: 'GitHub is down' }]);

    expect(await h.queue.request()).toMatchObject({ ok: false });
    expect(h.pushes).toHaveLength(RETRY_DELAYS_MS.length + 1);
    expect(saveState.get()).toMatchObject({ status: 'failed', message: 'GitHub is down' });
  });

  it('reports what it is doing while it waits', async () => {
    const states: string[] = [];
    const unsubscribe = saveState.subscribe((s) => states.push(s.status));

    await harness([{ ok: false, retryable: true }, ok]).queue.request();
    unsubscribe();

    expect(states).toContain('saving');
    expect(states).toContain('retrying');
    expect(states[states.length - 1]).toBe('idle');
  });
});

describe('terminal failures', () => {
  /** Hammering a revoked token is four ways to delay the prompt the user needed immediately. */
  it('does NOT retry an auth failure — it asks for a re-connect', async () => {
    const h = harness([{ ok: false, retryable: false, reconnect: true, message: 'Your connection expired.' }]);

    await h.queue.request();

    expect(h.pushes).toHaveLength(1);
    expect(h.slept).toEqual([]);
    expect(saveState.get()).toMatchObject({ status: 'failed', reconnect: true });
  });

  it('does not retry any non-retryable failure', async () => {
    const h = harness([{ ok: false, retryable: false, message: 'That repository is gone.' }]);
    await h.queue.request();

    expect(h.pushes).toHaveLength(1);
    expect(saveState.get()).toMatchObject({ status: 'failed', message: 'That repository is gone.' });
  });

  /**
   * A divergence retried is a divergence forever — the remote does not move back. It is a question for
   * the user (§4.13), not an error to grind against.
   */
  it('settles a divergence immediately instead of retrying into it', async () => {
    const h = harness([{ ok: false, divergence: true, retryable: true }]);

    expect(await h.queue.request()).toMatchObject({ divergence: true });
    expect(h.pushes).toHaveLength(1);
    expect(h.slept).toEqual([]);

    // Not `failed`: nothing went wrong. The caller raises the two-button choice.
    expect(saveState.get()).toEqual({ status: 'idle' });
  });

  it('treats a thrown push as retryable rather than dying', async () => {
    const queue = new SaveQueue({
      push: async () => {
        throw new Error('network exploded');
      },
      sleep: noSleep,
    });

    await queue.request();

    expect(saveState.get()).toMatchObject({ status: 'failed', message: 'network exploded' });
  });
});

describe('concurrency — one save in flight per project', () => {
  /**
   * Two concurrent pushes to one branch means the second's fast-forward check races the first's
   * commit: one loses and reports a divergence the user did not create and cannot understand.
   */
  it('never runs two saves at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const queue = new SaveQueue({
      push: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;

        return ok;
      },
      sleep: noSleep,
    });

    await Promise.all([queue.request(), queue.request(), queue.request()]);

    expect(maxInFlight).toBe(1);
  });

  /**
   * Coalescing must not mean DROPPING. A request that arrives while a save is running may carry work
   * the running save had already read past — so the queue goes round once more.
   */
  it('runs again for work that arrived mid-save', async () => {
    let pushes = 0;
    const queue: SaveQueue = new SaveQueue({
      push: async () => {
        pushes++;

        // Arrives while the first push is in flight.
        if (pushes === 1) {
          void queue.request();
        }

        return ok;
      },
      sleep: noSleep,
    });

    await queue.request();

    expect(pushes).toBe(2);
  });

  it('goes round only once however many requests pile up', async () => {
    let pushes = 0;
    const queue: SaveQueue = new SaveQueue({
      push: async () => {
        pushes++;

        if (pushes === 1) {
          void queue.request();
          void queue.request();
          void queue.request();
        }

        return ok;
      },
      sleep: noSleep,
    });

    await queue.request();

    // Three coalesced requests are one follow-up, not three.
    expect(pushes).toBe(2);
  });

  it('is reusable after a failure', async () => {
    const outcomes: SaveOutcome[] = [{ ok: false, retryable: false, message: 'nope' }];
    const queue = new SaveQueue({ push: async () => outcomes[0], sleep: noSleep });

    await queue.request();
    expect(saveState.get()).toMatchObject({ status: 'failed' });

    outcomes[0] = ok;
    await queue.request();

    expect(saveState.get()).toEqual({ status: 'idle' });
  });
});
