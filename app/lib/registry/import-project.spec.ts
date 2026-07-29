/**
 * The workspace an IMPORT writes into (T3b, `spec/sandbox-codesandbox.md`).
 *
 * Importing a repo or a folder starts from the landing page, where no project exists — and on a
 * project-backed runtime there is nothing to write into until one does. Three properties here, and
 * every one of them fails SILENTLY:
 *
 *   - on a runtime that needs no project (WebContainer), and on an import started from inside an
 *     already-open project, NOTHING is registered. A server round trip added to the incumbent's
 *     import path is a behaviour change nobody asked for, and a second project row created because
 *     the user imported a folder into the game they already had open is a duplicate on the dashboard.
 *   - on a runtime that does need one, the project is registered BEFORE the boot and its id rides out
 *     with the workspace. Without that pointer the reload after an import boots a different sandbox
 *     and the clone is stranded on a VM nothing names.
 *   - a boot failure ROLLS THE ROW BACK and rethrows the boot's own error. An empty card on the
 *     dashboard reads as data loss; and a swallowed error is the indefinite spinner this whole task
 *     exists to remove, so the refusal must be DESCRIBED — the original message, not a cleanup one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({
  requiresProject: true,
  bootedProjectId: vi.fn<() => string | undefined>(),
  bootForProject: vi.fn(),
  requireBootedSandbox: vi.fn(),
}));

/*
 * `SANDBOX_REQUIRES_PROJECT` is a module const derived from `import.meta.env.VITE_SANDBOX_PROVIDER`,
 * so the only way to drive both builds from one file is to mock the seam and expose the flag as a
 * getter — the module reads it per call, which is what makes this legitimate rather than a fiction.
 */
vi.mock('~/lib/sandbox', () => ({
  get SANDBOX_REQUIRES_PROJECT() {
    return seam.requiresProject;
  },
  bootedProjectId: seam.bootedProjectId,
  bootForProject: seam.bootForProject,
  requireBootedSandbox: seam.requireBootedSandbox,
}));

const createProject = vi.hoisted(() => vi.fn());
const deleteProject = vi.hoisted(() => vi.fn());

vi.mock('~/lib/persistence/projects', () => ({ createProject, deleteProject }));

import { openImportWorkspace } from './import-project';

const BOOTED = { workdir: '/project/workspace' };
const EAGER = { workdir: '/home/project' };

beforeEach(() => {
  vi.clearAllMocks();
  seam.requiresProject = true;
  seam.bootedProjectId.mockReturnValue(undefined);
  seam.bootForProject.mockResolvedValue(BOOTED);
  seam.requireBootedSandbox.mockResolvedValue(EAGER);
  createProject.mockResolvedValue({ id: 'prj_new', name: 'Imported' });
  deleteProject.mockResolvedValue(undefined);
});

describe('an import that already has a workspace registers nothing', () => {
  it('uses the sandbox this tab is already bound to, and reports that project', async () => {
    seam.bootedProjectId.mockReturnValue('prj_open');

    const workspace = await openImportWorkspace({ name: 'my-repo' });

    expect(workspace.sandbox).toBe(EAGER);
    expect(workspace.projectId).toBe('prj_open');
    expect(createProject).not.toHaveBeenCalled();
    expect(seam.bootForProject).not.toHaveBeenCalled();
  });

  /*
   * WebContainer's runtime is tab-local and anonymous and boots at module scope; an import there has
   * never needed a project record. A server round trip here would be a regression, not a fix.
   */
  it('leaves the incumbent runtime byte-identical — no project, no boot call', async () => {
    seam.requiresProject = false;

    const workspace = await openImportWorkspace({ name: 'my-repo' });

    expect(workspace.sandbox).toBe(EAGER);
    expect(workspace.projectId).toBeUndefined();
    expect(createProject).not.toHaveBeenCalled();
    expect(seam.bootForProject).not.toHaveBeenCalled();
  });
});

describe('an import on a project-backed runtime registers the project first', () => {
  it('creates the project, then boots FOR it, and hands the id back', async () => {
    const workspace = await openImportWorkspace({ name: 'my-repo' });

    expect(createProject).toHaveBeenCalledTimes(1);
    expect(createProject.mock.calls[0][0]).toMatchObject({ name: 'my-repo' });
    expect(seam.bootForProject).toHaveBeenCalledWith('prj_new');

    // The ORDER is the property: there is no filesystem to boot into before the row exists.
    expect(createProject.mock.invocationCallOrder[0]).toBeLessThan(seam.bootForProject.mock.invocationCallOrder[0]);

    expect(workspace.sandbox).toBe(BOOTED);
    expect(workspace.projectId).toBe('prj_new');
  });

  it('never awaits the bare seam on this path', async () => {
    await openImportWorkspace({ name: 'my-repo' });

    /*
     * `requireBootedSandbox` refuses when nothing is booted — awaiting it here would turn every
     * landing-page import into a refusal instead of a project.
     */
    expect(seam.requireBootedSandbox).not.toHaveBeenCalled();
  });
});

describe('a boot failure is a DESCRIBED refusal with no orphan left behind', () => {
  it('rolls the row back and rethrows the boot’s own error', async () => {
    const failure = new Error('Sandbox provider is not configured.');
    seam.bootForProject.mockRejectedValueOnce(failure);

    await expect(openImportWorkspace({ name: 'my-repo' })).rejects.toBe(failure);

    expect(deleteProject).toHaveBeenCalledWith('prj_new');
  });

  /*
   * 🔴 A cleanup that fails must not replace the message the user needs. The boot failure is the
   * problem; "we could not roll back" is a different one, and reporting it sends them to fix the
   * wrong thing.
   */
  it('still reports the boot failure when the rollback itself fails', async () => {
    seam.bootForProject.mockRejectedValueOnce(new Error('VM quota exceeded'));
    deleteProject.mockRejectedValueOnce(new Error('network down'));

    await expect(openImportWorkspace({ name: 'my-repo' })).rejects.toThrow('VM quota exceeded');
  });

  /*
   * The whole point of T3b: a refusal, promptly, with words. Nothing on this path may resolve to a
   * pending promise — that is the indefinite spinner it replaces.
   */
  it('rejects rather than hanging when the project cannot even be registered', async () => {
    createProject.mockRejectedValueOnce(new Error('Sign in to create a project.'));

    await expect(openImportWorkspace({ name: 'my-repo' })).rejects.toThrow('Sign in to create a project.');

    // Nothing was registered, so there is nothing to roll back.
    expect(deleteProject).not.toHaveBeenCalled();
    expect(seam.bootForProject).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 The boot is NOT the last thing that can fail. A typo'd repo URL, a rejected credential, a file
 * that will not read — all of them happen after `openImportWorkspace` has returned, and without the
 * handed-back `rollback` the failed import leaves a registered empty project on the dashboard AND a
 * forked VM billing by the second. That is the same orphan this task removes from creation, one flow
 * over, and it would have been INTRODUCED by the fix rather than found in it.
 */
describe('the caller can undo a registration when the import itself fails', () => {
  it('hands back a rollback that deletes the project it created', async () => {
    const workspace = await openImportWorkspace({ name: 'my-repo' });

    expect(deleteProject).not.toHaveBeenCalled();

    await workspace.rollback();

    expect(deleteProject).toHaveBeenCalledWith('prj_new');
  });

  /*
   * A no-op when this call registered nothing — otherwise a failed import started from inside an open
   * project would DELETE the project the user is looking at, and a clone's own network retry would
   * delete the project its first attempt legitimately created.
   */
  it('is a no-op when this call registered nothing', async () => {
    seam.bootedProjectId.mockReturnValue('prj_open');

    const workspace = await openImportWorkspace({ name: 'my-repo' });
    await workspace.rollback();

    expect(deleteProject).not.toHaveBeenCalled();
  });

  it('never rejects, so it cannot replace the import failure it is cleaning up after', async () => {
    deleteProject.mockRejectedValueOnce(new Error('network down'));

    const workspace = await openImportWorkspace({ name: 'my-repo' });

    await expect(workspace.rollback()).resolves.toBeUndefined();
  });
});
