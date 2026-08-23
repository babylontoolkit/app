/**
 * The single-flight seam behind `ensureRunnableOnce` / `ensureRunnableNow` (§4.13a, T14).
 *
 * Every test here is written against a failure that would be SILENT in the product:
 *
 *   - a joiner that starts a SECOND `npm install` on the one shared shell — `executeCommand` writes
 *     `\x03` and interrupts whatever is running, so the two would Ctrl-C each other;
 *   - a returned promise that resolves BEFORE the work finishes, which is the 2026-08-03 splash defect
 *     pointed the other way: the cover comes down at the exact instant the 30 seconds begins, and it
 *     passes every test that only checks the promise resolved;
 *   - a rejected run left parked in the slot, so one failed install poisons every later call for the
 *     rest of the page's life without a single command being run. That is `execution-queue.ts`'s
 *     missing `.catch()` one module over, and it is the reason the `.finally` exists at all;
 *   - a toast library throwing inside a step listener and taking the install down with it.
 *
 * The module is dependency-injected precisely so these can be driven without a shell: `start` is
 * whatever the test hands it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnsureRunnableOutcome } from './ensure-runnable';
import {
  isRunnableRunInFlight,
  onRunnableStep,
  resetRunnableRunForTests,
  sharedRunnableRun,
  type RunnableStep,
} from './runnable-run';

/** A promise the test decides when to settle — the only honest way to assert "still pending". */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

/** Drain the microtask queue so "still pending" means pending, not merely "not yet scheduled". */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetRunnableRunForTests();
});

describe('sharedRunnableRun — one run, one shell', () => {
  it('invokes start exactly once for two concurrent calls, and hands both callers the same outcome', async () => {
    const start = vi.fn(async (): Promise<EnsureRunnableOutcome> => 'started');

    const [a, b] = await Promise.all([sharedRunnableRun(start), sharedRunnableRun(start)]);

    expect(start).toHaveBeenCalledTimes(1);
    expect(a).toBe('started');
    expect(b).toBe('started');
  });

  /*
   * 🔴 The property the whole task exists for. `ensureRunnableOnce` returns `Promise.resolve()` on
   * purpose; a switch that reached for it would take its splash down before the install started. This
   * asserts the other entry point's seam really does wait — with a deferred, because a promise that
   * resolves too early still resolves, and an `await` alone cannot tell the two apart.
   */
  it('resolves only after start has settled', async () => {
    const work = deferred<EnsureRunnableOutcome>();
    let settledWith: EnsureRunnableOutcome | undefined;

    const run = sharedRunnableRun(() => work.promise);
    void run.then((outcome) => {
      settledWith = outcome;
    });

    await settle();
    expect(settledWith).toBeUndefined();
    expect(isRunnableRunInFlight()).toBe(true);

    work.resolve('started');
    await run;

    expect(settledWith).toBe('started');
  });

  /*
   * 🔴 The rejection path clears the slot. Without the `.finally`, the rejected promise stays parked
   * and every later caller joins it — handed a failure from an install that ran minutes ago, with no
   * command issued and nothing on screen saying so.
   */
  it('clears the slot when the run REJECTS, so a later call really runs again', async () => {
    const failure = new Error('the sandbox went away mid-install');
    const first = vi.fn(async (): Promise<EnsureRunnableOutcome> => {
      throw failure;
    });

    await expect(sharedRunnableRun(first)).rejects.toBe(failure);
    expect(isRunnableRunInFlight()).toBe(false);

    const second = vi.fn(async (): Promise<EnsureRunnableOutcome> => 'started');

    await expect(sharedRunnableRun(second)).resolves.toBe('started');
    expect(second).toHaveBeenCalledTimes(1);
  });

  /*
   * A FINISHED run is deliberately not remembered: re-opening a project that turns out not to be
   * serving must be able to fix it, and a branch switch must be able to reinstall in a page that
   * already mounted.
   */
  it('clears the slot on SUCCESS too — a finished run is not remembered', async () => {
    const start = vi.fn(async (): Promise<EnsureRunnableOutcome> => 'started');

    await sharedRunnableRun(start);
    expect(isRunnableRunInFlight()).toBe(false);

    await sharedRunnableRun(start);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('reports in-flight during the run and not after it', async () => {
    const work = deferred<EnsureRunnableOutcome>();

    expect(isRunnableRunInFlight()).toBe(false);

    const run = sharedRunnableRun(() => work.promise);
    await settle();
    expect(isRunnableRunInFlight()).toBe(true);

    work.resolve('already-running');
    await run;

    expect(isRunnableRunInFlight()).toBe(false);
  });
});

describe('onRunnableStep — the broadcast', () => {
  it('delivers steps in order and stops on unsubscribe, without touching the other listeners', async () => {
    const leaving: RunnableStep[] = [];
    const staying: RunnableStep[] = [];

    const stop = onRunnableStep((step) => leaving.push(step));
    onRunnableStep((step) => staying.push(step));

    await sharedRunnableRun(async (emit) => {
      emit('waiting');
      emit('installing');
      stop();
      emit('starting');

      return 'started';
    });

    expect(leaving).toEqual(['waiting', 'installing']);

    /*
     * CONTROL. `leaving` going quiet is also what a broadcast that stopped working entirely looks
     * like, and `stop()` deleting the wrong entry — or the set — would read as a passing test. The
     * second listener proves unsubscribe removed only its own.
     */
    expect(staying).toEqual(['waiting', 'installing', 'starting']);
  });

  /*
   * Pinned because the impl comments it: steps are NARRATION. The worst case of catching is a phase
   * that does not update; the worst case of not catching is an install that never happened because a
   * toast library was unhappy.
   */
  it('survives a listener that throws — the run finishes and the other listeners still fire', async () => {
    const seen: RunnableStep[] = [];

    onRunnableStep(() => {
      throw new Error('toast library exploded');
    });
    onRunnableStep((step) => seen.push(step));

    const outcome = await sharedRunnableRun(async (emit) => {
      emit('waiting');
      emit('installing');

      return 'started';
    });

    expect(outcome).toBe('started');
    expect(seen).toEqual(['waiting', 'installing']);
  });

  /*
   * A caller can JOIN a run it did not start — a branch switch pressed while the mount's own detached
   * install is still going. It is showing a cover over that wait, so it needs the narration for a run
   * whose `start` it never supplied.
   */
  it('delivers subsequent steps to a listener that joined a run already in flight', async () => {
    const gate = deferred<void>();
    const joined: RunnableStep[] = [];

    const run = sharedRunnableRun(async (emit) => {
      emit('waiting');
      await gate.promise;
      emit('installing');
      emit('starting');

      return 'started';
    });

    await settle();

    // Registered late, and joining rather than starting — `start` must not run a second time.
    const start = vi.fn(async (): Promise<EnsureRunnableOutcome> => 'no-shell');
    onRunnableStep((step) => joined.push(step));

    const joiner = sharedRunnableRun(start);

    gate.resolve();

    expect(await joiner).toBe('started');
    expect(await run).toBe('started');
    expect(start).not.toHaveBeenCalled();

    // 'waiting' fired before it subscribed; that step is over and pretending otherwise would be a lie.
    expect(joined).toEqual(['installing', 'starting']);
  });
});

/**
 * The two entry points, asserted at SOURCE level — and honestly labelled as such.
 *
 * ⚠️ This is a source scan, not a behavioural test, and it is the weaker of the two kinds. It is used
 * here because importing `useChatHistory` boots a sandbox, an editor store and a watcher: every spec
 * in this directory MOCKS it, which is exactly why the seam above was extracted into its own module in
 * the first place. What remains un-extractable is the ONE-LINE difference between the two entry
 * points — whether each returns the shared run or a resolved promise — and that difference is
 * load-bearing in both directions:
 *
 *   - `ensureRunnableOnce` must NOT return the run. The install needs the agent's shell, the shell is
 *     spawned by the workbench's `<Terminal>`, and the workbench does not render until the mount
 *     resolves. Awaiting it deadlocks the open on something that cannot happen until it returns.
 *   - `ensureRunnableNow` must return it, or a caller holding a full-page cover takes that cover down
 *     at the instant the work begins — passing every test while destroying the reason the cover exists.
 *
 * A scan can only see the shape of the code, so it carries controls proving the extractor actually
 * finds bodies and actually fails to find things that are not there.
 */
describe('the two entry points differ in exactly one way', () => {
  const MODULE = path.join(process.cwd(), 'app/lib/persistence/useChatHistory.ts');

  /** This file's own prose quotes both shapes; a comment must never satisfy a scan about the code. */
  const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const source = stripComments(fs.readFileSync(MODULE, 'utf8'));

  /**
   * The body of a top-level `function NAME(...)`, brace-matched.
   *
   * Paren-matched first so a default parameter value (`options: {...} = {}`) cannot be mistaken for
   * the opening brace of the body.
   */
  function bodyOf(text: string, name: string): string | undefined {
    const at = text.search(new RegExp(`\\bfunction\\s+${name}\\s*\\(`));

    if (at < 0) {
      return undefined;
    }

    let i = text.indexOf('(', at);
    let depth = 0;

    for (; i < text.length; i++) {
      if (text[i] === '(') {
        depth++;
      } else if (text[i] === ')') {
        depth--;

        if (depth === 0) {
          break;
        }
      }
    }

    const open = text.indexOf('{', i);

    if (open < 0) {
      return undefined;
    }

    depth = 0;

    for (let j = open; j < text.length; j++) {
      if (text[j] === '{') {
        depth++;
      } else if (text[j] === '}') {
        depth--;

        if (depth === 0) {
          return text.slice(open + 1, j);
        }
      }
    }

    return undefined;
  }

  /*
   * CONTROL. A body extractor that silently returns undefined — or the whole file — would make every
   * assertion below vacuous in one direction or the other. Prove it finds a function that exists,
   * bounds it (the neighbouring function's body must not bleed in), and misses one that does not.
   */
  it('the body extractor finds real functions, bounds them, and misses invented ones', () => {
    const once = bodyOf(source, 'ensureRunnableOnce');

    expect(once).toBeDefined();
    expect(once).toContain('sharedRunnableRun');
    expect(once).not.toContain('ensureRunnableNow');
    expect(bodyOf(source, 'ensureRunnableNeverExisted')).toBeUndefined();
  });

  it('ensureRunnableOnce returns immediately and never hands back the run', () => {
    const body = bodyOf(source, 'ensureRunnableOnce')!;

    expect(body).toContain('return Promise.resolve()');
    expect(body).not.toMatch(/return\s+sharedRunnableRun/);
    expect(body).not.toMatch(/await\s+sharedRunnableRun/);
  });

  it('ensureRunnableNow returns the real run, and runs the real work', () => {
    const body = bodyOf(source, 'ensureRunnableNow')!;

    expect(body).toMatch(/return\s+sharedRunnableRun/);
    expect(body).not.toContain('return Promise.resolve()');

    /*
     * ⚠️ And it hands `sharedRunnableRun` the REAL work. Asserting only `return sharedRunnableRun`
     * passes for `sharedRunnableRun(async () => 'started')` — a function that returns the right
     * SHAPE and installs nothing.
     */
    expect(body).toContain('runProjectRunnable(pid, emit)');
  });

  /**
   * 🔴 THE ONE LINE THAT CONNECTS THE WORK TO THE NARRATION, and nothing was pinning it.
   *
   * `onRunnableStep`'s fan-out is tested above in isolation, and `sharedRunnableRun` is tested with a
   * `start` that emits. But `runProjectRunnable`'s `onStep` handler is where `ensureProjectRunnable`'s
   * real steps are handed to that emitter, and deleting `emit(step)` there left the entire suite green
   * and `tsc` clean — `emit` is a parameter, so there is no unused-variable error either.
   *
   * The consequence is the §4.2.8 silent shape: T15's branch switch registers an `onStep`, raises
   * `switching-branch`, and then never hears `installing` or `starting` — so the splash sits on the
   * first phase for the whole 30 seconds and nothing throws. The wait would still be covered; it
   * would simply stop saying what it was waiting for, which is the entire point of narrating it.
   *
   * A source scan is the only instrument that reaches this line (importing `useChatHistory` boots a
   * sandbox, an editor store and a watcher) — so it is a scan, stated as one, rather than nothing.
   */
  it('runProjectRunnable broadcasts every step it is told about', () => {
    const body = bodyOf(source, 'runProjectRunnable')!;

    expect(body).toContain('onStep:');
    expect(body).toContain('emit(step)');

    /*
     * The CONTROL: the extractor really is reading THIS function and not the whole file. If the
     * brace-matching drifted and returned everything, this would pass for any body at all — so the
     * scan is bounded by something only the neighbouring function contains.
     */
    expect(body).not.toContain('return Promise.resolve()');
  });
});
