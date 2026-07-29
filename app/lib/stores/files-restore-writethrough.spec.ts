/**
 * T9b — `restoreFiles` reports into the file map SYNCHRONOUSLY, on every provider.
 *
 * 🔴 Why this file exists. `recordAgentWrite` closed the stale-serialize race for ARTIFACT writes
 * only. Every RESTORE door — checkpoint undo, working-copy restore, repo restore, git pull, snapshot
 * restore — wrote the disk and then left the map to the watcher. On WebContainer that lag is a
 * microtask; on a server provider it is an event plus an enrichment read PER FILE, each a round trip.
 * Anything that SERIALIZES the store inside that window (the §4.5.4c working copy, a checkpoint, a
 * push) captures a mix of the old project and the new one — the exact measured second-session defect
 * (a generated `Home.tsx` beside the starter's `Home.css`), reached through the restore door.
 *
 * So the assertions here fire the watcher ZERO times. That is not a convenience of the double, it is
 * the claim: the map must be correct without any watcher help at all. Anything that passes only
 * because an event arrived is testing the watcher, not the write-through.
 *
 * The headline pin is the LAST-mile one: `serializeFiles()` called immediately after `restoreFiles`
 * returns the RESTORED content — because serialization is what the money/data paths actually do with
 * the map, and it is what silently shipped the stale mix.
 *
 * ⚠️ Binaries are METADATA ONLY in the map (`isBinary` + `size`, EMPTY content — SPEC §1.3 principle
 * 10). The incoming serialized map carries base64, which is a WIRE format: copying it into `content`
 * would put binary bytes into the editor's text map and into the model's context. The bytes are on
 * disk; `serializeFiles` reads them back from the provider, which is also asserted here.
 */
/*
 * The provider double's unused members are inert ON PURPOSE — the claim under test is what the STORE
 * does with a provider, so its collaborators do nothing deliberately rather than by omission (same
 * convention as `files-exclusions.spec.ts`).
 */
/* eslint-disable @typescript-eslint/no-empty-function */
import { describe, expect, it, vi } from 'vitest';
import { base64ToBytes, bytesToBase64, type SerializedFileMap } from '~/lib/binary/binary-files';
import { toProjectRelativePath } from '~/lib/common/sandbox-paths';
import type { SandboxProvider } from '~/lib/sandbox';
import { resolveInWorkdir } from '~/lib/sandbox/codesandbox-translate';
import { WORK_DIR } from '~/utils/constants';
import { FilesStore } from './files';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A PNG-shaped payload: magic bytes plus the full byte range, including 0x00 and >0x7F. */
function makePng(payloadSize = 512): Uint8Array {
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const bytes = new Uint8Array(header.length + payloadSize);
  bytes.set(header, 0);

  for (let i = 0; i < payloadSize; i++) {
    bytes[header.length + i] = i % 256;
  }

  return bytes;
}

/**
 * A provider double with a real in-memory disk and a watcher that NEVER fires.
 *
 * `workdir` is a parameter because the whole point of T9b's acceptance is that the write-through is
 * provider-neutral: the same battery runs against a WebContainer-shaped workdir (`/home/project`) and
 * a CodeSandbox-shaped one (`/project/workspace`).
 *
 * 🔴 The fs RESOLVES the path it is handed through the real `resolveInWorkdir`, exactly as the
 * CodeSandbox provider does, and keys the disk by the resulting project-relative path. That detail is
 * load-bearing: `restoreFiles`' `toContainerPath` passes a FOREIGN root (`/home/project/…` restored
 * into a `/project/workspace` project) through VERBATIM, and it is the provider that rescues it. A
 * double that keyed its disk by the raw string would agree with a map keyed by the raw string, and
 * the cross-root disagreement these tests exist to catch would be invisible — coverage over the one
 * shape that cannot fail.
 */
function providerDouble(workdir: string) {
  const disk = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const reads: string[] = [];

  /** The provider's own path story: resolve against the workdir, then key relative to it. */
  const toDiskKey = (rawPath: string) => toProjectRelativePath(resolveInWorkdir(workdir, rawPath));

  const provider = {
    workdir,
    watchPaths: vi.fn(() => () => {}),
    fs: {
      async readdir(dirPath: string) {
        const prefix = dirPath === '.' || dirPath === '' ? '' : `${toDiskKey(dirPath)}/`;
        const entries = new Map<string, boolean>();

        for (const key of disk.keys()) {
          if (!key.startsWith(prefix)) {
            continue;
          }

          const rest = key.slice(prefix.length);
          const slash = rest.indexOf('/');

          entries.set(slash === -1 ? rest : rest.slice(0, slash), slash !== -1);
        }

        return [...entries].map(([name, isDir]) => ({
          name,
          isDirectory: () => isDir,
          isFile: () => !isDir,
        }));
      },
      async readFile(relPath: string) {
        const key = toDiskKey(relPath);
        reads.push(key);

        const bytes = disk.get(key);

        if (!bytes) {
          throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' });
        }

        return bytes;
      },
      async writeFile(relPath: string, data: string | Uint8Array) {
        // Matches the providers' string semantics: a string body is UTF-8 encoded on the way down.
        disk.set(toDiskKey(relPath), typeof data === 'string' ? encoder.encode(data) : data);
      },
      async mkdir(dirPath: string) {
        dirs.add(toDiskKey(dirPath));
      },
      async rm(relPath: string) {
        if (!disk.delete(toDiskKey(relPath))) {
          throw Object.assign(new Error(`ENOENT: ${relPath}`), { code: 'ENOENT' });
        }
      },
    },
  } as unknown as SandboxProvider;

  return { provider, disk, dirs, reads };
}

/** The two provider shapes this codebase ships. Same store, same contract, different workdir. */
const WORKDIRS: Array<[label: string, workdir: string]> = [
  ['WebContainer shape', '/home/project'],
  ['CodeSandbox shape', '/project/workspace'],
];

function newStore(workdir: string) {
  const double = providerDouble(workdir);
  const store = new FilesStore(Promise.resolve(double.provider));

  return { store, ...double };
}

describe.each(WORKDIRS)('restoreFiles write-through (%s)', (_label, workdir) => {
  const png = makePng();
  const p = (rel: string) => `${workdir}/${rel}`;

  /** The shape a real restore has: a folder, source text, and a binary carried as base64. */
  function restorePayload(): SerializedFileMap {
    return {
      [p('public')]: { type: 'folder' },
      [p('src/pages/Home.tsx')]: { type: 'file', content: 'export const Home = () => null;\n', isBinary: false },
      [p('public/babylon.png')]: {
        type: 'file',
        content: bytesToBase64(png),
        isBinary: true,
        size: png.byteLength,
      },
    };
  }

  it('reflects restored TEXT in the map synchronously — the watcher never ticks', async () => {
    const { store, provider } = newStore(workdir);

    await store.restoreFiles(restorePayload(), { protect: () => false });

    // Zero watcher events were delivered; the map is nonetheless correct.
    expect(provider.watchPaths).toBeDefined();
    expect(store.getFile(p('src/pages/Home.tsx'))?.content).toBe('export const Home = () => null;\n');
    expect(store.getFile(p('src/pages/Home.tsx'))?.isBinary).toBe(false);
  });

  it('records a BINARY as metadata only — isBinary, real byte size, empty content', async () => {
    const { store } = newStore(workdir);

    await store.restoreFiles(restorePayload(), { protect: () => false });

    const entry = store.getFile(p('public/babylon.png'));

    expect(entry?.isBinary).toBe(true);

    // SPEC §1.3 principle 10: base64 is a wire format and must never land in the map.
    expect(entry?.content).toBe('');
    expect(entry?.size).toBe(png.byteLength);
  });

  it('derives the byte size when the serialized entry carries none (never the base64 length)', async () => {
    const { store } = newStore(workdir);
    const encoded = bytesToBase64(png);

    // `size` is optional on `SerializedDirent`; older/hand-built envelopes omit it.
    await store.restoreFiles(
      { [p('public/babylon.png')]: { type: 'file', content: encoded, isBinary: true } },
      { protect: () => false },
    );

    const entry = store.getFile(p('public/babylon.png'));

    expect(entry?.size).toBe(png.byteLength);

    // The wrong answer — reporting the base64 length — would be ~4/3 too big, silently.
    expect(entry?.size).not.toBe(encoded.length);
  });

  it('records folders, so the tree is complete without waiting for add_dir events', async () => {
    const { store } = newStore(workdir);

    await store.restoreFiles(restorePayload(), { protect: () => false });

    expect(store.files.get()[p('public')]).toEqual({ type: 'folder' });
  });

  it("carries an existing file's lock forward — a restore is not an unlock", async () => {
    const { store } = newStore(workdir);

    // Seed the map the way the watcher would have, with the file locked by the user.
    store.files.setKey(p('src/pages/Home.tsx'), {
      type: 'file',
      content: 'old',
      isBinary: false,
      isLocked: true,
    });

    await store.restoreFiles(restorePayload(), { protect: () => false });

    const entry = store.getFile(p('src/pages/Home.tsx'));

    expect(entry?.content).toBe('export const Home = () => null;\n');
    expect(entry?.isLocked).toBe(true);
  });

  it('counts each new file once — a re-restore does not inflate filesCount', async () => {
    const { store } = newStore(workdir);

    await store.restoreFiles(restorePayload(), { protect: () => false });

    const afterFirst = store.filesCount;

    // Two files in the payload (the folder is not a file).
    expect(afterFirst).toBe(2);

    await store.restoreFiles(restorePayload(), { protect: () => false });

    /*
     * Restoring the same map twice is ordinary (an undo, then an undo of the undo). A counter that
     * grows each time silently misreports the project size everywhere it is surfaced.
     */
    expect(store.filesCount).toBe(afterFirst);
  });

  it('write-throughs the OVERLAY case too — no `protect` option, same synchronous map', async () => {
    const { store } = newStore(workdir);

    /*
     * The overlay path returns EARLY (it deletes nothing), which is exactly where a write-through
     * placed after the deletion planning would have been skipped — silently, for the snapshot-restore
     * caller in `useChatHistory` that passes no options at all.
     */
    await store.restoreFiles(restorePayload());

    expect(store.getFile(p('src/pages/Home.tsx'))?.content).toBe('export const Home = () => null;\n');
    expect(store.getFile(p('public/babylon.png'))?.isBinary).toBe(true);
  });

  it('still deletes what the incoming map dropped, and those files leave the map', async () => {
    const { store, disk } = newStore(workdir);

    // A file that exists on disk and in the map, and that the incoming restore does not have.
    await store.restoreFiles(
      { [p('src/pages/Obsolete.tsx')]: { type: 'file', content: 'gone soon', isBinary: false } },
      { protect: () => false },
    );
    expect(store.getFile(p('src/pages/Obsolete.tsx'))).toBeDefined();

    await store.restoreFiles(restorePayload(), { protect: () => false });

    // The write-through must not defeat the deletion half of a restore.
    expect(store.files.get()[p('src/pages/Obsolete.tsx')]).toBeUndefined();
    expect(disk.has('src/pages/Obsolete.tsx')).toBe(false);

    // CONTROL: the restored files are still there — the deletion was targeted, not a wipe.
    expect(store.getFile(p('src/pages/Home.tsx'))?.content).toBe('export const Home = () => null;\n');
  });

  it('protects what `protect` says to protect (the `.env` rule) even with the write-through', async () => {
    const { store } = newStore(workdir);

    await store.restoreFiles(
      { [p('.env')]: { type: 'file', content: 'SECRET=1', isBinary: false } },
      { protect: () => false },
    );

    // A repo restore's map never contains `.env`; `protectForRepoRestore` is why it survives.
    await store.restoreFiles(restorePayload(), { protect: (filePath) => filePath.endsWith('.env') });

    expect(store.getFile(p('.env'))?.content).toBe('SECRET=1');
  });

  /**
   * 🔴 THE HEADLINE PIN (T9b acceptance). Serialization is what every durability path does with the
   * map, and it is the step that shipped the stale mix. No watcher tick between the two calls.
   */
  it('serializeFiles() immediately after a restore returns the RESTORED project', async () => {
    const { store, reads } = newStore(workdir);

    // Pre-seed the map with the STALE project, exactly as a live session would have it.
    store.files.setKey(p('src/pages/Home.tsx'), { type: 'file', content: 'STALE starter Home', isBinary: false });

    await store.restoreFiles(restorePayload(), { protect: () => false });

    const serialized = await store.serializeFiles({ strict: true });

    // Text comes back as the restored content, never the stale body it replaced.
    expect(serialized[p('src/pages/Home.tsx')]).toEqual({
      type: 'file',
      content: 'export const Home = () => null;\n',
      isBinary: false,
      size: undefined,
    });

    // The binary comes back as base64 read from the provider's DISK — byte-identical.
    const binary = serialized[p('public/babylon.png')];

    expect(binary).toMatchObject({ type: 'file', isBinary: true, size: png.byteLength });
    expect([...base64ToBytes((binary as { content: string }).content)]).toEqual([...png]);

    // And it really did go to disk for those bytes rather than trusting a map field.
    expect(reads).toContain('public/babylon.png');

    // The folder rides along, so a restore-of-the-serialization rebuilds the same tree.
    expect(serialized[p('public')]).toEqual({ type: 'folder' });
  });

  it('the serialized text is what a later restore would write back to disk (no round-trip drift)', async () => {
    const { store, disk } = newStore(workdir);

    await store.restoreFiles(restorePayload(), { protect: () => false });

    const serialized = await store.serializeFiles({ strict: true });

    // Fresh store, fresh disk: restoring the serialization reproduces the project byte-for-byte.
    const second = newStore(workdir);
    await second.store.restoreFiles(serialized, { protect: () => false });

    expect(decoder.decode(second.disk.get('src/pages/Home.tsx'))).toBe(decoder.decode(disk.get('src/pages/Home.tsx')));
    expect([...second.disk.get('public/babylon.png')!]).toEqual([...png]);
  });
});

/**
 * 🔴 CROSS-ROOT RESTORES — the shape the whole CodeSandbox migration performs, and the one the
 * parameterized battery above could NOT see.
 *
 * `describe.each` runs both provider shapes, but always with MATCHING keys: the payload was built
 * from the same `workdir` the store had. That is coverage over the case that cannot fail. In
 * production the incoming map routinely carries ANOTHER provider's root — a §4.5.4c working copy or a
 * checkpoint written under WebContainer (`/home/project/…`) restored into a CodeSandbox project
 * (`/project/workspace/…`) — which is precisely why `SANDBOX_ROOTS` is a LIST and not a constant
 * (`app/lib/common/sandbox-paths.ts` names this exact scenario).
 *
 * The disk write rebases (the provider's `resolveInWorkdir` rescues a foreign root), so a map keyed
 * off the RAW incoming path points at files that do not exist under that key. Consequences, all
 * silent until they are not: `serializeFiles({ strict: true })` — the working-copy save and every
 * checkpoint — THROWS on the first binary it cannot read; and once the watcher catches up the project
 * is in the map TWICE (doubled model context, doubled ZIP/push, and phantom keys the next restore's
 * `planRestore` schedules for DELETION).
 */
describe('restoreFiles rebases FOREIGN-root keys onto the provider workdir', () => {
  const png = makePng();

  /** A restore payload whose keys carry `root` — deliberately not the store's workdir. */
  function payloadUnder(root: string): SerializedFileMap {
    return {
      [`${root}/public`]: { type: 'folder' },
      [`${root}/src/pages/Home.tsx`]: { type: 'file', content: 'export const Home = () => null;\n', isBinary: false },
      [`${root}/public/babylon.png`]: {
        type: 'file',
        content: bytesToBase64(png),
        isBinary: true,
        size: png.byteLength,
      },
    };
  }

  /** Every FILE key in the map, expressed the way the provider keys its disk. */
  function mapFileKeys(store: FilesStore) {
    return Object.entries(store.files.get())
      .filter(([, dirent]) => dirent?.type === 'file')
      .map(([filePath]) => filePath)
      .sort();
  }

  it('a WebContainer-era working copy restored into a CodeSandbox project lands under /project/workspace', async () => {
    const workdir = '/project/workspace';
    const { store, disk } = newStore(workdir);

    await store.restoreFiles(payloadUnder('/home/project'), { protect: () => false });

    /*
     * The map's keys and the DISK's keys must name the same files. This is the whole defect: the
     * bytes went to `src/pages/Home.tsx`, and the map used to say `/home/project/src/pages/Home.tsx`.
     */
    expect(mapFileKeys(store)).toEqual([`${workdir}/public/babylon.png`, `${workdir}/src/pages/Home.tsx`]);
    expect([...disk.keys()].sort()).toEqual(['public/babylon.png', 'src/pages/Home.tsx']);

    // Not one key may carry the foreign root — a single survivor is a phantom file forever.
    expect(Object.keys(store.files.get()).some((key) => key.startsWith('/home/project'))).toBe(false);

    // The folder is rebased too, or the tree grows a second, parallel root.
    expect(store.files.get()[`${workdir}/public`]).toEqual({ type: 'folder' });
  });

  it('and the STRICT serialize right after it completes — the failure the user would actually hit', async () => {
    const workdir = '/project/workspace';
    const { store } = newStore(workdir);

    await store.restoreFiles(payloadUnder('/home/project'), { protect: () => false });

    /*
     * `strict: true` is what the working copy and the checkpoint pass (a quietly incomplete map
     * becomes a restore source that DELETES files). With a raw-keyed map, the binary read misses and
     * this throws `IncompleteSerializationError` — every save after a cross-root restore, refused.
     */
    const serialized = await store.serializeFiles({ strict: true });

    expect(serialized[`${workdir}/src/pages/Home.tsx`]).toMatchObject({
      content: 'export const Home = () => null;\n',
      isBinary: false,
    });

    const binary = serialized[`${workdir}/public/babylon.png`];
    expect(binary).toMatchObject({ isBinary: true, size: png.byteLength });
    expect([...base64ToBytes((binary as { content: string }).content)]).toEqual([...png]);
  });

  it('mirrors in the other direction — a CodeSandbox-era map restored into a WebContainer project', async () => {
    /*
     * Asserted so the rule cannot be one-directional by accident. (The migration the product performs
     * is WC → CSB; this direction pins the STORE's rule — rebase onto the provider's workdir,
     * whatever it is — against a double that resolves like a provider does.)
     */
    const workdir = '/home/project';
    const { store, disk } = newStore(workdir);

    await store.restoreFiles(payloadUnder('/project/workspace'), { protect: () => false });

    expect(mapFileKeys(store)).toEqual([`${workdir}/public/babylon.png`, `${workdir}/src/pages/Home.tsx`]);
    expect([...disk.keys()].sort()).toEqual(['public/babylon.png', 'src/pages/Home.tsx']);
    expect(Object.keys(store.files.get()).some((key) => key.startsWith('/project/workspace'))).toBe(false);

    await expect(store.serializeFiles({ strict: true })).resolves.toBeTruthy();
  });

  it('an already-RELATIVE key (no root at all) still lands under the workdir', async () => {
    /*
     * Serialized maps of unknown provenance are the norm here (repo trees, hand-built envelopes,
     * older working copies). `toProjectRelativePath` is idempotent, so a rootless key must not be
     * left rootless in the map — a bare `src/main.ts` key matches nothing the rest of the product
     * looks up, and reads to `planRestore` as a file to delete.
     */
    const workdir = '/project/workspace';
    const { store } = newStore(workdir);

    await store.restoreFiles(
      {
        'src/main.ts': { type: 'file', content: 'export {};\n', isBinary: false },
        'public/babylon.png': { type: 'file', content: bytesToBase64(png), isBinary: true },
      },
      { protect: () => false },
    );

    expect(mapFileKeys(store)).toEqual([`${workdir}/public/babylon.png`, `${workdir}/src/main.ts`]);
    expect(store.getFile(`${workdir}/src/main.ts`)?.content).toBe('export {};\n');
    await expect(store.serializeFiles({ strict: true })).resolves.toBeTruthy();
  });

  it('a cross-root restore does not double-count filesCount either', async () => {
    const workdir = '/project/workspace';
    const { store } = newStore(workdir);

    // Same two files, once under the foreign root and once under the native one.
    await store.restoreFiles(payloadUnder('/home/project'), { protect: () => false });
    await store.restoreFiles(payloadUnder(workdir), { protect: () => false });

    expect(store.filesCount).toBe(2);
  });
});

/**
 * 🔴 T17a — a restore CONTAINS its failures instead of dying on them (measured live 2026-07-28).
 *
 * A stale checkpoint carried `.codesandbox/...` entries from before `.codesandbox` joined
 * `MAP_EXCLUDED_DIRS`; writing one over the provider's live directory threw the SDK's raw
 * `21: Os { code: 21, kind: IsADirectory }` out of `restoreFiles`, and the whole primary server-open
 * path silently degraded to the legacy IndexedDB mount — every file lost, plus the wake hook.
 * Two independent walls, both pinned here: the excludes apply on the way IN (what the map layer
 * refuses to hold, a restore refuses to write), and a per-file failure is skipped, never thrown.
 */
describe('restoreFiles: T17a containment', () => {
  const workdir = '/project/workspace';
  const EISDIR = '21: Os { code: 21, kind: IsADirectory, message: "Is a directory" }';
  const p = (rel: string) => `${workdir}/${rel}`;

  it('filters MAP-excluded dirs out of the incoming map — never written, never recorded, never planned', async () => {
    const { store, disk } = newStore(workdir);

    await store.restoreFiles(
      {
        [p('.codesandbox/tasks.json')]: { type: 'file', content: '{"tasks":{}}', isBinary: false },
        [p('node_modules/vite/index.js')]: { type: 'file', content: 'module.exports = {};', isBinary: false },
        [p('.git/HEAD')]: { type: 'file', content: 'ref: refs/heads/main', isBinary: false },
        [p('src/main.ts')]: { type: 'file', content: 'export {};\n', isBinary: false },
      },
      { protect: () => false },
    );

    // The real file landed on disk and in the map…
    expect(disk.has('src/main.ts')).toBe(true);
    expect(store.getFile(p('src/main.ts'))?.content).toBe('export {};\n');

    // …and not one excluded entry reached the disk OR the store.
    for (const rel of ['.codesandbox/tasks.json', 'node_modules/vite/index.js', '.git/HEAD']) {
      expect(disk.has(rel)).toBe(false);
      expect(store.files.get()[p(rel)]).toBeUndefined();
    }

    // Only the surviving file is counted — the filter ran before recording, not after.
    expect(store.filesCount).toBe(1);
  });

  it('the filter matches excluded names on ANY path segment, not just the first', async () => {
    const { store, disk } = newStore(workdir);

    await store.restoreFiles(
      {
        [p('packages/app/node_modules/x/index.js')]: { type: 'file', content: 'x', isBinary: false },
        [p('src/ok.ts')]: { type: 'file', content: 'ok', isBinary: false },
      },
      { protect: () => false },
    );

    expect(disk.has('packages/app/node_modules/x/index.js')).toBe(false);
    expect(disk.has('src/ok.ts')).toBe(true);
  });

  it('🔴 a write that throws the MEASURED EISDIR string is skipped — the restore completes', async () => {
    const { store, provider, disk } = newStore(workdir);

    // Make exactly one path behave like a directory on disk, the way the SDK reported it live.
    const fs = provider.fs as { writeFile(path: string, data: string | Uint8Array): Promise<void> };
    const realWrite = fs.writeFile.bind(fs);

    fs.writeFile = async (path, data) => {
      if (path.endsWith('src/pages')) {
        throw new Error(EISDIR);
      }

      await realWrite(path, data);
    };

    await expect(
      store.restoreFiles(
        {
          [p('src/pages')]: { type: 'file', content: 'stale entry over a live directory', isBinary: false },
          [p('src/main.ts')]: { type: 'file', content: 'export {};\n', isBinary: false },
          [p('src/other.ts')]: { type: 'file', content: 'export const other = 1;\n', isBinary: false },
        },
        { protect: () => false },
      ),
    ).resolves.toBeUndefined();

    // Every OTHER file landed on disk and in the map — one bad entry cost one file, not the project.
    expect(disk.has('src/main.ts')).toBe(true);
    expect(disk.has('src/other.ts')).toBe(true);
    expect(store.getFile(p('src/main.ts'))?.content).toBe('export {};\n');
    expect(store.getFile(p('src/other.ts'))?.content).toBe('export const other = 1;\n');
    expect(disk.has('src/pages')).toBe(false);
  });

  it('without `protect`, a restore deletes NOTHING — even when the store holds extra files', async () => {
    const { store, disk } = newStore(workdir);

    // A file the incoming map does not have, on disk and in the map.
    await store.restoreFiles(
      { [p('src/Extra.tsx')]: { type: 'file', content: 'extra', isBinary: false } },
      { protect: () => false },
    );
    expect(store.getFile(p('src/Extra.tsx'))).toBeDefined();

    // No `protect` → pure overlay: the extra file survives on both the disk and the map.
    await store.restoreFiles({ [p('src/main.ts')]: { type: 'file', content: 'export {};\n', isBinary: false } });

    expect(store.getFile(p('src/Extra.tsx'))?.content).toBe('extra');
    expect(disk.has('src/Extra.tsx')).toBe(true);

    // CONTROL: the same shape WITH `protect` does delete — the overlay pin is not a dead deletion path.
    await store.restoreFiles(
      { [p('src/main.ts')]: { type: 'file', content: 'export {};\n', isBinary: false } },
      { protect: () => false },
    );
    expect(store.files.get()[p('src/Extra.tsx')]).toBeUndefined();
    expect(disk.has('src/Extra.tsx')).toBe(false);
  });

  it('surfaces per-file progress over the surviving FILE entries', async () => {
    const { store } = newStore(workdir);
    const ticks: Array<[number, number]> = [];

    await store.restoreFiles(
      {
        [p('public')]: { type: 'folder' },
        [p('.codesandbox/tasks.json')]: { type: 'file', content: '{}', isBinary: false },
        [p('src/a.ts')]: { type: 'file', content: 'a', isBinary: false },
        [p('src/b.ts')]: { type: 'file', content: 'b', isBinary: false },
      },
      { onProgress: (done, total) => ticks.push([done, total]) },
    );

    // Two survivors: the folder is not a file and the excluded entry was filtered BEFORE counting.
    expect(ticks).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});

/**
 * PRE-EXISTING behaviour, documented rather than fixed (deliberate for T9b).
 *
 * These are properties `#recordRestoredFiles` INHERITS from `recordAgentWrite`; they predate the
 * write-through and are out of this task's scope. They are pinned here so the behaviour is visible
 * and a future change to it is a deliberate one — NOT because either is desirable.
 */
describe('restoreFiles: inherited behaviours (pre-existing, not fixed in T9b)', () => {
  it('does NOT clear a path from the deleted-paths set, so a later refresh drops the restored file', async () => {
    /*
     * `deleteFile` remembers the path so a `refreshFiles` cannot resurrect what the user removed. A
     * restore that brings the same path BACK does not un-remember it — so the file is on disk and in
     * the map, and the next full re-scan (`skip`) silently omits it again.
     *
     * Pre-existing: the same asymmetry exists for `recordAgentWrite` and for `createFile`'s callers.
     * Left alone in T9b because changing what "the user deleted this" means is its own decision.
     *
     * ⚠️ Uses WORK_DIR as the workdir on purpose: `refreshFiles` keys its rebuilt map (and its `skip`
     * lookup) off the WORK_DIR constant rather than the provider's workdir.
     */
    const { store, disk } = newStore(WORK_DIR);

    await store.restoreFiles(
      { [`${WORK_DIR}/src/main.ts`]: { type: 'file', content: 'v1', isBinary: false } },
      { protect: () => false },
    );
    await store.deleteFile(`${WORK_DIR}/src/main.ts`);

    // The restore puts the bytes back and the write-through puts the entry back…
    await store.restoreFiles(
      { [`${WORK_DIR}/src/main.ts`]: { type: 'file', content: 'v2', isBinary: false } },
      { protect: () => false },
    );
    expect(store.getFile(`${WORK_DIR}/src/main.ts`)?.content).toBe('v2');
    expect(disk.has('src/main.ts')).toBe(true);

    // …and a full re-scan still treats it as user-deleted. Documented, not endorsed.
    await store.refreshFiles();
    expect(store.files.get()[`${WORK_DIR}/src/main.ts`]).toBeUndefined();

    // CONTROL: the re-scan really ran and really does surface an untouched file.
    expect(decoder.decode(disk.get('src/main.ts'))).toBe('v2');
  });
});
