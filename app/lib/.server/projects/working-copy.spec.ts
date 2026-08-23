/**
 * The server working copy (SPEC §4.5.4c).
 *
 * This is a crash-recovery buffer for the user's game, so the assertions here are data-loss
 * assertions: bytes must survive exactly, there must only ever be ONE copy, and a copy that cannot be
 * trusted must read as ABSENT rather than as authoritative — a recovery buffer that hands back a stale
 * or malformed project causes the loss it exists to prevent.
 *
 * The binary tests are the same family as `seed-store.spec.ts` / the deleted `snapshots.spec.ts`: a
 * Babylon game is PNGs and WASM, and a persistence path that UTF-8s one silently returns a broken game.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToBase64 } from '~/lib/binary/binary-files';
import { FsObjectStore } from '~/lib/.server/storage/store';
import { setObjectStore } from '~/lib/.server/storage';
import {
  DEFAULT_WORKING_COPY_MAX_MB,
  maxWorkingCopyBytes,
  WorkingCopyTooLargeError,
  deleteWorkingCopy,
  getWorkingCopy,
  putWorkingCopy,
  workingCopyKey,
} from './working-copy';
import type { SerializedFileMap } from '~/lib/binary/binary-files';

/** Bytes that are hostile to a text codec: a PNG header, a NUL, a lone 0xFF, a UTF-8 continuation. */
const HOSTILE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0xc0]);

const files: SerializedFileMap = {
  'src/pages/Home.tsx': { type: 'file', content: 'export default function Home() {}', isBinary: false },
  'public/assets/generated/hero.png': {
    type: 'file',
    content: bytesToBase64(HOSTILE_BYTES),
    isBinary: true,
    size: HOSTILE_BYTES.length,
  },
};

let tmp: string;
let objects: FsObjectStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'working-copy-'));
  objects = new FsObjectStore(path.join(tmp, 'objects'));
  setObjectStore(objects);
});

afterEach(async () => {
  setObjectStore(undefined);
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('round trip', () => {
  it('preserves binary bytes exactly', async () => {
    await putWorkingCopy('prj_1', { projectId: 'prj_1', seq: 7, updatedAt: 'now', files });

    const back = await getWorkingCopy('prj_1');
    expect(back!.files['public/assets/generated/hero.png']).toEqual(files['public/assets/generated/hero.png']);
    expect(back!.seq).toBe(7);
  });

  it('is absent for a project that has never checkpointed — a miss is normal, not an error', async () => {
    expect(await getWorkingCopy('prj_never')).toBeNull();
  });
});

describe('there is only ever ONE copy', () => {
  /*
   * 🔴 The invariant that keeps this from becoming the deleted `snapshots` table. Retention is what
   * made that unbounded; "keep the last few" is how it grows back.
   */
  it('overwrites in place rather than accumulating versions', async () => {
    await putWorkingCopy('prj_1', { projectId: 'prj_1', seq: 1, updatedAt: 'a', files });
    await putWorkingCopy('prj_1', { projectId: 'prj_1', seq: 2, updatedAt: 'b', files });
    await putWorkingCopy('prj_1', { projectId: 'prj_1', seq: 3, updatedAt: 'c', files });

    expect((await getWorkingCopy('prj_1'))!.seq).toBe(3);
    expect((await objects.list('working/')).map((o) => o.key)).toEqual([workingCopyKey('prj_1')]);
  });

  /*
   * The key is a pure function of the project id — that is what makes `requireOwnedProject` sufficient
   * on its own, since there is no id for a caller to supply. The deleted snapshot route needed a
   * second ownership assertion precisely because it took one.
   */
  it('derives the key from the project id alone', () => {
    expect(workingCopyKey('prj_abc')).toBe('working/prj_abc.json');
    expect(workingCopyKey('prj_abc')).toBe(workingCopyKey('prj_abc'));
  });

  it('keeps projects separate', async () => {
    await putWorkingCopy('prj_a', { projectId: 'prj_a', seq: 1, updatedAt: 'a', files });
    await putWorkingCopy('prj_b', { projectId: 'prj_b', seq: 9, updatedAt: 'b', files });

    expect((await getWorkingCopy('prj_a'))!.seq).toBe(1);
    expect((await getWorkingCopy('prj_b'))!.seq).toBe(9);
  });
});

describe('a copy that cannot be trusted reads as ABSENT', () => {
  /*
   * "When in doubt, do nothing" — the same bias as `planRestore` and `planTranscriptRecovery`. Handing
   * back a copy we cannot order or read would let a stale/garbled project overwrite a good one, which
   * is the loss this module exists to prevent.
   */
  it('ignores corrupt bytes rather than throwing', async () => {
    await objects.put(workingCopyKey('prj_1'), new TextEncoder().encode('{not json'));
    expect(await getWorkingCopy('prj_1')).toBeNull();
  });

  it('ignores a copy with no usable seq — it could not be ordered against a local checkpoint', async () => {
    const noSeq = JSON.stringify({ projectId: 'prj_1', updatedAt: 'now', files });
    await objects.put(workingCopyKey('prj_1'), new TextEncoder().encode(noSeq));
    expect(await getWorkingCopy('prj_1')).toBeNull();
  });

  it('ignores a copy with no files', async () => {
    const noFiles = JSON.stringify({ projectId: 'prj_1', seq: 1, updatedAt: 'now' });
    await objects.put(workingCopyKey('prj_1'), new TextEncoder().encode(noFiles));
    expect(await getWorkingCopy('prj_1')).toBeNull();
  });
});

describe('bounds and cleanup', () => {
  /* SPEC §5: client-supplied bytes, written on EVERY checkpoint — uncapped is unbounded spend. */
  it('refuses a copy past the cap', async () => {
    const huge: SerializedFileMap = {
      'big.bin': { type: 'file', content: 'x'.repeat(maxWorkingCopyBytes() + 1), isBinary: false },
    };
    await expect(putWorkingCopy('prj_1', { projectId: 'prj_1', seq: 1, updatedAt: 'n', files: huge })).rejects.toThrow(
      WorkingCopyTooLargeError,
    );
  });

  /* Bytes must never outlive the record that named them — the §4.5.4b orphan shape. */
  it('is deleted with the project', async () => {
    await putWorkingCopy('prj_1', { projectId: 'prj_1', seq: 1, updatedAt: 'a', files });
    await deleteWorkingCopy('prj_1');

    expect(await getWorkingCopy('prj_1')).toBeNull();
    expect(await objects.list('working/')).toHaveLength(0);
  });
});

describe('secrets never reach the store (defence in depth)', () => {
  /*
   * 🔴 FOUND BY DRIVING THE REAL ROUTE, not by a test. `saveWorkingCopy` strips the `.env` family
   * client-side, and that was the entire defence — so a direct PUT stored the user's API keys in our
   * object storage. Every other secret boundary here is enforced at both ends (the shell allow-list is
   * client-side AND server-side, §4.2.5); this one was not.
   */
  it('drops the .env family even when the caller sends it', async () => {
    await putWorkingCopy('prj_1', {
      projectId: 'prj_1',
      seq: 1,
      updatedAt: 'now',
      files: {
        'src/main.ts': { type: 'file', content: 'ok', isBinary: false },
        '.env': { type: 'file', content: 'KIE_API_KEY=supersecret', isBinary: false },
        '.env.production': { type: 'file', content: 'PROD=secret', isBinary: false },
        '.npmrc': { type: 'file', content: '//registry:_authToken=nope', isBinary: false },
      },
    });

    const back = await getWorkingCopy('prj_1');
    expect(Object.keys(back!.files)).toEqual(['src/main.ts']);
    expect(JSON.stringify(back)).not.toContain('supersecret');
    expect(JSON.stringify(back)).not.toContain('_authToken');
  });
});

describe('the cap is configurable (WORKING_COPY_MAX_MB)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to 256MB', () => {
    vi.stubEnv('WORKING_COPY_MAX_MB', undefined as unknown as string);
    expect(maxWorkingCopyBytes()).toBe(DEFAULT_WORKING_COPY_MAX_MB * 1024 * 1024);
  });

  it('honours an operator override', () => {
    vi.stubEnv('WORKING_COPY_MAX_MB', '512');
    expect(maxWorkingCopyBytes()).toBe(512 * 1024 * 1024);
  });

  /*
   * A nonsensical override must neither disable the cap (§5 requires one) nor make every checkpoint
   * fail. Ignore it and keep the default — the same rule the Unity licence price ladder uses.
   */
  it.each(['0', '-1', 'lots', ''])('ignores a nonsense override (%s)', (raw) => {
    vi.stubEnv('WORKING_COPY_MAX_MB', raw);
    expect(maxWorkingCopyBytes()).toBe(DEFAULT_WORKING_COPY_MAX_MB * 1024 * 1024);
  });

  /* The operator needs the SIZE and the LIMIT to act — "too large" alone is unactionable. */
  it('names the size, the limit, and the env var when it refuses', async () => {
    vi.stubEnv('WORKING_COPY_MAX_MB', '1');

    const huge: SerializedFileMap = {
      'big.bin': { type: 'file', content: 'x'.repeat(2 * 1024 * 1024), isBinary: false },
    };

    await expect(putWorkingCopy('prj_1', { projectId: 'prj_1', seq: 1, updatedAt: 'n', files: huge })).rejects.toThrow(
      /2\.0MB.*1MB.*WORKING_COPY_MAX_MB/s,
    );
  });
});

/**
 * 🔴 READING A COPY THAT PREDATES THE BRANCH STAMP (§4.13a T17).
 *
 * There is one object per project and it is overwritten in place, so on the day the field shipped
 * every stored copy in existence had no `branch` key. `getWorkingCopy` must read those exactly as it
 * always did — absent, never a fabricated value and never a parse failure, because a recovery buffer
 * that refuses to load causes the loss it exists to prevent.
 *
 * The read is also the LAST door: the route coerces on the way in, but bytes already in the store were
 * written by clients that never did, so the same normalisation runs here. That mirrors `messageId`
 * beside it and the `isSecretPath` rule one function up — one rule, applied at every door.
 */
describe('the branch stamp reads as UNKNOWN when it is absent or unusable', () => {
  /** An object written before the field existed, byte-shaped exactly as it was stored then. */
  async function storeRaw(projectId: string, object: unknown) {
    await objects.put(workingCopyKey(projectId), new TextEncoder().encode(JSON.stringify(object)));
  }

  it('parses a legacy object with no branch key', async () => {
    await storeRaw('prj_old', { projectId: 'prj_old', seq: 4, updatedAt: 'then', files });

    const back = await getWorkingCopy('prj_old');

    expect(back).not.toBeNull();
    expect(back!.seq).toBe(4);
    expect(back!.branch).toBeUndefined();
    expect(back!.files['public/assets/generated/hero.png']).toEqual(files['public/assets/generated/hero.png']);
  });

  it('drops a non-string branch rather than passing it on', async () => {
    for (const branch of [123, true, null, { name: 'main' }]) {
      await storeRaw('prj_bad', { projectId: 'prj_bad', seq: 1, updatedAt: 'then', branch, files });
      expect((await getWorkingCopy('prj_bad'))!.branch, JSON.stringify(branch)).toBeUndefined();
    }
  });

  it('drops an empty string — it is not a branch name', async () => {
    await storeRaw('prj_empty', { projectId: 'prj_empty', seq: 1, updatedAt: 'then', branch: '', files });
    expect((await getWorkingCopy('prj_empty'))!.branch).toBeUndefined();
  });

  /*
   * CONTROL. Every assertion above is an absence, so a reader that simply deleted the field would pass
   * all of them — and would silently disable the guard for every project. A real name survives the
   * round trip untouched.
   */
  it('CONTROL — a real branch name survives the round trip', async () => {
    await putWorkingCopy('prj_1', { projectId: 'prj_1', seq: 2, updatedAt: 'now', branch: 'feature/hud', files });
    expect((await getWorkingCopy('prj_1'))!.branch).toBe('feature/hud');
  });
});
