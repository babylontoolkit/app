/**
 * The save queue (SPEC §4.5.4b).
 *
 * Auto-push means the platform saves the user's work without being asked, which makes the failure mode
 * the whole design problem: **a save that fails silently is worse than no auto-save at all**, because
 * the user stops thinking about saving and we stop doing it. §4.5.4b puts it plainly — a failed save is
 * LOUD, with a visible retry.
 *
 * So this is a queue rather than a fire-and-forget call, and the state it exposes is the point:
 *
 *   - `idle`    — nothing to do.
 *   - `saving`  — in flight.
 *   - `retrying`— it failed for a reason that might pass (rate limit, transport). Counting down.
 *   - `failed`  — it failed for a reason that will not pass. The user must act, and can see so.
 *
 * ## Rules that are not obvious
 *
 * **One save in flight per project, ever.** Two concurrent pushes to the same branch means the second
 * one's fast-forward check races the first one's commit — one of them loses, reports a spurious
 * divergence, and asks the user to resolve a conflict they did not create. A save requested while one
 * is running sets a flag; the running save picks it up when it finishes.
 *
 * **The queue never holds files.** It re-reads them at the moment it pushes, via the callback. Files
 * captured at enqueue time are stale by the time a retry runs 30 seconds later — and pushing them
 * would silently revert whatever the user did in between.
 *
 * **Only retryable failures retry.** A revoked token retried four times is four ways to waste the
 * user's time before showing the re-connect prompt they needed immediately (`GitProviderError.kind`
 * already carries this distinction; do not re-derive it here).
 */
import { atom } from 'nanostores';
import type { SaveOutcome } from './projects';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('SaveQueue');

export type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'retrying'; attempt: number; nextAttemptAt: number; message: string }
  | { status: 'failed'; message: string; reconnect?: boolean };

export const saveState = atom<SaveState>({ status: 'idle' });

/** Backoff between retries. Bounded: after this many attempts it is a `failed` the user must see. */
export const RETRY_DELAYS_MS = [2_000, 8_000, 30_000];

interface QueueOptions {
  /** Re-read the project and push it. Called at push time, never at enqueue time — see the header. */
  push: () => Promise<SaveOutcome>;

  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A save queue for ONE project.
 *
 * Deliberately not a singleton: the state is per-project, and a module-level queue would carry one
 * project's `failed` badge into the next project the user opens.
 */
export class SaveQueue {
  private _running = false;
  private _requestedAgain = false;
  private readonly _sleep: (ms: number) => Promise<void>;
  private readonly _now: () => number;

  constructor(private readonly _options: QueueOptions) {
    this._sleep = _options.sleep ?? defaultSleep;
    this._now = _options.now ?? Date.now;
  }

  /**
   * Ask for a save.
   *
   * Returns when this save (and any coalesced follow-up) has settled. If one is already running, the
   * request is coalesced into it rather than starting a second — see the header.
   */
  async request(): Promise<SaveOutcome | undefined> {
    if (this._running) {
      /*
       * Coalesce. The in-flight save re-reads the files when it pushes, so a request that arrives
       * mid-push is often already satisfied by it — but not always (the files may have changed after
       * it read them), so the flag makes it go round once more rather than assuming.
       */
      this._requestedAgain = true;

      return undefined;
    }

    this._running = true;

    try {
      let outcome = await this._attempt();

      while (this._requestedAgain) {
        this._requestedAgain = false;
        outcome = await this._attempt();
      }

      return outcome;
    } finally {
      this._running = false;
    }
  }

  /** Push, retrying only what is worth retrying, and leaving the state honest whatever happens. */
  private async _attempt(): Promise<SaveOutcome> {
    let outcome: SaveOutcome = { ok: false };

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      saveState.set({ status: 'saving' });

      try {
        outcome = await this._options.push();
      } catch (error) {
        // The push callback should not throw, but a save path may not depend on that being true.
        outcome = { ok: false, retryable: true, message: (error as Error).message };
      }

      if (outcome.ok) {
        saveState.set({ status: 'idle' });
        return outcome;
      }

      /*
       * A divergence is NOT a failure to retry — retrying is guaranteed to diverge again, forever. It
       * is a question for the user (§4.13), so it settles immediately and the caller raises the
       * two-button choice.
       */
      if (outcome.divergence) {
        saveState.set({ status: 'idle' });
        return outcome;
      }

      const isLast = attempt === RETRY_DELAYS_MS.length;

      if (!outcome.retryable || isLast) {
        const message = outcome.message ?? 'Could not save your work.';

        saveState.set({ status: 'failed', message, reconnect: outcome.reconnect });
        logger.error(`Save failed${outcome.retryable ? ' after retries' : ''}: ${message}`);

        return outcome;
      }

      const delay = RETRY_DELAYS_MS[attempt];

      saveState.set({
        status: 'retrying',
        attempt: attempt + 1,
        nextAttemptAt: this._now() + delay,
        message: outcome.message ?? 'Could not save — trying again.',
      });

      await this._sleep(delay);
    }

    return outcome;
  }
}
