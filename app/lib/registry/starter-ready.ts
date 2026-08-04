/**
 * Waiting for a newly created project to actually be RUNNING (§4.4a, plan T6).
 *
 * The owner's success condition for New Project is not "the files are on disk" — it is *"npm install +
 * npm run dev and showing the starter app template basic home page"*. Creation used to hand back a
 * settled file tree and dismiss the splash while `npm install` was still running in a terminal the user
 * could not see, then fire a generation over the top of it. With the build gone (T5), what is left is a
 * clone that is not finished until it serves something.
 *
 * So the splash covers the last two steps too, and this module is the wait behind them. It is a decision
 * function of its own — pure, with an injected clock — for the same reason `settleAfterCreation` and
 * `awaitRunningPreview` are: the failure it prevents is invisible. A wait that is too short shows the
 * user a "ready" project with a blank preview; one that is unbounded hangs the New Project button on
 * somebody else's slow install, forever, with no way out.
 *
 * 🔴 **BOUNDED AND DEGRADING, NEVER BLOCKING** (§1.3 principle 0). Reaching a ceiling here is NORMAL and
 * SILENT: the project was created, the splash comes down, and the preview arrives when it arrives. This
 * function has no failure mode of its own — every ending is a value, never an exception — and it reports
 * what happened rather than deciding anything. (It can still propagate a throw from an injected callback;
 * the caller keeps this inside the post-create boundary that returns success either way, which is where
 * that belongs.) The caller must not branch on `installed`/`serving` to decide whether creation
 * SUCCEEDED; creation succeeded before this was called.
 *
 * The two stages are narrated separately because they fail differently and take wildly different times.
 * On CodeSandbox `node_modules` is baked into the forked template, so install is a ~2s "up to date" and
 * Vite is ready in ~400ms; on WebContainer a cold install is the real wait, and it is exactly the wait
 * that most needs a sentence under it.
 */
import { awaitRunningPreview } from '~/lib/persistence/port-settle';

/**
 * How long the splash waits for `npm install`.
 *
 * Sized for a COLD WebContainer install of the starter's full dependency tree, which is the slow case
 * this narration exists for — a warm CodeSandbox fork resolves in seconds and never approaches it.
 * Reaching it is not an error; it means the install is taking longer than we are willing to hold a
 * full-screen overlay for, and it keeps running in the terminal after the splash comes down.
 */
export const CREATION_INSTALL_TIMEOUT_MS = 180_000;

/**
 * How long the splash then waits for the dev server to bind a port.
 *
 * Much shorter than the install window on purpose: by this point the dependencies are on disk and Vite
 * is the only thing left. If it has not opened a port in this window something is wrong with the
 * project, and a broken preview is better looked at in the workbench than behind an overlay.
 */
export const CREATION_SERVE_TIMEOUT_MS = 60_000;

/** How often each stage re-checks. Short enough that a fast provider costs ~one poll, not the window. */
export const CREATION_READY_POLL_MS = 500;

export type StarterReadyStage = 'install' | 'serve';

/**
 * Has the setup artifact's `npm install` reached an ENDING?
 *
 * Pure, and out here rather than inline in the caller, because it is a decision and not a read: it
 * answers "may the splash move on?", and the tempting wrong version of it — `status === 'complete'` —
 * fails silently in the one case that matters. An install that ERRORS is a project the user needs to
 * look at now; waiting only for success spends the entire 3-minute install window narrating a step that
 * already gave up, and then dismisses the splash as if it had merely been slow.
 *
 * So `failed` and `aborted` are endings. Only `pending` and `running` are not.
 *
 * An artifact with no shell action at all reports NOT done — deliberately. It means the setup artifact
 * has not been parsed into the runner yet (the parser is sampled every 50ms), and reading "no shells,
 * therefore nothing left to wait for" would skip the install stage entirely on every fast machine.
 */
export function isInstallFinished(actions: Array<{ type: string; status: string }>): boolean {
  const shells = actions.filter((action) => action.type === 'shell');

  return shells.length > 0 && shells.every((action) => action.status !== 'pending' && action.status !== 'running');
}

export interface StarterReadyOptions {
  /**
   * Has the setup artifact's `npm install` finished? Read fresh on every poll — that is the point.
   *
   * "Finished" must include FAILED and ABORTED, not just succeeded. An install that errors out is a
   * project the user needs to look at, and treating only success as an ending turns a broken install
   * into the full install window spent staring at a splash.
   */
  installComplete: () => boolean;

  /** How many previews the store currently holds. */
  runningPreviews: () => number;

  /** Injected so the wait is testable without real time passing. */
  wait: (ms: number) => Promise<void>;

  /**
   * Called once as each stage begins, so the caller can narrate it.
   *
   * OPTIONAL since 2026-08-03: the creation flow narrates these stages in the TERMINAL now (owner —
   * the splash used to cover install+serve and no longer does), so it passes nothing. Required-ness
   * here would force a caller that has nothing to say to pass a no-op, which reads as an oversight
   * rather than as a decision.
   */
  onStage?: (stage: StarterReadyStage) => void;

  installTimeoutMs?: number;
  serveTimeoutMs?: number;
  pollMs?: number;
}

export interface StarterReadyResult {
  /** Did the install reach an ending within its window? `false` means the ceiling was hit. */
  installed: boolean;

  /** Did a preview appear? `false` means the ceiling was hit — the project exists either way. */
  serving: boolean;

  /**
   * Total polled time. The SUM OF THE POLLS, never a wall clock — the same rule the ledger's `seq`
   * ordering and `port-settle` both record: a clock that ties or goes backwards must not decide
   * anything, and a wall clock makes the bound untestable.
   */
  elapsedMs: number;
}

/**
 * Wait for the starter to install and start serving, narrating each stage.
 *
 * Both stages return as soon as their answer is known, so the fast path costs about one poll rather
 * than the window. Neither stage can prevent the other from running: an install that times out still
 * gets its serve wait, because a dev server may well already be up (the CodeSandbox template bakes one
 * in) and concluding "not installed, therefore not serving" would dismiss the splash on a project that
 * was a fraction of a second from showing its home page.
 */
export async function awaitStarterRunning(options: StarterReadyOptions): Promise<StarterReadyResult> {
  const pollMs = Math.max(1, options.pollMs ?? CREATION_READY_POLL_MS);
  const installTimeoutMs = options.installTimeoutMs ?? CREATION_INSTALL_TIMEOUT_MS;
  const serveTimeoutMs = options.serveTimeoutMs ?? CREATION_SERVE_TIMEOUT_MS;

  let elapsedMs = 0;

  options.onStage?.('install');

  let installed = options.installComplete();

  while (!installed && elapsedMs < installTimeoutMs) {
    const step = Math.min(pollMs, installTimeoutMs - elapsedMs);
    await options.wait(step);
    elapsedMs += step;
    installed = options.installComplete();
  }

  options.onStage?.('serve');

  /*
   * The port half is `awaitRunningPreview` rather than a second loop written here. It already answers
   * exactly this question, it already documents both wrong answers, and duplicating it would give the
   * product two places that decide "is something serving?" — which is how the two ended up disagreeing
   * everywhere else this repo has tried it.
   */
  const serving = await awaitRunningPreview({
    runningPreviews: options.runningPreviews,
    wait: async (ms) => {
      await options.wait(ms);
      elapsedMs += ms;
    },
    timeoutMs: serveTimeoutMs,
    pollMs,
  });

  return { installed, serving, elapsedMs };
}
