/**
 * The checkpoint attempt as a POLICY, not an inline prayer (T17c, SPEC §4.12, §4.5.4c).
 *
 * ## The bug this exists for (measured live 2026-07-28)
 *
 * On CodeSandbox every project's checkpoint history stopped at seq 0 — the pre-generation starter —
 * while WebContainer projects checkpointed on every turn. "Undo this change" had nothing to restore,
 * and kill-recovery restored the STARTER over a 500-credit creation. Nothing logged, nothing toasted:
 * the whole failure surface between `onFinish` and `createLocalSnapshot` was silent.
 *
 * Three silent mechanisms, all observed on the live provider:
 *
 *   1. **`onFinish` fires while the actions are still WRITING.** The model stopping is not the files
 *      landing — on a server sandbox each `<boltAction>` write is a round trip, so the serialize raced
 *      the action runner's own write queue over the same connection. `actions-settled.ts` exists for
 *      exactly this (the creation celebration already waits); the checkpoint did not.
 *   2. **A dead sandbox connection HANGS instead of erroring.** Measured: `fs.readFile` against a
 *      hibernated VM / stale session queues forever — the serialize promise never settles, so the
 *      `.catch()` never fires, the idempotency ref stays set, and checkpointing is over for the
 *      session with zero evidence.
 *   3. **A transient read failure threw once and gave up.** `serializeFiles` retries individual
 *      paths immediately, but a burst of RTT reads racing fresh writes needs TIME, not instant
 *      retries — and the single strict throw ended checkpointing for the turn.
 *
 * ## The policy
 *
 * Wait for the turn's actions to settle (bounded — a wedged runner must not swallow the checkpoint
 * silently, it must REPORT), then serialize strictly with a per-attempt TIMEOUT (a hang becomes a
 * classified failure) and spaced retries (the transient-read case). Every exit is a named outcome the
 * caller can act on — `ok` writes the checkpoint, everything else is LOUD (§4.5.4b: a failed save is
 * never silent).
 *
 * Pure and dependency-injected: this decides when the user's undo safety net silently dies, which is
 * the same category as the auto-repair loop — exhaustively testable without a sandbox or a clock.
 */

import type { SerializedFileMap } from '~/lib/binary/binary-files';

/** Per-attempt ceiling. An idle strict serialize measured ~5s on the live provider; a minute means stuck. */
export const CHECKPOINT_SERIALIZE_TIMEOUT_MS = 60_000;

/** Total serialize attempts. The retries exist for reads racing the tail of the write queue. */
export const CHECKPOINT_SERIALIZE_ATTEMPTS = 3;

/** Pause between attempts — long enough for an RTT write burst to drain, short enough not to stall the UI. */
export const CHECKPOINT_RETRY_DELAY_MS = 3_000;

/**
 * Ceiling on waiting for the turn's actions. Mirrors the celebration toast's wait; reaching it means
 * the runner is wedged, and a checkpoint of a half-written project is the poisoned-checkpoint case
 * strict mode exists to refuse.
 */
export const CHECKPOINT_SETTLE_TIMEOUT_MS = 120_000;

export interface WritesSettledResult {
  settled: boolean;
  stillPending: number;
}

export type CheckpointFailureReason = 'writes-pending' | 'timeout' | 'error';

export type CheckpointOutcome =
  | { kind: 'ok'; files: SerializedFileMap; attempts: number }
  | { kind: 'failed'; reason: CheckpointFailureReason; detail: string; attempts: number };

export interface CheckpointRunOptions {
  /** The strict serialize — `workbenchStore.serializeFiles({ strict: true })` in production. */
  serialize: () => Promise<SerializedFileMap>;

  /** Wait for the turn's queued actions to reach a terminal state (`waitForActionsSettled`). */
  waitForWrites?: () => Promise<WritesSettledResult>;

  attempts?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

class SerializeTimeoutError extends Error {
  constructor(ms: number) {
    super(`serialize did not settle within ${ms}ms (the sandbox connection may be gone)`);
    this.name = 'SerializeTimeoutError';
  }
}

/**
 * Race a promise against a deadline WITHOUT leaking a timer past the win.
 *
 * The losing serialize keeps running in the background — that is deliberate and harmless (it only
 * reads); what matters is that the CHECKPOINT decision is made in bounded time.
 */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SerializeTimeoutError(ms)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runCheckpointSerialize(options: CheckpointRunOptions): Promise<CheckpointOutcome> {
  const {
    serialize,
    waitForWrites,
    attempts = CHECKPOINT_SERIALIZE_ATTEMPTS,
    timeoutMs = CHECKPOINT_SERIALIZE_TIMEOUT_MS,
    retryDelayMs = CHECKPOINT_RETRY_DELAY_MS,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = options;

  /*
   * Files first stop moving, then they are photographed. A checkpoint taken mid-write is not a
   * smaller checkpoint — restored with `protectNothing` it DELETES every file the writer had not
   * reached yet, which is §4.12's poisoned-checkpoint case. If the runner never settles we refuse
   * loudly rather than photograph the race.
   */
  if (waitForWrites) {
    const writes = await waitForWrites();

    if (!writes.settled) {
      return {
        kind: 'failed',
        reason: 'writes-pending',
        detail: `${writes.stillPending} action(s) still running after the settle window`,
        attempts: 0,
      };
    }
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    try {
      const files = await withTimeout(serialize(), timeoutMs);

      return { kind: 'ok', files, attempts: attempt };
    } catch (error) {
      lastError = error;

      if (attempt < Math.max(1, attempts)) {
        await sleep(retryDelayMs);
      }
    }
  }

  const isTimeout = lastError instanceof SerializeTimeoutError;

  return {
    kind: 'failed',
    reason: isTimeout ? 'timeout' : 'error',
    detail: lastError instanceof Error ? lastError.message : String(lastError),
    attempts: Math.max(1, attempts),
  };
}
