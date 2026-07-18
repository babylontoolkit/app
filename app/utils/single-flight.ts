/**
 * Collapse concurrent calls for the same key into one in-flight run.
 *
 * A "single flight": while a call keyed `k` is running, every other call with the same `k` gets the
 * SAME promise instead of starting its own work. Once it settles, the slot is freed, so a LATER call
 * runs afresh — this dedupes concurrency, it does not memoize a result.
 *
 * It exists because some operations are idempotent in intent but destructive when run twice at once.
 * The mount path is the case in point (§4.5.4b): a React effect that re-fires for the same project
 * (StrictMode's double-invoke, a `searchParams`/`navigate` identity change) would otherwise pull the
 * repo twice and — the part that actually breaks — run two `npm install`s into the one shared
 * WebContainer, which can corrupt `node_modules`. The same shape as `SaveQueue`'s "one save in flight
 * per project", generalised so the mount can reuse it.
 *
 * The slot is freed in `finally`, so a rejection frees it too — a failed run must not wedge the key
 * forever. The rejection still propagates to every caller sharing that flight.
 */
export function createSingleFlight<K>() {
  const inFlight = new Map<K, Promise<unknown>>();

  return function run<T>(key: K, fn: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(key) as Promise<T> | undefined;

    if (existing) {
      return existing;
    }

    const promise = (async () => fn())().finally(() => {
      inFlight.delete(key);
    });

    inFlight.set(key, promise);

    return promise;
  };
}
