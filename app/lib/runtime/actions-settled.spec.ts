/**
 * When is a turn actually finished? (SPEC §4.4)
 *
 * Reported live 2026-07-27: the creation success toast fired on `onFinish` — the model's stream ending —
 * while the artifact card still had a spinner on `Write src/custom/splash.css`. The product announced a
 * finished game while it was writing the splash screen, and pointed the user at a preview that was
 * mid-rebuild. Every rule below is one way that message can be wrong again.
 */
import { describe, expect, it } from 'vitest';
import { actionsSettled, isActionSettled, pendingActionCount, waitForActionsSettled } from './actions-settled';

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe('actionsSettled', () => {
  it('is false while any action is still pending or running — the reported bug', () => {
    expect(actionsSettled(['complete', 'complete', 'running'])).toBe(false);
    expect(actionsSettled(['complete', 'pending'])).toBe(false);
  });

  /**
   * `failed` and `aborted` are TERMINAL, not successful. Waiting for `complete` would hang forever on
   * the turn that most needs a message — a build whose last write failed.
   */
  it('treats failed and aborted as settled — terminal is not the same as succeeded', () => {
    expect(isActionSettled('failed')).toBe(true);
    expect(isActionSettled('aborted')).toBe(true);
    expect(actionsSettled(['complete', 'failed', 'aborted'])).toBe(true);
  });

  /** A prose-only turn queues nothing; blocking on an empty list would mean it never reports done. */
  it('treats an empty list as settled', () => {
    expect(actionsSettled([])).toBe(true);
  });

  it('counts what is still in flight, for an honest message', () => {
    expect(pendingActionCount(['complete', 'running', 'pending', 'failed'])).toBe(2);
    expect(pendingActionCount(['complete', 'failed'])).toBe(0);
  });
});

describe('waitForActionsSettled', () => {
  it('resolves as soon as the last write lands', async () => {
    const clock = fakeClock();
    let calls = 0;

    const result = await waitForActionsSettled({
      readStatuses: () => (++calls < 4 ? ['complete', 'running'] : ['complete', 'complete']),
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.settled).toBe(true);
    expect(result.stillPending).toBe(0);
  });

  /**
   * A runner that never settles — a wedged sandbox, a dropped socket — must not swallow the completion
   * message entirely (§1.3 principle 0: degrade, never refuse). It reports what is still outstanding so
   * the caller can say something true instead of claiming the game is ready.
   */
  it('gives up at the ceiling and reports what is still outstanding', async () => {
    const clock = fakeClock();

    const result = await waitForActionsSettled({
      readStatuses: () => ['complete', 'running', 'pending'],
      timeoutMs: 5_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.settled).toBe(false);
    expect(result.stillPending).toBe(2);
    expect(result.waitedMs).toBeGreaterThanOrEqual(5_000);
  });

  /** The common case: nothing queued, so it must not cost a single poll interval. */
  it('returns immediately when there is nothing to wait for', async () => {
    const clock = fakeClock();
    const result = await waitForActionsSettled({ readStatuses: () => [], now: clock.now, sleep: clock.sleep });

    expect(result.settled).toBe(true);
    expect(result.waitedMs).toBe(0);
  });
});
