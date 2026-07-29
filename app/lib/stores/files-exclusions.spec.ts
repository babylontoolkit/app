/**
 * The two CALL SITES that actually apply `MAP_EXCLUDED_DIRS` (T9).
 *
 * 🔴 This file exists because its absence was a real, demonstrated hole. The constants, the walk
 * predicate and the glob list were all pinned (`map-exclusions.spec.ts`) — and reverting BOTH call
 * sites in `files.ts` to their pre-T9 literals (`exclude: ['**\/node_modules', '.git']` on the
 * watcher, `(name) => name === 'node_modules' || name === '.git'` on the re-scan) left the whole
 * suite GREEN. The feature reverted silently, with every constant intact and every constant test
 * passing, because nothing asserted that the code READS the constants.
 *
 * A rule that cannot fail is a rule nobody is keeping. So both wirings are asserted here against the
 * real `FilesStore` over a provider double:
 *
 *   (a) the watcher's `exclude` IS `MAP_EXCLUDE_GLOBS` — the imported value, never a literal copy
 *       (a copy re-creates the drift the constant exists to remove: the spec would keep passing while
 *       the store watched a directory the walk prunes);
 *   (b) `refreshFiles` never `readdir`s `.codesandbox` — with a CONTROL proving an ordinary
 *       directory IS read, since "no readdir for X" is trivially true of a walk that does nothing.
 *
 * Everything the map holds is the SOURCE for every egress path (model context, file tree, ZIP,
 * working copy, checkpoint, git push), and a repo restore plans every map path the repo lacks for
 * DELETION — so `.codesandbox/tasks.json` reaching the map is not cosmetic, it is the template's dev
 * server never starting again.
 */
/*
 * The provider double's unused members are inert ON PURPOSE — the claim under test is what the STORE
 * does with a provider, so its collaborators do nothing deliberately rather than by omission (same
 * convention as `previews.spec.ts` and `codesandbox-provider.spec.ts`).
 */
/* eslint-disable @typescript-eslint/no-empty-function */
import { describe, expect, it, vi } from 'vitest';
import type { SandboxProvider, SandboxWatchOptions } from '~/lib/sandbox';
import { WORK_DIR } from '~/utils/constants';
import { FilesStore, MAP_EXCLUDE_GLOBS } from './files';

interface FakeTree {
  [dir: string]: Array<{ name: string; dir?: boolean }>;
}

/**
 * A provider whose `fs` walks a fake tree and whose `watchPaths` records what it was registered with.
 *
 * Deliberately minimal: `FilesStore` only reaches for `watchPaths` and `fs` on these two paths, and a
 * double that implemented more would invite assertions about collaborators instead of about the store.
 */
function providerDouble(tree: FakeTree) {
  const readdirCalls: string[] = [];
  const watchOptions: SandboxWatchOptions[] = [];

  const provider = {
    watchPaths: vi.fn((options: SandboxWatchOptions) => {
      watchOptions.push(options);

      return () => {};
    }),
    fs: {
      async readdir(dirPath: string) {
        readdirCalls.push(dirPath);

        return (tree[dirPath] ?? []).map((entry) => ({
          name: entry.name,
          isDirectory: () => entry.dir === true,
          isFile: () => entry.dir !== true,
        }));
      },
      async readFile(relPath: string) {
        return new TextEncoder().encode(`bytes:${relPath}`);
      },
    },
  } as unknown as SandboxProvider;

  return { provider, readdirCalls, watchOptions };
}

/** The shape a real project has on this provider: the provider's dir sits beside the user's code. */
const TREE: FakeTree = {
  '.': [
    { name: '.codesandbox', dir: true },
    { name: 'node_modules', dir: true },
    { name: 'src', dir: true },
    { name: 'package.json' },
  ],
  '.codesandbox': [{ name: 'tasks.json' }, { name: 'btk-project.json' }],
  node_modules: [{ name: 'left-pad', dir: true }],
  src: [{ name: 'main.ts' }],
};

describe('FilesStore hands the map exclusions to the watcher', () => {
  it('registers the watcher with MAP_EXCLUDE_GLOBS itself — not a literal that can drift', async () => {
    const { provider, watchOptions } = providerDouble(TREE);

    new FilesStore(Promise.resolve(provider));
    await vi.waitFor(() => expect(watchOptions).toHaveLength(1));

    /*
     * `toBe`, not `toEqual`: the store must read the shared constant. An equal-but-separate array
     * satisfies a deep-equality assertion forever while quietly re-introducing two lists that can
     * disagree — which is the exact failure `MAP_EXCLUDED_DIRS` was created to make impossible.
     */
    expect(watchOptions[0].exclude).toBe(MAP_EXCLUDE_GLOBS);

    // And the value really does carry the provider's directory (the T9 change itself).
    expect(watchOptions[0].exclude).toContain('.codesandbox');
  });

  it('still watches the project root and asks for content — the exclusions are the only change', async () => {
    const { provider, watchOptions } = providerDouble(TREE);

    new FilesStore(Promise.resolve(provider));
    await vi.waitFor(() => expect(watchOptions).toHaveLength(1));

    /*
     * CONTROL for the assertion above: if a future edit narrowed the watch itself (a smaller
     * `include`, `includeContent: false`), `.codesandbox` would also stop appearing — for the wrong
     * reason, and taking the user's files with it.
     */
    expect(watchOptions[0].include).toEqual([`${WORK_DIR}/**`]);
    expect(watchOptions[0].includeContent).toBe(true);
  });
});

describe('FilesStore.refreshFiles prunes the provider directory from the re-scan', () => {
  async function refresh() {
    const { provider, readdirCalls } = providerDouble(TREE);
    const store = new FilesStore(Promise.resolve(provider));

    await store.refreshFiles();

    return { store, readdirCalls };
  }

  it('never readdirs .codesandbox — and DOES readdir an ordinary directory', async () => {
    const { readdirCalls } = await refresh();

    expect(readdirCalls).not.toContain('.codesandbox');
    expect(readdirCalls).not.toContain('node_modules');

    // CONTROL: the walk really ran, so the two absences above are not the absence of a walk.
    expect(readdirCalls).toEqual(expect.arrayContaining(['.', 'src']));
  });

  it('leaves no .codesandbox entry in the map, and keeps every ordinary file', async () => {
    const { store } = await refresh();
    const paths = Object.keys(store.files.get());

    expect(paths.some((p) => p.includes('.codesandbox'))).toBe(false);
    expect(paths).toEqual(expect.arrayContaining([`${WORK_DIR}/src`, `${WORK_DIR}/src/main.ts`]));

    /*
     * The map is what every egress path serializes. A `.codesandbox/tasks.json` here rides into the
     * model's context, the ZIP, the working copy and the user's git push — and a later repo restore,
     * finding no such path in the repo, plans it for deletion off the VM.
     */
    expect(paths).toContain(`${WORK_DIR}/package.json`);
  });
});
