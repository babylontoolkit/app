/**
 * The serial queue every artifact action runs through (`workbenchStore.addToExecutionQueue`).
 *
 * 🔴 **A PROMISE CHAIN THAT REJECTS STAYS REJECTED, AND THIS ONE HAD NO REJECTION HANDLER.**
 *
 * It shipped as one line inside the store:
 *
 *     this.#globalExecutionQueue = this.#globalExecutionQueue.then(() => callback())
 *
 * `.then(onFulfilled)` on a rejected promise does not call `onFulfilled` — it forwards the rejection.
 * So the FIRST callback to throw turned the queue itself into a rejected promise, and **every action
 * queued afterwards, for the rest of the page's life, was never called at all.** Not delayed, not
 * retried: never invoked. One transient sandbox error and the tab silently stopped executing actions.
 *
 * Found from the report *"the game build is supposed to be complete but the file artifact is still
 * saying creating in progress even though the rest of the project says its done"* (2026-07-31). The
 * mechanism reads straight off the action lifecycle: a file action's FIRST streaming delta sets it
 * `running`, and its closing non-streaming run is what sets `complete` and writes the file. Kill the
 * queue in between and the row spins forever, the file never lands, and every later action is dropped
 * too — while the model's prose, which is only text and passes through no queue, says it all shipped.
 *
 * Extracted from the store rather than fixed in place because the store cannot be constructed in a unit
 * test (importing it boots a sandbox, an editor store and a file watcher), and a money-adjacent
 * behaviour that no test can reach is how this survived in the first place.
 *
 * ## Why `onError` is required, not optional politeness
 *
 * A bare `.catch(() => {})` keeps the queue alive and trades one silent failure for another — the file
 * still did not get written, and now nothing says so. `spec/fail-loud.md`: an action the user paid for
 * that did not run must never be silent. The reporter is itself wrapped, because a queue whose
 * survival depends on its logger not throwing has just moved the poisoning one level down.
 */
export interface ExecutionQueue {
  /** Queue a callback. It runs after everything already queued, whether or not those succeeded. */
  add(callback: () => Promise<void>): void;

  /** Resolves when everything queued so far has settled. Never rejects. Testing + shutdown. */
  drained(): Promise<void>;
}

export interface ExecutionQueueOptions {
  /** Called with whatever a callback threw. Failures are reported, never swallowed. */
  onError?: (error: unknown) => void;
}

export function createExecutionQueue(options: ExecutionQueueOptions = {}): ExecutionQueue {
  /*
   * INVARIANT: `chain` is never a rejected promise. Every link ends in the handler below, so the next
   * `.then` is always attached to a fulfilled promise — which is the entire fix.
   */
  let chain = Promise.resolve();

  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      /*
       * Deliberately empty. The reporter is a courtesy; the queue is the contract. If logging the
       * failure throws, letting that escape would poison the chain in exactly the way this module
       * exists to prevent — the original bug, reintroduced through the error path.
       */
    }
  };

  return {
    add(callback) {
      chain = chain.then(async () => {
        try {
          /*
           * `await` inside the try, so a callback that throws SYNCHRONOUSLY is caught too. A bare
           * `return callback()` would let a synchronous throw escape — and `unreachable('Artifact not
           * found')`, one of the real ways this queue died, throws synchronously.
           */
          await callback();
        } catch (error) {
          report(error);
        }
      });
    },
    drained() {
      return chain;
    },
  };
}
