/**
 * Waiting for the agent's shell to attach, before asking it to run anything.
 *
 * 🔴 **THE INSTALL USED TO RIDE ON A REDUNDANCY, AND A FIX DELETED IT (2026-07-31).**
 *
 * `BoltShell.executeCommand` returns `undefined` — not a non-zero exit — when its terminal has not
 * attached yet, because the shell process is spawned by `attachBoltTerminal`, which the workbench's
 * `<Terminal>` calls on mount. A project mount that reaches the install before that render gets
 * nothing, and `installDependencies` treated it as "not yet, a later cycle will do it".
 *
 * There is no later cycle. That comment described the mount effect firing MORE THAN ONCE per page
 * load (its deps include `searchParams`, whose reference changes on hydration) — a redundancy the
 * `mountedThisLoad` guard removed the same week, because it was also costing a duplicated ~9s of
 * sandbox work. Nothing announced that the install had been depending on it.
 *
 * The result is a resumed project that mounts all of its files, never installs, never starts its dev
 * server, and shows an empty terminal with no preview — with nothing thrown and no error logged.
 *
 * ⚠️ **It went unnoticed because CodeSandbox cannot reach it.** A persistent VM keeps `node_modules`
 * on disk and the dev server running, so `prepareMountedProject` returns early at
 * `awaitRunningPreview` and the install is never needed. Only a tab-local runtime (Nodepod,
 * WebContainer) has to reinstall on every page load. A provider swap did not cause this defect; it
 * revealed one that had been latent behind the default.
 *
 * So the wait is EXPLICIT and BOUNDED here, rather than implicit in how often an effect happens to
 * re-run. Bounded because the original reasoning against `await shell.ready()` is still correct and
 * still load-bearing: **the terminal may never attach at all** (the workbench can stay closed), and
 * an unbounded wait there hangs the whole mount — trading a project that does not run for a project
 * that does not open.
 */

/**
 * How long to wait for the terminal to attach before giving up.
 *
 * 🔴 **Generous because the wait is DETACHED from the mount, and a short one is a guess about how
 * long a restore takes.** MEASURED live on a resumed 76-file project: `showWorkbench`, the xterm
 * element and the shell's process all appeared at **22,433 ms** — the same millisecond, because the
 * workbench does not render until the mount completes, and the terminal cannot attach before the
 * workbench renders. A 20s bound missed it by 2.4 seconds and the project silently never installed.
 *
 * Any fixed bound smaller than "however long this project's restore takes" loses that race, and a
 * bigger project loses it by more. The bound exists only so a terminal that never attaches at all
 * (the workbench can stay closed) does not leak a task that waits forever.
 */
export const SHELL_ATTACH_TIMEOUT_MS = 120_000;

/**
 * How long to wait between polls. Only used by the default clock; tests inject their own.
 *
 * The shell attaches in about a millisecond once the workbench renders (MEASURED live on Nodepod:
 * `init` completed in 1ms, process attached, first output the synthesised prompt), so this is really
 * waiting on a React render, not on the runtime.
 */
export const SHELL_ATTACH_POLL_MS = 100;

export interface AwaitShellAttachedOptions {
  /** Has the shell finished `init` — i.e. is there a process to talk to? */
  attached: () => boolean;

  /** Injected so tests need no real timers, and so a caller can pass an abort-aware wait. */
  wait: (ms: number) => Promise<void>;

  /** Elapsed-time source; injected for the same reason. */
  now: () => number;

  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Resolve `true` once the shell has attached, or `false` if it has not within the timeout.
 *
 * Polling rather than awaiting `shell.ready()` on purpose: `ready()` never rejects and never resolves
 * when the terminal is absent, so racing it against a timer leaves the losing promise pending for the
 * life of the page. A predicate can also be answered by a shell that attached BEFORE this was called,
 * which is the common case and must not cost a single tick.
 */
export async function awaitShellAttached(options: AwaitShellAttachedOptions): Promise<boolean> {
  const { attached, wait, now } = options;
  const timeoutMs = options.timeoutMs ?? SHELL_ATTACH_TIMEOUT_MS;
  const pollMs = options.pollMs ?? SHELL_ATTACH_POLL_MS;

  // Checked BEFORE any wait: an already-attached shell is the common case and must cost nothing.
  if (attached()) {
    return true;
  }

  const startedAt = now();

  while (now() - startedAt < timeoutMs) {
    await wait(pollMs);

    if (attached()) {
      return true;
    }
  }

  return false;
}
