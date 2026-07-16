/**
 * The checkpoint history, in the browser (SPEC §4.5.4b, §4.12).
 *
 * ## Why this exists
 *
 * Until now the platform held every project's files: `checkpointProject` uploaded the whole
 * `SerializedFileMap` to `/api/projects/:id/snapshots` after every generation, and the version history
 * (§4.12) was a list of those server rows. Repo-primary persistence removes the premise. The user's
 * game lives in THEIR repo and nowhere else; before they save, it lives only in this browser. A server
 * that keeps a copy of every unlinked project is not a backup, it is the old model wearing a new name
 * — and it is the specific thing §4.5.4b says we do not do.
 *
 * So the history moves here. Same shape as the server store it replaces (`create` / `list` / `read` /
 * `setCurrent`), so `restore-target.ts` and the §4.12 UI keep working against the same contract.
 *
 * ## What is NOT negotiable here
 *
 * **Byte identity.** `SerializedFileMap` is the codec the WebContainer serializes to — text inline,
 * binaries base64 (spec/binary-files.md). IndexedDB will happily store the object as-is via structured
 * clone, so a checkpoint→restore round trip is byte-exact for a PNG or a GLB. Do not "optimise" this
 * into a string, a Blob, or anything that re-encodes: base64 is a WIRE format, and the only reason it
 * survives is that nothing along this path reinterprets it.
 *
 * **The history is append-only.** A restore adds a checkpoint rather than deleting the ones after it,
 * exactly as §4.12 requires on the server. There is no delete-one API, deliberately.
 *
 * ## The bound, and why there is one
 *
 * A server store had a quota we controlled. IndexedDB has one the BROWSER controls, and when it runs
 * out it throws `QuotaExceededError` — on the write, mid-generation, for a project whose only other
 * copy may not exist yet. A Babylon project with a few GLBs is comfortably 5–10MB per checkpoint, so
 * an unbounded history is a wall the user hits without warning. `MAX_CHECKPOINTS_PER_PROJECT` trims
 * the OLDEST first: recent history is what "undo that last change" needs, and the deep past is what
 * the linked repo is for.
 */
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('LocalSnapshots');

const SNAPSHOTS = 'projectSnapshots';
const STATE = 'projectState';

/**
 * How many checkpoints a project keeps locally.
 *
 * Not a storage-efficiency number — a "do not hit the browser's quota wall silently" number. Twenty
 * covers a long working session; anything older is history the repo holds properly.
 */
export const MAX_CHECKPOINTS_PER_PROJECT = 20;

export interface LocalSnapshot {
  id: string;
  projectId: string;
  files: SerializedFileMap;

  /**
   * Order within this project's history. Monotonic, allocated under the write transaction.
   *
   * **Not `createdAt`, and this is the same lesson the ledger already paid for** (migration 0003):
   * two checkpoints in the same millisecond TIE on a timestamp, and a tie falls through to whatever
   * arbitrary tiebreak the sort happens to have. There it made a balance read pick a random row; here
   * it makes "restore to before this change" pick a random checkpoint, and it decides which one the
   * trim throws away. Both are silent. Clocks tie and clocks go backwards — never order by one.
   */
  seq: number;

  /** The assistant message this was taken after — what anchors "restore to before this change". */
  messageId?: string;
  label?: string;
  createdAt: string;
}

interface ProjectStateRow {
  projectId: string;
  currentSnapshotId?: string;

  /** The next `seq` to hand out. Lives beside the pointer so both move in one transaction. */
  nextSeq?: number;

  /**
   * The seq of the checkpoint that was current the last time this browser pushed to the repo.
   *
   * This is what makes "you have unsaved work" answerable (§4.5.4b, `mount-source.ts`). A checkpoint
   * newer than this exists in this browser and nowhere else — which is the whole reason the LINKED
   * indicator, the nudges, and the beforeunload warning can tell the truth rather than guess.
   */
  syncedSeq?: number;
}

/** What `selectMountSource` needs to know about this browser's copy. */
export interface LocalSyncState {
  localSeq?: number;
  syncedSeq?: number;
}

/** The list view: metadata only. Reading twenty checkpoints' worth of bytes to draw a list is absurd. */
export type LocalSnapshotSummary = Omit<LocalSnapshot, 'files'> & { fileCount: number; totalBytes: number };

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Wait for the TRANSACTION, not just the request — a write is not durable until the tx commits. */
function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

function newSnapshotId(): string {
  return `snp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function summarize(snapshot: LocalSnapshot): LocalSnapshotSummary {
  const files = Object.values(snapshot.files).filter((d) => d?.type === 'file');

  return {
    id: snapshot.id,
    projectId: snapshot.projectId,
    seq: snapshot.seq,
    messageId: snapshot.messageId,
    label: snapshot.label,
    createdAt: snapshot.createdAt,
    fileCount: files.length,

    /*
     * `size` is the true byte count; `content.length` for a binary is base64 (~4/3 of the bytes). Using
     * the string length would make every number the user sees disagree with the file on disk.
     */
    totalBytes: files.reduce((sum, d) => sum + (d!.size ?? d!.content.length), 0),
  };
}

/**
 * Write a checkpoint and make it current.
 *
 * Both stores are written in ONE transaction. Separately, a crash between them leaves a project
 * pointing at a checkpoint that does not exist — which on the next reload is an empty project.
 */
export async function createLocalSnapshot(
  db: IDBDatabase,
  input: { projectId: string; files: SerializedFileMap; messageId?: string; label?: string },
): Promise<LocalSnapshot> {
  const tx = db.transaction([SNAPSHOTS, STATE], 'readwrite');
  const store = tx.objectStore(SNAPSHOTS);
  const stateStore = tx.objectStore(STATE);

  /*
   * Allocate `seq` inside the SAME transaction that writes the snapshot. IndexedDB gives us a
   * serialized readwrite transaction over these stores, so read-then-write here cannot interleave
   * with another checkpoint — which is what makes the counter safe without a lock. (The server's
   * equivalent needs a Postgres advisory lock for exactly this reason; see `append_ledger_entry`.)
   */
  const state = ((await promisify(stateStore.get(input.projectId))) as ProjectStateRow | undefined) ?? {
    projectId: input.projectId,
  };

  const snapshot: LocalSnapshot = {
    id: newSnapshotId(),
    projectId: input.projectId,
    files: input.files,
    seq: state.nextSeq ?? 0,
    messageId: input.messageId,
    label: input.label,
    createdAt: new Date().toISOString(),
  };

  store.put(snapshot);

  // Spread `state` — `syncedSeq` lives in this row too, and a bare put would erase it (see below).
  stateStore.put({ ...state, projectId: input.projectId, currentSnapshotId: snapshot.id, nextSeq: snapshot.seq + 1 });

  // Trim inside the same transaction, so the history can never briefly exceed the bound on disk.
  const existing = (await promisify(
    store.index('projectId').getAll(IDBKeyRange.only(input.projectId)),
  )) as LocalSnapshot[];
  const ordered = existing.sort(bySeq);

  for (const old of ordered.slice(0, Math.max(0, ordered.length - MAX_CHECKPOINTS_PER_PROJECT))) {
    store.delete(old.id);
  }

  await transactionDone(tx);

  return snapshot;
}

/** Oldest first. `seq` only — see the field's doc comment for why a timestamp is not an ordering. */
const bySeq = (a: LocalSnapshot, b: LocalSnapshot) => a.seq - b.seq;

/** Every checkpoint for a project, OLDEST FIRST — the order `selectRestoreTarget` requires. */
export async function listLocalSnapshots(db: IDBDatabase, projectId: string): Promise<LocalSnapshotSummary[]> {
  const tx = db.transaction(SNAPSHOTS, 'readonly');
  const rows = (await promisify(
    tx.objectStore(SNAPSHOTS).index('projectId').getAll(IDBKeyRange.only(projectId)),
  )) as LocalSnapshot[];

  return rows.sort(bySeq).map(summarize);
}

export async function readLocalSnapshot(db: IDBDatabase, snapshotId: string): Promise<LocalSnapshot | undefined> {
  const tx = db.transaction(SNAPSHOTS, 'readonly');

  return (await promisify(tx.objectStore(SNAPSHOTS).get(snapshotId))) as LocalSnapshot | undefined;
}

export async function getCurrentLocalSnapshotId(db: IDBDatabase, projectId: string): Promise<string | undefined> {
  const tx = db.transaction(STATE, 'readonly');
  const row = (await promisify(tx.objectStore(STATE).get(projectId))) as
    | { projectId: string; currentSnapshotId?: string }
    | undefined;

  return row?.currentSnapshotId;
}

/** The files the builder remounts on resume — the local equivalent of `restoreLatestServerCheckpoint`. */
export async function readCurrentLocalSnapshot(db: IDBDatabase, projectId: string): Promise<LocalSnapshot | undefined> {
  const currentId = await getCurrentLocalSnapshotId(db, projectId);

  return currentId ? readLocalSnapshot(db, currentId) : undefined;
}

export async function setCurrentLocalSnapshot(db: IDBDatabase, projectId: string, snapshotId: string): Promise<void> {
  const tx = db.transaction(STATE, 'readwrite');
  const store = tx.objectStore(STATE);

  /*
   * Read-modify-write, NOT a bare `put`. The row carries `nextSeq` as well as the pointer, and a `put`
   * of `{projectId, currentSnapshotId}` replaces the whole record — resetting the counter to 0, so the
   * next checkpoints would re-use seq numbers already in the history and the ordering would silently
   * fold back on itself. A partial write of a whole-record store is not an update, it is a delete plus
   * an insert.
   */
  const existing = ((await promisify(store.get(projectId))) as ProjectStateRow | undefined) ?? { projectId };

  store.put({ ...existing, projectId, currentSnapshotId: snapshotId });

  await transactionDone(tx);
}

/**
 * How far this browser has moved, and how far it has been saved (§4.5.4b).
 *
 * `localSeq` is the CURRENT checkpoint's seq, not the highest — after a restore the pointer sits on an
 * older one, and the project on screen is that older state. Reading the highest would report unsaved
 * work that is not on screen.
 */
export async function getLocalSyncState(db: IDBDatabase, projectId: string): Promise<LocalSyncState> {
  const tx = db.transaction([SNAPSHOTS, STATE], 'readonly');
  const state = (await promisify(tx.objectStore(STATE).get(projectId))) as ProjectStateRow | undefined;

  if (!state?.currentSnapshotId) {
    return { localSeq: undefined, syncedSeq: state?.syncedSeq };
  }

  const current = (await promisify(tx.objectStore(SNAPSHOTS).get(state.currentSnapshotId))) as
    | LocalSnapshot
    | undefined;

  return { localSeq: current?.seq, syncedSeq: state.syncedSeq };
}

/**
 * Record that the current checkpoint is now in the repo.
 *
 * Called ONLY after a push actually lands. Calling it optimistically — before the response, or on a
 * failure path — is how a user is told their work is saved when it is not, which is the one thing
 * §4.5.4b insists must never happen quietly.
 */
export async function markSynced(db: IDBDatabase, projectId: string): Promise<void> {
  const { localSeq } = await getLocalSyncState(db, projectId);

  if (localSeq === undefined) {
    return;
  }

  const tx = db.transaction(STATE, 'readwrite');
  const store = tx.objectStore(STATE);
  const existing = ((await promisify(store.get(projectId))) as ProjectStateRow | undefined) ?? { projectId };

  store.put({ ...existing, projectId, syncedSeq: localSeq });

  await transactionDone(tx);
}

/** Used when a project is deleted. Removes the history AND the pointer — no orphaned bytes. */
export async function deleteLocalProject(db: IDBDatabase, projectId: string): Promise<void> {
  const tx = db.transaction([SNAPSHOTS, STATE], 'readwrite');
  const store = tx.objectStore(SNAPSHOTS);
  const rows = (await promisify(store.index('projectId').getAll(IDBKeyRange.only(projectId)))) as LocalSnapshot[];

  for (const row of rows) {
    store.delete(row.id);
  }

  tx.objectStore(STATE).delete(projectId);

  await transactionDone(tx);

  logger.info(`Cleared ${rows.length} local checkpoints for project ${projectId}`);
}
