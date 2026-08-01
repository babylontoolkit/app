/**
 * The workspace an IMPORT writes into (T3b, `spec/sandbox-codesandbox.md`).
 *
 * Importing a repo or a folder starts from the landing page, where no project exists — and on a
 * project-backed runtime there is nothing to write into until one does. Three properties here, and
 * every one of them fails SILENTLY:
 *
 *   - EVERY import registers, on BOTH runtimes, because registration is where `PROJECT_CREATE_CREDITS`
 *     is taken and both runtimes provision a workspace the platform pays for (owner, 2026-07-31). The
 *     sole exemption is an import started from inside an ALREADY-OPEN project: that workspace has been
 *     paid for already, so a second registration bills twice for one VM and puts a duplicate card on
 *     the dashboard. `SANDBOX_REQUIRES_PROJECT` now decides only whether a failed registration is
 *     fatal — never whether money is taken.
 *   - a 402 is a DECISION, not an outage, so it refuses on every runtime; anything else degrades to a
 *     browser-local import only where the runtime can boot without a project id.
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

/*
 * `ApiError` must be a REAL class here, not a stub: the module distinguishes a 402 from an outage with
 * `instanceof`, and a plain object would fail that check silently — turning "the platform declined" into
 * "the server was unreachable", which is the exact mis-degradation these tests exist to prevent.
 */
const errors = vi.hoisted(() => {
  class ApiError extends Error {
    statusCode: number;

    constructor(message: string, statusCode: number) {
      super(message);
      this.name = 'ApiError';
      this.statusCode = statusCode;
    }
  }

  return { ApiError };
});

vi.mock('~/lib/persistence/projects', () => ({ ApiError: errors.ApiError, createProject, deleteProject }));

/** A refusal the module must treat as a decision, not an outage. */
const refusal = (message: string) => new errors.ApiError(message, 402);

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
   * The exemption is `alreadyBooted` and ONLY `alreadyBooted`: that workspace exists and has already
   * been charged for, so a second registration would bill twice for one VM. It must hold on the
   * incumbent runtime too, where the tab is bound to a project.
   */
  it('registers nothing on the incumbent runtime either, when a project is already open', async () => {
    seam.requiresProject = false;
    seam.bootedProjectId.mockReturnValue('prj_open');

    const workspace = await openImportWorkspace({ name: 'my-repo' });

    expect(workspace.projectId).toBe('prj_open');
    expect(createProject).not.toHaveBeenCalled();
  });
});

/*
 * 🔴 EVERY IMPORT REGISTERS, ON BOTH RUNTIMES — because registration is where `PROJECT_CREATE_CREDITS`
 * is taken, and both runtimes provision a workspace the platform pays for (owner, 2026-07-31).
 *
 * This reverses a deliberate earlier decision that skipped registration when the RUNTIME did not need
 * a project id. That expression was answering a runtime question and a billing question at once, so
 * the identical import was billed on CodeSandbox and free on the default provider, silently.
 */
describe('an import on the incumbent runtime still registers, because that is where the charge is taken', () => {
  beforeEach(() => {
    seam.requiresProject = false;
  });

  it('creates the project even though the runtime does not need its id to boot', async () => {
    const workspace = await openImportWorkspace({ name: 'my-repo' });

    expect(createProject).toHaveBeenCalledTimes(1);
    expect(createProject.mock.calls[0][0]).toMatchObject({ name: 'my-repo' });
    expect(workspace.projectId).toBe('prj_new');
  });

  /*
   * §1.3 principle 0 — an unreachable server must not stop someone building. This runtime boots
   * without a project id, so an outage degrades to a browser-local import rather than a refusal.
   */
  it('degrades to a browser-local import when registration is unreachable', async () => {
    createProject.mockRejectedValue(new Error('network down'));

    const workspace = await openImportWorkspace({ name: 'my-repo' });

    expect(workspace.sandbox).toBe(EAGER);
    expect(workspace.projectId).toBeUndefined();
    expect(workspace.rollback).toBeDefined();
    await expect(workspace.rollback()).resolves.toBeUndefined();
    expect(deleteProject).not.toHaveBeenCalled();
  });

  /*
   * ⚠️ THE ONE THAT COSTS MONEY IF IT REGRESSES. A 402 is the platform deliberately declining, not an
   * outage: degrading past it hands a user with no credits a working project for FREE and tells them
   * the server was unreachable. Both halves wrong, neither throws.
   */
  it('refuses a 402 rather than degrading past it', async () => {
    createProject.mockRejectedValue(refusal('Not enough credits — 100 needed, 12 available.'));

    await expect(openImportWorkspace({ name: 'my-repo' })).rejects.toThrow(/Not enough credits/);
    expect(seam.bootForProject).not.toHaveBeenCalled();
  });
});

describe('a 402 refuses on the project-backed runtime too', () => {
  it('rethrows the platform’s own message, naming the price', async () => {
    createProject.mockRejectedValue(refusal('Not enough credits — 100 needed, 12 available.'));

    await expect(openImportWorkspace({ name: 'my-repo' })).rejects.toThrow(/100 needed/);
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
