/**
 * "Is the artifact actually FINISHED?" — the difference between the model stopping and the project
 * being written (SPEC §4.4, §4.2).
 *
 * ## The bug this exists for (reported live 2026-07-27)
 *
 * The creation celebration — `🎮 Your game is ready — open Preview to play it` — fired from `onFinish`,
 * i.e. the moment the model's TEXT STREAM ended. But the text is not the work: each `<boltAction>` is
 * queued and executed against the sandbox afterwards, and on a server sandbox every file write is a
 * round trip rather than a memory write. Observed: the chat showed the model's closing summary in the
 * past tense ("I gave First-Person Explorer a cohesive expedition-survey direction…") and a success
 * toast, while the artifact card still had a spinner on `Write src/custom/splash.css`.
 *
 * So the product announced a finished game while it was still writing the splash screen, and told the
 * user to open a preview that was mid-rebuild. Both halves are wrong, and the second is worse: it sends
 * someone to look at a half-written project and decide the build is broken.
 *
 * ## The rule
 *
 * A generation is DONE when its stream has ended AND every action it queued has reached a terminal
 * state. `complete`, `failed` and `aborted` are all terminal — a failed write is still not "in flight",
 * and waiting for it to become `complete` would hang forever on exactly the turn that needs a message.
 *
 * Pure, so the terminal-state rule is testable without a sandbox, a runner, or a real clock. The waiter
 * takes its clock and its poll from the caller for the same reason.
 */
import type { ActionStatus } from './action-runner';

/** Terminal = not going to change again. NOT the same as "succeeded" — see the module note. */
const TERMINAL: ActionStatus[] = ['complete', 'failed', 'aborted'];

export function isActionSettled(status: ActionStatus): boolean {
  return TERMINAL.includes(status);
}

/**
 * Every action across every artifact of this turn, settled?
 *
 * An empty list is settled by definition: a prose-only turn queues nothing, and blocking on it would
 * mean a chat answer never reports completion.
 */
export function actionsSettled(statuses: ActionStatus[]): boolean {
  return statuses.every(isActionSettled);
}

/** How many are still in flight — for a "writing 3 more files…" style message, and for logging. */
export function pendingActionCount(statuses: ActionStatus[]): number {
  return statuses.filter((status) => !isActionSettled(status)).length;
}

export interface WaitForActionsOptions {
  /** Snapshot the statuses of every action the turn queued. */
  readStatuses: () => ActionStatus[];

  /**
   * Hard ceiling. A runner that never settles (a wedged sandbox, a dropped websocket) must not swallow
   * the completion message entirely — §1.3 principle 0: degrade, never refuse. Reaching it is reported,
   * not thrown.
   */
  timeoutMs?: number;

  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ActionsSettledResult {
  settled: boolean;
  waitedMs: number;
  stillPending: number;
}

export async function waitForActionsSettled(options: WaitForActionsOptions): Promise<ActionsSettledResult> {
  const {
    readStatuses,
    timeoutMs = 120_000,
    pollMs = 250,
    now = () => Date.now(),
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = options;

  const startedAt = now();

  for (;;) {
    const statuses = readStatuses();

    if (actionsSettled(statuses)) {
      return { settled: true, waitedMs: now() - startedAt, stillPending: 0 };
    }

    if (now() - startedAt >= timeoutMs) {
      return { settled: false, waitedMs: now() - startedAt, stillPending: pendingActionCount(statuses) };
    }

    await sleep(pollMs);
  }
}
