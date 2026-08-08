/**
 * The file map has ONE key spelling, and every writer uses it (`_specs/cold-start-cost_plan.md` §2).
 *
 * 🔴 Why this file exists. The map is keyed sandbox-ABSOLUTE — the watcher keys on the event's own
 * absolute path, `refreshFiles` keys on `` `${WORK_DIR}/${relPath}` ``. `recordAgentWrite` was handed
 * `action.filePath`, which is what the MODEL emitted: project-relative, always, because that is the
 * artifact format. The parameter it arrived through is declared `absoluteFilePath`, and nothing
 * checked. So an artifact write did not OVERWRITE the watcher's entry, it created a SECOND one, and
 * every file the model wrote was in the map twice.
 *
 * Nothing threw. Measured on a real project's working copy: **14 duplicated files, 90,092 chars ≈
 * 22.5k tokens** — `Home.tsx`, `Home.css`, four `src/scripts/kart/*.ts`, the mode class, five
 * `src/chrome/*`, `SPEC.md`, `DESIGN.md` — i.e. exactly the set the model had written. Those bytes
 * rode in the per-turn game-code cache entry, re-sent at the 2× cache-WRITE rate on every turn for the
 * life of the project, and the duplication grows as the game does.
 *
 * The cost was the loud half. The quiet half is worse:
 *
 *   - the model is shown two copies of `Home.tsx` and can edit one while the other goes stale;
 *   - `getFile()`, `#modifiedFiles` and lock state all key ABSOLUTE, so the relative twin is a ghost
 *     none of them can see — which means an agent write to a LOCKED file read the lock as absent and
 *     silently dropped it;
 *   - `filesCount` counted the same file twice.
 *
 * ⚠️ The watcher fires ZERO times in the dedupe assertions, then exactly once, deliberately: the claim
 * is about two writers AGREEING on a key, so the test has to let both of them write. A test that only
 * ever exercised one writer is what let this ship — `#recordRestoredFiles` had already derived the
 * rebase rule for the restore door, and its own doc comment names this exact failure ("once the
 * watcher catches up every restored file is in the map twice"), yet the sibling it says it
 * "deliberately mirrors" never got it.
 */
/* eslint-disable @typescript-eslint/no-empty-function */
import { describe, expect, it, vi } from 'vitest';
import { SANDBOX_ROOTS, toSandboxStoreKey } from '~/lib/common/sandbox-paths';
import type { SandboxProvider } from '~/lib/sandbox';
import { WORK_DIR } from '~/utils/constants';
import { FilesStore } from './files';

/** A provider double whose watcher never fires on its own — every event here is deliberate. */
function newStore() {
  const provider = {
    workdir: WORK_DIR,
    watchPaths: vi.fn(() => () => {}),
    fs: {
      async readdir() {
        return [];
      },
      async readFile() {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      async writeFile() {},
      async mkdir() {},
      async rm() {},
    },
  } as unknown as SandboxProvider;

  return new FilesStore(Promise.resolve(provider));
}

/**
 * What the WATCHER would have written for `rel` — the canonical spelling, reproduced here from the
 * store's own rule (`#processEventBuffer` keys on the event path; `refreshFiles` on
 * `` `${WORK_DIR}/${relPath}` ``) rather than imported, so a change to that rule fails these tests
 * instead of moving them silently.
 */
const watcherKey = (rel: string) => `${WORK_DIR}/${rel}`;

/** The watcher's own write, as `#processEventBuffer` performs it. */
function deliverWatcherEvent(store: FilesStore, rel: string, content: string) {
  store.files.setKey(watcherKey(rel), { type: 'file', content, isBinary: false });
}

describe('toSandboxStoreKey', () => {
  it('rebases a project-relative path onto the workdir', () => {
    expect(toSandboxStoreKey('src/pages/Home.tsx', '/home/project')).toBe('/home/project/src/pages/Home.tsx');
  });

  it('leaves an already-absolute key unchanged — it is idempotent', () => {
    const key = toSandboxStoreKey('/home/project/src/pages/Home.tsx', '/home/project');

    expect(key).toBe('/home/project/src/pages/Home.tsx');
    expect(toSandboxStoreKey(key, '/home/project')).toBe(key);
  });

  it('rebases a FOREIGN provider root onto this workdir', () => {
    /*
     * A working copy written under WebContainer is restored into a CodeSandbox project. Recording the
     * raw key would file the entry under a root this sandbox does not have.
     */
    expect(toSandboxStoreKey('/home/project/src/main.ts', '/project/workspace')).toBe('/project/workspace/src/main.ts');
  });

  it('handles every root the platform ships', () => {
    for (const root of SANDBOX_ROOTS) {
      expect(toSandboxStoreKey(`${root}/src/main.ts`, root)).toBe(`${root}/src/main.ts`);
    }
  });
});

describe('recordAgentWrite keys the map the way the watcher does', () => {
  it('🔴 an artifact write then a watcher event for the SAME file leave ONE key', () => {
    const store = newStore();

    // The artifact runner passes `action.filePath` — project-relative, straight off the model.
    store.recordAgentWrite('src/pages/Home.tsx', 'const Home = 1;');

    // ...and a moment later the watcher confirms it, absolute.
    deliverWatcherEvent(store, 'src/pages/Home.tsx', 'const Home = 1;');

    const keys = Object.keys(store.files.get());

    expect(keys).toEqual([watcherKey('src/pages/Home.tsx')]);
    expect(keys).toHaveLength(1);
  });

  it('CONTROL — two genuinely different files still produce two keys', () => {
    const store = newStore();

    store.recordAgentWrite('src/pages/Home.tsx', 'a');
    store.recordAgentWrite('src/pages/About.tsx', 'b');

    /*
     * Without this the dedupe assertion above passes for a store that collapses EVERYTHING to one
     * entry — a test that cannot tell "correct" from "broken in the other direction".
     */
    expect(Object.keys(store.files.get()).sort()).toEqual(
      [watcherKey('src/pages/About.tsx'), watcherKey('src/pages/Home.tsx')].sort(),
    );
  });

  it('accepts an already-absolute path unchanged — callers disagree about the form', () => {
    const store = newStore();

    store.recordAgentWrite(watcherKey('src/main.ts'), 'x');
    store.recordAgentWrite('src/main.ts', 'y');

    expect(Object.keys(store.files.get())).toEqual([watcherKey('src/main.ts')]);
    expect(store.getFile(watcherKey('src/main.ts'))?.content).toBe('y');
  });

  it('is visible to getFile() — the relative twin used to be a ghost', () => {
    const store = newStore();

    store.recordAgentWrite('src/pages/Home.tsx', 'const Home = 1;');

    /*
     * `getFile` keys absolute. Before the rebase this returned undefined for a file the store had
     * just been told about, so every absolute-keyed reader (the editor, diffing, locks) missed it.
     */
    expect(store.getFile(watcherKey('src/pages/Home.tsx'))?.content).toBe('const Home = 1;');
  });

  it('carries an existing LOCK forward — an agent write is not an unlock', () => {
    const store = newStore();

    store.files.setKey(watcherKey('src/pages/Home.tsx'), {
      type: 'file',
      content: 'old',
      isBinary: false,
      isLocked: true,
    });

    store.recordAgentWrite('src/pages/Home.tsx', 'new');

    /*
     * The lock is read off the CURRENT entry at the write key. Keyed relative, that lookup found
     * nothing and the file came back unlocked — a silent unlock on every artifact write.
     */
    const entry = store.getFile(watcherKey('src/pages/Home.tsx'));

    expect(entry?.content).toBe('new');
    expect(entry?.isLocked).toBe(true);
  });

  it('counts a file once, however it is spelled', () => {
    const store = newStore();

    store.recordAgentWrite('src/pages/Home.tsx', 'a');
    store.recordAgentWrite(watcherKey('src/pages/Home.tsx'), 'b');
    deliverWatcherEvent(store, 'src/pages/Home.tsx', 'b');

    expect(store.filesCount).toBe(1);
  });
});

describe('a map that ALREADY holds both spellings heals on restore', () => {
  it('collapses a working copy carrying relative AND absolute keys for one file', async () => {
    const store = newStore();

    /*
     * Every project created before the fix has a persisted working copy in this shape, so the restore
     * door has to converge rather than faithfully reproduce the duplication. `#recordRestoredFiles`
     * already rebases; this pins that the two spellings land on ONE key rather than two.
     */
    await store.restoreFiles(
      {
        'src/pages/Home.tsx': { type: 'file', content: 'relative copy', isBinary: false },
        [watcherKey('src/pages/Home.tsx')]: { type: 'file', content: 'absolute copy', isBinary: false },
      },
      { protect: () => false },
    );

    expect(Object.keys(store.files.get())).toEqual([watcherKey('src/pages/Home.tsx')]);
    expect(store.filesCount).toBe(1);
  });
});
