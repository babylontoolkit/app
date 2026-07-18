/**
 * The single-flight guard (used by the mount path, §4.5.4b).
 *
 * The property that matters: two concurrent calls for the same key do the work ONCE. A double mount
 * would otherwise run two `npm install`s into the one shared WebContainer.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSingleFlight } from './single-flight';

/** A promise with externally-visible resolve/reject, so a test can hold a "flight" open. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

describe('createSingleFlight', () => {
  it('runs the work once for concurrent calls with the same key', async () => {
    const run = createSingleFlight<string>();
    const d = deferred<number>();
    const fn = vi.fn(() => d.promise);

    const a = run('proj', fn);
    const b = run('proj', fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(a).toBe(b); // same promise handed to both callers

    d.resolve(42);
    expect(await a).toBe(42);
    expect(await b).toBe(42);
  });

  it('runs again for a sequential call after the first settled — it dedupes, it does not memoize', async () => {
    const run = createSingleFlight<string>();
    const fn = vi.fn(async () => 'done');

    expect(await run('proj', fn)).toBe('done');
    expect(await run('proj', fn)).toBe('done');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('keeps different keys independent', async () => {
    const run = createSingleFlight<string>();
    const fn = vi.fn(async (which: string) => which);

    const a = run('a', () => fn('a'));
    const b = run('b', () => fn('b'));

    expect(fn).toHaveBeenCalledTimes(2);
    expect(await a).toBe('a');
    expect(await b).toBe('b');
  });

  it('frees the key after a rejection so the next call can run — a failure must not wedge it forever', async () => {
    const run = createSingleFlight<string>();
    const failing = vi.fn(async () => {
      throw new Error('mount failed');
    });

    await expect(run('proj', failing)).rejects.toThrow('mount failed');

    const ok = vi.fn(async () => 'recovered');
    expect(await run('proj', ok)).toBe('recovered');
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('propagates a rejection to every caller sharing the flight', async () => {
    const run = createSingleFlight<string>();
    const d = deferred<number>();
    const fn = vi.fn(() => d.promise);

    const a = run('proj', fn);
    const b = run('proj', fn);

    d.reject(new Error('boom'));

    await expect(a).rejects.toThrow('boom');
    await expect(b).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('converts a synchronous throw into a rejection and still frees the key', async () => {
    const run = createSingleFlight<string>();

    await expect(
      run('proj', () => {
        throw new Error('sync throw');
      }),
    ).rejects.toThrow('sync throw');

    // Key freed despite the synchronous throw.
    expect(await run('proj', async () => 'after')).toBe('after');
  });
});
