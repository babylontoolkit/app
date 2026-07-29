// @vitest-environment jsdom
/**
 * Cloning a repository into a project this hook had to REGISTER first (T3b).
 *
 * Two subjects. `repoNameOf` is pure — a clone now names a project, so the URL became user-visible.
 * The rest drives the REAL hook with `git.clone` mocked, because the clone is the LAST thing that can
 * fail and it fails after the project exists:
 *
 * 🔴 **A typo'd URL (404) or a rejected credential (401) used to leave a registered empty project on
 * the dashboard AND a forked VM billing by the second.** The outer `try` around the retry/messaging
 * block owns the undo — `await rollback(); throw error;` — and that one line is invisible when it is
 * missing: the clone still fails with exactly the right words, the user still sees the right toast,
 * and the only trace is an empty card they did not make. It was verified that deleting
 * `rollback = workspace.rollback` kept the entire suite green (finding F9), so it is pinned here
 * behaviourally rather than by reading the source.
 *
 * The inverse is equally load-bearing and equally silent: `NO_ROLLBACK` when this call registered
 * nothing. A clone started from INSIDE an open project must never delete the project the user is
 * looking at, and a network retry must not delete the project the first attempt legitimately created.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const seam = vi.hoisted(() => ({
  requiresProject: true,
  bootedProjectId: vi.fn<() => string | undefined>(),
  requireBootedSandbox: vi.fn(),
}));

/* The flag is a module const derived from `import.meta.env`; a getter is the only honest way to vary it. */
vi.mock('~/lib/sandbox', () => ({
  get SANDBOX_REQUIRES_PROJECT() {
    return seam.requiresProject;
  },
  bootedProjectId: seam.bootedProjectId,
  requireBootedSandbox: seam.requireBootedSandbox,
}));

const openImportWorkspace = vi.hoisted(() => vi.fn());
const noRollback = vi.hoisted(() =>
  vi.fn(async () => {
    /* The real one is a no-op too — this exists only so the tests can tell the two apart. */
  }),
);

vi.mock('~/lib/registry/import-project', () => ({ openImportWorkspace, NO_ROLLBACK: noRollback }));

const clone = vi.hoisted(() => vi.fn());

vi.mock('isomorphic-git', () => ({ default: { clone } }));
vi.mock('isomorphic-git/http/web', () => ({ default: {} }));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), success: vi.fn() } }));
vi.mock('js-cookie', () => ({ default: { get: vi.fn(() => undefined), set: vi.fn() } }));

import { repoNameOf, useGit } from './useGit';

const URL_OK = 'https://github.com/MackeyK24/blank-canvas.git';

/** The rollback the acquisition hands back when it DID register a project. */
const workspaceRollback = vi.fn(async () => {
  /* Deliberately empty: what matters is WHETHER it was called, never what it does. */
});

const sandboxFs = {
  writeFile: vi.fn(async () => undefined),
  readFile: vi.fn(async () => ''),
  mkdir: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  rm: vi.fn(async () => undefined),
};

const SANDBOX = { workdir: '/project/workspace', fs: sandboxFs };

beforeEach(() => {
  vi.clearAllMocks();
  seam.requiresProject = true;

  // The landing-page shape: nothing booted, so the hook is ready at once and acquires on clone.
  seam.bootedProjectId.mockReturnValue(undefined);
  seam.requireBootedSandbox.mockResolvedValue(SANDBOX);

  openImportWorkspace.mockResolvedValue({
    sandbox: SANDBOX,
    projectId: 'prj_new',
    rollback: workspaceRollback,
  });

  /* A clone that succeeds writes at least one file, which is what fills the returned `data` map. */
  clone.mockImplementation(async (options: any) => {
    await options.fs.promises.writeFile(`${SANDBOX.workdir}/README.md`, '# hi', { encoding: 'utf8' });
  });

  // The hook logs the clone's progress and its failures; silenced so a red suite stays readable.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function readyGit() {
  const { result } = renderHook(() => useGit());
  await waitFor(() => expect(result.current.ready).toBe(true));

  return result;
}

describe('repoNameOf', () => {
  it.each([
    ['https://github.com/MackeyK24/blank-canvas.git', 'blank-canvas'],
    ['https://github.com/MackeyK24/blank-canvas', 'blank-canvas'],
    ['https://github.com/MackeyK24/blank-canvas/', 'blank-canvas'],
    ['https://github.com/MackeyK24/blank-canvas.git#dev', 'blank-canvas'],
    ['https://github.com/MackeyK24/blank-canvas#feature/thing', 'blank-canvas'],
    ['git@github.com:MackeyK24/blank-canvas.git', 'blank-canvas'],
    ['https://gitlab.com/group/sub/My.Repo.GIT', 'My.Repo'],
  ])('names %s → %s', (url, expected) => {
    expect(repoNameOf(url)).toBe(expected);
  });

  it.each(['', '#dev', '///'])('falls back to a readable name for %j', (url) => {
    expect(repoNameOf(url)).toBe('Imported Repository');
  });

  /*
   * A URL with no repository segment keeps whatever IS recognisable rather than throwing it away —
   * "github.com" tells the user which import this project came from; a hard fallback would not.
   */
  it('keeps the last recognisable segment when there is no repo name', () => {
    expect(repoNameOf('https://github.com/')).toBe('github.com');
  });
});

describe('a clone that fails leaves no orphan behind', () => {
  /* 🔴 The F9 mutation's target: the rollback the acquisition handed back must actually be held. */
  it('rolls the registration back exactly once when the repository does not exist', async () => {
    clone.mockRejectedValueOnce(new Error('HttpError: 404 Not Found'));

    const result = await readyGit();

    await expect(result.current.gitClone(URL_OK)).rejects.toThrow(/Repository not found/);

    expect(openImportWorkspace).toHaveBeenCalledWith({ name: 'blank-canvas' });
    expect(workspaceRollback).toHaveBeenCalledTimes(1);
  });

  /* A rejected credential is the other likely failure, and it must undo the same way. */
  it('rolls the registration back when the credentials are refused', async () => {
    clone.mockRejectedValueOnce(new Error('HttpError: 401 Unauthorized'));

    const result = await readyGit();

    await expect(result.current.gitClone(URL_OK)).rejects.toThrow(/Unauthorized access/);
    expect(workspaceRollback).toHaveBeenCalledTimes(1);
  });

  /*
   * The undo must not eat the diagnosis. A rollback that swallowed the error would leave the caller
   * with a resolved promise and no repository — the silent success that is worse than the failure.
   */
  it('still propagates the failure after the rollback runs', async () => {
    const failure = new Error('something unmapped went wrong');
    clone.mockRejectedValueOnce(failure);

    const result = await readyGit();

    await expect(result.current.gitClone(URL_OK)).rejects.toBe(failure);
    expect(workspaceRollback).toHaveBeenCalledTimes(1);
  });
});

describe('a clone that succeeds keeps its project', () => {
  /*
   * The control. Without it every assertion above passes just as well if `rollback` were called
   * unconditionally — which would delete the project on the happy path, the worst outcome available.
   */
  it('never rolls back, and returns the workdir, the files and the project id', async () => {
    const result = await readyGit();

    const cloned = await result.current.gitClone(URL_OK);

    expect(workspaceRollback).not.toHaveBeenCalled();
    expect(cloned.workdir).toBe('/project/workspace');
    expect(cloned.projectId).toBe('prj_new');
    expect(cloned.data).toHaveProperty('README.md');
  });
});

describe('a clone from inside an already-open project touches nothing', () => {
  /*
   * 🔴 `openImportWorkspace` takes its already-booted branch and hands back `NO_ROLLBACK`, so a failed
   * clone here must NOT delete the project the user is currently looking at. This is the branch that
   * makes the rollback safe to hold unconditionally, and it is invisible if it breaks: the user sees a
   * clone error and, later, that their game is gone.
   */
  it('acquires nothing and deletes nothing when the clone fails', async () => {
    seam.bootedProjectId.mockReturnValue('prj_open');
    clone.mockRejectedValueOnce(new Error('HttpError: 404 Not Found'));

    const result = await readyGit();

    await expect(result.current.gitClone(URL_OK)).rejects.toThrow(/Repository not found/);

    expect(openImportWorkspace).not.toHaveBeenCalled();
    expect(workspaceRollback).not.toHaveBeenCalled();
  });
});

describe('a network retry does not delete the project the first attempt created', () => {
  /*
   * The retry recurses into `gitClone`, and the recursive call returns THROUGH the outer try — so a
   * second attempt that succeeds must never reach the catch. Getting this wrong deletes a project
   * whose clone then completes into it: a live import writing to a row that no longer exists.
   */
  it('retries after a timeout and rolls nothing back when the second attempt lands', async () => {
    clone.mockRejectedValueOnce(new Error('connect ETIMEDOUT 140.82.121.4:443'));

    const result = await readyGit();

    vi.useFakeTimers();

    const pending = result.current.gitClone(URL_OK);

    // The retry sleeps `1000 * retryCount` before trying again; fake timers keep this instant.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    const cloned = await pending;

    expect(clone).toHaveBeenCalledTimes(2);
    expect(workspaceRollback).not.toHaveBeenCalled();
    expect(cloned.projectId).toBe('prj_new');
  });
});
