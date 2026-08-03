/**
 * When is a turn actually finished? (SPEC §4.4)
 *
 * Reported live 2026-07-27: the creation success toast fired on `onFinish` — the model's stream ending —
 * while the artifact card still had a spinner on `Write src/chrome/splash.css`. The product announced a
 * finished game while it was writing the splash screen, and pointed the user at a preview that was
 * mid-rebuild. Every rule below is one way that message can be wrong again.
 */
import { describe, expect, it } from 'vitest';
import {
  actionsSettled,
  isActionSettled,
  pendingActionCount,
  settleableStatuses,
  waitForActionsSettled,
} from './actions-settled';

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

/**
 * 🔴 THE DEV SERVER IS NOT AN UNFINISHED FILE WRITE.
 *
 * A `start` action (`npm run dev`) never exits, so the runner leaves it `running` for the whole session,
 * and artifacts are never removed from the workbench store. Once creation stopped firing the build
 * (§4.4a), every later turn's `onFinish` therefore read a tab that still held the creation setup
 * artifact — so "has this turn settled?" was permanently NO. The game-ready message could never fire,
 * and 120s later the honest "still writing 1 file(s)" variant fired instead, about a dev server that was
 * serving perfectly. The message that exists to avoid over-claiming would have become the only message
 * the product ever showed, permanently, and wrong.
 *
 * These tests are the difference between "the rule is written down" and "the rule is enforced" — and the
 * shape of the mistake matters: excluding a long-lived action is not a loosening, because a `start`
 * reaching a terminal state means the server DIED.
 */
describe('settleableStatuses', () => {
  it('drops a running `start` — a live dev server is success, not work in flight', () => {
    expect(settleableStatuses([{ type: 'start', status: 'running' }])).toEqual([]);
  });

  /** The whole point of the filter: a turn whose own writes are done is DONE, dev server or not. */
  it('makes the real tab settle — creation setup artifact plus a finished write', () => {
    const statuses = settleableStatuses([
      { type: 'shell', status: 'complete' },
      { type: 'start', status: 'running' },
      { type: 'file', status: 'complete' },
    ]);

    expect(statuses).toEqual(['complete', 'complete']);
    expect(actionsSettled(statuses)).toBe(true);
  });

  /**
   * 🔴 THE CONTROL. Filtering by TYPE, not by "things that never finish": a `shell` or a `file` still in
   * flight is exactly what the wait exists for, and a filter that swallowed those would restore the
   * original 2026-07-27 bug — announcing a finished game mid-write — while looking like this fix.
   */
  it('keeps a running shell and a running file — those really are in flight', () => {
    const statuses = settleableStatuses([
      { type: 'shell', status: 'running' },
      { type: 'file', status: 'pending' },
      { type: 'start', status: 'running' },
    ]);

    expect(statuses).toEqual(['running', 'pending']);
    expect(actionsSettled(statuses)).toBe(false);
    expect(pendingActionCount(statuses)).toBe(2);
  });

  /**
   * A terminal `start` is dropped too, and deliberately: it means the server exited, which is a preview
   * problem the alert system reports — never a reason to hold up (or fail) the completion message.
   */
  it('drops a `start` whatever its status, terminal included', () => {
    for (const status of ['complete', 'failed', 'aborted', 'pending'] as const) {
      expect(settleableStatuses([{ type: 'start', status }])).toEqual([]);
    }
  });

  it('an empty list stays empty — a prose-only turn queues nothing', () => {
    expect(settleableStatuses([])).toEqual([]);
    expect(actionsSettled(settleableStatuses([]))).toBe(true);
  });

  /** Mixed, in order, with the count the "still writing N file(s)" message quotes. */
  it('a mid-write build counts its writes and never the dev server', () => {
    const statuses = settleableStatuses([
      { type: 'shell', status: 'complete' },
      { type: 'start', status: 'running' },
      { type: 'file', status: 'complete' },
      { type: 'file', status: 'running' },
      { type: 'file', status: 'pending' },
      { type: 'start', status: 'running' },
    ]);

    expect(statuses).toEqual(['complete', 'complete', 'running', 'pending']);
    expect(pendingActionCount(statuses)).toBe(2);
  });
});

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
