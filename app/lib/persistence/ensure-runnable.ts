/**
 * Making an opened project RUN — unconditionally, every time (SPEC §4.5.4b).
 *
 * 🔴 **OPENING A PROJECT MUST NOT BE A DECISION (owner, 2026-08-03).** Reported as *"I click the chat
 * to load the workspace, it is supposed to run `npm install` and `npm run dev`… it does not, it is just
 * sitting at the terminal"*, and then, on being told it reproduced only sometimes: *"selecting a project
 * and reopening should be ROCK SOLID… there should not be a decision making."* Correct, and the code
 * disagreed with it in three separate places:
 *
 *   1. `mountProjectFiles` took a `prepareToRun` option. The `/chat/:id` reload path passed **false**,
 *      delegating the install to a `<boltArtifact>` rebuilt from the chat's stored snapshot — which
 *      only exists when that chat happens to have a snapshot at index ≥ 1. A chat without one (a
 *      "New chat, same game", a project whose row 404s, an import whose setup artifact was never
 *      stored) mounted every file, installed nothing, started nothing, and said nothing.
 *   2. The mount is deduped per page load by PROJECT ID ALONE (`mountedThisLoad`), and concurrent
 *      callers join the FIRST caller's options (`mountInFlight`). Four components call
 *      `useChatHistory`, all running the same effect, so which instance won the race decided whether
 *      the workspace installed. That is the whole of "sometimes it does and sometimes it does not".
 *   3. `preparingContainer` was module-level and left set on success, so one project's prepare could
 *      silently satisfy the next project's.
 *
 * So the question "should this project be made runnable?" is deleted. Every mount ends here, and this
 * runs `npm install` and `npm run dev` unless the project is ALREADY serving — which is a fact read
 * from the preview store, not a guess about what some other code path might have done.
 *
 * ## Why it still cannot just fire the commands immediately
 *
 * `BoltShell.executeCommand` **interrupts whatever is running** (it writes `\x03` and waits for a
 * prompt before sending). The `/chat/:id` path replays an artifact whose actions run `npm install` and
 * `npm run dev` through that same single shell — so firing ours on top of a replay in flight would
 * Ctrl-C a running install, which is the exact failure `prepareToRun: false` was invented to dodge.
 * The fix is to WAIT for the shell to go quiet rather than to opt out of running at all: quiescence,
 * not a flag, for the same reason `settleAfterCreation` waits for the file map to stop changing rather
 * than sleeping a guessed number of milliseconds.
 *
 * ## Never regress, each of these fails silently
 *
 *   - **The install runs even when `node_modules` looks present.** The old code asked
 *     `decideDependencyInstall` about a FILE MAP, which is a stale, watcher-filled copy that never
 *     carries `node_modules` on some paths and does on others. `npm install` on a warm pod answers
 *     "added 0 packages" in ~2s; that is a cheap price for never being wrong about it again.
 *   - **A shell that never attaches is REPORTED, never swallowed.** The old path returned `false` and
 *     dismissed its toast, so the user got an idle terminal and no stated cause (`spec/fail-loud.md`).
 *   - **A dev server that never comes up is REPORTED.** `npm run dev` cannot be awaited (it runs for
 *     the life of the session), so the only honest confirmation is a preview appearing.
 */

/** How long to keep waiting for the shell to be free before running anything. */
export const SHELL_IDLE_CEILING_MS = 240_000;

/** How long the shell must be continuously idle before we believe nothing else is using it. */
export const SHELL_IDLE_WINDOW_MS = 1_500;

/** Poll interval for every wait in this module. */
export const POLL_MS = 250;

/** How long to wait for a preview after starting the dev server before calling it a failure. */
export const PREVIEW_TIMEOUT_MS = 120_000;

export type EnsureRunnableOutcome =
  | 'already-running'
  | 'started'
  | 'no-dev-script'
  | 'no-shell'
  | 'install-failed'
  | 'no-preview';

export interface EnsureRunnableDeps {
  /** Resolve true once the agent's shell has a process to talk to (`awaitShellAttached`). */
  waitForShell: () => Promise<boolean>;

  /** Is a command running in the agent's shell right now? */
  shellBusy: () => boolean;

  /** How many dev servers are serving in this sandbox (the preview store). */
  runningPreviews: () => number;

  /** The npm script that starts this project's dev server, or undefined if it declares none. */
  devScript: () => string | undefined;

  /** Run a command in the agent's shell. Resolves undefined if the shell dropped it. */
  execute: (id: string, command: string) => Promise<{ exitCode: number; output: string } | undefined>;

  /** Start the dev server without awaiting it — it never exits. */
  startDevServer: (command: string) => void;

  /**
   * Anything the user needs to know about. Called for every non-running outcome that is not simply
   * "this project declares no dev script" — a workspace that cannot run must never be silent.
   */
  onProblem: (outcome: EnsureRunnableOutcome, detail?: string) => void;

  /** Progress narration for the boot surface. Optional — nothing here depends on it. */
  onStep?: (step: 'waiting' | 'installing' | 'starting') => void;

  wait: (ms: number) => Promise<void>;
  now: () => number;

  shellIdleCeilingMs?: number;
  shellIdleWindowMs?: number;
  previewTimeoutMs?: number;
  pollMs?: number;
}

/**
 * Make the mounted project runnable, or say why it is not.
 *
 * Returns an outcome rather than throwing: every caller is a mount that has already succeeded, and a
 * project that cannot start its dev server is still a project the user must be able to look at and
 * edit. The reporting is `onProblem`'s job, and it is not optional.
 */
export async function ensureProjectRunnable(deps: EnsureRunnableDeps): Promise<EnsureRunnableOutcome> {
  const pollMs = deps.pollMs ?? POLL_MS;
  const idleWindowMs = deps.shellIdleWindowMs ?? SHELL_IDLE_WINDOW_MS;
  const idleCeilingMs = deps.shellIdleCeilingMs ?? SHELL_IDLE_CEILING_MS;
  const previewTimeoutMs = deps.previewTimeoutMs ?? PREVIEW_TIMEOUT_MS;

  if (deps.runningPreviews() > 0) {
    return 'already-running';
  }

  deps.onStep?.('waiting');

  if (!(await deps.waitForShell())) {
    deps.onProblem('no-shell');
    return 'no-shell';
  }

  /*
   * Wait for whatever else is using the one shared shell (an artifact replay's own install) to finish.
   * A CONTINUOUS idle window, not a single sample: a replay's actions are queued, so the shell dips to
   * idle between them and one sample lands in the gap — which would Ctrl-C the next command a moment
   * after it started.
   */
  const startedAt = deps.now();
  let idleSince: number | undefined;

  while (deps.now() - startedAt < idleCeilingMs) {
    if (deps.runningPreviews() > 0) {
      // Something else got there first and it is serving. Nothing left to do, and nothing to report.
      return 'already-running';
    }

    if (deps.shellBusy()) {
      idleSince = undefined;
    } else {
      idleSince ??= deps.now();

      if (deps.now() - idleSince >= idleWindowMs) {
        break;
      }
    }

    await deps.wait(pollMs);
  }

  deps.onStep?.('installing');

  const install = await deps.execute(`deps-${Math.round(deps.now())}`, 'npm install');

  if (!install) {
    /*
     * The shell accepted no command — it attached and then went away (a torn-down sandbox, a reset
     * terminal). Loud: this is the state that used to present as an idle terminal with no cause.
     */
    deps.onProblem('no-shell');
    return 'no-shell';
  }

  if (install.exitCode !== 0) {
    deps.onProblem('install-failed', install.output);
    return 'install-failed';
  }

  // The replay's own `start` action may have landed while we installed.
  if (deps.runningPreviews() > 0) {
    return 'already-running';
  }

  const script = deps.devScript();

  if (!script) {
    /*
     * Not a failure and not reported: a project that declares no dev/start script has nothing we are
     * permitted to run (the shell allow-list takes `npm run <script>` only), and inventing one would
     * be refused anyway.
     */
    return 'no-dev-script';
  }

  deps.onStep?.('starting');
  deps.startDevServer(`npm run ${script}`);

  /*
   * `npm run dev` never exits, so the only honest confirmation that the workspace came up is a preview
   * registering. Without this check a dev server that dies on startup (a bad `vite.config.ts`, a port
   * conflict, a missing native binding) leaves exactly the silent idle terminal this module exists to
   * abolish.
   */
  const waitingSince = deps.now();

  while (deps.now() - waitingSince < previewTimeoutMs) {
    if (deps.runningPreviews() > 0) {
      return 'started';
    }

    await deps.wait(pollMs);
  }

  deps.onProblem('no-preview');

  return 'no-preview';
}
