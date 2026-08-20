/**
 * T6 — the restore-in-flight flag is a COUNTER, and its clearing is in a `finally` (SPEC §4.5.4c, §4.12).
 *
 * ## Both properties fail silently, in opposite directions
 *
 * Stuck ON is the worse one: `planTopUp` skips while a restore is in flight, so a flag that never clears
 * disables every top-up for the rest of the page's life — turning a loud restore failure into exactly the
 * silent late-write loss this whole plan exists to close. Nothing throws; the user simply stops being
 * checkpointed. Hence `try/finally` rather than a decrement after the awaited work.
 *
 * Stuck OFF early is the mirror: with a boolean instead of a counter, the INNER of two overlapping
 * restores clears the flag on completion and the outer one — still writing and deleting files — is
 * photographed as if the user had made those changes. A mount that restores twice (working copy, then a
 * checkpoint) is the ordinary case, not an exotic one.
 *
 * These are unit tests of the counter itself. `workbench-save-trigger.spec.ts` proves the same properties
 * end-to-end through the real `WorkbenchStore.restoreFiles`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isRestoreInFlight, resetRestoreInFlight, withRestoreInFlight } from './restore-flag';

/** A promise the test resolves by hand, so two restores can genuinely overlap. */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;

  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

beforeEach(() => resetRestoreInFlight());
afterEach(() => resetRestoreInFlight());

describe('withRestoreInFlight', () => {
  /* The baseline: nothing is restoring until something is, and the flag goes back down after. */
  it('is off before, on during, and off after', async () => {
    expect(isRestoreInFlight()).toBe(false);

    const seen: boolean[] = [];
    await withRestoreInFlight(async () => {
      seen.push(isRestoreInFlight());
    });

    expect(seen).toEqual([true]);
    expect(isRestoreInFlight()).toBe(false);
  });

  /*
   * 🔴 The `finally`. A restore that throws leaves the tree HALF-WRITTEN, which is the state that most
   * needs the suppression — and a flag left on would silence every top-up for the rest of the session.
   */
  it('clears the flag when the work rejects, and still propagates the rejection', async () => {
    await expect(
      withRestoreInFlight(async () => {
        throw new Error('write failed');
      }),
    ).rejects.toThrow('write failed');

    expect(isRestoreInFlight()).toBe(false);
  });

  /* Synchronous throws take the same path — `work()` is called inside the `try`, not before it. */
  it('clears the flag when the work throws synchronously', async () => {
    await expect(
      withRestoreInFlight((() => {
        throw new Error('bad map');
      }) as () => Promise<void>),
    ).rejects.toThrow('bad map');

    expect(isRestoreInFlight()).toBe(false);
  });

  /*
   * 🔴 THE REASON IT IS A COUNTER AND NOT A BOOLEAN. The inner restore completing must not declare the
   * outer one over: a boolean here reports "no restore in flight" while the outer restore is still
   * writing files, which is the whole defect the flag exists to prevent.
   */
  it('stays on while an OUTER restore is still running after an inner one finishes', async () => {
    const outer = deferred();
    const inner = deferred();

    const outerRun = withRestoreInFlight(async () => {
      await withRestoreInFlight(() => inner.promise);

      // The inner one is done; the outer one is not.
      expect(isRestoreInFlight()).toBe(true);

      await outer.promise;
    });

    await Promise.resolve();
    expect(isRestoreInFlight()).toBe(true);

    inner.resolve();
    await Promise.resolve();

    expect(isRestoreInFlight()).toBe(true);

    outer.resolve();
    await outerRun;

    expect(isRestoreInFlight()).toBe(false);
  });

  /* Concurrent (not nested) restores: the flag survives until the LAST one settles. */
  it('stays on until the last of two concurrent restores settles', async () => {
    const first = deferred();
    const second = deferred();

    const a = withRestoreInFlight(() => first.promise);
    const b = withRestoreInFlight(() => second.promise);

    expect(isRestoreInFlight()).toBe(true);

    first.resolve();
    await a;

    expect(isRestoreInFlight()).toBe(true);

    second.resolve();
    await b;

    expect(isRestoreInFlight()).toBe(false);
  });

  /*
   * 🔴 CONTROL for the pair above. "Stays on" passes trivially for a flag that is stuck on forever —
   * which is the worst failure of the two. A rejecting restore alongside a healthy one must still
   * balance the counter back to zero.
   */
  it('CONTROL — a rejecting restore alongside a healthy one still balances to zero', async () => {
    const healthy = deferred();

    const a = withRestoreInFlight(() => healthy.promise);
    const b = withRestoreInFlight(async () => {
      throw new Error('restore failed');
    });

    await expect(b).rejects.toThrow('restore failed');
    expect(isRestoreInFlight()).toBe(true);

    healthy.resolve();
    await a;

    expect(isRestoreInFlight()).toBe(false);
  });

  /* The work's value is returned unchanged — the wrapper is transparent to its caller. */
  it('returns the work’s resolved value', async () => {
    await expect(withRestoreInFlight(async () => 'restored')).resolves.toBe('restored');
  });
});
