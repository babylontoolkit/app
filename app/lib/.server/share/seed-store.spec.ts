/**
 * The remix seed round-trip (SPEC §4.8, §4.5.4b, spec/binary-files.md).
 *
 * The seed is now the ONLY path on which a user's own bytes pass through the platform. The binary
 * assertions here are ported from `snapshots.spec.ts`, which was deleted with the snapshot store: the
 * store is gone, but the invariant it protected is not. A Babylon game is PNGs and GLBs, and a seed
 * that UTF-8s one hands every remixer a broken game with nothing to tell them why — the exact upstream
 * defect Stage 0 fixed, which must not re-enter through a new persistence path.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bytesToBase64 } from '~/lib/binary/binary-files';
import { FsObjectStore } from '~/lib/.server/storage/store';
import { setObjectStore } from '~/lib/.server/storage';
import { deleteRemixSeed, getRemixSeed, putRemixSeed, seedKey } from './seed-store';
import type { SerializedFileMap } from '~/lib/binary/binary-files';

/** Bytes that are hostile to a text codec: a PNG header, a NUL, a lone 0xFF, a UTF-8 continuation. */
const HOSTILE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0xc0]);

let tmp: string;
let objects: FsObjectStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-store-'));
  objects = new FsObjectStore(path.join(tmp, 'objects'));
  setObjectStore(objects);
});

afterEach(async () => {
  setObjectStore(undefined);
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('a seed survives the round trip', () => {
  it('preserves binary bytes exactly', async () => {
    const payload: SerializedFileMap = {
      'src/pages/Home.tsx': { type: 'file', content: 'export default function Home() {}', isBinary: false },
      'public/hero.png': {
        type: 'file',
        content: bytesToBase64(HOSTILE_BYTES),
        isBinary: true,
        size: HOSTILE_BYTES.length,
      },
      src: { type: 'folder' },
    };

    await putRemixSeed('prj_1', payload);

    const restored = await getRemixSeed('prj_1');
    const hero = restored!['public/hero.png'];

    expect(hero?.type === 'file' && hero.isBinary).toBe(true);

    // The real assertion: the bytes that come back are byte-for-byte the ones that went in.
    expect(hero?.type === 'file' && hero.content).toBe(bytesToBase64(HOSTILE_BYTES));
    expect(hero?.type === 'file' && hero.size).toBe(HOSTILE_BYTES.length);
  });

  it('preserves text content exactly, including non-ASCII', async () => {
    const source = 'const π = 3.14159;\nconst emoji = "🏎️";\n';
    await putRemixSeed('prj_1', { 'src/x.ts': { type: 'file', content: source, isBinary: false } });

    const restored = await getRemixSeed('prj_1');
    const file = restored!['src/x.ts'];

    expect(file?.type === 'file' && file.content).toBe(source);
  });

  it('keeps folders, so a restored tree has its shape', async () => {
    await putRemixSeed('prj_1', { src: { type: 'folder' } });
    expect((await getRemixSeed('prj_1'))!.src).toEqual({ type: 'folder' });
  });
});

describe('a seed belongs to exactly one project', () => {
  /**
   * The key is DERIVED, and that is a security property, not a convenience.
   *
   * The route this replaced took a caller-supplied snapshot id, which is why it needed a second wall to
   * stop project A's owner reading project B's files by naming B's id in A's URL. There is no id to
   * supply here — so `requireOwnedProject` alone is sufficient, and that is only true while this stays
   * a pure function of the project id.
   */
  it('derives its key from the project id and nothing else', () => {
    expect(seedKey('prj_1')).toBe('seeds/prj_1.json');
    expect(seedKey('prj_2')).not.toBe(seedKey('prj_1'));
  });

  it('does not let one project read another’s seed', async () => {
    await putRemixSeed('prj_1', { 'a.ts': { type: 'file', content: 'mine', isBinary: false } });

    expect(await getRemixSeed('prj_2')).toBeNull();
  });
});

describe('a missing seed is a value, not a failure', () => {
  /** The NORMAL case: almost no project has a seed, and asking must never be an error. */
  it('returns null for a project that has none', async () => {
    expect(await getRemixSeed('prj_never_published')).toBeNull();
  });

  /**
   * Corrupt bytes read as "no seed" rather than throwing. The caller's fallback is identical either
   * way (a clone with no files), and a seed must never be the reason a page fails to load.
   */
  it('returns null rather than throwing on unparseable bytes', async () => {
    await objects.put(seedKey('prj_1'), new TextEncoder().encode('{ not json'));

    expect(await getRemixSeed('prj_1')).toBeNull();
  });
});

describe('forgetting a seed', () => {
  /**
   * Unpublish and delete both call this. If it does not really remove the bytes, "make my game private
   * again" leaves our copy of the user's source in storage — the §4.5.4b promise as a claim rather
   * than a behaviour.
   */
  it('really removes the bytes', async () => {
    await putRemixSeed('prj_1', { 'a.ts': { type: 'file', content: 'secret-ish', isBinary: false } });
    expect(await getRemixSeed('prj_1')).not.toBeNull();

    await deleteRemixSeed('prj_1');

    expect(await getRemixSeed('prj_1')).toBeNull();
    expect(await objects.get(seedKey('prj_1'))).toBeNull();
  });

  /** Project delete calls this unconditionally, so it must not throw when there is nothing there. */
  it('is a no-op for a project that never had one', async () => {
    await expect(deleteRemixSeed('prj_never')).resolves.toBeUndefined();
  });

  it('leaves other projects’ seeds alone', async () => {
    await putRemixSeed('prj_1', { 'a.ts': { type: 'file', content: 'one', isBinary: false } });
    await putRemixSeed('prj_2', { 'a.ts': { type: 'file', content: 'two', isBinary: false } });

    await deleteRemixSeed('prj_1');

    expect(await getRemixSeed('prj_2')).not.toBeNull();
  });
});

describe('re-publishing', () => {
  it('overwrites the previous seed rather than accumulating copies', async () => {
    await putRemixSeed('prj_1', { 'a.ts': { type: 'file', content: 'v1', isBinary: false } });
    await putRemixSeed('prj_1', { 'a.ts': { type: 'file', content: 'v2', isBinary: false } });

    const restored = await getRemixSeed('prj_1');
    const file = restored!['a.ts'];

    expect(file?.type === 'file' && file.content).toBe('v2');
    expect(await objects.list('seeds/')).toHaveLength(1);
  });
});
