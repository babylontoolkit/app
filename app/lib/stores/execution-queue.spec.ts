/**
 * 🔴 THE GLOBAL ACTION QUEUE MUST SURVIVE A FAILED ACTION (found live 2026-07-31).
 *
 * Reported as *"the game build is supposed to be complete but the file artifact is still saying
 * creating in progress even though the rest of the project says its done"* — an artifact row spinning
 * forever under a message whose prose claimed the game had shipped.
 *
 * `workbenchStore.addToExecutionQueue` chains every action through ONE promise:
 *
 *     this.#globalExecutionQueue = this.#globalExecutionQueue.then(() => callback())
 *
 * with no `.catch()`. A promise chain that rejects stays rejected: `.then(onFulfilled)` on a rejected
 * promise does not call `onFulfilled`, it passes the rejection along. So the FIRST callback to throw —
 * a transient sandbox error, an `unreachable('Artifact not found')`, a write to a dead connection —
 * silently turns the queue into a rejected promise, and **every action queued afterwards, for the rest
 * of the page's life, is never called at all**.
 *
 * The visible result is precisely the report: an action that got as far as `running` (set by the first
 * streaming write) never receives its closing non-streaming run, so it spins forever, its file is never
 * written, and the actions after it never execute either — while the model's prose, which is just text,
 * cheerfully says everything is done.
 *
 * Two properties are pinned here, and the second is why a bare `.catch(() => {})` is not enough on its
 * own: the queue must CONTINUE, and the failure must be REPORTED (`spec/fail-loud.md` — an action the
 * user paid for that did not run must never be silent).
 *
 * The queue is exercised through its real shape rather than through `workbenchStore`, which cannot be
 * constructed in a unit test (it boots a sandbox, an editor store and a file watcher on import). The
 * shape IS the bug: a single `.then`-chained promise with no rejection handler.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createExecutionQueue } from './execution-queue';

describe('the global action execution queue', () => {
  it('runs queued callbacks in order', async () => {
    const order: number[] = [];
    const queue = createExecutionQueue();

    queue.add(async () => void order.push(1));
    queue.add(async () => void order.push(2));
    queue.add(async () => void order.push(3));
    await queue.drained();

    expect(order).toEqual([1, 2, 3]);
  });

  /**
   * 🔴 THE BUG. Without a rejection handler the chain is poisoned and callbacks 2 and 3 never run —
   * which is the stuck artifact row, the unwritten file, and every action after it, from one failure.
   */
  it('keeps running later actions after one of them throws', async () => {
    const order: string[] = [];
    const queue = createExecutionQueue();

    queue.add(async () => void order.push('before'));
    queue.add(async () => {
      throw new Error('sandbox write failed');
    });
    queue.add(async () => void order.push('after'));
    await queue.drained();

    expect(order).toEqual(['before', 'after']);
  });

  /** A callback that throws SYNCHRONOUSLY must not escape either — `unreachable()` does exactly that. */
  it('survives a callback that throws synchronously', async () => {
    const order: string[] = [];
    const queue = createExecutionQueue();

    queue.add((() => {
      throw new Error('Artifact not found');
    }) as () => Promise<void>);
    queue.add(async () => void order.push('after'));
    await queue.drained();

    expect(order).toEqual(['after']);
  });

  /** Many failures in a row must not compound — the queue is never left in a poisoned state. */
  it('recovers from repeated failures', async () => {
    const order: string[] = [];
    const queue = createExecutionQueue();

    for (let i = 0; i < 5; i++) {
      queue.add(async () => {
        throw new Error(`fail ${i}`);
      });
    }

    queue.add(async () => void order.push('survivor'));
    await queue.drained();

    expect(order).toEqual(['survivor']);
  });

  /**
   * LOUD, not swallowed. A file the user paid for that never got written is exactly the kind of silent
   * failure `spec/fail-loud.md` exists to forbid, and a queue that quietly eats errors to stay alive
   * trades one silent failure for another.
   */
  it('reports every failure to the caller', async () => {
    const onError = vi.fn();
    const queue = createExecutionQueue({ onError });

    queue.add(async () => {
      throw new Error('sandbox write failed');
    });
    await queue.drained();

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('sandbox write failed');
  });

  /**
   * A reporter that itself throws must not re-poison the queue it is reporting for.
   *
   * Not a hypothetical: `onError` in the store shows a toast, and the queue's survival must not depend
   * on a UI library behaving. Letting it escape would be the original bug reintroduced via the error
   * path — the place nobody looks.
   */
  it('survives a reporter that throws', async () => {
    const order: string[] = [];
    const queue = createExecutionQueue({
      onError: () => {
        throw new Error('the logger is broken too');
      },
    });

    queue.add(async () => {
      throw new Error('sandbox write failed');
    });
    queue.add(async () => void order.push('after'));
    await queue.drained();

    expect(order).toEqual(['after']);
  });
});

/**
 * 🔴 AND THE STORE MUST ACTUALLY USE IT.
 *
 * Everything above tests a module the store could stop calling tomorrow. The bug was one line long and
 * looked completely ordinary — `chain = chain.then(() => callback())` is what anyone writes when they
 * want work serialized — so the thing worth pinning is that `workbench.ts` no longer builds its own.
 *
 * A source scan, and therefore worthless without a control: one proving the scanner is reading the real
 * file, and one proving it can SEE the offending shape on a fixture where the shape exists.
 */
const WORKBENCH_SOURCE = readFileSync(join(process.cwd(), 'app/lib/stores/workbench.ts'), 'utf-8');

/** A promise chained onto itself with no rejection handler — the shape that poisons. */
const SELF_CHAINED_PROMISE = /(\w+)\s*=\s*(?:this\.)?#?\1\s*\.then\(/;

describe('the workbench store routes through the queue module', () => {
  it('CONTROL: the scanner is reading the real workbench store', () => {
    expect(WORKBENCH_SOURCE.length).toBeGreaterThan(1000);
    expect(WORKBENCH_SOURCE).toContain('addToExecutionQueue');
  });

  it('CONTROL: the scanner detects the poisoning shape when it is present', () => {
    expect(SELF_CHAINED_PROMISE.test('this.#globalExecutionQueue = this.#globalExecutionQueue.then(() => cb())')).toBe(
      true,
    );
  });

  it('builds its execution queue with createExecutionQueue', () => {
    expect(WORKBENCH_SOURCE).toContain('createExecutionQueue(');
  });

  it('never re-chains a promise onto itself without a rejection handler', () => {
    expect(SELF_CHAINED_PROMISE.test(WORKBENCH_SOURCE)).toBe(false);
  });
});
