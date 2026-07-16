/**
 * The browser-side checkpoint history (SPEC §4.5.4b, §4.12, spec/binary-files.md).
 *
 * This store took over a job the server used to do, which means it inherited the server store's whole
 * test burden — and one the server never had. Until the user saves, **this is the only copy of their
 * game that exists anywhere**. There is no bucket to fall back to and no row to re-read. Every failure
 * here is data loss, and every one of them is silent:
 *
 *   - a base64 round-trip that re-encodes → their textures and models come back corrupt, and nothing
 *     throws (the same class of defect `spec/binary-files.md` exists to prevent);
 *   - a history that trims the wrong end → "undo my last change" restores last Tuesday;
 *   - an unbounded history → `QuotaExceededError` on a write, mid-generation, with nowhere else to go;
 *   - a pointer written outside the snapshot's transaction → a project that reloads empty.
 *
 * Run against `fake-indexeddb`, which is the real IndexedDB semantics (structured clone, transaction
 * lifetimes, index ranges) rather than a Map pretending to be a database — a Map would pass the binary
 * test for the wrong reason, since it never serializes anything at all.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bytesToBase64 } from '~/lib/binary/binary-files';
import { openDatabase } from './db';
import {
  MAX_CHECKPOINTS_PER_PROJECT,
  createLocalSnapshot,
  deleteLocalProject,
  getCurrentLocalSnapshotId,
  getLocalSyncState,
  listLocalSnapshots,
  markSynced,
  readCurrentLocalSnapshot,
  readLocalSnapshot,
  setCurrentLocalSnapshot,
} from './local-snapshots';
import type { SerializedFileMap } from '~/lib/binary/binary-files';

let db: IDBDatabase;

/** Real PNG header bytes — the exact thing that used to arrive as an empty file or literal base64. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0xfe, 0xff]);

/** A GLB: magic + version + length, i.e. bytes that are meaningless if a single one shifts. */
const GLB_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00]);

/** Narrow a dirent to a file. `SerializedDirent` is a union, and a folder has no bytes to assert on. */
function fileAt(map: SerializedFileMap, path: string) {
  const dirent = map[path];

  if (dirent?.type !== 'file') {
    throw new Error(`Expected a file at ${path}, found ${dirent?.type ?? 'nothing'}`);
  }

  return dirent;
}

const files = (): SerializedFileMap => ({
  'src/game.ts': { type: 'file', content: 'export const speed = 10;\n', isBinary: false },
  'public/logo.png': {
    type: 'file',
    content: bytesToBase64(PNG_BYTES),
    isBinary: true,
    size: PNG_BYTES.byteLength,
  },
  'public/car.glb': {
    type: 'file',
    content: bytesToBase64(GLB_BYTES),
    isBinary: true,
    size: GLB_BYTES.byteLength,
  },
  'src/components': { type: 'folder' },
});

beforeEach(async () => {
  db = (await openDatabase())!;
});

afterEach(() => {
  db?.close();

  // A fresh database per test — IndexedDB is process-global under fake-indexeddb.
  indexedDB.deleteDatabase('boltHistory');
});

describe('the database', () => {
  it('creates the v3 stores without destroying upstream’s', () => {
    expect([...db.objectStoreNames]).toEqual(
      expect.arrayContaining(['chats', 'snapshots', 'projectSnapshots', 'projectState']),
    );
  });
});

describe('byte identity — the only copy of the user’s game', () => {
  it('round-trips a PNG and a GLB byte-for-byte', async () => {
    const created = await createLocalSnapshot(db, { projectId: 'p1', files: files() });
    const read = await readLocalSnapshot(db, created.id);

    expect(fileAt(read!.files, 'public/logo.png')).toEqual({
      type: 'file',
      content: bytesToBase64(PNG_BYTES),
      isBinary: true,
      size: PNG_BYTES.byteLength,
    });
    expect(fileAt(read!.files, 'public/car.glb')).toMatchObject({ content: bytesToBase64(GLB_BYTES), isBinary: true });
  });

  it('keeps the true byte size, not the base64 length', async () => {
    const created = await createLocalSnapshot(db, { projectId: 'p1', files: files() });
    const read = await readLocalSnapshot(db, created.id);

    // 12 raw bytes → 16 base64 chars. Storing 16 would make every size the user sees a lie.
    expect(fileAt(read!.files, 'public/logo.png').size).toBe(12);
    expect(fileAt(read!.files, 'public/logo.png').content.length).toBe(16);
  });

  it('preserves text exactly, and folders as folders', async () => {
    const created = await createLocalSnapshot(db, { projectId: 'p1', files: files() });
    const read = await readLocalSnapshot(db, created.id);

    expect(fileAt(read!.files, 'src/game.ts').content).toBe('export const speed = 10;\n');
    expect(read!.files['src/components']).toEqual({ type: 'folder' });
  });
});

/**
 * The ledger already paid for this lesson once (migration 0003): `now()` ties, so back-to-back rows
 * ordered by a clock fall through to an arbitrary tiebreak. There it made a balance read pick a random
 * row from that millisecond. Here it would make an undo restore a random checkpoint, and the trim
 * discard a random one — both silent, and both on the only copy of the user's game.
 */
describe('ordering is by seq, never a clock', () => {
  it('allocates a monotonic seq per project', async () => {
    const a = await createLocalSnapshot(db, { projectId: 'p1', files: files() });
    const b = await createLocalSnapshot(db, { projectId: 'p1', files: files() });
    const c = await createLocalSnapshot(db, { projectId: 'p1', files: files() });

    expect([a.seq, b.seq, c.seq]).toEqual([0, 1, 2]);
  });

  it('counts each project independently', async () => {
    await createLocalSnapshot(db, { projectId: 'p1', files: files() });

    const other = await createLocalSnapshot(db, { projectId: 'p2', files: files() });

    expect(other.seq).toBe(0);
  });

  /** Checkpoints taken inside one millisecond must still have a total order. */
  it('orders correctly when every checkpoint shares a timestamp', async () => {
    const made = await Promise.all(
      ['a', 'b', 'c', 'd'].map((label) => createLocalSnapshot(db, { projectId: 'p1', files: files(), label })),
    );

    const listed = await listLocalSnapshots(db, 'p1');

    // Whatever order the writes serialized in, the read order must match the write order exactly.
    expect(listed.map((s) => s.id)).toEqual([...made].sort((x, y) => x.seq - y.seq).map((s) => s.id));
    expect(listed.map((s) => s.seq)).toEqual([0, 1, 2, 3]);
  });

  /**
   * `setCurrentLocalSnapshot` shares a row with the seq counter. A bare `put` of the pointer replaces
   * the whole record and resets the counter — after which new checkpoints re-use seq numbers already
   * in the history, and the ordering folds back on itself.
   */
  it('does not reset the counter when the pointer moves', async () => {
    const first = await createLocalSnapshot(db, { projectId: 'p1', files: files() });
    await createLocalSnapshot(db, { projectId: 'p1', files: files() });

    await setCurrentLocalSnapshot(db, 'p1', first.id);

    expect((await createLocalSnapshot(db, { projectId: 'p1', files: files() })).seq).toBe(2);
  });
});

describe('the history', () => {
  it('lists OLDEST FIRST — the order selectRestoreTarget requires', async () => {
    const a = await createLocalSnapshot(db, { projectId: 'p1', files: files(), label: 'first' });
    const b = await createLocalSnapshot(db, { projectId: 'p1', files: files(), label: 'second' });
    const c = await createLocalSnapshot(db, { projectId: 'p1', files: files(), label: 'third' });

    expect((await listLocalSnapshots(db, 'p1')).map((s) => s.id)).toEqual([a.id, b.id, c.id]);
  });

  it('never mixes one project’s history into another’s', async () => {
    await createLocalSnapshot(db, { projectId: 'p1', files: files() });
    await createLocalSnapshot(db, { projectId: 'p2', files: files() });

    expect(await listLocalSnapshots(db, 'p1')).toHaveLength(1);
    expect((await listLocalSnapshots(db, 'p1'))[0].projectId).toBe('p1');
  });

  it('summarises without carrying the bytes — a list must not load the whole game', async () => {
    await createLocalSnapshot(db, { projectId: 'p1', files: files() });

    const [summary] = await listLocalSnapshots(db, 'p1');

    expect(summary).not.toHaveProperty('files');
    expect(summary.fileCount).toBe(3);
    expect(summary.totalBytes).toBe('export const speed = 10;\n'.length + 12 + 12);
  });

  it('anchors a checkpoint to its message, so "before this change" knows where before is', async () => {
    await createLocalSnapshot(db, { projectId: 'p1', files: files(), messageId: 'msg-7' });

    expect((await listLocalSnapshots(db, 'p1'))[0].messageId).toBe('msg-7');
  });
});

describe('the bound — a quota wall is data loss with no warning', () => {
  it('keeps the most recent checkpoints and trims the OLDEST', async () => {
    const ids: string[] = [];

    for (let i = 0; i < MAX_CHECKPOINTS_PER_PROJECT + 5; i++) {
      /*
       * Ids embed `Date.now()` but the label is what identifies them here — several of these land in
       * the same millisecond, which is precisely why ordering must not depend on the id.
       */
      ids.push((await createLocalSnapshot(db, { projectId: 'p1', files: files(), label: `c${i}` })).id);
    }

    const kept = await listLocalSnapshots(db, 'p1');

    expect(kept).toHaveLength(MAX_CHECKPOINTS_PER_PROJECT);

    /*
     * The five OLDEST are gone; the newest is still here. Trimming the other end would silently
     * discard exactly the checkpoint an undo is reaching for.
     */
    expect(kept.map((s) => s.label)).not.toContain('c0');
    expect(kept.map((s) => s.label)).toContain(`c${MAX_CHECKPOINTS_PER_PROJECT + 4}`);
  });

  it('trims per project — a busy project must not evict a quiet one', async () => {
    await createLocalSnapshot(db, { projectId: 'quiet', files: files(), label: 'only' });

    for (let i = 0; i < MAX_CHECKPOINTS_PER_PROJECT + 3; i++) {
      await createLocalSnapshot(db, { projectId: 'busy', files: files() });
    }

    expect(await listLocalSnapshots(db, 'quiet')).toHaveLength(1);
  });
});

describe('the current pointer', () => {
  it('follows the newest checkpoint automatically', async () => {
    await createLocalSnapshot(db, { projectId: 'p1', files: files() });

    const second = await createLocalSnapshot(db, { projectId: 'p1', files: files() });

    expect(await getCurrentLocalSnapshotId(db, 'p1')).toBe(second.id);
  });

  it('reads back the files the builder remounts on resume', async () => {
    await createLocalSnapshot(db, {
      projectId: 'p1',
      files: { 'a.ts': { type: 'file', content: 'old', isBinary: false } },
    });
    await createLocalSnapshot(db, {
      projectId: 'p1',
      files: { 'a.ts': { type: 'file', content: 'new', isBinary: false } },
    });

    expect(fileAt((await readCurrentLocalSnapshot(db, 'p1'))!.files, 'a.ts').content).toBe('new');
  });

  /** §4.12: a restore MOVES the pointer and adds history — it never destroys what came after. */
  it('moves back without deleting the checkpoints after it', async () => {
    const first = await createLocalSnapshot(db, { projectId: 'p1', files: files(), label: 'first' });
    await createLocalSnapshot(db, { projectId: 'p1', files: files(), label: 'second' });

    await setCurrentLocalSnapshot(db, 'p1', first.id);

    expect(await getCurrentLocalSnapshotId(db, 'p1')).toBe(first.id);
    expect(await listLocalSnapshots(db, 'p1')).toHaveLength(2);
  });

  it('reports nothing for a project with no checkpoints — a normal state, not an error', async () => {
    expect(await getCurrentLocalSnapshotId(db, 'nope')).toBeUndefined();
    expect(await readCurrentLocalSnapshot(db, 'nope')).toBeUndefined();
    expect(await listLocalSnapshots(db, 'nope')).toEqual([]);
  });
});

/**
 * "You have unsaved work" is only truthful if this pair is. It drives the LINKED indicator, the
 * nudges, and the beforeunload warning — the three things standing between a user and losing the only
 * copy of their game (§4.5.4b).
 */
describe('the saved/unsaved boundary', () => {
  it('reports nothing saved before the first push', async () => {
    await createLocalSnapshot(db, { projectId: 'p1', files: files() });

    expect(await getLocalSyncState(db, 'p1')).toEqual({ localSeq: 0, syncedSeq: undefined });
  });

  it('marks the current checkpoint as saved once a push lands', async () => {
    await createLocalSnapshot(db, { projectId: 'p1', files: files() });
    await createLocalSnapshot(db, { projectId: 'p1', files: files() });
    await markSynced(db, 'p1');

    expect(await getLocalSyncState(db, 'p1')).toEqual({ localSeq: 1, syncedSeq: 1 });
  });

  it('goes back to unsaved the moment new work happens', async () => {
    await createLocalSnapshot(db, { projectId: 'p1', files: files() });
    await markSynced(db, 'p1');
    await createLocalSnapshot(db, { projectId: 'p1', files: files() });

    expect(await getLocalSyncState(db, 'p1')).toEqual({ localSeq: 1, syncedSeq: 0 });
  });

  /**
   * A checkpoint and a mark share the `projectState` row. `createLocalSnapshot` writes that row too,
   * and a bare `put` there would erase `syncedSeq` — turning every saved project back into "unsaved"
   * on its next checkpoint, forever.
   */
  it('does not lose the saved mark when the next checkpoint is taken', async () => {
    await createLocalSnapshot(db, { projectId: 'p1', files: files() });
    await markSynced(db, 'p1');
    await createLocalSnapshot(db, { projectId: 'p1', files: files() });

    expect((await getLocalSyncState(db, 'p1')).syncedSeq).toBe(0);
  });

  /**
   * `localSeq` is the CURRENT checkpoint, not the newest. After a restore the project on screen is an
   * older state, and reporting the newest seq would claim unsaved work that is not there.
   */
  it('follows the current pointer, not the high-water mark', async () => {
    const first = await createLocalSnapshot(db, { projectId: 'p1', files: files() });
    await createLocalSnapshot(db, { projectId: 'p1', files: files() });
    await markSynced(db, 'p1');

    await setCurrentLocalSnapshot(db, 'p1', first.id);

    expect(await getLocalSyncState(db, 'p1')).toEqual({ localSeq: 0, syncedSeq: 1 });
  });

  it('is inert for a project with no checkpoints', async () => {
    await markSynced(db, 'nope');

    expect(await getLocalSyncState(db, 'nope')).toEqual({ localSeq: undefined, syncedSeq: undefined });
  });
});

describe('deleting a project', () => {
  it('removes its history and its pointer, and touches nothing else', async () => {
    await createLocalSnapshot(db, { projectId: 'p1', files: files() });
    await createLocalSnapshot(db, { projectId: 'p1', files: files() });
    await createLocalSnapshot(db, { projectId: 'p2', files: files() });

    await deleteLocalProject(db, 'p1');

    expect(await listLocalSnapshots(db, 'p1')).toEqual([]);
    expect(await getCurrentLocalSnapshotId(db, 'p1')).toBeUndefined();
    expect(await listLocalSnapshots(db, 'p2')).toHaveLength(1);
  });
});
