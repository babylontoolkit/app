/**
 * The disk link (SPEC §4.5.4d): folder store, scan, mirror and external-change poll, driven against
 * the in-memory directory double — which performs every write and delete for real.
 *
 * Every failure here is silent in production: a path that escapes the folder writes somewhere on the
 * user's machine; an echo rewrites a whole project on every open; a poisoned queue stops mirroring
 * with nothing on screen; a stub that never writes makes all of it green.
 */
import { describe, expect, it } from 'vitest';
import type { SandboxWatchEvent } from '~/lib/sandbox/types';
import { base64ToBytes } from '~/lib/binary/binary-files';
import { MemoryDirectory } from './memory-directory';
import {
  createProjectFolder,
  findProjectFolder,
  FolderTooLargeError,
  LocalPathError,
  ProjectFolder,
  splitRelativePath,
} from './fsa-store';
import { buildProjectMarker, candidateDirNames, parseProjectMarker, slugForFolder } from './dir-name';
import { sameBytes, treeToSerializedFileMap } from './scan';
import { LocalMirror } from './mirror';
import { applyExternalChanges, diffDiskIndex } from './external-changes';
import { PROJECT_MARKER_FILE } from './types';
import { projectsRoot, UNITY_PROJECTS_FOLDER, WEB_PROJECTS_FOLDER } from './projects-root';
import { ownerKeyFor } from './handles';

const WORKDIR = '/home/project';
const EXCLUDED = new Set(['node_modules', '.git', '.codesandbox', 'dist']);
const OPTIONS = { isExcludedDir: (name: string) => EXCLUDED.has(name) };
const text = (s: string) => new TextEncoder().encode(s);

function folderIn(root: MemoryDirectory, maxFiles?: number): ProjectFolder {
  return new ProjectFolder(root, { ...OPTIONS, maxFiles });
}

/** A sandbox double: a map of project-relative path → bytes, with the seam's `fs` shape over it. */
function fakeSandbox(files: Record<string, string | Uint8Array> = {}) {
  const store = new Map<string, Uint8Array>();

  for (const [rel, content] of Object.entries(files)) {
    store.set(rel, typeof content === 'string' ? text(content) : content);
  }

  const writes: string[] = [];
  const removed: string[] = [];
  let watcher: ((events: SandboxWatchEvent[]) => void) | undefined;

  return {
    store,
    writes,
    removed,
    fire: (events: SandboxWatchEvent[]) => watcher?.(events),
    sandbox: {
      workdir: WORKDIR,
      fs: {
        readFile: async (rel: string) => {
          const bytes = store.get(rel);

          if (!bytes) {
            throw new Error(`ENOENT ${rel}`);
          }

          return bytes;
        },
        writeFile: async (rel: string, data: string | Uint8Array) => {
          store.set(rel, typeof data === 'string' ? text(data) : new Uint8Array(data));
          writes.push(rel);
        },
        mkdir: async () => undefined,
        rm: async (rel: string) => {
          removed.push(rel);
          store.delete(rel);
        },
      },
      watchPaths: (_options: unknown, callback: (events: SandboxWatchEvent[]) => void) => {
        watcher = callback;

        return () => {
          watcher = undefined;
        };
      },
    } as any,
  };
}

const event = (type: SandboxWatchEvent['type'], rel: string): SandboxWatchEvent => ({
  type,
  path: `${WORKDIR}/${rel}`,
});

function mirrorOver(
  root: MemoryDirectory,
  sb: ReturnType<typeof fakeSandbox>,
  restoring = () => false,
  initialIndex = {},
) {
  const statuses: Array<{ pending: number; error?: string }> = [];
  const mirror = new LocalMirror(
    {
      sandbox: sb.sandbox,
      folder: folderIn(root),
      excludeGlobs: [],
      isRestoreInFlight: restoring,
      onStatus: (status) => statuses.push({ pending: status.pending, error: status.error }),
      setTimer: () => 0, // never fires — tests drain by hand
      clearTimer: () => undefined,
      maxAttempts: 2,
    },
    initialIndex,
  );

  return { mirror, statuses };
}

/* ------------------------------------------------------------------------------- paths */

describe("splitRelativePath — the wall between the sandbox and the user's disk", () => {
  it.each(['', '/etc/passwd', '../outside', 'src/../../x', 'src//a', 'C:\\x', 'a\\b', './a'])('refuses %j', (rel) => {
    expect(() => splitRelativePath(rel)).toThrow(LocalPathError);
  });

  it('accepts ordinary project paths (control)', () => {
    expect(splitRelativePath('src/scripts/KartMode.ts')).toEqual(['src', 'scripts', 'KartMode.ts']);
    expect(splitRelativePath('package.json')).toEqual(['package.json']);
  });
});

/* -------------------------------------------------------------------------- the folder */

describe('ProjectFolder', () => {
  it('writes bytes byte-for-byte, creating parents, and reads them back', async () => {
    const root = new MemoryDirectory('projects');
    const folder = folderIn(root);
    const bytes = new Uint8Array([0, 255, 137, 80, 78, 71, 13, 10, 26, 10, 0]);

    await folder.writeFile('public/assets/hero.png', bytes);

    expect(await folder.readFile('public/assets/hero.png')).toEqual(bytes);
    expect(await folder.stat('public/assets/hero.png')).toMatchObject({ size: bytes.byteLength });
  });

  it("copies the bytes it is handed — the caller's buffer is on loan", async () => {
    const root = new MemoryDirectory('projects');
    const folder = folderIn(root);
    const bytes = new Uint8Array([1, 2, 3]);

    await folder.writeFile('a.bin', bytes);
    bytes[0] = 99;

    expect(await folder.readFile('a.bin')).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('reads undefined for a missing file and removes a missing path without error', async () => {
    const folder = folderIn(new MemoryDirectory('projects'));

    expect(await folder.readFile('nope.ts')).toBeUndefined();
    expect(await folder.stat('missing/nope.ts')).toBeUndefined();
    await expect(folder.remove('missing/nope.ts')).resolves.toBeUndefined();
  });

  it('removes a directory recursively', async () => {
    const root = new MemoryDirectory('projects');
    const folder = folderIn(root);
    await folder.writeFile('src/a.ts', 'a');
    await folder.writeFile('src/deep/b.ts', 'b');

    await folder.remove('src');

    expect(root.paths()).toEqual([]);
  });

  it('readTree skips excluded directory names at any depth and the marker, and lists directories', async () => {
    const root = new MemoryDirectory('projects');
    const folder = folderIn(root);
    await folder.writeFile('package.json', '{}');
    await folder.writeFile('src/main.ts', 'main');
    await folder.writeFile('node_modules/react/index.js', 'x');
    await folder.writeFile('src/vendor/node_modules/dep/index.js', 'x');
    await folder.writeFile('dist/index.html', 'x');
    await folder.writeFile('.git/HEAD', 'ref');
    await folder.writeFile('empty-dir-parent/.keep', '');
    await folder.writeMarker(buildProjectMarker('p1', 'Kart'));

    const tree = await folder.readTree({ withBytes: true });

    expect(Object.keys(tree.files).sort()).toEqual(['empty-dir-parent/.keep', 'package.json', 'src/main.ts']);
    expect(tree.directories.sort()).toEqual(['empty-dir-parent', 'src', 'src/vendor']);
    expect(Object.keys(tree.index).sort()).toEqual(['empty-dir-parent/.keep', 'package.json', 'src/main.ts']);
    expect(tree.files[PROJECT_MARKER_FILE]).toBeUndefined();
  });

  it('readTree without bytes still returns every stamp (control for the poll)', async () => {
    const folder = folderIn(new MemoryDirectory('projects'));
    await folder.writeFile('a.ts', 'aaaa');

    const tree = await folder.readTree({ withBytes: false });

    expect(tree.files).toEqual({});
    expect(tree.index['a.ts']).toMatchObject({ size: 4 });
  });

  it('refuses a folder over the file cap', async () => {
    const folder = folderIn(new MemoryDirectory('projects'), 2);
    await folder.writeFile('a', '1');
    await folder.writeFile('b', '2');
    await folder.writeFile('c', '3');

    await expect(folder.readTree({ withBytes: false })).rejects.toBeInstanceOf(FolderTooLargeError);
  });

  it('isIgnored covers excluded dirs at any depth and the root marker only', () => {
    const folder = folderIn(new MemoryDirectory('projects'));

    expect(folder.isIgnored('node_modules/x.js')).toBe(true);
    expect(folder.isIgnored('src/node_modules/x.js')).toBe(true);
    expect(folder.isIgnored(PROJECT_MARKER_FILE)).toBe(true);
    expect(folder.isIgnored(`src/${PROJECT_MARKER_FILE}`)).toBe(false);
    expect(folder.isIgnored('src/main.ts')).toBe(false);
  });
});

/* ------------------------------------------------------------- naming, markers, locating */

describe('folder names and markers', () => {
  it('slugs a title and falls back to a word, never the id', () => {
    expect(slugForFolder('Kart Racer!!')).toBe('kart-racer');
    expect(slugForFolder('')).toBe('project');
    expect(slugForFolder(undefined)).toBe('project');
  });

  it('walks slug, slug-2, slug-3…', () => {
    expect(candidateDirNames('kart', 3)).toEqual(['kart', 'kart-2', 'kart-3']);
  });

  it('parses only a real marker', () => {
    expect(parseProjectMarker(JSON.stringify(buildProjectMarker('p1', 'Kart')))).toMatchObject({ projectId: 'p1' });
    expect(parseProjectMarker('{}')).toBeUndefined();
    expect(parseProjectMarker('not json')).toBeUndefined();
    expect(parseProjectMarker('{"projectId": 5}')).toBeUndefined();
  });
});

describe('findProjectFolder / createProjectFolder — inside Web/, by MARKER, never by name (D61)', () => {
  it('a new project lands in Web/<slug>/ with its marker, and Web/ and Unity/ both exist', async () => {
    const parent = new MemoryDirectory('projects');
    const created = await createProjectFolder(parent, 'p1', 'Kart Racer', OPTIONS);

    expect(created.name).toBe('kart-racer');
    expect(parent.text(`Web/kart-racer/${PROJECT_MARKER_FILE}`)).toContain('"projectId": "p1"');
    expect([...parent.children.keys()].sort()).toEqual(['Unity', 'Web']);
    expect(parent.children.get('Unity')).toBeInstanceOf(MemoryDirectory);

    const found = await findProjectFolder(parent, 'p1', 'Kart Racer', OPTIONS);
    expect(found?.name).toBe('kart-racer');
  });

  it('projectsRoot creates Web/ and Unity/ and touches nothing else at the top level', async () => {
    const parent = new MemoryDirectory('projects');
    await parent.put('notes.txt', 'mine');

    const { web, unity } = await projectsRoot(parent);

    expect(web.name).toBe(WEB_PROJECTS_FOLDER);
    expect(unity.name).toBe(UNITY_PROJECTS_FOLDER);
    expect([...parent.children.keys()].sort()).toEqual(['Unity', 'Web', 'notes.txt']);
    expect(parent.text('notes.txt')).toBe('mine');

    // Idempotent: a second call returns the same folders, no duplicates.
    await projectsRoot(parent);
    expect([...parent.children.keys()].sort()).toEqual(['Unity', 'Web', 'notes.txt']);
  });

  it('finds an existing project inside Web/ by its marker (the mount door)', async () => {
    const parent = new MemoryDirectory('projects');
    await parent.put(`Web/renamed/${PROJECT_MARKER_FILE}`, JSON.stringify(buildProjectMarker('p1', 'Old')));

    const found = await findProjectFolder(parent, 'p1', 'New Name', OPTIONS);

    expect(found?.name).toBe('renamed');
  });

  it('CONTROL: a marked folder at the TOP level is never found, adopted or touched', async () => {
    const parent = new MemoryDirectory('projects');
    const marker = JSON.stringify(buildProjectMarker('p1', 'Kart Racer'));
    const topLevel = await parent.put(`kart-racer/${PROJECT_MARKER_FILE}`, marker);
    const writesBefore = topLevel.writes;

    expect(await findProjectFolder(parent, 'p1', 'Kart Racer', OPTIONS)).toBeUndefined();

    const created = await createProjectFolder(parent, 'p1', 'Kart Racer', OPTIONS);

    expect(created.name).toBe('kart-racer');
    expect(parent.text(`Web/kart-racer/${PROJECT_MARKER_FILE}`)).toContain('"projectId": "p1"');
    expect(parent.text(`kart-racer/${PROJECT_MARKER_FILE}`)).toBe(marker);
    expect(topLevel.writes).toBe(writesBefore);
    expect((parent.children.get('kart-racer') as MemoryDirectory).paths()).toEqual([PROJECT_MARKER_FILE]);
  });

  it('does NOT adopt a same-named folder belonging to another project, and does not adopt one with no marker', async () => {
    const parent = new MemoryDirectory('projects');
    await createProjectFolder(parent, 'other', 'Kart Racer', OPTIONS);
    await parent.put('Web/unmarked/package.json', '{}');

    expect(await findProjectFolder(parent, 'p1', 'Kart Racer', OPTIONS)).toBeUndefined();
    expect(await findProjectFolder(parent, 'p1', 'Unmarked', OPTIONS)).toBeUndefined();

    const created = await createProjectFolder(parent, 'p1', 'Kart Racer', OPTIONS);
    expect(created.name).toBe('kart-racer-2');
    expect(parent.text(`Web/kart-racer-2/${PROJECT_MARKER_FILE}`)).toContain('"projectId": "p1"');
  });

  it('finds a renamed project by scanning markers', async () => {
    const parent = new MemoryDirectory('projects');
    await createProjectFolder(parent, 'p1', 'Old Name', OPTIONS);

    const found = await findProjectFolder(parent, 'p1', 'New Name', OPTIONS);
    expect(found?.name).toBe('old-name');
  });

  it('createProjectFolder is idempotent for a project that already has a folder', async () => {
    const parent = new MemoryDirectory('projects');
    await createProjectFolder(parent, 'p1', 'Kart', OPTIONS);

    const again = await createProjectFolder(parent, 'p1', 'Kart', OPTIONS);

    expect(again.name).toBe('kart');
    expect([...parent.children.keys()].sort()).toEqual(['Unity', 'Web']);
    expect([...(parent.children.get('Web') as MemoryDirectory).children.keys()]).toEqual(['kart']);
  });
});

/* ----------------------------------------------------------------------------------- scan */

describe('treeToSerializedFileMap', () => {
  it('keys sandbox-absolute, base64s binaries, keeps text as text, and carries folders', () => {
    const png = new Uint8Array([137, 80, 78, 71, 0, 1, 2]);
    const map = treeToSerializedFileMap(
      { files: { 'src/main.ts': text('hi'), 'public/a.png': png }, directories: ['src', 'public'], index: {} },
      WORKDIR,
    );

    expect(map[`${WORKDIR}/src`]).toEqual({ type: 'folder' });
    expect(map[`${WORKDIR}/src/main.ts`]).toMatchObject({ type: 'file', content: 'hi', isBinary: false });

    const bin = map[`${WORKDIR}/public/a.png`];
    expect(bin).toMatchObject({ type: 'file', isBinary: true, size: 7 });
    expect(base64ToBytes((bin as { content: string }).content)).toEqual(png);
  });

  it('sameBytes compares content, not identity (control)', () => {
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(sameBytes(new Uint8Array([1]), new Uint8Array([1, 0]))).toBe(false);
  });
});

/* --------------------------------------------------------------------------------- mirror */

describe('LocalMirror — every sandbox change lands on disk', () => {
  it('writes a changed file, as a COPY of the sandbox bytes', async () => {
    const root = new MemoryDirectory('kart');
    const sb = fakeSandbox({ 'src/main.ts': 'v1' });
    const { mirror } = mirrorOver(root, sb);

    mirror.accept([event('add_file', 'src/main.ts')]);
    expect(mirror.pending).toBe(1);
    await mirror.drain();

    expect(root.text('src/main.ts')).toBe('v1');

    // The sandbox's own buffer is mutated afterwards; the disk copy must not follow it.
    sb.store.get('src/main.ts')![0] = 'X'.charCodeAt(0);
    expect(root.text('src/main.ts')).toBe('v1');
  });

  it('deletes a removed file and a removed directory, and a directory delete supersedes queued writes beneath it', async () => {
    const root = new MemoryDirectory('kart');
    await root.put('src/a.ts', 'a');
    await root.put('src/b.ts', 'b');

    const sb = fakeSandbox({ 'src/a.ts': 'a2' });
    const { mirror } = mirrorOver(root, sb, () => false, {
      'src/a.ts': { size: 1, lastModified: 0 },
      'src/b.ts': { size: 1, lastModified: 0 },
    });

    mirror.accept([event('change', 'src/a.ts'), event('remove_file', 'src/b.ts'), event('remove_dir', 'src')]);
    await mirror.drain();

    expect(root.paths()).toEqual([]);
    expect(mirror.index).toEqual({});
  });

  it('never touches ignored paths', async () => {
    const root = new MemoryDirectory('kart');
    const sb = fakeSandbox({ 'node_modules/x/index.js': 'x', [PROJECT_MARKER_FILE]: 'nope', 'dist/index.html': 'x' });
    const { mirror } = mirrorOver(root, sb);

    mirror.accept([
      event('add_file', 'node_modules/x/index.js'),
      event('add_file', PROJECT_MARKER_FILE),
      event('add_file', 'dist/index.html'),
    ]);
    await mirror.drain();

    expect(root.paths()).toEqual([]);
  });

  it('compares before writing for events queued during a RESTORE — a disk-sourced mount does not rewrite itself', async () => {
    const root = new MemoryDirectory('kart');
    const same = await root.put('src/same.ts', 'same');
    const differs = await root.put('src/differs.ts', 'old');
    const sb = fakeSandbox({ 'src/same.ts': 'same', 'src/differs.ts': 'new' });
    const { mirror } = mirrorOver(root, sb, () => true);

    mirror.accept([event('change', 'src/same.ts'), event('change', 'src/differs.ts')]);
    await mirror.drain();

    expect(same.writes).toBe(1); // the `put`, nothing since
    expect(differs.writes).toBe(2);
    expect(root.text('src/differs.ts')).toBe('new');
    expect(mirror.index['src/same.ts']).toMatchObject({ size: 4 });
  });

  it('writes WITHOUT comparing when not restoring and the stamp is the one it recorded (control)', async () => {
    const root = new MemoryDirectory('kart');
    const sb = fakeSandbox({ 'src/a.ts': 'v1' });
    const { mirror } = mirrorOver(root, sb);

    mirror.accept([event('add_file', 'src/a.ts')]);
    await mirror.drain();

    const file = root.file('src/a.ts')!;
    expect(file.writes).toBe(1);

    // Same bytes, ordinary event, stamp unchanged → a plain write (cheap; no read of the disk).
    mirror.accept([event('change', 'src/a.ts')]);
    await mirror.drain();
    expect(file.writes).toBe(2);
  });

  it('reports a failing write LOUDLY, retries it a bounded number of times, and keeps mirroring the rest', async () => {
    const root = new MemoryDirectory('kart');
    const sb = fakeSandbox({ 'src/bad.ts': 'bad', 'src/good.ts': 'good' });
    const { mirror, statuses } = mirrorOver(root, sb);

    // A file the folder refuses: a directory already sits where the file should go.
    await root.getDirectoryHandle('src', { create: true });
    await (await root.getDirectoryHandle('src')).getDirectoryHandle('bad.ts', { create: true });

    mirror.accept([event('add_file', 'src/bad.ts'), event('add_file', 'src/good.ts')]);
    await mirror.drain();

    expect(root.text('src/good.ts')).toBe('good');
    expect(statuses.some((s) => s.error?.startsWith('src/bad.ts:'))).toBe(true);

    // Second attempt (maxAttempts 2) also fails; then it is dropped, not retried forever.
    await mirror.drain();
    expect(mirror.pending).toBe(0);
  });

  it('syncAll writes every listed file and skips ignored ones', async () => {
    const root = new MemoryDirectory('kart');
    const sb = fakeSandbox({ 'package.json': '{}', 'src/main.ts': 'm', 'node_modules/x.js': 'x' });
    const { mirror } = mirrorOver(root, sb);

    await mirror.syncAll(['package.json', 'src/main.ts', 'node_modules/x.js']);

    expect(root.paths()).toEqual(['package.json', 'src/main.ts']);
  });

  it('stop() drops the queue and unsubscribes', async () => {
    const root = new MemoryDirectory('kart');
    const sb = fakeSandbox({ 'a.ts': 'a' });
    const { mirror } = mirrorOver(root, sb);
    mirror.start();

    mirror.stop();
    sb.fire([event('add_file', 'a.ts')]);
    await mirror.drain();

    expect(root.paths()).toEqual([]);
  });
});

/* ------------------------------------------------------------------- external edits */

describe('diffDiskIndex', () => {
  it('reports new, changed-by-size, changed-by-mtime and removed files', () => {
    const diff = diffDiskIndex(
      {
        same: { size: 1, lastModified: 1 },
        bigger: { size: 1, lastModified: 1 },
        newer: { size: 1, lastModified: 1 },
        gone: { size: 1, lastModified: 1 },
      },
      {
        same: { size: 1, lastModified: 1 },
        bigger: { size: 2, lastModified: 1 },
        newer: { size: 1, lastModified: 2 },
        added: { size: 3, lastModified: 3 },
      },
    );

    expect(diff.changed.sort()).toEqual(['added', 'bigger', 'newer']);
    expect(diff.removed).toEqual(['gone']);
  });
});

describe('applyExternalChanges — VS Code edits flow into the sandbox and do not bounce back out', () => {
  it('writes changed files into the sandbox, removes deleted ones, and the mirror then skips the echo', async () => {
    const root = new MemoryDirectory('kart');
    const sb = fakeSandbox({ 'src/main.ts': 'v1', 'src/old.ts': 'old' });
    const { mirror } = mirrorOver(root, sb);

    // Establish the disk as the mirror knows it.
    await mirror.syncAll(['src/main.ts', 'src/old.ts']);

    const mainOnDisk = root.file('src/main.ts')!;
    const writesBefore = mainOnDisk.writes;

    // Someone edits main.ts in VS Code and deletes old.ts.
    await root.put('src/main.ts', 'v2 from vscode');
    await (await root.getDirectoryHandle('src')).removeEntry('old.ts');

    const diff = await applyExternalChanges({ folder: folderIn(root), mirror, sandbox: sb.sandbox });

    expect(diff.changed).toEqual(['src/main.ts']);
    expect(diff.removed).toEqual(['src/old.ts']);
    expect(new TextDecoder().decode(sb.store.get('src/main.ts'))).toBe('v2 from vscode');
    expect(sb.removed).toEqual(['src/old.ts']);

    // The sandbox write comes back through the watcher: the mirror must compare and NOT rewrite.
    const disk = root.file('src/main.ts')!;
    const writesAfterEdit = disk.writes;
    mirror.accept([event('change', 'src/main.ts')]);
    await mirror.drain();

    expect(disk.writes).toBe(writesAfterEdit);
    expect(disk.writes).toBeGreaterThan(writesBefore); // control: the external edit itself did write
  });
});

/* ------------------------------------------------------------------------ account scoping */

describe('ownerKeyFor — a projects folder belongs to an account (§4.5.3a)', () => {
  it('is the signed-in user (the local developer included), and nothing for an anonymous or unknown viewer', () => {
    expect(ownerKeyFor({ status: 'user', id: 'u-1' })).toBe('u-1');
    expect(ownerKeyFor({ status: 'user', id: 'local' })).toBe('local');
    expect(ownerKeyFor({ status: 'nobody' })).toBeUndefined();
    expect(ownerKeyFor({ status: 'unknown' })).toBeUndefined();
  });
});
