/**
 * `ensureProjectRunnable` — the guarantee that opening a project installs and starts it.
 *
 * Every test here is written against a failure that actually shipped (see the module's own doc): an
 * install that never ran because another code path was assumed to have run it, a shell command fired
 * on top of a running install, and — the one that made all of it invisible — a workspace that could
 * not run and said nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { ensureProjectRunnable, type EnsureRunnableDeps } from './ensure-runnable';

/** A clock that runs as fast as the test wants it to; nothing here waits on a real timer. */
function clock() {
  let t = 0;

  return {
    now: () => t,
    wait: async (ms: number) => {
      t += ms;
    },
  };
}

function deps(overrides: Partial<EnsureRunnableDeps> = {}): EnsureRunnableDeps {
  const c = clock();

  return {
    waitForShell: async () => true,
    shellBusy: () => false,
    runningPreviews: () => 0,
    devScript: () => 'dev',
    execute: async () => ({ exitCode: 0, output: '' }),
    startDevServer: () => {},
    onProblem: () => {},
    now: c.now,
    wait: c.wait,
    ...overrides,
  };
}

describe('ensureProjectRunnable', () => {
  it('installs and starts a project that is not serving', async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, output: '' }));
    const startDevServer = vi.fn();

    // Serving only once the dev server has been asked to start — a real preview, never an assumption.
    let started = false;

    const outcome = await ensureProjectRunnable(
      deps({
        execute,
        startDevServer: (command) => {
          startDevServer(command);
          started = true;
        },
        runningPreviews: () => (started ? 1 : 0),
      }),
    );

    expect(outcome).toBe('started');
    expect(execute).toHaveBeenCalledWith(expect.any(String), 'npm install');
    expect(startDevServer).toHaveBeenCalledWith('npm run dev');
  });

  /*
   * The whole point of the rewrite. The old code asked whether some OTHER path had already installed
   * (an artifact replay, a previous mount) and skipped when it thought so. It is not allowed to think.
   */
  it('installs even when nothing suggests it is needed', async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, output: '' }));

    await ensureProjectRunnable(deps({ execute, runningPreviews: () => 0, devScript: () => undefined }));

    expect(execute).toHaveBeenCalledWith(expect.any(String), 'npm install');
  });

  it('does nothing when the project is already serving', async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, output: '' }));
    const startDevServer = vi.fn();

    const outcome = await ensureProjectRunnable(deps({ execute, startDevServer, runningPreviews: () => 1 }));

    expect(outcome).toBe('already-running');
    expect(execute).not.toHaveBeenCalled();
    expect(startDevServer).not.toHaveBeenCalled();
  });

  /*
   * `executeCommand` Ctrl-Cs whatever is running. An artifact replay owns the same shell, so running
   * on top of it kills a live `npm install` — the failure `prepareToRun: false` used to dodge by not
   * running at all.
   */
  it('waits for the shared shell to go quiet before running anything', async () => {
    const c = clock();
    let busy = true;
    const busyAt: number[] = [];

    const outcome = await ensureProjectRunnable(
      deps({
        now: c.now,
        wait: async (ms) => {
          await c.wait(ms);

          if (c.now() >= 3_000) {
            busy = false;
          }
        },
        shellBusy: () => busy,
        execute: async () => {
          busyAt.push(c.now());
          return { exitCode: 0, output: '' };
        },
        devScript: () => undefined,
      }),
    );

    expect(outcome).toBe('no-dev-script');
    expect(busyAt).toHaveLength(1);
    expect(busyAt[0]).toBeGreaterThanOrEqual(3_000);
  });

  it('requires the shell to be continuously idle, not merely idle once', async () => {
    const c = clock();

    /*
     * Busy, then a single idle sample in the gap between two queued actions, then busy again. A
     * one-sample check fires into that gap and Ctrl-Cs the next command.
     */
    const samples = [true, false, true, true, false, false, false, false, false, false, false, false];
    let i = 0;

    let ranAt: number | undefined;

    await ensureProjectRunnable(
      deps({
        now: c.now,
        wait: c.wait,
        shellBusy: () => samples[Math.min(i++, samples.length - 1)],
        execute: async () => {
          ranAt = i;
          return { exitCode: 0, output: '' };
        },
        devScript: () => undefined,
      }),
    );

    // Not in the gap at index 1 — it must have waited out the later, sustained idle run.
    expect(ranAt).toBeGreaterThan(5);
  });

  it('stops waiting and reports if the shell never attaches', async () => {
    const onProblem = vi.fn();
    const execute = vi.fn(async () => ({ exitCode: 0, output: '' }));

    const outcome = await ensureProjectRunnable(deps({ waitForShell: async () => false, onProblem, execute }));

    expect(outcome).toBe('no-shell');
    expect(execute).not.toHaveBeenCalled();
    expect(onProblem).toHaveBeenCalledWith('no-shell');
  });

  /* A dropped command used to be read as "not yet, someone will retry" — nobody retries. */
  it('reports a command the shell silently dropped', async () => {
    const onProblem = vi.fn();

    const outcome = await ensureProjectRunnable(deps({ execute: async () => undefined, onProblem }));

    expect(outcome).toBe('no-shell');
    expect(onProblem).toHaveBeenCalledWith('no-shell');
  });

  it('reports a failed install and never starts the dev server on top of it', async () => {
    const onProblem = vi.fn();
    const startDevServer = vi.fn();

    const outcome = await ensureProjectRunnable(
      deps({
        execute: async () => ({ exitCode: 1, output: 'npm ERR! code ERESOLVE' }),
        onProblem,
        startDevServer,
      }),
    );

    expect(outcome).toBe('install-failed');
    expect(startDevServer).toHaveBeenCalledTimes(0);
    expect(onProblem).toHaveBeenCalledWith('install-failed', 'npm ERR! code ERESOLVE');
  });

  it('reports a dev server that never produces a preview', async () => {
    const onProblem = vi.fn();

    const outcome = await ensureProjectRunnable(deps({ onProblem, runningPreviews: () => 0 }));

    expect(outcome).toBe('no-preview');
    expect(onProblem).toHaveBeenCalledWith('no-preview');
  });

  /* A project with no dev script has nothing we are permitted to run; that is not a fault to report. */
  it('is quiet about a project that declares no dev script', async () => {
    const onProblem = vi.fn();

    const outcome = await ensureProjectRunnable(deps({ devScript: () => undefined, onProblem }));

    expect(outcome).toBe('no-dev-script');
    expect(onProblem).not.toHaveBeenCalled();
  });

  it('stands down if another path starts serving while the install runs', async () => {
    const startDevServer = vi.fn();
    let serving = 0;

    const outcome = await ensureProjectRunnable(
      deps({
        execute: async () => {
          serving = 1;
          return { exitCode: 0, output: '' };
        },
        runningPreviews: () => serving,
        startDevServer,
      }),
    );

    expect(outcome).toBe('already-running');
    expect(startDevServer).not.toHaveBeenCalled();
  });

  it('gives up waiting for a shell that stays busy forever, rather than hanging the open', async () => {
    const c = clock();
    const execute = vi.fn(async () => ({ exitCode: 0, output: '' }));

    await ensureProjectRunnable(
      deps({
        now: c.now,
        wait: c.wait,
        shellBusy: () => true,
        execute,
        devScript: () => undefined,
        shellIdleCeilingMs: 5_000,
      }),
    );

    // It still ran: a workspace that cannot install is worse than one that interrupted something.
    expect(execute).toHaveBeenCalled();
    expect(c.now()).toBeGreaterThanOrEqual(5_000);
  });
});
