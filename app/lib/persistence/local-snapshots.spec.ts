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
 *
 * ## Mutation-verified (hand-discharged 2026-08-15, `amendLocalSnapshot`)
 *
 * A hole cut in an append-only history is only as good as the guards around it, and a guard is only as
 * good as the test that would notice it gone. Each mutation was applied to the source, the suite run, and
 * the source restored byte-exactly:
 *
 *   - **drop the `state?.currentSnapshotId !== existing.id` guard** → **1 failure**, and it is the right
 *     one: *"refuses a row the pointer has moved off — the post-undo case"*. Nothing else notices, which is
 *     the point — being newest and being current are separate questions and no other test asks this one.
 *   - **drop the `existing.kind !== 'top-up'` condition** → **1 failure**: *"refuses a row that is not a
 *     top-up, and writes nothing"*.
 *   - **bump `nextSeq` on an amend** → **1 failure**: *"does not touch nextSeq"*. Asserted through the NEXT
 *     checkpoint's seq rather than by reading the counter, so it measures the consequence rather than the
 *     implementation.
 *   - **implement the amend as delete-then-create** (new id, new seq, pointer moved, trim re-run) →
 *     **6 failures**, including *"does not disturb the trim"* — the eviction the whole function exists to
 *     prevent, arriving through the fix.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bytesToBase64 } from '~/lib/binary/binary-files';
import { openDatabase } from './db';
import {
  MAX_CHECKPOINTS_PER_PROJECT,
  amendLocalSnapshot,
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

/**
 * The LATE render — a §4.16 image that lands after the generation already checkpointed.
 *
 * Deliberately a different length as well as different bytes: an amend that wrote the original map back
 * (or one that re-encoded on the way through) would still match on length alone.
 */
const LATE_PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef, 0x7f]);

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

/** What the project looks like once the late render has landed — the map a top-up amends IN. */
const lateFiles = (): SerializedFileMap => ({
  'src/game.ts': { type: 'file', content: 'export const speed = 20;\n', isBinary: false },
  'public/assets/generated/hero.png': {
    type: 'file',
    content: bytesToBase64(LATE_PNG_BYTES),
    isBinary: true,
    size: LATE_PNG_BYTES.byteLength,
  },
});

/** A one-file map, for tests where the only thing that matters is telling two states apart. */
const marker = (content: string): SerializedFileMap => ({
  'src/game.ts': { type: 'file', content, isBinary: false },
});

/**
 * The shape `planTopUp` hands to an amend: a real generation checkpoint, then the top-up that completes
 * it — so the top-up is `kind:'top-up'`, is the newest row, and is the current pointer.
 */
async function seedAmendableTopUp(projectId = 'p1') {
  const generation = await createLocalSnapshot(db, {
    projectId,
    files: marker('generation'),
    messageId: 'msg-7',
    label: 'c0',
  });
  const topUp = await createLocalSnapshot(db, {
    projectId,
    files: files(),
    messageId: 'msg-7',
    label: 'Unsaved changes',
    kind: 'top-up',
  });

  return { generation, topUp };
}

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
 * Amending a top-up (SPEC §4.5.4c, §4.12) — the one row in an append-only history that may be rewritten.
 *
 * An editor save schedules a top-up every four seconds. Appending one per save pushes twenty auto-saves
 * through a twenty-slot history in about a minute and evicts every generation checkpoint §4.12's undo
 * actually reaches for — data loss dressed as durability. So a top-up rewrites its own row instead, which
 * bounds a project to at most one top-up per real checkpoint.
 *
 * That is a hole cut in a written invariant, so the tests here are about the EDGES of the hole rather than
 * about the happy path. Each guard fails silently and each failure lands on the only copy of the user's
 * game: amending a generation checkpoint rewrites history; amending a row with newer siblings rewrites the
 * MIDDLE of a version list, so "restore to here" starts landing somewhere else; and amending a row the
 * §4.12 pointer is no longer parked on overwrites the state the user still has a way of asking for.
 *
 * Every refusal is therefore asserted twice — that it returned `false`, AND that the target row's bytes are
 * exactly as they were. A guard that returns `false` after writing has refused nothing.
 */
describe('amending a top-up', () => {
  /* The whole point: the late render's bytes land, and the row keeps the identity §4.12 navigates by. */
  it('replaces the files while keeping id, seq, messageId and kind', async () => {
    const { topUp } = await seedAmendableTopUp();

    expect(await amendLocalSnapshot(db, { snapshotId: topUp.id, files: lateFiles() })).toBe(true);

    const read = await readLocalSnapshot(db, topUp.id);

    expect(read).toMatchObject({
      id: topUp.id,
      seq: topUp.seq,
      messageId: 'msg-7',
      kind: 'top-up',
      label: 'Unsaved changes',
      projectId: 'p1',
    });
    expect(Object.keys(read!.files).sort()).toEqual(['public/assets/generated/hero.png', 'src/game.ts']);
    expect(fileAt(read!.files, 'src/game.ts').content).toBe('export const speed = 20;\n');
  });

  /*
   * `spec/binary-files.md`: base64 is a WIRE format that survives only because nothing on this path
   * reinterprets it. The amend is a NEW write of a map that has already been through structured clone
   * once, which is exactly where a well-meaning "normalise the files first" would land.
   */
  it('round-trips a binary byte-for-byte across create → amend → read', async () => {
    const { topUp } = await seedAmendableTopUp();

    await amendLocalSnapshot(db, { snapshotId: topUp.id, files: lateFiles() });

    const read = await readLocalSnapshot(db, topUp.id);

    expect(fileAt(read!.files, 'public/assets/generated/hero.png')).toEqual({
      type: 'file',
      content: bytesToBase64(LATE_PNG_BYTES),
      isBinary: true,
      size: LATE_PNG_BYTES.byteLength,
    });

    // The true byte count, not the base64 length — 13 raw bytes become 20 characters.
    expect(fileAt(read!.files, 'public/assets/generated/hero.png').size).toBe(13);
    expect(fileAt(read!.files, 'public/assets/generated/hero.png').content.length).toBe(20);
  });

  /*
   * The row already exists, so advancing the counter burns a seq for nothing — and REUSING one would put
   * two rows on a single seq, which is the tie `seq`'s own doc comment says the ledger paid for once. The
   * assertion is the observable version of "unchanged": the next real checkpoint gets the number it would
   * have got had no amend ever happened.
   */
  it('does not touch nextSeq — the next checkpoint gets the seq it would have got anyway', async () => {
    const { topUp } = await seedAmendableTopUp();

    expect(topUp.seq).toBe(1);

    for (let i = 0; i < 5; i++) {
      await amendLocalSnapshot(db, { snapshotId: topUp.id, files: marker(`amend-${i}`) });
    }

    expect((await createLocalSnapshot(db, { projectId: 'p1', files: files() })).seq).toBe(2);
  });

  /* An amend is a write to ONE row. Moving the pointer would make it a restore nobody asked for. */
  it('leaves the current pointer where it was', async () => {
    const { topUp } = await seedAmendableTopUp();

    await amendLocalSnapshot(db, { snapshotId: topUp.id, files: lateFiles() });

    expect(await getCurrentLocalSnapshotId(db, 'p1')).toBe(topUp.id);
    expect(await getLocalSyncState(db, 'p1')).toEqual({ localSeq: 1, syncedSeq: undefined });
  });

  /* Amending is not appending: the row count must not move, however many editor saves land. */
  it('rewrites one row rather than adding one', async () => {
    const { topUp } = await seedAmendableTopUp();

    for (let i = 0; i < 5; i++) {
      await amendLocalSnapshot(db, { snapshotId: topUp.id, files: marker(`amend-${i}`) });
    }

    const kept = await listLocalSnapshots(db, 'p1');

    expect(kept).toHaveLength(2);
    expect(fileAt((await readLocalSnapshot(db, topUp.id))!.files, 'src/game.ts').content).toBe('amend-4');
  });

  /*
   * 🔴 CONTROL. Without this the test above passes for an `amendLocalSnapshot` that writes NOTHING at all,
   * or for a fixture where five saves were never five saves. Appending the same five top-ups to the same
   * fixture must visibly grow the history — that growth is the thing amending exists to prevent, so it has
   * to be demonstrated rather than assumed.
   */
  it('CONTROL: appending the same five top-ups instead DOES grow the history', async () => {
    await seedAmendableTopUp();

    for (let i = 0; i < 5; i++) {
      await createLocalSnapshot(db, { projectId: 'p1', files: marker(`append-${i}`), kind: 'top-up' });
    }

    expect(await listLocalSnapshots(db, 'p1')).toHaveLength(7);
  });

  /*
   * A generation checkpoint is history, and history is append-only — there is no delete-one API here
   * deliberately. A row with no `kind` predates the field or came from `checkpointProject`; either way it
   * is not ours to rewrite.
   */
  it('refuses a row that is not a top-up, and writes nothing', async () => {
    const ordinary = await createLocalSnapshot(db, { projectId: 'p1', files: marker('generation') });

    expect(await amendLocalSnapshot(db, { snapshotId: ordinary.id, files: lateFiles() })).toBe(false);

    const read = await readLocalSnapshot(db, ordinary.id);

    expect(fileAt(read!.files, 'src/game.ts').content).toBe('generation');
    expect(read!.files['public/assets/generated/hero.png']).toBeUndefined();
  });

  /*
   * Newer siblings mean the row is in the MIDDLE of the history. Rewriting the middle of a version list is
   * how "restore to here" starts landing somewhere else. Note the pointer is parked back ON the top-up
   * here, so `isCurrent` passes and this test isolates the newest-row guard.
   */
  it('refuses a row that is not the newest, and writes nothing', async () => {
    const { topUp } = await seedAmendableTopUp();

    await createLocalSnapshot(db, { projectId: 'p1', files: marker('newer'), label: 'newer' });
    await setCurrentLocalSnapshot(db, 'p1', topUp.id);

    expect(await amendLocalSnapshot(db, { snapshotId: topUp.id, files: lateFiles() })).toBe(false);

    const read = await readLocalSnapshot(db, topUp.id);

    expect(fileAt(read!.files, 'src/game.ts').content).toBe('export const speed = 10;\n');
    expect(read!.files['public/assets/generated/hero.png']).toBeUndefined();
  });

  /*
   * 🔴 The post-undo case. After a §4.12 undo the pointer is parked on an OLDER snapshot
   * (`Messages.client.tsx`) while the top-up is still the newest row — so `isNewest` alone waves this
   * through, and the amend would overwrite the newest work with the state the user had just undone. That
   * is why the two guards are separate questions and neither implies the other.
   *
   * The parked snapshot is asserted byte-identical afterwards as well: a refusal must leave the whole
   * history alone, not merely the row it declined to write.
   */
  it('refuses a row the pointer has moved off — the post-undo case — and leaves both rows byte-identical', async () => {
    const generation = await createLocalSnapshot(db, { projectId: 'p1', files: files(), label: 'generation' });
    const topUp = await createLocalSnapshot(db, {
      projectId: 'p1',
      files: marker('the state the user undid from'),
      kind: 'top-up',
    });

    // Undo: the pointer parks on the older snapshot while the top-up stays the newest row.
    await setCurrentLocalSnapshot(db, 'p1', generation.id);

    expect(await amendLocalSnapshot(db, { snapshotId: topUp.id, files: lateFiles() })).toBe(false);

    const parked = await readLocalSnapshot(db, generation.id);

    expect(fileAt(parked!.files, 'public/logo.png')).toEqual({
      type: 'file',
      content: bytesToBase64(PNG_BYTES),
      isBinary: true,
      size: PNG_BYTES.byteLength,
    });
    expect(fileAt(parked!.files, 'public/car.glb').content).toBe(bytesToBase64(GLB_BYTES));
    expect(fileAt(parked!.files, 'src/game.ts').content).toBe('export const speed = 10;\n');

    // …and the row the amend was aimed at is untouched too.
    expect(fileAt((await readLocalSnapshot(db, topUp.id))!.files, 'src/game.ts')).toEqual({
      type: 'file',
      content: 'the state the user undid from',
      isBinary: false,
    });
    expect(await getCurrentLocalSnapshotId(db, 'p1')).toBe(generation.id);
  });

  /* A row deleted by the trim between the plan and the write. `false`, not a throw — the caller appends. */
  it('refuses a snapshot that does not exist rather than throwing', async () => {
    await seedAmendableTopUp();

    await expect(amendLocalSnapshot(db, { snapshotId: 'snp_gone', files: lateFiles() })).resolves.toBe(false);
    expect(await listLocalSnapshots(db, 'p1')).toHaveLength(2);
  });

  /*
   * The guards are answered from the row's OWN project. Reading the pointer or the sibling set from the
   * wrong project would make an amend in a busy project's history depend on whatever a quiet one was doing.
   */
  it('never reaches into another project’s history', async () => {
    const { topUp } = await seedAmendableTopUp('p1');
    const other = await createLocalSnapshot(db, { projectId: 'p2', files: marker('p2 work'), kind: 'top-up' });

    expect(await amendLocalSnapshot(db, { snapshotId: topUp.id, files: lateFiles() })).toBe(true);

    expect(fileAt((await readLocalSnapshot(db, other.id))!.files, 'src/game.ts').content).toBe('p2 work');
    expect(await getCurrentLocalSnapshotId(db, 'p2')).toBe(other.id);
    expect(await listLocalSnapshots(db, 'p2')).toHaveLength(1);
  });

  /*
   * The eviction this whole function exists to prevent. At the cap, an append costs the OLDEST checkpoint —
   * so a long editing session would quietly consume the twenty slots §4.12's undo navigates. Amending must
   * be a no-op for the trim however many times it runs.
   */
  it('does not disturb the trim, however many times it runs', async () => {
    for (let i = 0; i < MAX_CHECKPOINTS_PER_PROJECT - 1; i++) {
      await createLocalSnapshot(db, { projectId: 'p1', files: files(), label: `c${i}` });
    }

    const topUp = await createLocalSnapshot(db, {
      projectId: 'p1',
      files: files(),
      label: 'Unsaved changes',
      kind: 'top-up',
    });

    for (let i = 0; i < 30; i++) {
      await amendLocalSnapshot(db, { snapshotId: topUp.id, files: marker(`save-${i}`) });
    }

    const kept = await listLocalSnapshots(db, 'p1');

    expect(kept).toHaveLength(MAX_CHECKPOINTS_PER_PROJECT);
    expect(kept.map((s) => s.label)).toContain('c0');
    expect(kept.map((s) => s.id)).toContain(topUp.id);
    expect(fileAt((await readLocalSnapshot(db, topUp.id))!.files, 'src/game.ts').content).toBe('save-29');
  });

  /*
   * 🔴 CONTROL for the test above — and the measurement of the bug. Thirty appends against the identical
   * fixture hold the row count at twenty by throwing away the twenty oldest checkpoints, `c0` first. Without
   * this, "count is still twenty" is a fact about the cap rather than a fact about amending.
   */
  it('CONTROL: thirty appends at the cap evict the oldest checkpoints instead', async () => {
    for (let i = 0; i < MAX_CHECKPOINTS_PER_PROJECT - 1; i++) {
      await createLocalSnapshot(db, { projectId: 'p1', files: files(), label: `c${i}` });
    }

    await createLocalSnapshot(db, { projectId: 'p1', files: files(), label: 'Unsaved changes', kind: 'top-up' });

    for (let i = 0; i < 30; i++) {
      await createLocalSnapshot(db, { projectId: 'p1', files: marker(`save-${i}`), kind: 'top-up' });
    }

    const kept = await listLocalSnapshots(db, 'p1');

    expect(kept).toHaveLength(MAX_CHECKPOINTS_PER_PROJECT);
    expect(kept.map((s) => s.label)).not.toContain('c0');

    // Every generation checkpoint is gone: the whole history is auto-saves.
    expect(kept.every((s) => s.kind === 'top-up')).toBe(true);
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
