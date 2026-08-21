/**
 * The first durable copy of an imported project (SPEC §4.5.4b, §4.5.4c, §4.12, §4.13a).
 *
 * 🔴 Everything here fails SILENTLY, on the only copy of somebody's project. `importChat` ends in a
 * full page load and the enabled sandbox provider does not survive one, so this checkpoint IS the
 * import as far as the next page load is concerned. A lax serialize writes a map that DELETES the
 * binaries it could not read (a checkpoint restores with `protectNothing`); a swallowed failure leaves
 * the user believing an import landed when it did not; a checkpoint written before the map is captured
 * is a photograph of a half-arrived project.
 *
 * Collaborators are mocked at the LEAF — the local snapshot store, the serialize policy's input, the
 * working-copy writer — so the module under test is real and the assertions are about ORDER, ARGUMENTS
 * and what reaches the user.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const snapshots = vi.hoisted(() => ({ createLocalSnapshot: vi.fn() }));
const workbench = vi.hoisted(() => ({ serializeFiles: vi.fn(), files: { get: vi.fn(() => ({})) } }));
const workingCopy = vi.hoisted(() => ({ saveWorkingCopy: vi.fn() }));
const budget = vi.hoisted(() => ({ withinWorkingCopyBudget: vi.fn(() => true) }));
const toasts = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() }));
const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() }));
const history = vi.hoisted(() => ({ db: {} as IDBDatabase | undefined }));

vi.mock('react-toastify', () => ({ toast: toasts }));
vi.mock('~/utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/logger')>()),
  createScopedLogger: () => log,
}));
vi.mock('~/lib/persistence/local-snapshots', () => ({ createLocalSnapshot: snapshots.createLocalSnapshot }));
vi.mock('~/lib/persistence/projects', () => ({ saveWorkingCopy: workingCopy.saveWorkingCopy }));
vi.mock('~/lib/persistence/working-copy-size', () => ({ withinWorkingCopyBudget: budget.withinWorkingCopyBudget }));
vi.mock('~/lib/stores/workbench', () => ({ workbenchStore: workbench }));

/*
 * `db` is read as a LIVE BINDING at call time (the hook assigns it once IndexedDB opens), so the getter
 * is what lets a test move it — a plain value would freeze whatever it was at import.
 */
vi.mock('~/lib/persistence/useChatHistory', () => ({
  get db() {
    return history.db;
  },
}));

import { checkpointImportedProject } from './import-checkpoint';
import { CHECKPOINT_RETRY_DELAY_MS, CHECKPOINT_SERIALIZE_ATTEMPTS } from './checkpoint-run';

const FILES = {
  '/home/project/package.json': { type: 'file' as const, content: '{}', isBinary: false },
  '/home/project/public/logo.png': { type: 'file' as const, content: 'AAA=', isBinary: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  history.db = {} as IDBDatabase;
  workbench.serializeFiles.mockResolvedValue(FILES);
  snapshots.createLocalSnapshot.mockResolvedValue({ id: 'snap_1', seq: 3 });
  workingCopy.saveWorkingCopy.mockResolvedValue(undefined);
  budget.withinWorkingCopyBudget.mockReturnValue(true);
  workbench.files = { get: vi.fn(() => FILES) };
});

describe('the map it checkpoints', () => {
  it('uses the map the caller handed in, without reading the sandbox', async () => {
    await expect(checkpointImportedProject({ projectId: 'prj_1', name: 'octocat/Hello', files: FILES })).resolves.toBe(
      true,
    );

    expect(workbench.serializeFiles).not.toHaveBeenCalled();
    expect(snapshots.createLocalSnapshot.mock.calls[0][1]).toMatchObject({ projectId: 'prj_1', files: FILES });
  });

  /* Names the row in the §4.12 version list — "Imported <what>", never an internal id. */
  it('labels the checkpoint with what was imported', async () => {
    await checkpointImportedProject({ projectId: 'prj_1', name: 'my-game', files: FILES });

    expect(snapshots.createLocalSnapshot.mock.calls[0][1]).toMatchObject({ label: 'Imported my-game' });
  });

  it('serializes the whole store when the caller hands in no map', async () => {
    await expect(checkpointImportedProject({ projectId: 'prj_1', name: 'my-game' })).resolves.toBe(true);

    expect(workbench.serializeFiles).toHaveBeenCalled();
    expect(snapshots.createLocalSnapshot.mock.calls[0][1]).toMatchObject({ files: FILES });
  });

  /*
   * 🔴 STRICT. A lax serialize omits binaries it could not read, and this map is restored as the whole
   * truth under `protectNothing` — so a lax import checkpoint arranges for `havok.wasm` to be deleted
   * on the next reload. That is the very defect a checkpoint exists to prevent, wearing its clothes.
   */
  it('serializes strictly, never leniently', async () => {
    await checkpointImportedProject({ projectId: 'prj_1', name: 'my-game' });

    expect(workbench.serializeFiles).toHaveBeenCalledWith({ strict: true });
  });
});

describe('the server recovery copy', () => {
  /*
   * A folder import has no repository behind it, so the local checkpoint and this copy are the only
   * places the project exists (§4.5.4c).
   *
   * 🔴 Written from the map already in hand, under the checkpoint's OWN seq — never re-read from the
   * store. Resume compares the two copies, and one monotonic counter is what makes that comparison
   * mean anything.
   */
  it('is written from the checkpointed map, under the checkpoint’s own seq', async () => {
    await checkpointImportedProject({ projectId: 'prj_1', name: 'my-game', serverCopy: true });

    expect(workingCopy.saveWorkingCopy).toHaveBeenCalledWith('prj_1', 3, FILES);
  });

  /*
   * The CONTROL. A git import is born LINKED, and a linked browser with no local checkpoint mounts from
   * the repo — `selectMountSource` never ranks the working copy against it — so a copy written here
   * would be written and never read.
   */
  it('is not written for an import that has a repository', async () => {
    await checkpointImportedProject({ projectId: 'prj_1', name: 'octocat/Hello', files: FILES });

    expect(workingCopy.saveWorkingCopy).not.toHaveBeenCalled();
  });

  /*
   * The §4.16 size gate, applied exactly as `checkpointProject` applies it: over the client budget the
   * project keeps its local checkpoint and simply has no server copy. Uploading it is what froze the
   * tab on media-heavy projects.
   */
  it('is skipped, not attempted, for a project over the client budget', async () => {
    budget.withinWorkingCopyBudget.mockReturnValue(false);

    await expect(checkpointImportedProject({ projectId: 'prj_1', name: 'my-game', serverCopy: true })).resolves.toBe(
      true,
    );

    expect(workingCopy.saveWorkingCopy).not.toHaveBeenCalled();
    expect(snapshots.createLocalSnapshot).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('budget'));
  });

  /* Sequenced after the checkpoint: a failed upload degrades to "no recovery copy", never "no checkpoint". */
  it('never takes the checkpoint down with it', async () => {
    workingCopy.saveWorkingCopy.mockRejectedValue(new Error('offline'));

    await expect(checkpointImportedProject({ projectId: 'prj_1', name: 'my-game', serverCopy: true })).resolves.toBe(
      true,
    );

    expect(snapshots.createLocalSnapshot).toHaveBeenCalledTimes(1);

    // Logged for us; not toasted, because the user has already been told everything actionable.
    expect(log.warn).toHaveBeenCalled();
    expect(toasts.warn).not.toHaveBeenCalled();
  });
});

describe('every failure is loud', () => {
  /**
   * 🔴 The user is the only party who can act on this: their import may simply not come back. A
   * `logger.error` on that path is a silent data loss with a receipt nobody reads (`spec/fail-loud.md`).
   */
  it('warns the user, naming the cause and the consequence, when the snapshot write fails', async () => {
    snapshots.createLocalSnapshot.mockRejectedValue(new Error('IndexedDB is full'));

    await expect(checkpointImportedProject({ projectId: 'prj_1', name: 'my-game', files: FILES })).resolves.toBe(false);

    expect(toasts.warn).toHaveBeenCalledTimes(1);

    const message = toasts.warn.mock.calls[0][0] as string;

    // The cause, in the failure's own words — never a fixed "something went wrong".
    expect(message).toContain('IndexedDB is full');

    // The consequence, and the one action that fixes it.
    expect(message).toMatch(/reload/i);
    expect(message).toMatch(/repositor/i);

    // Asserted alongside, so "made it loud" cannot mean "moved the record into a toast that auto-dismisses".
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('checkpoint'), expect.any(Error));
  });

  it('warns when the store could not be serialized, and writes nothing', async () => {
    workbench.serializeFiles.mockRejectedValue(new Error('ENOENT: havok.wasm'));

    /*
     * Fake timers, because the retries are SPACED on purpose (`checkpoint-run.ts`: a burst of RTT reads
     * racing fresh writes needs time, not instant retries) — running them for real would put the real
     * delay into every CI run. Advanced past every retry but well short of the per-attempt timeout, so
     * this exercises the failure path it names rather than the timeout path beside it.
     */
    vi.useFakeTimers();

    try {
      const pending = checkpointImportedProject({ projectId: 'prj_1', name: 'my-game' });

      await vi.advanceTimersByTimeAsync(CHECKPOINT_RETRY_DELAY_MS * (CHECKPOINT_SERIALIZE_ATTEMPTS + 1));
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }

    expect(snapshots.createLocalSnapshot).not.toHaveBeenCalled();
    expect(toasts.warn).toHaveBeenCalledTimes(1);
    expect(workbench.serializeFiles).toHaveBeenCalledTimes(CHECKPOINT_SERIALIZE_ATTEMPTS);
  });

  /* No database is not "nothing to do" — it means this import has no copy at all. */
  it('warns when the browser has no local database', async () => {
    history.db = undefined;

    await expect(checkpointImportedProject({ projectId: 'prj_1', name: 'my-game', files: FILES })).resolves.toBe(false);

    expect(toasts.warn).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalled();
  });

  /*
   * The CONTROL. A successful import says nothing — otherwise every assertion above is satisfied by a
   * module that warns on every import, which is how a real warning stops being read.
   */
  it('says nothing when the checkpoint succeeds', async () => {
    await checkpointImportedProject({ projectId: 'prj_1', name: 'my-game', serverCopy: true });

    expect(toasts.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});
