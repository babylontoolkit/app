/**
 * The single-flight around "make this project runnable", and the two ways to wait for it (§4.13a).
 *
 * ## Why this is a module and not four lines inside `useChatHistory`
 *
 * `execution-queue.ts`'s lesson, applied before the bug rather than after it: importing
 * `useChatHistory` boots a sandbox, an editor store and a watcher, so nothing in it can be unit
 * tested — every spec in this directory MOCKS it. A one-line mistake in a promise seam that no test
 * can reach is exactly how `addToolResult`'s missing `.catch()` poisoned an entire tab's action
 * queue for a page's lifetime, silently. The seam here is the same species, so it gets the same
 * treatment.
 *
 * ## The two entry points, and why they are not the same function
 *
 * 🔴 **`ensureRunnableOnce` deliberately does NOT return the run** (it resolves immediately), and
 * that is load-bearing for the MOUNT: the install needs the agent's shell, the shell is spawned by
 * the workbench's `<Terminal>`, and the workbench does not render until the mount resolves — so a
 * mount that awaited the install would wait for something that cannot happen until it returns.
 * MEASURED: `showWorkbench`, the xterm element and the shell process all appear in the same
 * millisecond.
 *
 * 🔴 **A branch switch needs the opposite** — and reaching for the mount's function is the 2026-08-03
 * splash defect wearing new clothes, pointed the other way. That bug raised a phase nothing could
 * bring down; this one would bring a phase down while the work it narrates is still starting. A
 * switch that calls the immediate-resolve version inside `try/finally { endBootPhase() }` passes
 * every test and takes the splash off the screen at the exact moment the 30 seconds begins,
 * destroying the entire justification for reinstalling in the first place: a narrated 30-second wait
 * is a wait, and a silent one is a broken button.
 *
 * So the run is started once and shared, and the CALLER chooses whether to wait for it.
 *
 * ⚠️ **Neither entry point writes `bootProgress`.** The phase belongs to whoever can guarantee it
 * comes down — a `finally` on the operation that raised it. That is the generalisation the
 * 2026-08-03 comment states: `bootProgress` is ONE SLOT owned by the mount, and a task that outlives
 * the mount must never write to it. Steps are BROADCAST here; the caller decides what, if anything,
 * to draw with them.
 */
import type { EnsureRunnableOutcome } from './ensure-runnable';

/** The narration `ensureProjectRunnable` emits as it goes. */
export type RunnableStep = 'waiting' | 'installing' | 'starting';

/**
 * The run currently in flight, or `undefined`.
 *
 * Single-flighted per PAGE LOAD rather than per project, because the shell is a page-level singleton:
 * two of these at once would Ctrl-C each other (`BoltShell.executeCommand` writes `\x03` and
 * interrupts whatever is running) regardless of which project they belong to.
 *
 * A FINISHED run is deliberately not remembered — re-opening a project that turns out not to be
 * serving must be able to fix it, and the `already-running` check makes a redundant call free. That
 * is also what lets a branch switch reinstall in a page that already mounted.
 */
let inFlight: Promise<EnsureRunnableOutcome> | undefined;

/**
 * Who wants to hear about the steps.
 *
 * A SET rather than a parameter on the run, because a caller can JOIN a run it did not start — a
 * switch pressed while the mount's own install is still going — and it still needs the narration to
 * cover the wait it is showing the user. Listeners registered after a step has already fired do not
 * see it; that is honest (the step is over) and the caller's `finally` still ends the phase.
 */
const listeners = new Set<(step: RunnableStep) => void>();

/** Listen for steps until the returned function is called. Safe to call while a run is in flight. */
export function onRunnableStep(listener: (step: RunnableStep) => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/**
 * Start the run, or join the one already going.
 *
 * ⚠️ `start` is only invoked when there is nothing in flight, so a joiner never runs a second
 * install — that is the whole point. It receives the emitter rather than reading the module's set
 * directly so the broadcast cannot be bypassed by a future caller.
 *
 * ⚠️ **The `finally` that clears `inFlight` runs on the REJECTION path too.** Without it one failed
 * install would leave a rejected promise parked in the slot, and every later caller — for the rest of
 * the page's life — would join it and be handed that same old failure without a single command being
 * run. That is `execution-queue.ts`'s poisoned chain, one module over.
 */
export function sharedRunnableRun(
  start: (emit: (step: RunnableStep) => void) => Promise<EnsureRunnableOutcome>,
): Promise<EnsureRunnableOutcome> {
  if (inFlight) {
    return inFlight;
  }

  const emit = (step: RunnableStep) => {
    for (const listener of [...listeners]) {
      try {
        listener(step);
      } catch {
        /*
         * A listener that throws must never take down the run. It is narration: the worst case is a
         * phase that does not update, and the worst case of NOT catching is an install that never
         * happened because a toast library was unhappy.
         */
      }
    }
  };

  const run = (async () => start(emit))().finally(() => {
    inFlight = undefined;
  });

  inFlight = run;

  return run;
}

/** Is a run going right now? Exposed for tests and for a caller that wants to avoid queueing one. */
export function isRunnableRunInFlight(): boolean {
  return inFlight !== undefined;
}

/** Test-only: forget the in-flight run and every listener. */
export function resetRunnableRunForTests(): void {
  inFlight = undefined;
  listeners.clear();
}
