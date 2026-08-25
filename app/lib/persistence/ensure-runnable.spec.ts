/**
 * `ensureProjectRunnable` — the guarantee that opening a project installs and starts it.
 *
 * Every test here is written against a failure that actually shipped (see the module's own doc): an
 * install that never ran because another code path was assumed to have run it, a shell command fired
 * on top of a running install, and — the one that made all of it invisible — a workspace that could
 * not run and said nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ensureProjectRunnable, SHELL_IDLE_CEILING_MS, type EnsureRunnableDeps } from './ensure-runnable';

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

/**
 * The rejected design, pinned as an ABSENCE (T14).
 *
 * ⚠️ A source scan, not a behavioural test — there is no behaviour to observe, which is the point. The
 * old code asked `decideDependencyInstall` whether an install was needed, and got it wrong in a way
 * nobody could see: it reads a FILE MAP, which is a stale watcher-filled copy that carries
 * `node_modules` on some paths and not on others, so the workspace installed sometimes and sat at an
 * idle terminal the rest of the time (owner: *"there should not be a decision making"*). Deleting the
 * conditional fixed it; nothing stops it being reintroduced as an obvious-looking optimisation, and if
 * it were, every test above would still pass — they all drive a project that has to install.
 *
 * The module's own doc NAMES `decideDependencyInstall` to explain why it was rejected, so comments are
 * stripped first: a gate that fires on the explanation of a fix forces the next person to delete the
 * warning in order to get green (`no-client-token.spec.ts`'s established pattern).
 */
describe('the dependency decision stays deleted', () => {
  const MODULE = path.join(process.cwd(), 'app/lib/persistence/ensure-runnable.ts');
  const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const code = stripComments(fs.readFileSync(MODULE, 'utf8'));

  it('consults no dependency decision and does not import the module that makes one', () => {
    expect(code).not.toContain('decideDependencyInstall');
    expect(code).not.toMatch(/from\s+['"]\.\/dependencies['"]/);
  });

  /*
   * CONTROL. The two assertions above are equally satisfied by a scanner that reads an empty string —
   * a wrong path, a comment stripper that ate the file. This proves the same stripped source still
   * carries the code it is supposed to.
   */
  it('the scanner is reading real code — the same stripped source still contains the function itself', () => {
    expect(code).toContain('export async function ensureProjectRunnable');
    expect(code).toContain("'npm install'");

    // And the stripper really strips: the rejected name survives in the ORIGINAL, in prose only.
    expect(fs.readFileSync(MODULE, 'utf8')).toContain('decideDependencyInstall');
  });
});

/**
 * 🔴 RESTART MODE — replacing a dev server that is already running (§4.13a, owner 2026-08-22).
 *
 * Reported as *"something is wrong with SWITCHING BRANCHES… I have to either RELOAD the page or
 * control-break in the terminal and manually fire off `npm run dev` — ONLY THEN does the proper preview
 * show."* The Ctrl-C is the diagnosis: the stale thing was the dev SERVER, holding the previous
 * branch's module graph in memory, not the iframe in front of it.
 *
 * This module's whole contract is "unless it is already serving", which is right for a mount and
 * backwards for a branch operation — so `applyBranchTree` got `already-running` off the first line and
 * ran nothing at all.
 */
describe('restart mode replaces a running dev server', () => {
  it('installs and starts even though something is already serving', async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, output: '' }));
    const startDevServer = vi.fn();

    const outcome = await ensureProjectRunnable(
      deps({
        restart: true,

        /* Serving throughout — the old server's port, which is the whole point. */
        runningPreviews: () => 1,
        execute,
        startDevServer,
      }),
    );

    expect(outcome).toBe('started');
    expect(execute).toHaveBeenCalledWith(expect.any(String), 'npm install');
    expect(startDevServer).toHaveBeenCalledWith('npm run dev');
  });

  /**
   * CONTROL — the exact same facts WITHOUT `restart` must still stand down. Without this the test
   * above passes for a module that lost its `already-running` guard entirely, which would make every
   * mount Ctrl-C a healthy dev server.
   */
  it('CONTROL — without restart, a serving project is left alone', async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, output: '' }));
    const startDevServer = vi.fn();

    const outcome = await ensureProjectRunnable(deps({ runningPreviews: () => 1, execute, startDevServer }));

    expect(outcome).toBe('already-running');
    expect(execute).not.toHaveBeenCalled();
    expect(startDevServer).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ THE IDLE WAIT IS SKIPPED, and this is the difference between a fix and a four-minute stall.
   * The shell is busy *because* the dev server being replaced is running in it, so the quiescence loop
   * can never be satisfied — it would poll to the full ceiling and then run the same command anyway,
   * with the workspace covered the whole time. `executeCommand` writes `\x03` first, so the install
   * command IS the Ctrl-C the user has been typing by hand.
   */
  it('does not wait for a shell that is busy running the server it is replacing', async () => {
    const c = clock();
    const execute = vi.fn(async () => ({ exitCode: 0, output: '' }));

    const outcome = await ensureProjectRunnable(
      deps({
        restart: true,
        runningPreviews: () => 1,
        shellBusy: () => true,
        execute,
        now: c.now,
        wait: c.wait,
      }),
    );

    expect(outcome).toBe('started');
    expect(execute).toHaveBeenCalled();
    expect(c.now(), 'the restart sat through the idle ceiling').toBeLessThan(SHELL_IDLE_CEILING_MS);
  });

  /**
   * 🔴 The subtle one. The Ctrl-C kills the server, but the preview store need not deregister its port
   * before the post-install check runs. Reading a stale registration there would return
   * `already-running` from a restart that has just torn the dev server DOWN — leaving the project with
   * no server at all, which is worse than the bug being fixed.
   */
  it('starts the server even if the old port is still registered after the install', async () => {
    const startDevServer = vi.fn();

    const outcome = await ensureProjectRunnable(
      deps({ restart: true, runningPreviews: () => 1, shellBusy: () => true, startDevServer }),
    );

    expect(startDevServer).toHaveBeenCalledTimes(1);
    expect(outcome).toBe('started');
  });

  /** A failed install is still a failed install — restart mode changes what runs, not what is reported. */
  it('still reports an install failure', async () => {
    const onProblem = vi.fn();

    const outcome = await ensureProjectRunnable(
      deps({
        restart: true,
        runningPreviews: () => 1,
        execute: async () => ({ exitCode: 1, output: 'ENOENT' }),
        onProblem,
      }),
    );

    expect(outcome).toBe('install-failed');
    expect(onProblem).toHaveBeenCalledWith('install-failed', 'ENOENT');
  });
});
