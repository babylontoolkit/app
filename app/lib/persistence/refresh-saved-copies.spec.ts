/**
 * The post-checkpoint top-up of BOTH saved copies (SPEC §4.5.4c, §4.12, §4.16).
 *
 * ## What changed, and why the old assertions had to be inverted
 *
 * This module shipped as `refresh-working-copy.ts` and wrote only the SERVER copy: it read the current
 * local checkpoint purely to BORROW its `seq`. That is the defect, not a simplification — the local
 * checkpoint is what an ordinary reload restores, with `protectNothing`, and a `protectNothing` restore
 * DELETES what the incoming map does not have. So a late §4.16 render was not merely un-backed-up; it
 * was actively removed on the next refresh (*"they were created and showing, but a refresh LOSES them"*).
 *
 * Two of this file's original tests therefore asserted the bug, in good faith:
 *
 *   - **"reuses the current local checkpoint seq"** — the seq MOVES now. `unsavedWork` is
 *     `localSeq > syncedSeq` (`mount-source.ts`), so folding a late file into the seq the project was
 *     already synced at reports *"everything saved"* while a genuinely unpushed file exists. The test
 *     survives inverted: the server copy must be written at the NEW checkpoint's seq.
 *   - **"does nothing before the first checkpoint — there is no seq to borrow"** — that no-op meant the
 *     very first render of a brand-new project reached NEITHER copy. A top-up allocates its own seq now,
 *     so it can simply be the first checkpoint. The test is kept **at that spot, renamed**, asserting the
 *     opposite; it is a deliberate behaviour change and deleting it would erase the record of that.
 *
 * ## Every rule below fails silently
 *
 * A lax serialize OMITS binaries it could not read, and this map is restored as the whole truth — so a
 * lax top-up arranges for `havok.wasm` to be deleted on the next reload, i.e. the defect wearing the
 * fix's clothes. A local write that takes the server write down with it removes the recovery path for
 * exactly the browser whose storage just filled up. Serializing mid-stream is what froze the tab. And a
 * top-up that writes only LOCALLY is the mirror of the original bug — hence the CONTROL.
 *
 * ## The real `runCheckpointSerialize` runs here (deliberate)
 *
 * `checkpoint-run.ts` is NOT mocked; only `workbenchStore.serializeFiles` is stubbed. A mocked outcome
 * would prove which branch the module takes on a `{kind:'failed'}` object it was handed — never that a
 * serialize which actually throws reaches that branch, and never that the strict flag is really passed.
 * The cost is that a failure case runs the real retry/backoff policy, which the fake clock absorbs.
 *
 * ## Mutation verification (hand-discharged 2026-08-15)
 *
 * The `createLocalSnapshot` call was removed from `push()` (`snapshot` left `undefined`, so the server
 * copy falls back to the previous checkpoint's seq — exactly the shipped behaviour this task replaces),
 * the suite re-run, and the file restored byte-for-byte (`diff` clean). **7 of the 16 tests this file
 * held at the time** fail — the file has since grown to 21 (the T4 amend-wiring block and the
 * post-serialize restore re-check), and both numbers are recorded on purpose: a denominator is a fact
 * about a suite at a moment, and a stale one reads as a description of the suite you are looking at.
 * A separate mutation — removing the post-serialize `isRestoreInFlight()` re-check — fails exactly 1
 * ("discards a top-up when a restore begins DURING the serialize"). The seven are:
 * "writes a local checkpoint, then the server copy AT THE NEW SEQ", "carries the previous checkpoint's
 * messageId forward", "creates the first checkpoint when there is none — REPLACES the old no-op",
 * "defers while streaming, then writes once the stream ends", "collapses a burst of deliveries into a
 * single write", "still writes again for a delivery after the window closes", and "CONTROL — the server
 * copy is still written, from the live store that holds the late file".
 *
 * Two results there are worth keeping: the inherited defer/coalescing tests only fail because they were
 * EXTENDED to count local writes as well as uploads — as originally written they passed against the
 * server-only module, which is exactly why they could not see this bug for as long as it existed. And
 * "reports unsaved work once the local checkpoint lands" SURVIVES the mutation, because `unsavedWork` is
 * set after the call rather than from its result; that is honest reporting of a weak spot, not a
 * failure of the mutation — the flag is asserted, the ordering is not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The file the report is about: it lands ~25s AFTER the generation checkpointed. */
const LATE_ASSET = '/home/project/public/assets/generated/hero.jpg';
const HOME = '/home/project/src/pages/Home.tsx';

/** What a strict serialize hands back — the code AND the late asset it references. */
function serializedProject() {
  return {
    [HOME]: { type: 'file' as const, content: `<img src="/assets/generated/hero.jpg">`, isBinary: false, size: 38 },
    [LATE_ASSET]: { type: 'file' as const, content: 'AAECAw==', isBinary: true, size: 4 },
  };
}

/** The live file map the SERVER writer reads from (it does not take the serialized map). */
function liveFiles() {
  return serializedProject();
}

/* Typed args, so the seq assertions read `calls[0][1]` rather than indexing an empty tuple. */
const writeWorkingCopyFromStore = vi.fn(
  async (_projectId: string, _seq: number, _messageId?: string) => 'saved' as string,
);
const createLocalSnapshot = vi.fn(async (_db: unknown, _input: any) => ({ id: 'snp_new', seq: 13 }) as any);
const amendLocalSnapshot = vi.fn(async (_db: unknown, _input: any) => true as boolean);
const listLocalSnapshots = vi.fn(async () => [] as any[]);
const getCurrentLocalSnapshotId = vi.fn(async () => undefined as string | undefined);
const serializeFiles = vi.fn(async (_opts?: { strict?: boolean }) => serializedProject() as any);
const filesGet = vi.fn(() => liveFiles() as any);
const unsavedWorkSet = vi.fn((_value: boolean) => undefined);
const projectIdGet = vi.fn(() => 'prj_1' as string | undefined);

let streaming = false;
let restoreInFlight = false;

/** What the live store held at the moment the SERVER writer was invoked — the CONTROL's evidence. */
let storeAtServerWrite: Record<string, unknown> | undefined;

vi.mock('~/lib/stores/streaming', () => ({ streamingState: { get: () => streaming } }));
vi.mock('~/lib/stores/restore-flag', () => ({ isRestoreInFlight: () => restoreInFlight }));
vi.mock('~/lib/stores/workbench', () => ({
  workbenchStore: {
    serializeFiles: (...args: unknown[]) => serializeFiles(...(args as [{ strict?: boolean }?])),
    files: { get: () => filesGet() },
  },
}));
vi.mock('~/lib/persistence/useChatHistory', () => ({
  projectId: { get: () => projectIdGet() },
  db: {} as IDBDatabase,
  unsavedWork: { set: (value: boolean) => unsavedWorkSet(value) },
}));
vi.mock('~/lib/persistence/local-snapshots', () => ({
  createLocalSnapshot: (...args: unknown[]) => createLocalSnapshot(...(args as [unknown, any])),
  amendLocalSnapshot: (...args: unknown[]) => amendLocalSnapshot(...(args as [unknown, any])),
  listLocalSnapshots: (...args: unknown[]) => listLocalSnapshots(...(args as [])),
  getCurrentLocalSnapshotId: (...args: unknown[]) => getCurrentLocalSnapshotId(...(args as [])),
}));
vi.mock('~/lib/persistence/working-copy-writer', () => ({
  writeWorkingCopyFromStore: (...args: unknown[]) => {
    /* Photograph the live store here: the server writer reads it, so "was it called" is not enough. */
    storeAtServerWrite = filesGet();
    return writeWorkingCopyFromStore(...(args as [string, number, string?]));
  },
}));

let refreshSavedCopiesSoon: (reason: string) => void;
const COALESCE_MS = 4_000;

/** The ordinary state: one generation checkpoint exists, and it is both the newest row and the pointer. */
function withExistingCheckpoint() {
  listLocalSnapshots.mockResolvedValue([{ id: 's1', seq: 12, messageId: 'msg_7', kind: undefined }]);
  getCurrentLocalSnapshotId.mockResolvedValue('s1');
}

/**
 * A generation checkpoint that has ALREADY been topped up once — the state a second editor save finds.
 *
 * The top-up row is newest and is the pointer, so `planTopUp` asks for an amend. This is the fixture the
 * whole 20-slot history bound rests on, and until it existed the amend branch of this module had never
 * been executed by anything.
 */
function withPreviousTopUp() {
  listLocalSnapshots.mockResolvedValue([
    { id: 's1', seq: 12, messageId: 'msg_7', kind: undefined },
    { id: 's2', seq: 13, messageId: 'msg_7', kind: 'top-up' },
  ]);
  getCurrentLocalSnapshotId.mockResolvedValue('s2');
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();

  /*
   * Implementations, not just call counts. `clearAllMocks` clears `mock.calls` and leaves
   * implementations in place, so a per-test override below otherwise leaks into every test after it.
   */
  projectIdGet.mockReturnValue('prj_1');
  createLocalSnapshot.mockResolvedValue({ id: 'snp_new', seq: 13, messageId: 'msg_7' });
  amendLocalSnapshot.mockResolvedValue(true);
  listLocalSnapshots.mockResolvedValue([]);
  getCurrentLocalSnapshotId.mockResolvedValue(undefined);
  serializeFiles.mockResolvedValue(serializedProject());
  filesGet.mockReturnValue(liveFiles());
  writeWorkingCopyFromStore.mockResolvedValue('saved');
  streaming = false;
  restoreInFlight = false;
  storeAtServerWrite = undefined;
  ({ refreshSavedCopiesSoon } = await import('./refresh-saved-copies'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

/** Run the debounce out and let the async push settle. */
async function settle() {
  await vi.runAllTimersAsync();
}

/**
 * The wiring T4 added, which nothing executed until these tests existed.
 *
 * The parts were each correct and independently tested — `planTopUp` returns `amend`, and
 * `amendLocalSnapshot` amends — while the code JOINING them had never run: every fixture here left the
 * current row as an ordinary checkpoint, so `planTopUp` returned `append` every time. Worse than
 * uncovered: `amendLocalSnapshot` was missing from the mock factory, so the first real amend would have
 * thrown a *vitest* error into this module's local-write `catch` and been logged as a quota failure — a
 * mock fault wearing a code fault's clothes. That is the wiring-between-correct-parts gap this codebase
 * has recorded repeatedly, and it is why these two cases are not optional.
 */
describe('the second top-up amends the first rather than growing the history', () => {
  /*
   * An editor save schedules a top-up every four seconds. Appending each one would push twenty
   * auto-saves through the twenty-slot history in about a minute and evict every generation checkpoint
   * §4.12's undo reaches for — so the second save must rewrite the first top-up, not add a row.
   */
  it('amends the previous top-up and writes the server copy at ITS seq', async () => {
    withPreviousTopUp();

    refreshSavedCopiesSoon('editor save');
    await settle();

    expect(amendLocalSnapshot).toHaveBeenCalledTimes(1);
    expect(amendLocalSnapshot.mock.calls[0][1]).toMatchObject({ snapshotId: 's2', files: serializedProject() });

    // No new row, and the server copy stays on the amended row's seq rather than inventing a newer one.
    expect(createLocalSnapshot).not.toHaveBeenCalled();
    expect(writeWorkingCopyFromStore).toHaveBeenCalledTimes(1);
    expect(writeWorkingCopyFromStore.mock.calls[0][1]).toBe(13);
    expect(writeWorkingCopyFromStore.mock.calls[0][2]).toBe('msg_7');
  });

  /*
   * A refusal is not a failure. Between the read that chose `amend` and the write, a generation can land
   * or the user can hit undo — so the row stops being amendable and the store says so. Appending is
   * always safe, and falling back to it is what stops a lost race from silently dropping the save.
   */
  it('falls back to appending when the store refuses the amend', async () => {
    withPreviousTopUp();
    amendLocalSnapshot.mockResolvedValue(false);
    createLocalSnapshot.mockResolvedValue({ id: 'snp_new', seq: 14, messageId: 'msg_7' });

    refreshSavedCopiesSoon('editor save');
    await settle();

    expect(amendLocalSnapshot).toHaveBeenCalledTimes(1);
    expect(createLocalSnapshot).toHaveBeenCalledTimes(1);
    expect(createLocalSnapshot.mock.calls[0][1]).toMatchObject({ kind: 'top-up', messageId: 'msg_7' });
    expect(writeWorkingCopyFromStore.mock.calls[0][1]).toBe(14);
  });

  /*
   * CONTROL. Amending must be a property of the ROW, not of this module — an implementation that
   * amended unconditionally would pass both tests above while quietly rewriting generation checkpoints,
   * which is the append-only rule broken in the one direction that destroys history.
   */
  it('CONTROL — appends, and never amends, when the current row is a generation checkpoint', async () => {
    withExistingCheckpoint();

    refreshSavedCopiesSoon('editor save');
    await settle();

    expect(amendLocalSnapshot).not.toHaveBeenCalled();
    expect(createLocalSnapshot).toHaveBeenCalledTimes(1);
  });
});

describe('it tops up BOTH copies — the local checkpoint is the one a reload reads', () => {
  /*
   * 🔴 The whole defect. The old module borrowed the checkpoint's seq and wrote the server copy alone,
   * so the local checkpoint — the copy `selectMountSource` prefers, and the copy a `protectNothing`
   * restore treats as the whole truth — never learned the file existed and deleted it on next mount.
   *
   * The seq MOVES, and that inverts the original assertion: a late file is genuinely unpushed, so
   * folding it into the already-synced seq would report "everything saved" over unsaved work.
   */
  it('writes a local checkpoint, then the server copy AT THE NEW SEQ', async () => {
    withExistingCheckpoint();
    createLocalSnapshot.mockResolvedValue({ id: 'snp_new', seq: 13, messageId: 'msg_7' });

    refreshSavedCopiesSoon('media 1');
    await settle();

    expect(createLocalSnapshot).toHaveBeenCalledTimes(1);
    expect(writeWorkingCopyFromStore).toHaveBeenCalledTimes(1);
    expect(writeWorkingCopyFromStore.mock.calls[0][1]).toBe(13);
    expect(writeWorkingCopyFromStore.mock.calls[0][1]).not.toBe(12);
  });

  /*
   * A checkpoint that cannot name the turn it contains makes `checkUnappliedTurn` re-offer the §4.5.4c
   * apply dialog on every mount, forever. The top-up completes the previous turn — it carries its id.
   */
  it("carries the previous checkpoint's messageId forward", async () => {
    withExistingCheckpoint();

    refreshSavedCopiesSoon('media 1');
    await settle();

    expect(createLocalSnapshot.mock.calls[0][1]).toMatchObject({
      projectId: 'prj_1',
      messageId: 'msg_7',
      kind: 'top-up',
    });

    /* The §4.12 version list is user-facing copy, never the caller's log string ("media med_abc123"). */
    expect(createLocalSnapshot.mock.calls[0][1].label).toBe('Unsaved changes');
    expect(createLocalSnapshot.mock.calls[0][1].label).not.toContain('media');
  });

  /*
   * 🔴 STRICT. A lax `serializeFiles` omits binaries it could not read, and this map is restored under
   * `protectNothing` as the whole truth — so a lax top-up arranges for `havok.wasm` to be DELETED on the
   * next reload. That is the defect this module exists to fix, wearing the fix's clothes.
   */
  it('serializes strictly', async () => {
    withExistingCheckpoint();

    refreshSavedCopiesSoon('media 1');
    await settle();

    expect(serializeFiles).toHaveBeenCalledWith({ strict: true });
  });

  /*
   * REPLACES the original "does nothing before the first checkpoint — there is no seq to borrow".
   * That no-op was a real hole: the first render of a brand-new project reached NEITHER saved copy. A
   * top-up allocates its own seq now, so it can simply BE the first checkpoint. Kept here, inverted,
   * rather than deleted — the behaviour change is the point of the task and deserves a record.
   */
  it('creates the first checkpoint when there is none — REPLACES the old no-op', async () => {
    listLocalSnapshots.mockResolvedValue([]);
    getCurrentLocalSnapshotId.mockResolvedValue(undefined);
    createLocalSnapshot.mockResolvedValue({ id: 'snp_first', seq: 0, messageId: undefined });

    refreshSavedCopiesSoon('media 1');
    await settle();

    expect(createLocalSnapshot).toHaveBeenCalledTimes(1);
    expect(createLocalSnapshot.mock.calls[0][1].messageId).toBeUndefined();
    expect(writeWorkingCopyFromStore).toHaveBeenCalledTimes(1);
    expect(writeWorkingCopyFromStore.mock.calls[0][1]).toBe(0);
  });

  /* The seq moved past `syncedSeq`, so the chip must say so in THIS session too, not only after a reload. */
  it('reports unsaved work once the local checkpoint lands', async () => {
    withExistingCheckpoint();

    refreshSavedCopiesSoon('media 1');
    await settle();

    expect(unsavedWorkSet).toHaveBeenCalledWith(true);
  });

  it('does nothing without a project', async () => {
    projectIdGet.mockReturnValue(undefined);

    refreshSavedCopiesSoon('media 1');
    await settle();

    expect(createLocalSnapshot).not.toHaveBeenCalled();
    expect(writeWorkingCopyFromStore).not.toHaveBeenCalled();
  });

  /*
   * A restore's whole job is to write and delete files; a top-up's whole job is to notice files being
   * written and deleted. Composed, they photograph the restore as the user's own work — so a §4.12 undo
   * is immediately followed by a checkpoint of the state it undid. Terminal, not deferred.
   */
  it('skips entirely while a restore is writing over the project', async () => {
    withExistingCheckpoint();
    restoreInFlight = true;

    refreshSavedCopiesSoon('media 1');
    await settle();

    expect(serializeFiles).not.toHaveBeenCalled();
    expect(createLocalSnapshot).not.toHaveBeenCalled();
    expect(writeWorkingCopyFromStore).not.toHaveBeenCalled();
  });

  /*
   * 🔴 AND THE SERIALIZE IS THE LONG PART, so checking only before it is checking at the wrong end.
   *
   * A strict serialize reads the whole project — seconds on a real one, with retries — and a restore
   * that STARTS inside that window hands back a photograph of a tree mid-rewrite: half the old project,
   * half the new. Written as a checkpoint, that torn map is what a later `protectNothing` restore adopts
   * as the whole truth, which is the defect this module exists to fix arriving through its own front
   * door. Discarding costs one debounce; writing it costs the project.
   */
  it('discards a top-up when a restore begins DURING the serialize', async () => {
    withExistingCheckpoint();
    serializeFiles.mockImplementation(async () => {
      restoreInFlight = true;
      return serializedProject();
    });

    refreshSavedCopiesSoon('editor save');
    await settle();

    // It got as far as serializing — this is the post-serialize gate, not the pre-serialize one.
    expect(serializeFiles).toHaveBeenCalled();
    expect(createLocalSnapshot).not.toHaveBeenCalled();
    expect(writeWorkingCopyFromStore).not.toHaveBeenCalled();
  });

  /*
   * CONTROL for the case above: with the restore never starting, the identical fixture writes both
   * copies. Without it, an implementation that had simply stopped writing after a serialize would pass.
   */
  it('CONTROL — the same fixture writes both copies when no restore intervenes', async () => {
    withExistingCheckpoint();

    refreshSavedCopiesSoon('editor save');
    await settle();

    expect(createLocalSnapshot).toHaveBeenCalledTimes(1);
    expect(writeWorkingCopyFromStore).toHaveBeenCalledTimes(1);
  });
});

describe('a failed serialize leaves the existing checkpoint exactly as it was', () => {
  /*
   * 🔴 Writing a lax map instead is the deletion described in the header. Writing NOTHING costs one
   * debounce — the next delivery or edit schedules another attempt, and the next generation's checkpoint
   * writes the whole project anyway. There is no delete-one API, so "untouched" IS "not written".
   */
  it('writes no local snapshot when the strict serialize never succeeds', async () => {
    withExistingCheckpoint();
    serializeFiles.mockRejectedValue(new Error('Failed to read 22 binary file(s)'));

    refreshSavedCopiesSoon('media 1');
    await settle();

    expect(createLocalSnapshot).not.toHaveBeenCalled();
    expect(unsavedWorkSet).not.toHaveBeenCalled();
  });

  /*
   * …and the server copy still goes out under the PREVIOUS checkpoint's seq — i.e. a failed local write
   * degrades to exactly what this module did before it wrote local checkpoints at all, rather than to
   * nothing. `selectMountSource` consults the working copy as a BOOLEAN, so the two copies carrying
   * different seqs cannot mislead a mount.
   */
  it('still writes the server copy, at the previous seq', async () => {
    withExistingCheckpoint();
    serializeFiles.mockRejectedValue(new Error('Failed to read 22 binary file(s)'));

    refreshSavedCopiesSoon('media 1');
    await settle();

    expect(writeWorkingCopyFromStore).toHaveBeenCalledTimes(1);
    expect(writeWorkingCopyFromStore.mock.calls[0][1]).toBe(12);
    expect(writeWorkingCopyFromStore.mock.calls[0][2]).toBe('msg_7');
  });

  /*
   * `QuotaExceededError` is a NORMAL outcome on a 5–10MB map, not an exceptional one. It must not take
   * the server copy down with it: that copy is the recovery path for precisely the browser whose storage
   * is full.
   */
  it('lets the server write proceed when the local write throws', async () => {
    withExistingCheckpoint();
    createLocalSnapshot.mockRejectedValue(new DOMException('quota', 'QuotaExceededError'));

    refreshSavedCopiesSoon('media 1');
    await expect(settle()).resolves.not.toThrow();

    expect(writeWorkingCopyFromStore).toHaveBeenCalledTimes(1);
    expect(writeWorkingCopyFromStore.mock.calls[0][1]).toBe(12);
  });
});

describe('it never serializes mid-generation (§4.16 — the freeze)', () => {
  /*
   * 🔴 The refresh fired 4s after the first media render landed — squarely mid-stream, while more
   * renders were still arriving — and serializing the project there is what pinned the main thread.
   * While the stream is live it must reschedule, never serialize. Now that a top-up also writes an
   * IndexedDB row, the cost of getting this wrong went up rather than down.
   */
  it('defers while streaming, then writes once the stream ends', async () => {
    withExistingCheckpoint();
    streaming = true;
    refreshSavedCopiesSoon('media 1');

    // The window elapses; push runs, sees the live stream, and reschedules WITHOUT serializing.
    await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
    expect(serializeFiles).not.toHaveBeenCalled();
    expect(createLocalSnapshot).not.toHaveBeenCalled();
    expect(writeWorkingCopyFromStore).not.toHaveBeenCalled();

    // Stream ends; the rescheduled window fires and both copies are finally written — exactly once.
    streaming = false;
    await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
    expect(createLocalSnapshot).toHaveBeenCalledTimes(1);
    expect(writeWorkingCopyFromStore).toHaveBeenCalledTimes(1);
  });
});

describe('coalescing', () => {
  /*
   * A creation commissions up to four images that land seconds apart, and every write is the WHOLE
   * project — now twice over (an IndexedDB row AND an upload). One per image is four of each for one
   * logical change, and four rows out of a 20-slot history that §4.12 undo depends on.
   */
  it('collapses a burst of deliveries into a single write', async () => {
    withExistingCheckpoint();

    refreshSavedCopiesSoon('media 1');
    refreshSavedCopiesSoon('media 2');
    refreshSavedCopiesSoon('media 3');
    refreshSavedCopiesSoon('media 4');
    await settle();

    expect(createLocalSnapshot).toHaveBeenCalledTimes(1);
    expect(writeWorkingCopyFromStore).toHaveBeenCalledTimes(1);
  });

  /* Control: the coalescing must not be swallowing writes that are genuinely separate. */
  it('still writes again for a delivery after the window closes', async () => {
    withExistingCheckpoint();

    refreshSavedCopiesSoon('media 1');
    await settle();

    refreshSavedCopiesSoon('media 2');
    await settle();

    expect(createLocalSnapshot).toHaveBeenCalledTimes(2);
    expect(writeWorkingCopyFromStore).toHaveBeenCalledTimes(2);
  });
});

describe('it is best-effort', () => {
  /* The local checkpoint is the copy that makes the data safe — a failed upload must stay quiet. */
  it('swallows an upload failure rather than surfacing it', async () => {
    withExistingCheckpoint();
    writeWorkingCopyFromStore.mockRejectedValueOnce(new Error('offline'));

    refreshSavedCopiesSoon('media 1');
    await expect(settle()).resolves.not.toThrow();
  });

  /* A 'skipped-too-large' result is a normal degradation, not an error — it must not throw either. */
  it('handles a size-gated skip without surfacing it', async () => {
    withExistingCheckpoint();
    writeWorkingCopyFromStore.mockResolvedValueOnce('skipped-too-large');

    refreshSavedCopiesSoon('media 1');
    await expect(settle()).resolves.not.toThrow();
  });
});

describe('CONTROL', () => {
  /*
   * 🔴 Every assertion above is satisfied by a module that writes the local checkpoint and then stops —
   * which is the ORIGINAL bug pointing the other way. The server working copy is §4.5.4c crash
   * recovery: it is the only copy that survives this browser, and dropping it would leave a user whose
   * tab died with nothing at all.
   *
   * "Was it called" is too weak: the server writer does not take the serialized map, it re-reads the
   * LIVE store. So this asserts the call happened at a point where the live store still holds the late
   * asset — the same file the local checkpoint just captured — and that both copies therefore describe
   * the same project rather than two different ones.
   */
  it('CONTROL — the server copy is still written, from the live store that holds the late file', async () => {
    withExistingCheckpoint();

    refreshSavedCopiesSoon('media 1');
    await settle();

    expect(writeWorkingCopyFromStore).toHaveBeenCalledTimes(1);
    expect(writeWorkingCopyFromStore.mock.calls[0][0]).toBe('prj_1');

    /* The local checkpoint got the real bytes… */
    expect(Object.keys(createLocalSnapshot.mock.calls[0][1].files).sort()).toEqual([HOME, LATE_ASSET].sort());

    /* …and the server write was made against a store that still holds them. */
    expect(storeAtServerWrite).toBeDefined();
    expect(Object.keys(storeAtServerWrite!)).toContain(LATE_ASSET);
  });
});
