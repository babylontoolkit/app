/**
 * T5/T6 — what tops up the saved copies, and what must never be photographed (SPEC §4.5.4c, §4.12).
 *
 * T5 is the manual editor save; T6 adds the file-tree mutations (create/delete, file and folder) and the
 * other half that makes them safe — a RESTORE must schedule nothing and capture nothing, or the fix
 * becomes its own defect: a duplicate checkpoint on every mount, and after a §4.12 undo a checkpoint of
 * the state the user just undid.
 *
 * ## The defect, and why it is silent
 *
 * `FilesStore.saveFile` writes the sandbox FS and the file map and stops. `#modifiedFiles` is
 * diff-tracking for the LLM context — cleared wholesale by `resetAllFileModifications()` — not a dirty
 * flag anybody persists from. So a hand-edited file existed on the sandbox disk and in NEITHER
 * persistence store, and the next ordinary reload restored the last checkpoint with `protectNothing`,
 * which treats its map as the whole truth. The edit was therefore not merely un-backed-up: it was
 * overwritten. That is the *"edits on source files are GONE"* half of the owner's report, and nothing
 * about it throws — the save succeeds, the editor goes clean, and the loss happens on the next refresh.
 *
 * ## Why this drives the REAL `WorkbenchStore`
 *
 * `execution-queue.spec.ts` records that the store "cannot be constructed in a unit test (it boots a
 * sandbox, an editor store and a file watcher on import)". That is true of the store's COLLABORATORS,
 * not of the store — with `~/lib/sandbox` mocked to an in-memory double, `new WorkbenchStore()` and its
 * whole save path run fine here. It matters because this codebase's recorded lesson is that every
 * defect in this area lived in the wiring the unit tests drove around (`CLAUDE.md`): a spec that only
 * asserted `refreshSavedCopiesSoon` exists somewhere in `workbench.ts` would pass against a call placed
 * before the early return, inside a branch that never runs, or in `saveAllFiles` instead of `saveFile`.
 *
 * `~/lib/persistence/refresh-saved-copies` is mocked as a WRAPPER, not a stub: the spy counts the
 * scheduling calls (T5's acceptance) *and* forwards to the real module, so the real 4-second trailing
 * debounce, the real `planTopUp` and the real strict serialize all run. Only the two leaf writers
 * (`createLocalSnapshot`, `writeWorkingCopyFromStore`) and the IndexedDB reads are doubles. Counting
 * schedule calls alone would prove nothing about the thing the user cares about, which is how many
 * copies actually get WRITTEN.
 *
 * ## The CONTROLs
 *
 * Two of them, because this suite could go green in two different wrong ways. A "fix" that stopped
 * saving the file altogether would schedule exactly one top-up and pass every count — so the save
 * itself is asserted at both layers it reaches (the sandbox disk and the file map). And a collapse
 * assertion (`one write for N saves`) passes trivially for a debounce that has broken and writes once
 * ever — so a save AFTER the window closes must write again.
 *
 * ## Mutation verification (hand-discharged 2026-08-15)
 *
 * `refreshSavedCopiesSoon('editor save')` was deleted from `WorkbenchStore.saveFile`, the suite re-run,
 * and the file restored byte-for-byte (`diff` clean). **6 of the 10 tests this file held at the time**
 * fail — re-measured after T6 grew the file to 23, the same mutation now fails **10 of 23**, and the
 * six named below are among them. (Recording both numbers on purpose: a count is a fact about a suite
 * at a moment, and a stale one reads as a description of the suite you are looking at.) They are:
 * "schedules exactly
 * one top-up for one editor save", "adds no scheduling call of its own — one per file, no more",
 * "collapses a burst of editor saves into ONE write of both saved copies", "CONTROL — a save after the
 * window closes writes again", "writes the whole project, including files the save did not touch", and
 * "CONTROL — the trigger really is wired in workbench.ts". The four that survive are the two
 * save-still-happens CONTROLs, the early-return guard, and the `files.ts` source scan — all of which
 * are supposed to survive: they describe behaviour the trigger must not have changed, and the scan's
 * own scanner control is the sixth failure above, which is what proves the scan is not vacuous.
 *
 * ## T6 mutation verification (hand-discharged 2026-08-15) — twice, on purpose
 *
 * Both sides of the suppression were mutated separately, because they fail this suite at DIFFERENT
 * assertions and only the pair proves the whole rule. **1 of 23** named tests fails each time, and it is
 * the same one — "a top-up that comes due DURING a restore writes neither saved copy":
 *
 *   - `files.ts` — `restoreFiles` calling `this.#restoreFiles(...)` directly, bypassing
 *     `withRestoreInFlight`: fails at `expect(isRestoreInFlight()).toBe(true)`, i.e. the flag is never
 *     raised at all;
 *   - `top-up-plan.ts` — deleting the `restoreInFlight` skip branch: fails at
 *     `expect(createLocalSnapshot).not.toHaveBeenCalled()` with a real checkpoint of the half-restored
 *     tree, i.e. the flag is raised and nobody reads it.
 *
 * Both files were restored byte-for-byte (`diff` clean). ⚠️ Only that ONE test discriminates, and that
 * is inherent: `restoreFiles` is built from the untriggered `FilesStore` primitives, so the "a restore
 * schedules ZERO top-ups" test has nothing pending to suppress and passes either way. It is kept as the
 * literal statement of the acceptance and as the complement of the source scan at the bottom of this
 * file — but the one that would notice a regression is the one with a debounce already in flight.
 */
/*
 * The doubles' empty members are inert ON PURPOSE — the claim under test is what the STORE does, so its
 * collaborators do nothing deliberately rather than by omission (same convention as
 * `files-restore-writethrough.spec.ts`).
 */
/* eslint-disable @typescript-eslint/no-empty-function */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { protectNothing } from '~/lib/persistence/restore-plan';
import type { SerializedFileMap } from '~/lib/binary/binary-files';

const WORKDIR = '/home/project';
const HOME = `${WORKDIR}/src/pages/Home.tsx`;
const STYLES = `${WORKDIR}/src/pages/Home.css`;
const SCRIPT = `${WORKDIR}/src/scripts/KartMode.ts`;

/** The 4-second trailing debounce in `refresh-saved-copies.ts`. Duplicated deliberately: if that */
/* constant moves, the collapse tests below must be re-reasoned rather than silently re-tuned. */
const COALESCE_MS = 4_000;

/** An in-memory sandbox disk, so a save is observable at the layer it actually lands on. */
const disk = new Map<string, string>();

/**
 * Park the NEXT write, so a debounce armed before a restore can fire in the middle of one.
 *
 * That is the shape the suppression exists for and the only shape that can prove it: `restoreFiles`
 * builds on the untriggered `FilesStore` primitives, so a restore never ORIGINATES a schedule — what it
 * has to survive is a schedule that was already pending when it started (the module header says so).
 */
let writeGate: Promise<void> | undefined;

/** Project-relative paths whose write must reject — the "a restore hit a bad file" fixture. */
const rejectWrites = new Set<string>();

const writeFile = vi.fn(async (relativePath: string, content: string) => {
  if (writeGate) {
    const gate = writeGate;
    writeGate = undefined;
    await gate;
  }

  if (rejectWrites.has(relativePath)) {
    throw new Error(`EACCES: permission denied, write '${relativePath}'`);
  }

  disk.set(relativePath, content);
});

/** The persistence leaves. Everything between them and `saveFile` is the real code. */
const createLocalSnapshot = vi.fn(async (_db: unknown, _input: any) => ({ id: 'snp_1', seq: 1 }) as any);
const amendLocalSnapshot = vi.fn(async (_db: unknown, _input: any) => true);
const listLocalSnapshots = vi.fn(async () => [] as any[]);
const getCurrentLocalSnapshotId = vi.fn(async () => undefined as string | undefined);
const writeWorkingCopyFromStore = vi.fn(async (_projectId: string, _seq: number, _messageId?: string) => 'saved');

/** Counts the SCHEDULING calls; the real module still runs behind it (see the header). */
const scheduleSpy = vi.fn((_reason: string) => {});

vi.mock('~/lib/sandbox', () => ({
  sandbox: Promise.resolve({
    workdir: WORKDIR,
    fs: {
      writeFile: (relativePath: string, content: string) => writeFile(relativePath, content),
      readFile: async () => {
        throw new Error('no binaries in this fixture');
      },
      mkdir: async () => {},
      readdir: async () => [],

      /* Honest: a delete really removes the bytes, so the disk cannot flatter a checkpoint assertion. */
      rm: async (relativePath: string) => {
        disk.delete(relativePath);
      },
    },
    watchPaths: () => () => {},
    onServerReady: () => {},
    onPort: () => {},
  }),
  SANDBOX_PROVIDER: 'nodepod',
  SANDBOX_OUTLIVES_SESSION: false,
}));

vi.mock('~/lib/persistence/useChatHistory', () => ({
  projectId: { get: () => 'prj_1' },
  db: {} as IDBDatabase,
  unsavedWork: { set: () => {} },
  description: { get: () => undefined, set: () => {}, subscribe: () => () => {} },
}));

vi.mock('~/lib/persistence/local-snapshots', () => ({
  createLocalSnapshot: (...args: unknown[]) => createLocalSnapshot(...(args as [unknown, any])),
  amendLocalSnapshot: (...args: unknown[]) => amendLocalSnapshot(...(args as [unknown, any])),
  listLocalSnapshots: (...args: unknown[]) => listLocalSnapshots(...(args as [])),
  getCurrentLocalSnapshotId: (...args: unknown[]) => getCurrentLocalSnapshotId(...(args as [])),
}));

vi.mock('~/lib/persistence/working-copy-writer', () => ({
  writeWorkingCopyFromStore: (...args: unknown[]) => writeWorkingCopyFromStore(...(args as [string, number, string?])),
}));

vi.mock('~/lib/persistence/refresh-saved-copies', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/persistence/refresh-saved-copies')>();

  return {
    ...actual,
    refreshSavedCopiesSoon: (reason: string) => {
      scheduleSpy(reason);
      actual.refreshSavedCopiesSoon(reason);
    },
  };
});

/**
 * 🔴 ONE store instance for the whole file — this spec must NEVER call `vi.resetModules()`.
 *
 * It used to (with a dynamic `import('./workbench')` per test), and that quietly split the suite in two:
 * the test drove a FRESH `WorkbenchStore`, while the mocked `refresh-saved-copies` module — whose
 * `importOriginal` resolves once — kept serializing the FIRST one. So every top-up photographed a store
 * nobody had touched since the first test. It went unnoticed because the two instances happened to agree:
 * the first test in the file edits `Home.tsx` to the same string the content assertion checks for, so
 * "writes the whole project, including files the save did not touch" passed against a stale map. It only
 * became visible once a test DELETED a file — the deletion landed on one instance and the checkpoint was
 * written from the other, which is precisely the class of defect this suite exists to catch.
 *
 * The consequence is that state is per-FILE, not per-test, so `beforeEach` resets the store explicitly
 * rather than relying on a fresh module. The one thing that genuinely needs resetting between tests is
 * the restore counter, and `resetRestoreInFlight` exists for exactly that.
 *
 * The import is dynamic and lives in `beforeAll` only because the `vi.mock` factories close over the
 * constants above, and a static `import './workbench'` would run them in the temporal dead zone.
 */
type Workbench = typeof import('./workbench').workbenchStore;

let workbenchStore: Workbench;
let restoreFlag: typeof import('./restore-flag');

beforeAll(async () => {
  ({ workbenchStore } = await import('./workbench'));
  restoreFlag = await import('./restore-flag');
});

/** A tiny project: three text files, all present in the map and on the fake disk. */
function seedProject() {
  const files = {
    [HOME]: { type: 'file' as const, content: '<h1>starter</h1>', isBinary: false },
    [STYLES]: { type: 'file' as const, content: 'body{}', isBinary: false },
    [SCRIPT]: { type: 'file' as const, content: 'export class KartMode {}', isBinary: false },
  };

  for (const [filePath, dirent] of Object.entries(files)) {
    workbenchStore.files.setKey(filePath, dirent);
    disk.set(filePath.slice(WORKDIR.length + 1), dirent.content);
  }

  workbenchStore.setDocuments(files);
}

/** Type an edit into a file exactly as the editor does, leaving it unsaved. */
function edit(filePath: string, content: string) {
  workbenchStore.setSelectedFile(filePath);
  workbenchStore.setCurrentDocumentContent(content);
}

/**
 * Run the debounce out.
 *
 * `advanceTimersByTimeAsync`, NEVER `runAllTimersAsync`: `FilesStore.#init` registers a 30-second
 * `setInterval` for lock re-reads, and running all timers on a repeating interval never terminates.
 */
async function settle(ms = COALESCE_MS + 50) {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();

  createLocalSnapshot.mockResolvedValue({ id: 'snp_1', seq: 1 });
  amendLocalSnapshot.mockResolvedValue(true);
  listLocalSnapshots.mockResolvedValue([]);
  getCurrentLocalSnapshotId.mockResolvedValue(undefined);
  writeWorkingCopyFromStore.mockResolvedValue('saved');
  disk.clear();
  writeGate = undefined;
  rejectWrites.clear();

  /* The store is shared for the whole file (see above), so its state is reset here, explicitly. */
  workbenchStore.files.set({});
  workbenchStore.unsavedFiles.set(new Set());
  restoreFlag.resetRestoreInFlight();
  seedProject();
});

afterEach(() => {
  /* Discards any debounce a test armed and deliberately did not settle. */
  vi.useRealTimers();
});

describe('a manual editor save reaches the persistence layer', () => {
  /*
   * The headline. One user action — ⌘S — must schedule exactly one top-up: zero is the shipped bug
   * (the edit is deleted on the next reload), and more than one is a second "when do we save" rule for
   * one action, which is §4.5.4c invariant 4's stated failure shape.
   */
  it('schedules exactly one top-up for one editor save', async () => {
    edit(HOME, '<h1>edited by hand</h1>');
    await workbenchStore.saveFile(HOME);

    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    expect(scheduleSpy).toHaveBeenCalledWith('editor save');
  });

  /*
   * 🔴 CONTROL. A "fix" that simply stopped saving the file would schedule exactly one top-up and pass
   * the test above — so the save is asserted at both layers it reaches: the sandbox disk (what the dev
   * server serves) and the file map (what every egress path and the model read).
   */
  it('CONTROL — the file is still written to the sandbox and to the file map', async () => {
    edit(HOME, '<h1>edited by hand</h1>');
    await workbenchStore.saveFile(HOME);

    expect(disk.get('src/pages/Home.tsx')).toBe('<h1>edited by hand</h1>');

    const dirent = workbenchStore.files.get()[HOME];
    expect(dirent).toMatchObject({ type: 'file', content: '<h1>edited by hand</h1>' });
  });

  /*
   * 🔴 CONTROL. The editor's own bookkeeping must be untouched by the trigger — a save that leaves the
   * file marked unsaved makes the git chip and the save nudges lie about what is outstanding.
   */
  it('CONTROL — the file leaves the unsaved set', async () => {
    edit(HOME, '<h1>edited by hand</h1>');
    expect(workbenchStore.unsavedFiles.get().has(HOME)).toBe(true);

    await workbenchStore.saveFile(HOME);

    expect(workbenchStore.unsavedFiles.get().has(HOME)).toBe(false);
  });

  /*
   * The trigger sits AFTER the early return, not before it. `saveFile` on a path with no open editor
   * document writes nothing, so scheduling a top-up there would serialize the whole project on a no-op
   * — cheap to get wrong, invisible once wrong.
   */
  it('schedules nothing when there is no document to save', async () => {
    await workbenchStore.saveFile(`${WORKDIR}/src/pages/NotOpen.tsx`);

    expect(scheduleSpy).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe('saveAllFiles rides the same trigger', () => {
  /*
   * `saveAllFiles` loops `saveFile`, so it must add NO call of its own: the count is one per file and
   * not one more. A second call there would be the same user action asking two independent rules when
   * to save — and it would be invisible, because the debounce coalesces it away in the happy case and
   * only diverges when the timing is unlucky.
   */
  it('adds no scheduling call of its own — one per file, no more', async () => {
    edit(HOME, 'a');
    edit(STYLES, 'b');
    edit(SCRIPT, 'c');
    expect(workbenchStore.unsavedFiles.get().size).toBe(3);

    await workbenchStore.saveAllFiles();

    expect(scheduleSpy).toHaveBeenCalledTimes(3);
    expect(scheduleSpy.mock.calls.map(([reason]) => reason)).toEqual(['editor save', 'editor save', 'editor save']);
  });

  /*
   * What the count above is FOR. Three schedule calls must produce ONE write of each saved copy —
   * every top-up serializes the whole project, so a per-file write would base64 and upload the project
   * three times for one ⌘⇧S. This runs the real debounce and the real `planTopUp`, not a stub.
   */
  it('collapses a burst of editor saves into ONE write of both saved copies', async () => {
    edit(HOME, 'a');
    edit(STYLES, 'b');
    edit(SCRIPT, 'c');

    await workbenchStore.saveAllFiles();
    await settle();

    expect(createLocalSnapshot).toHaveBeenCalledTimes(1);
    expect(writeWorkingCopyFromStore).toHaveBeenCalledTimes(1);
  });

  /*
   * 🔴 CONTROL for the collapse. "One write for three saves" passes just as happily for a debounce
   * that has broken and writes once ever — which would restore the original defect for every edit
   * after the first. A save in a LATER window must write again.
   */
  it('CONTROL — a save after the window closes writes again', async () => {
    edit(HOME, 'a');
    await workbenchStore.saveFile(HOME);
    await settle();

    expect(createLocalSnapshot).toHaveBeenCalledTimes(1);

    edit(STYLES, 'b');
    await workbenchStore.saveFile(STYLES);
    await settle();

    expect(createLocalSnapshot).toHaveBeenCalledTimes(2);
    expect(writeWorkingCopyFromStore).toHaveBeenCalledTimes(2);
  });

  /*
   * The write is the WHOLE project, not the file that was saved. A top-up is restored under
   * `protectNothing`, which deletes everything the incoming map does not have — so a checkpoint
   * carrying only the edited file would delete the rest of the game on the next reload. That is the
   * defect this fix exists to close, wearing the fix's clothes.
   */
  it('writes the whole project, including files the save did not touch', async () => {
    edit(HOME, '<h1>edited by hand</h1>');
    await workbenchStore.saveFile(HOME);
    await settle();

    const written = createLocalSnapshot.mock.calls[0][1].files as Record<string, { content: string }>;

    expect(Object.keys(written).sort()).toEqual([HOME, STYLES, SCRIPT].sort());
    expect(written[HOME].content).toBe('<h1>edited by hand</h1>');
  });
});

/**
 * T6(a) — a file created or deleted from the TREE is a late write too.
 *
 * The delete is the mirror bug and the louder one: an un-checkpointed create is a file that vanishes on
 * reload, an un-checkpointed delete is a file that comes BACK, because the reload restores the last
 * checkpoint and that map still contains it. Either way the user's action silently did not happen.
 */
describe('file-tree mutations schedule a top-up', () => {
  /* A create is a late write with no other route into either saved copy — `#modifiedFiles` is */
  /* LLM-context bookkeeping, not a dirty flag anything persists from. */
  it('a file created from the tree schedules exactly one top-up', async () => {
    await workbenchStore.createFile(`${WORKDIR}/src/scripts/BoostPad.ts`, 'export class BoostPad {}');

    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    expect(scheduleSpy).toHaveBeenCalledWith('file created');
  });

  it('a folder created from the tree schedules exactly one top-up', async () => {
    await workbenchStore.createFolder(`${WORKDIR}/src/levels`);

    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    expect(scheduleSpy).toHaveBeenCalledWith('folder created');
  });

  it('a file deleted from the tree schedules exactly one top-up', async () => {
    await workbenchStore.deleteFile(STYLES);

    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    expect(scheduleSpy).toHaveBeenCalledWith('file deleted');
  });

  it('a folder deleted from the tree schedules exactly one top-up', async () => {
    await workbenchStore.deleteFolder(`${WORKDIR}/src/scripts`);

    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    expect(scheduleSpy).toHaveBeenCalledWith('folder deleted');
  });

  /*
   * 🔴 THE HEADLINE FOR THE DELETE, END TO END. Not "was a top-up scheduled" but "does the deletion
   * survive the next reload" — the checkpoint written here is the exact map an ordinary reload restores
   * under `protectNothing`, so if the deleted path is still in it the file is written straight back onto
   * disk and the user's delete is undone by the refresh. The baseline checkpoint is asserted to CONTAIN
   * it first, or "absent" would pass for a checkpoint that never had it.
   */
  it('a deleted file is absent from the checkpoint a reload would restore, and stays deleted', async () => {
    edit(HOME, '<h1>before the delete</h1>');
    await workbenchStore.saveFile(HOME);
    await settle();

    const baseline = createLocalSnapshot.mock.calls[0][1].files as SerializedFileMap;
    expect(Object.keys(baseline)).toContain(STYLES);

    await workbenchStore.deleteFile(STYLES);
    await settle();

    /* THE CHECKPOINT THAT WOULD BE RESTORED — the second call's map, written after the delete. */
    const checkpoint = createLocalSnapshot.mock.calls[1][1].files as SerializedFileMap;
    expect(Object.keys(checkpoint)).not.toContain(STYLES);
    expect(Object.keys(checkpoint)).toEqual(expect.arrayContaining([HOME, SCRIPT]));

    /* Simulate the reload: restore that checkpoint as the whole truth, exactly as a mount does. */
    await workbenchStore.restoreFiles(checkpoint, { protect: protectNothing });

    expect(workbenchStore.files.get()[STYLES]).toBeUndefined();
    expect(disk.has('src/pages/Home.css')).toBe(false);

    /* 🔴 CONTROL — the restore is a real one: the files that SHOULD come back did. */
    expect(workbenchStore.files.get()[HOME]).toMatchObject({ content: '<h1>before the delete</h1>' });
    expect(workbenchStore.files.get()[SCRIPT]).toBeDefined();
  });
});

/**
 * T6(b) — and a RESTORE is never photographed (SPEC §4.5.4c, §4.12).
 *
 * A restore writes and deletes files as its normal operation, and a top-up exists to notice files being
 * written and deleted. Without the suppression they compose into a bug that is invisible until the day it
 * matters: every mount appends a checkpoint of the mount itself (twenty slots filling with duplicates,
 * evicting the generation checkpoints undo reaches for), and a §4.12 undo is followed four seconds later
 * by a checkpoint of the state the user just undid — which quietly makes the undone state the newest one.
 *
 * The interesting case is NOT a schedule originating inside the restore (the primitives are untriggered —
 * the source scan below pins that). It is a debounce armed moments EARLIER — an editor save, a media
 * delivery, a tree delete — coming due in the middle of the restore. There is no call site to thread a
 * parameter through, which is why the flag is a flag.
 */
describe('a restore is never captured as a user checkpoint', () => {
  /** A promise the test resolves by hand, so a restore can be held open across the debounce. */
  function deferred() {
    let resolve!: () => void;

    const promise = new Promise<void>((res) => {
      resolve = res;
    });

    return { promise, resolve };
  }

  /** The map a mount restores: the project as serialized, with one file added and one removed. */
  async function incomingMap(): Promise<SerializedFileMap> {
    const current = await workbenchStore.serializeFiles({ strict: true });
    const incoming: SerializedFileMap = { ...current };

    delete incoming[STYLES];
    incoming[`${WORKDIR}/src/scripts/BoostPad.ts`] = {
      type: 'file',
      content: 'export class BoostPad {}',
      isBinary: false,
    };

    return incoming;
  }

  /*
   * The literal acceptance: a restore whose map both CREATES and DELETES schedules zero top-ups. It
   * passes because the restore is built from the untriggered `FilesStore` primitives — this is the
   * behavioural complement of the source scan below, which is what keeps it that way.
   */
  it('a restore that creates and deletes files schedules ZERO top-ups', async () => {
    const incoming = await incomingMap();

    await workbenchStore.restoreFiles(incoming, { protect: protectNothing });
    await settle();

    expect(scheduleSpy).not.toHaveBeenCalled();
    expect(createLocalSnapshot).not.toHaveBeenCalled();
    expect(writeWorkingCopyFromStore).not.toHaveBeenCalled();
  });

  /*
   * 🔴 CONTROL for the test above. "Zero schedules" passes just as happily for a restore that did
   * nothing at all — so the restore is asserted to have performed BOTH halves it is named for.
   */
  it('CONTROL — that restore really did create and delete', async () => {
    const incoming = await incomingMap();

    await workbenchStore.restoreFiles(incoming, { protect: protectNothing });

    expect(workbenchStore.files.get()[`${WORKDIR}/src/scripts/BoostPad.ts`]).toBeDefined();
    expect(workbenchStore.files.get()[STYLES]).toBeUndefined();
  });

  /*
   * 🔴 THE ONE THE SUPPRESSION EXISTS FOR, and the one the mutation breaks. A tree delete arms the
   * 4-second debounce; a restore starts before it comes due and is held open across it. The top-up fires
   * squarely inside the restore and must write NOTHING — capturing the half-written tree is how a mount
   * appends a checkpoint of itself and how an undo is silently re-undone.
   */
  it('a top-up that comes due DURING a restore writes neither saved copy', async () => {
    await workbenchStore.deleteFile(STYLES);
    expect(scheduleSpy).toHaveBeenCalledTimes(1);

    const held = deferred();
    writeGate = held.promise;

    const restoring = workbenchStore.restoreFiles(await incomingMap(), { protect: protectNothing });

    await vi.advanceTimersByTimeAsync(0);
    expect(restoreFlag.isRestoreInFlight()).toBe(true);

    // The debounce comes due while the restore is parked mid-write.
    await settle();

    expect(createLocalSnapshot).not.toHaveBeenCalled();
    expect(amendLocalSnapshot).not.toHaveBeenCalled();
    expect(writeWorkingCopyFromStore).not.toHaveBeenCalled();

    held.resolve();
    await restoring;

    expect(restoreFlag.isRestoreInFlight()).toBe(false);
  });

  /*
   * 🔴 THE CONTROL THAT MAKES THE SUPPRESSION A SUPPRESSION AND NOT AN OFF SWITCH. `planTopUp` returns
   * `skip` — terminal, not `defer` — so nothing re-arms itself after a restore; a save immediately
   * afterwards must still reach both saved copies. Without this, "writes nothing during a restore"
   * passes for a flag that is stuck on, which is the silent late-write loss this plan exists to close.
   */
  it('CONTROL — a save immediately AFTER the restore completes does write both copies', async () => {
    await workbenchStore.restoreFiles(await incomingMap(), { protect: protectNothing });
    await settle();

    expect(createLocalSnapshot).not.toHaveBeenCalled();

    edit(HOME, '<h1>edited right after the restore</h1>');
    await workbenchStore.saveFile(HOME);
    await settle();

    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    expect(createLocalSnapshot).toHaveBeenCalledTimes(1);
    expect(writeWorkingCopyFromStore).toHaveBeenCalledTimes(1);
  });

  /*
   * 🔴 THE FLAG IS CLEARED WHEN THE RESTORE FAILS. A half-written tree is the state that most needs the
   * suppression, and a flag stuck on would disable every top-up for the rest of the page's life — the
   * loud failure turning itself into the silent one.
   *
   * ⚠️ A rejecting WRITE does not make `restoreFiles` reject: `writeSerializedFileMap` is handed an
   * `onError` by `#restoreFiles`, so a failed file is reported, skipped and kept OUT of the map (that is
   * the phantom-key rule in `files.ts`). Asserted here rather than assumed, because a test written
   * expecting a throw would otherwise pass for the wrong reason. The genuinely-throwing case is below.
   */
  it('a failed write is skipped, not thrown — and the flag is still cleared', async () => {
    rejectWrites.add('src/scripts/BoostPad.ts');

    await expect(
      workbenchStore.restoreFiles(await incomingMap(), { protect: protectNothing }),
    ).resolves.toBeUndefined();

    expect(restoreFlag.isRestoreInFlight()).toBe(false);

    // The file that could not be written is not in the map either (no phantom key).
    expect(workbenchStore.files.get()[`${WORKDIR}/src/scripts/BoostPad.ts`]).toBeUndefined();

    // CONTROL: top-ups still work afterwards.
    edit(HOME, '<h1>after a failed restore</h1>');
    await workbenchStore.saveFile(HOME);
    await settle();

    expect(createLocalSnapshot).toHaveBeenCalledTimes(1);
  });

  /*
   * The throwing case, through the one un-guarded callback a restore has: `onProgress` is invoked
   * OUTSIDE `writeSerializedFileMap`'s error guard, so a progress reporter that blows up takes the whole
   * restore down with it. The rejection must propagate (a silent half-restore is worse than a loud one)
   * AND the flag must be back down.
   */
  it('a restore that throws propagates, and leaves the flag cleared', async () => {
    await expect(
      workbenchStore.restoreFiles(await incomingMap(), {
        protect: protectNothing,
        onProgress: () => {
          throw new Error('progress reporter died');
        },
      }),
    ).rejects.toThrow('progress reporter died');

    expect(restoreFlag.isRestoreInFlight()).toBe(false);

    // CONTROL: the next save is still checkpointed.
    edit(HOME, '<h1>after a thrown restore</h1>');
    await workbenchStore.saveFile(HOME);
    await settle();

    expect(createLocalSnapshot).toHaveBeenCalledTimes(1);
  });
});

/**
 * The trigger is wired at the `WorkbenchStore` level ONLY (T5's Details).
 *
 * `FilesStore.saveFile` / `createFile` / `deleteFile` are the primitives `restoreFiles` and the action
 * runner are built from, so a trigger inside them would fire on every agent write and — worse — during
 * a restore, checkpointing the restore itself: a duplicate checkpoint on every mount, and after a §4.12
 * undo, a checkpoint of the state the user just undid. The suppression flag exists for the schedules
 * that were already pending; this scan is what keeps the primitives from originating them at all.
 */
describe('the trigger is not wired into the FilesStore primitives', () => {
  const root = join(__dirname, '..', '..', '..');

  /** Comments out, so a note MENTIONING the trigger is not read as a call to it. */
  function code(relativePath: string): string {
    return readFileSync(join(root, relativePath), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  it('files.ts never references refreshSavedCopiesSoon', () => {
    expect(code('app/lib/stores/files.ts')).not.toContain('refreshSavedCopiesSoon');
  });

  /*
   * 🔴 AND THE ACTION RUNNER SAVES THROUGH THIS CLASS TOO — which is why "wire it at the WorkbenchStore
   * level" did not, on its own, achieve what T5's Details claimed it achieved.
   *
   * `_runAction`'s file branch calls back into the store to write the streamed content, so while that
   * call was `saveFile` EVERY agent write scheduled a top-up. `planTopUp` defers mid-stream, so the
   * §4.16 freeze stayed closed — but ~4s after the stream ended it fired against the generation
   * checkpoint `checkpointProject` had just written, appending a redundant top-up row: a second
   * whole-project strict serialize and upload per generation, and a 20-slot history holding ten undo
   * points instead of twenty. Finding B's eviction hazard, arriving through a door the plan did not
   * enumerate. `#writeDocument` is the same write with no trigger; only the user-facing entry points
   * schedule.
   */
  it('the action runner writes through the untriggered path, not saveFile', () => {
    const workbench = code('app/lib/stores/workbench.ts');
    const runAction = workbench.slice(workbench.indexOf('async _runAction'));
    const fileBranch = runAction.slice(0, runAction.indexOf("data.action.type === 'edit'"));

    expect(fileBranch).toContain('this.#writeDocument(fullPath)');
    expect(fileBranch).not.toContain('this.saveFile(');
  });

  /*
   * CONTROL for the slice above: an `indexOf` that missed would hand the assertions an EMPTY string,
   * which passes `not.toContain` for the worst possible reason — the scan found nothing at all.
   */
  it('CONTROL — the sliced file branch is real code, not an empty string', () => {
    const workbench = code('app/lib/stores/workbench.ts');
    const start = workbench.indexOf('async _runAction');
    const runAction = workbench.slice(start);
    const end = runAction.indexOf("data.action.type === 'edit'");

    /*
     * Both indices asserted FOUND, not just the resulting string asserted non-empty. A missing start
     * yields `slice(-1)` and a missing end yields `slice(0, -1)` — one gives a one-character string and
     * the other gives nearly the whole file, and the second one passes a naive "is it long enough?"
     * check while silently widening the window past the branch the scan is named for.
     */
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(-1);
    expect(runAction.slice(0, end)).toContain("data.action.type === 'file'");
  });

  /*
   * 🔴 CONTROL. A scanner that silently matches nothing reports a clean bill of health forever — and a
   * comment-stripper is exactly the kind of code that can start matching nothing. This proves it still
   * finds a real reference, and doubles as the source-level pin that `workbench.ts` owns the trigger.
   */
  it('CONTROL — the trigger really is wired in workbench.ts', () => {
    const workbench = code('app/lib/stores/workbench.ts');

    expect(workbench).toContain(`refreshSavedCopiesSoon('editor save')`);
    expect(workbench).toContain(`from '~/lib/persistence/refresh-saved-copies'`);
  });
});
