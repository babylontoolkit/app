/**
 * A failed creation must leave NO project row behind (T3b, `_specs/codesandbox-production_plan.md`).
 *
 * The record is registered at the top of phase 1 now — a sandbox cannot be booted for a project that
 * does not exist — so every failure below it can strand an empty project on the dashboard. Every way
 * this can be wrong is silent: nobody sees a missing delete, and a user reads the leftover card as a
 * game they lost.
 */
import { describe, it, expect, vi } from 'vitest';
import { rollbackRegisteredProject } from './creation-rollback';

describe('rollbackRegisteredProject', () => {
  it('deletes the row that phase 1 registered', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const clear = vi.fn();

    const rolledBack = await rollbackRegisteredProject({ projectId: 'prj_1', remove, clear });

    expect(rolledBack).toBe(true);
    expect(remove).toHaveBeenCalledWith('prj_1');
  });

  it('does nothing when registration never got that far', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const clear = vi.fn();

    const rolledBack = await rollbackRegisteredProject({ projectId: undefined, remove, clear });

    expect(rolledBack).toBe(false);
    expect(remove).not.toHaveBeenCalled();

    /*
     * The clear must not fire either: on WebContainer a creation runs with no registration at all,
     * and wiping the atoms there would drop a pointer that a DIFFERENT flow legitimately set.
     */
    expect(clear).not.toHaveBeenCalled();
  });

  it('drops the client-side pointers BEFORE the row goes', async () => {
    const order: string[] = [];
    const remove = vi.fn().mockImplementation(async () => {
      order.push('remove');
    });
    const clear = vi.fn(() => {
      order.push('clear');
    });

    await rollbackRegisteredProject({ projectId: 'prj_1', remove, clear });

    /*
     * A chat saved in the window between the two would name a row that no longer exists and its
     * transcript would have nowhere to live (§4.5.6).
     */
    expect(order).toEqual(['clear', 'remove']);
  });

  it('never rejects when the cleanup itself fails', async () => {
    const failure = new Error('network down');
    const remove = vi.fn().mockRejectedValue(failure);
    const clear = vi.fn();
    const onError = vi.fn();

    /*
     * The creation failure is what the user needs to hear. A rejection here would replace it with a
     * cleanup error — the wrong problem, reported to the one person who cannot act on it.
     */
    await expect(rollbackRegisteredProject({ projectId: 'prj_1', remove, clear, onError })).resolves.toBe(true);

    expect(onError).toHaveBeenCalledWith(failure);

    // The pointers are still dropped — a row we could not delete is not a row we should keep using.
    expect(clear).toHaveBeenCalled();
  });

  it('tolerates a caller that reports nothing', async () => {
    const remove = vi.fn().mockRejectedValue(new Error('nope'));

    const clear = vi.fn();

    await expect(rollbackRegisteredProject({ projectId: 'prj_1', remove, clear })).resolves.toBe(true);
  });
});
