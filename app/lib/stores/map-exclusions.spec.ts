/**
 * `MAP_EXCLUDED_DIRS` and its two spellings (T9).
 *
 * The file map is the SOURCE for every egress path — model context, file tree, ZIP export, working
 * copy, checkpoint, git push. A directory that reaches the map reaches all of them. `.codesandbox` is
 * the sandbox PROVIDER's own directory (task config + the project-identity sentinel), so it belongs
 * to none of those, and its presence is not merely noise: a repo restore plans every map path the
 * repo lacks for DELETION, and deleting `.codesandbox/tasks.json` off the VM stops the template's
 * port task from ever starting (MEASURED: the build times out waiting for the port).
 *
 * Two properties are pinned here, and both fail SILENTLY:
 *
 *   1. **The walk never lists nor enters it** — and never `readdir`s it, exactly like `node_modules`.
 *      A walk that entered it would work perfectly and just quietly poison every egress path.
 *   2. **The three spellings cannot drift.** The watcher glob list is hand-written on purpose (its
 *      doc comment says why: `**\/node_modules` must match at any depth, a root dotdir must not), so
 *      nothing in the type system relates it to the list it is a spelling of. This spec is that
 *      relation. Adding a fourth directory to `MAP_EXCLUDED_DIRS` and forgetting the glob list means
 *      the watcher keeps streaming it into the map while the re-scan prunes it — a map whose contents
 *      depend on which of the two last touched it.
 */
import { describe, expect, it } from 'vitest';
import { MAP_EXCLUDED_DIRS, MAP_EXCLUDE_GLOBS, isMapExcludedDir } from './files';
import { walkSandboxTree, type WalkFs } from './refresh-walk';

interface FakeTree {
  [dir: string]: Array<{ name: string; dir?: boolean }>;
}

/** A tree walker double that records every `readdir`/`readFile` it is asked for. */
function fakeFs(tree: FakeTree) {
  const readdirCalls: string[] = [];
  const readCalls: string[] = [];

  const fs: WalkFs = {
    async readdir(dirPath: string) {
      readdirCalls.push(dirPath);

      return (tree[dirPath] ?? []).map((entry) => ({
        name: entry.name,
        isDirectory: () => entry.dir === true,
        isFile: () => entry.dir !== true,
      }));
    },
    async readFile(relPath: string) {
      readCalls.push(relPath);

      return new TextEncoder().encode(`bytes:${relPath}`);
    },
  };

  return { fs, readdirCalls, readCalls };
}

describe('the walk prunes the provider’s own directory exactly like node_modules', () => {
  /*
   * The CONTROL matters as much as the assertion: an `exclude` predicate that answered `true` for
   * everything would satisfy every "is it absent?" check in this file and report a clean bill of
   * health on an empty project. `.codesandboxish/` is an ordinary user directory that must survive.
   */
  const tree: FakeTree = {
    '.': [
      { name: '.codesandbox', dir: true },
      { name: 'node_modules', dir: true },
      { name: '.git', dir: true },
      { name: '.codesandboxish', dir: true },
      { name: 'src', dir: true },
      { name: 'package.json' },
    ],
    '.codesandbox': [{ name: 'tasks.json' }, { name: 'btk-project.json' }],
    node_modules: [{ name: 'left-pad', dir: true }],
    '.git': [{ name: 'HEAD' }],
    '.codesandboxish': [{ name: 'note.md' }],
    src: [{ name: 'main.ts' }],
  };

  it('never lists .codesandbox, and never reads a byte out of it', async () => {
    const { fs, readCalls } = fakeFs(tree);

    const result = await walkSandboxTree(fs, { exclude: isMapExcludedDir });

    expect(result.folders).not.toContain('.codesandbox');
    expect(result.files.map((f) => f.relPath)).not.toContain('.codesandbox/tasks.json');

    // The identity sentinel is read through provider `fs` by the boot gate — never through the map.
    expect(readCalls).not.toContain('.codesandbox/btk-project.json');
  });

  it('never calls readdir for .codesandbox — pruned BEFORE the recursion, same as node_modules', async () => {
    const { fs, readdirCalls } = fakeFs(tree);

    await walkSandboxTree(fs, { exclude: isMapExcludedDir });

    /*
     * Listing it and then filtering the results would be an RTT per entry on a server sandbox for a
     * directory whose every path is discarded — and on a VM with a warm `node_modules` that is the
     * difference between a walk and a stall.
     */
    expect(readdirCalls).not.toContain('.codesandbox');
    expect(readdirCalls).not.toContain('node_modules');
    expect(readdirCalls).not.toContain('.git');

    // CONTROL: an ordinary directory IS entered, so the assertions above are not vacuous.
    expect(readdirCalls).toEqual(expect.arrayContaining(['.', 'src', '.codesandboxish']));
  });

  it('keeps every ordinary file — the exclusions are narrow, not a blanket', async () => {
    const { fs } = fakeFs(tree);

    const result = await walkSandboxTree(fs, { exclude: isMapExcludedDir });

    expect(result.files.map((f) => f.relPath).sort()).toEqual([
      '.codesandboxish/note.md',
      'package.json',
      'src/main.ts',
    ]);
    expect(result.folders.sort()).toEqual(['.codesandboxish', 'src']);
  });
});

describe('isMapExcludedDir matches NAMES, and only the listed ones', () => {
  it.each([...MAP_EXCLUDED_DIRS])('excludes %s', (name) => {
    expect(isMapExcludedDir(name)).toBe(true);
  });

  /*
   * The predicate is handed one path SEGMENT by the walk, never a path. A `startsWith`/`includes`
   * implementation would pass the assertions above and quietly swallow a user's `codesandbox-notes/`
   * or `src/.codesandbox-theme.ts` — files that exist only in their project, deleted from their
   * export with nothing thrown.
   */
  it.each(['.codesandboxish', 'codesandbox', '.codesandbox2', 'src/.codesandbox', 'my-node_modules', 'gitignore'])(
    'does NOT exclude %s',
    (name) => {
      expect(isMapExcludedDir(name)).toBe(false);
    },
  );
});

describe('the watcher glob list and the walk predicate cannot drift', () => {
  /*
   * `.git` and `.codesandbox` are root-relative names; `node_modules` needs `**\/` because a nested
   * dependency tree exists at any depth. So the glob for a name is one of exactly two shapes, and
   * both must resolve back to a name on the list.
   */
  const spellingsOf = (name: string) => [name, `**/${name}`];

  it.each([...MAP_EXCLUDED_DIRS])('%s has a watcher glob', (name) => {
    expect(MAP_EXCLUDE_GLOBS.some((glob) => spellingsOf(name).includes(glob))).toBe(true);
  });

  it.each(MAP_EXCLUDE_GLOBS)('the watcher glob %s names a directory the walk also prunes', (glob) => {
    /*
     * The reverse direction: a glob with no entry on the list is a watcher-only exclusion, i.e. the
     * same divergence from the other side — the watcher drops it, the re-scan puts it back.
     */
    const name = glob.replace(/^\*\*\//, '');

    expect(isMapExcludedDir(name)).toBe(true);
  });

  it('the two lists describe the same set, and .codesandbox is in it', () => {
    expect(MAP_EXCLUDE_GLOBS).toHaveLength(MAP_EXCLUDED_DIRS.length);
    expect([...MAP_EXCLUDED_DIRS]).toContain('.codesandbox');
    expect(MAP_EXCLUDE_GLOBS).toContain('.codesandbox');
  });

  /*
   * T17c: the build output is regenerated by any build and must never be tracked. Measured after a
   * publish: `dist/` entered the map (113 files vs 67) and rode into model context, checkpoints,
   * working copies, ZIP exports and the next publish's remix seed. The `it.each` blocks above cover
   * whatever IS on the list — only a membership pin fails when someone takes `dist` off it.
   */
  it('dist stays on the list — the parameterized tests cannot notice its removal', () => {
    expect([...MAP_EXCLUDED_DIRS]).toContain('dist');
    expect(MAP_EXCLUDE_GLOBS).toContain('dist');
  });
});
