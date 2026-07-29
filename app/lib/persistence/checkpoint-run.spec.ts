/**
 * The checkpoint policy is the user's undo safety net deciding whether to die (T17c, SPEC §4.12).
 *
 * Measured live 2026-07-28 on CodeSandbox: every project's checkpoint history stopped at seq 0 —
 * the pre-generation STARTER — because `checkpointProject`'s strict serialize threw once (or hung
 * forever on a dead connection) inside a `.catch(() => {})`. "Undo this change" refused, and kill
 * recovery restored the starter over a 500-credit creation, silently. `runCheckpointSerialize` is
 * that decision made pure: wait for writes, bound the hang, space the retries, name every exit.
 *
 * Same test discipline as `auto-repair.spec.ts` / `actions-settled.spec.ts`: everything injected,
 * no real sandbox, no real clock except where a tiny real timeout is the simplest honest race.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import { runCheckpointSerialize } from './checkpoint-run';

const FILES: SerializedFileMap = {
  '/home/project/src/main.ts': { type: 'file', content: 'x', isBinary: false },
};

/** An injected sleep that records its delays and yields immediately — retries cost no test time. */
function instantSleep() {
  const delays: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    delays.push(ms);
  });

  return { sleep, delays };
}

describe('runCheckpointSerialize', () => {
  /**
   * THE HEADLINE — the T17c repro. On the live provider a strict serialize racing the tail of the
   * action runner's RTT write queue threw exactly this error on the first read burst and would have
   * succeeded moments later. Under the OLD behavior (one attempt, error swallowed by
   * `.catch(() => {})`) this single transient throw ENDED checkpointing for the session — seq 0
   * forever. The policy retries after a real pause and the checkpoint lands.
   */
  it('retries a transient serialize failure and succeeds on attempt 2 (the T17c repro)', async () => {
    const { sleep, delays } = instantSleep();
    let calls = 0;

    const serialize = vi.fn(async () => {
      if (++calls === 1) {
        throw new Error('Could not read 2 file(s) from the sandbox: public/assets/generated/hero.jpg');
      }

      return FILES;
    });

    const outcome = await runCheckpointSerialize({ serialize, attempts: 3, retryDelayMs: 3_000, sleep });

    expect(outcome).toEqual({ kind: 'ok', files: FILES, attempts: 2 });
    expect(serialize).toHaveBeenCalledTimes(2);

    // The pause between attempts is the fix — an instant retry hits the same racing write queue.
    expect(delays).toEqual([3_000]);
  });

  /**
   * Mechanism 2 from the live diagnosis: `fs.readFile` against a hibernated VM / stale session
   * QUEUES FOREVER — the promise never settles, so without a deadline the `.catch()` never fires
   * and the idempotency ref stays set for the rest of the session. The race must classify the hang
   * as a 'timeout' failure in bounded time. Tiny real timeout — fake timers with a real
   * Promise.race is how a test hangs instead of the code under test.
   */
  it('classifies a serialize that never settles as a timeout failure', async () => {
    const { sleep } = instantSleep();

    const outcome = await runCheckpointSerialize({
      serialize: () => new Promise<SerializedFileMap>(() => undefined),
      attempts: 1,
      timeoutMs: 25,
      sleep,
    });

    expect(outcome.kind).toBe('failed');

    if (outcome.kind === 'failed') {
      expect(outcome.reason).toBe('timeout');
      expect(outcome.detail).toContain('25ms');
      expect(outcome.attempts).toBe(1);
    }
  });

  /**
   * Mechanism 1: `onFinish` is the model stopping, not the files landing. A checkpoint photographed
   * mid-write is POISONED — restored with `protectNothing` it deletes every file the writer had not
   * reached. So an unsettled runner is a refusal, and serialize must NEVER run: a policy that
   * refuses but photographs anyway has only moved the bug.
   */
  it('refuses with writes-pending and never calls serialize when the runner has not settled', async () => {
    const serialize = vi.fn(async () => FILES);

    const outcome = await runCheckpointSerialize({
      serialize,
      waitForWrites: async () => ({ settled: false, stillPending: 3 }),
    });

    expect(outcome).toEqual({
      kind: 'failed',
      reason: 'writes-pending',
      detail: '3 action(s) still running after the settle window',
      attempts: 0,
    });
    expect(serialize).not.toHaveBeenCalled();
  });

  it('proceeds to serialize once waitForWrites reports settled', async () => {
    const waitForWrites = vi.fn(async () => ({ settled: true, stillPending: 0 }));
    const serialize = vi.fn(async () => FILES);

    const outcome = await runCheckpointSerialize({ serialize, waitForWrites });

    expect(waitForWrites).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: 'ok', files: FILES, attempts: 1 });
  });

  /**
   * When every attempt fails the outcome must carry the LAST error's message — that is what the
   * caller logs and toasts, and a stale first-attempt message would send whoever reads it chasing
   * the wrong file.
   */
  it('exhausts all attempts, reports reason error, and carries the LAST error message', async () => {
    const { sleep, delays } = instantSleep();
    let calls = 0;

    const outcome = await runCheckpointSerialize({
      serialize: vi.fn(async () => {
        throw new Error(`read failed (attempt ${++calls})`);
      }),
      attempts: 3,
      retryDelayMs: 100,
      sleep,
    });

    expect(outcome).toEqual({
      kind: 'failed',
      reason: 'error',
      detail: 'read failed (attempt 3)',
      attempts: 3,
    });

    // Two pauses for three attempts — never a trailing sleep after the last failure.
    expect(delays).toEqual([100, 100]);
  });

  it('never sleeps when attempts is 1 — a single-shot failure returns immediately', async () => {
    const { sleep } = instantSleep();

    const outcome = await runCheckpointSerialize({
      serialize: async () => {
        throw new Error('boom');
      },
      attempts: 1,
      sleep,
    });

    expect(outcome.kind).toBe('failed');
    expect(sleep).not.toHaveBeenCalled();
  });

  /** `waitForWrites` is optional — a caller with no runner (tests, tooling) serializes directly. */
  it('serializes directly when no waitForWrites is provided', async () => {
    const serialize = vi.fn(async () => FILES);

    const outcome = await runCheckpointSerialize({ serialize });

    expect(serialize).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: 'ok', files: FILES, attempts: 1 });
  });

  /**
   * Timer hygiene: a fast successful serialize must not leave the deadline timer armed (the
   * module's `finally` clears it). With a long timeoutMs, a leaked timer would hold the vitest
   * process open — this test passing AND the suite exiting is the assertion.
   */
  it('does not leak the timeout timer on a fast success', async () => {
    const outcome = await runCheckpointSerialize({
      serialize: async () => FILES,
      timeoutMs: 60_000,
    });

    expect(outcome.kind).toBe('ok');
  });

  /** Defense against a nonsense caller: attempts <= 0 still runs exactly one attempt. */
  it('clamps a non-positive attempts to a single attempt', async () => {
    const serialize = vi.fn(async () => FILES);

    const outcome = await runCheckpointSerialize({ serialize, attempts: 0 });

    expect(serialize).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: 'ok', files: FILES, attempts: 1 });
  });

  /** A non-Error throw (a string, a rejected value) still lands readably in detail. */
  it('stringifies a non-Error rejection into detail', async () => {
    const outcome = await runCheckpointSerialize({
      serialize: async () => {
        // a non-Error rejection, as a raw transport layer can produce
        return Promise.reject('socket gone');
      },
      attempts: 1,
    });

    expect(outcome).toEqual({ kind: 'failed', reason: 'error', detail: 'socket gone', attempts: 1 });
  });
});
