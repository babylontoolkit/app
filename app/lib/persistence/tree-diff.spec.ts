/**
 * What am I about to publish? (§4.13a — Review changes.)
 *
 * The highest-value suite in the branch-client plan, and the reason is the failure MODE rather than
 * the feature: every defect this module can carry produces a **confident wrong answer** on a screen
 * built to make the user read carefully. Nothing throws. A user who is shown "you rewrote your entire
 * project" or "nothing changed" has no way to tell either from the truth.
 *
 * So the weighting here is deliberate. The pleasant tests (added/modified/deleted) are a handful; the
 * bulk of the file is the three traps `tree-diff.ts` names in its own header, each written so that
 * removing the guard makes a test fail rather than making the numbers slightly different:
 *
 *   1. Path shapes — the store keys `/home/project/src/main.ts`, a repo tree returns `src/main.ts`.
 *      Compared raw, NOTHING matches. `planRestore` records the same mistake **wiping** projects.
 *   2. Exclusions — `.env` and `node_modules` are never in the repository, so an honest set-difference
 *      reports them forever, on both sides.
 *   3. Binaries — `File.content` is ALWAYS empty when `isBinary`, so a content comparison cannot see a
 *      changed asset. The control for that one is spelled out at its `describe`.
 *
 * Every fixture is built from the REAL types (`File` / `SerializedDirent`) and every remote binary
 * from the REAL `bytesToBase64`, so a fixture cannot quietly encode an assumption the production
 * serializer does not share.
 */
import { describe, expect, it, vi } from 'vitest';
import { bytesToBase64, type SerializedDirent, type SerializedFileMap } from '~/lib/binary/binary-files';
import { compareTrees, DIFF_MAX_FILES, type TreeChange } from './tree-diff';
import type { File, FileMap } from '~/lib/stores/files';

/** WebContainer's workdir. `/project/workspace` (CodeSandbox) gets its own test below. */
const STORE = '/home/project';

function localText(content: string): File {
  return { type: 'file', content, isBinary: false, size: content.length };
}

/**
 * A binary as the STORE holds one: `isBinary` + `size`, and content ALWAYS empty (SPEC §1.3
 * principle 10). Written as a helper so no test can accidentally hand the local side real content and
 * make a `File.content` comparison look like it works.
 */
function localBinary(size: number): File {
  return { type: 'file', content: '', isBinary: true, size };
}

function remoteText(content: string): SerializedDirent {
  return { type: 'file', content, isBinary: false, size: content.length };
}

/** A binary as a repo tree returns one: base64 through the production encoder, plus the real size. */
function remoteBinary(bytes: Uint8Array): SerializedDirent {
  return { type: 'file', content: bytesToBase64(bytes), isBinary: true, size: bytes.length };
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/** Sorted paths, for asserting membership without asserting the whole row shape. */
function paths(changes: TreeChange[]): string[] {
  return changes.map((change) => change.path);
}

function statusOf(changes: TreeChange[], path: string): string | undefined {
  return changes.find((change) => change.path === path)?.status;
}

describe('the point: what changed', () => {
  it('classifies added, modified and deleted, and puts the sizes on the right sides', async () => {
    const local: FileMap = {
      [`${STORE}/src/new.ts`]: localText('brand new'),
      [`${STORE}/src/main.ts`]: localText('after the edit'),
      [`${STORE}/package.json`]: localText('{}'),
    };
    const remote: SerializedFileMap = {
      'src/main.ts': remoteText('before'),
      'src/gone.ts': remoteText('deleted by the user'),
      'package.json': remoteText('{}'),
    };

    const diff = await compareTrees(local, remote);

    expect(paths(diff.changes)).toEqual(['src/gone.ts', 'src/main.ts', 'src/new.ts']);

    // `to` only: it does not exist in the branch, so there is no `from` size to report.
    expect(diff.changes.find((c) => c.path === 'src/new.ts')).toEqual({
      path: 'src/new.ts',
      status: 'added',
      bytes: { to: 'brand new'.length },
      isBinary: false,
    });

    // Both sides, and they must not be swapped — `from` is the branch, `to` is the sandbox.
    expect(diff.changes.find((c) => c.path === 'src/main.ts')).toEqual({
      path: 'src/main.ts',
      status: 'modified',
      bytes: { from: 'before'.length, to: 'after the edit'.length },
      isBinary: false,
    });

    // `from` only: the sandbox has no such file, so there is no `to` size.
    expect(diff.changes.find((c) => c.path === 'src/gone.ts')).toEqual({
      path: 'src/gone.ts',
      status: 'deleted',
      bytes: { from: 'deleted by the user'.length },
      isBinary: false,
    });
  });

  it('says nothing about an unchanged file', async () => {
    const diff = await compareTrees(
      { [`${STORE}/package.json`]: localText('{ "name": "game" }') },
      { 'package.json': remoteText('{ "name": "game" }') },
    );

    expect(diff.changes).toEqual([]);
    expect(diff.truncated).toBeUndefined();
  });

  it('reports a whitespace-only text edit — text is compared verbatim, not trimmed', async () => {
    const diff = await compareTrees(
      { [`${STORE}/a.ts`]: localText('const a = 1;\n') },
      { 'a.ts': remoteText('const a = 1;') },
    );

    expect(statusOf(diff.changes, 'a.ts')).toBe('modified');
  });

  it('marks a change binary when EITHER side is binary, so the UI never offers to render a diff', async () => {
    const diff = await compareTrees(
      { [`${STORE}/logo.png`]: localBinary(4) },
      { 'logo.png': remoteText('this used to be a text file') },
    );

    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].isBinary).toBe(true);
  });

  it('reports an empty diff for two empty trees rather than inventing a row', async () => {
    await expect(compareTrees({}, {})).resolves.toEqual({ changes: [] });
  });
});

/**
 * 🔴 TRAP 1 — the load-bearing property of this whole module.
 *
 * A tree freshly restored from its branch has NOT changed, and the only way to say so is to normalise
 * both sides through `toRepoRelativePath`. Compared raw, the local `/home/project/src/main.ts` never
 * meets the remote `src/main.ts`: every local file reads as `added`, every remote file as `deleted`,
 * and the review dialog tells the user their commit replaces the entire project.
 *
 * `planRestore` documents the identical mistake, where it **wiped** projects. Here it only lies —
 * which is exactly why it would survive longer, and why this fixture is realistic (nested dirs, a
 * binary, both workdirs) rather than a two-file toy.
 *
 * Mutation to verify: make `collectLocal`/`collectRemote` key on the raw path. These tests must fail.
 */
describe('trap 1: a tree freshly restored from its branch has not changed', () => {
  const FAVICON = bytes(0, 1, 2, 3, 4, 5, 6, 7);

  function freshlyRestored(workdir: string) {
    const local: FileMap = {
      [`${workdir}/package.json`]: localText('{ "name": "kart-racer" }'),
      [`${workdir}/vite.config.ts`]: localText('export default {};'),
      [`${workdir}/src/main.ts`]: localText('import "./babylon/globals";'),
      [`${workdir}/src/pages/Home.tsx`]: localText('export default function Home() { return null; }'),
      [`${workdir}/src/scripts/KartMode.ts`]: localText('export class KartMode {}'),
      [`${workdir}/src/babylon/system/platform.tsx`]: localText('export const platform = 1;'),
      [`${workdir}/public/favicon.ico`]: localBinary(FAVICON.length),
    };

    const remote: SerializedFileMap = {
      'package.json': remoteText('{ "name": "kart-racer" }'),
      'vite.config.ts': remoteText('export default {};'),
      'src/main.ts': remoteText('import "./babylon/globals";'),
      'src/pages/Home.tsx': remoteText('export default function Home() { return null; }'),
      'src/scripts/KartMode.ts': remoteText('export class KartMode {}'),
      'src/babylon/system/platform.tsx': remoteText('export const platform = 1;'),
      'public/favicon.ico': remoteBinary(FAVICON),
    };

    return { local, remote };
  }

  it('yields ZERO changes for a WebContainer-keyed store against a repo-relative tree', async () => {
    const { local, remote } = freshlyRestored(STORE);

    const diff = await compareTrees(local, remote, { readLocalBytes: async () => FAVICON });

    expect(diff.changes).toEqual([]);
  });

  it('yields ZERO changes on the CodeSandbox workdir too — the root is a property of the PROVIDER', async () => {
    const { local, remote } = freshlyRestored('/project/workspace');

    const diff = await compareTrees(local, remote, { readLocalBytes: async () => FAVICON });

    expect(diff.changes).toEqual([]);
  });

  it('normalises the REMOTE side as well — a repo written by the nested-path era round-trips clean', async () => {
    /*
     * `toRepoRelativePath`'s own history: a `home/project`-only regex once pushed a whole project
     * nested under `project/workspace/`. Such a repo's tree comes back carrying the root, and a diff
     * that normalised only the local side would report every file added AND deleted.
     */
    const diff = await compareTrees(
      { [`${STORE}/src/main.ts`]: localText('same') },
      { '/project/workspace/src/main.ts': remoteText('same') },
    );

    expect(diff.changes).toEqual([]);
  });

  it('is not fooled by a bare leading slash on either side', async () => {
    const diff = await compareTrees(
      { '/src/main.ts': localText('same'), 'home/project/other.ts': localText('same') },
      { 'src/main.ts': remoteText('same'), 'other.ts': remoteText('same') },
    );

    expect(diff.changes).toEqual([]);
  });

  it('hands `readLocalBytes` the ORIGINAL store key, not the normalised one', async () => {
    /*
     * The reader is `FilesStore.readBinaryFile`, which keys on the sandbox-absolute path. Handing it
     * `public/logo.png` finds nothing, the read throws, and — by `digestOrNull`'s correct policy — the
     * file is reported `modified`. So this defect wears the costume of a working diff: an unchanged
     * binary shown as changed forever, with no error anywhere.
     */
    const readLocalBytes = vi.fn(async () => bytes(9, 9, 9));

    await compareTrees(
      { [`${STORE}/public/logo.png`]: localBinary(3) },
      { 'public/logo.png': remoteBinary(bytes(9, 9, 9)) },
      { readLocalBytes },
    );

    expect(readLocalBytes).toHaveBeenCalledWith(`${STORE}/public/logo.png`);
  });
});

/**
 * 🔴 TRAP 2 — a permanent false positive is worse than a missing row.
 *
 * `isSecretPath` keeps the whole `.env` family out of every push, and `MAP_EXCLUDED_DIRS` keeps
 * `node_modules`/`.git`/`.codesandbox`/`dist` out of the map. Neither is ever in the repository, so an
 * honest set-difference reports `.env` as `added` on every diff forever — and a row that is always
 * there and never actionable trains the user to skim past precisely the surface built to make them
 * read carefully.
 *
 * Both DIRECTIONS matter: a remote `.env` (a repo that predates the exclusion, or one the user
 * committed by hand) must not read as `deleted` either, because the suggested fix for that row is to
 * publish the file.
 *
 * Mutation to verify: make `isExcluded` return `false`. These tests must fail.
 */
describe('trap 2: files that are never in the repository are never in the list', () => {
  it('never shows a local secret as `added`', async () => {
    const local: FileMap = {
      [`${STORE}/.env`]: localText('ANTHROPIC_API_KEY=sk-ant-real'),
      [`${STORE}/.env.local`]: localText('LOCAL=1'),
      [`${STORE}/.env.production`]: localText('PROD=1'),
      [`${STORE}/.npmrc`]: localText('//registry.npmjs.org/:_authToken=real'),
      [`${STORE}/src/main.ts`]: localText('changed'),
    };

    const diff = await compareTrees(local, { 'src/main.ts': remoteText('before') });

    expect(paths(diff.changes)).toEqual(['src/main.ts']);
  });

  it('never shows a remote secret as `deleted` — the fix for that row would be to publish it', async () => {
    const diff = await compareTrees(
      { [`${STORE}/src/main.ts`]: localText('same') },
      {
        'src/main.ts': remoteText('same'),
        '.env': remoteText('LEAKED=1'),
        '.env.production': remoteText('LEAKED=1'),
        '.npmrc': remoteText('//registry.npmjs.org/:_authToken=leaked'),
      },
    );

    expect(diff.changes).toEqual([]);
  });

  it('never shows a map-excluded directory, on either side, at any depth', async () => {
    const local: FileMap = {
      [`${STORE}/node_modules/three/package.json`]: localText('{}'),
      [`${STORE}/src/node_modules/nested/index.js`]: localText('nested dep tree'),
      [`${STORE}/.git/HEAD`]: localText('ref: refs/heads/main'),
      [`${STORE}/dist/index.html`]: localText('<html>'),
      [`${STORE}/.codesandbox/tasks.json`]: localText('{}'),
      [`${STORE}/src/main.ts`]: localText('same'),
    };
    const remote: SerializedFileMap = {
      'node_modules/left-pad/index.js': remoteText('module.exports = 1;'),
      'dist/assets/app.js': remoteText('bundled'),
      '.git/config': remoteText('[core]'),
      'src/main.ts': remoteText('same'),
    };

    const diff = await compareTrees(local, remote);

    expect(diff.changes).toEqual([]);
  });

  /**
   * The control. Without it, "exclude the `.env` family" passes for a rule that drops every dotfile,
   * or every path containing the word `dist` — and `.env.example` is a file a project is SUPPOSED to
   * commit, so silently hiding it breaks the round-trip for anyone cloning the repo.
   */
  it('CONTROL: the exclusion is not over-broad — placeholders and lookalikes still appear', async () => {
    const local: FileMap = {
      [`${STORE}/.env.example`]: localText('API_KEY='),
      [`${STORE}/.env.sample`]: localText('API_KEY='),
      [`${STORE}/.env.template`]: localText('API_KEY='),
      [`${STORE}/.environment.md`]: localText('notes'),
      [`${STORE}/src/distance.ts`]: localText('export const d = 1;'),
      [`${STORE}/src/environment.ts`]: localText('export const e = 1;'),
    };

    const diff = await compareTrees(local, {});

    expect(paths(diff.changes)).toEqual([
      '.env.example',
      '.env.sample',
      '.env.template',
      '.environment.md',
      'src/distance.ts',
      'src/environment.ts',
    ]);
  });
});

/**
 * 🔴 TRAP 3 — the class most likely to have changed is the class a content comparison cannot see.
 *
 * `File.content` is ALWAYS the empty string when `isBinary` (SPEC §1.3 principle 10 — the map holds
 * `isBinary` + `size` only, and the bytes live in the sandbox FS). So for a binary the local side
 * carries no information at all beyond its length, and a comparison built on `content` is comparing
 * `''` against `''` for every asset in the project, on every diff.
 *
 * That is why the control below is written as a PAIR: an unchanged PNG and a changed PNG whose local
 * map entries are BYTE-IDENTICAL to each other — same `content: ''`, same `size`. Any implementation
 * that reached its verdict from `File.content` (or from `size` alone) is mathematically incapable of
 * telling those two fixtures apart, so a suite that distinguishes them cannot be passing by accident.
 *
 * Mutation to verify: make `sameBinary` return `local.size === remote.size`. The changed-PNG test
 * must fail.
 */
describe('trap 3: binaries are compared by size and a digest, never by `File.content`', () => {
  const ORIGINAL = bytes(0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4);

  /** Same LENGTH, different bytes — a re-generated asset that happened to land on the same size. */
  const REGENERATED = bytes(0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9);

  const localMap: FileMap = { [`${STORE}/public/logo.png`]: localBinary(ORIGINAL.length) };
  const remoteMap: SerializedFileMap = { 'public/logo.png': remoteBinary(ORIGINAL) };

  it('reports a same-size PNG whose BYTES changed as `modified`', async () => {
    const diff = await compareTrees(localMap, remoteMap, { readLocalBytes: async () => REGENERATED });

    expect(diff.changes).toEqual([
      {
        path: 'public/logo.png',
        status: 'modified',
        bytes: { from: ORIGINAL.length, to: ORIGINAL.length },
        isBinary: true,
      },
    ]);
  });

  it('CONTROL: the same fixture with the same bytes reports nothing — and the two local maps are identical', async () => {
    const diff = await compareTrees(localMap, remoteMap, { readLocalBytes: async () => ORIGINAL });

    expect(diff.changes).toEqual([]);

    /*
     * The half that makes the pair a proof rather than two tests. Both runs were handed the SAME
     * local map, whose only binary carries an empty `content` and a size equal to the remote's — so
     * neither `File.content` nor `size` can distinguish the changed run from this one. The verdict
     * came from the bytes or it came from nowhere.
     */
    const entry = localMap[`${STORE}/public/logo.png`] as File;
    expect(entry.isBinary).toBe(true);
    expect(entry.content).toBe('');
    expect(entry.size).toBe(ORIGINAL.length);
  });

  it('settles a different SIZE without reading a byte — the cheap answer is the whole point of size-first', async () => {
    const readLocalBytes = vi.fn(async () => bytes(1));

    const diff = await compareTrees(
      { [`${STORE}/a.png`]: localBinary(9999) },
      { 'a.png': remoteBinary(ORIGINAL) },
      {
        readLocalBytes,
      },
    );

    expect(statusOf(diff.changes, 'a.png')).toBe('modified');
    expect(readLocalBytes).not.toHaveBeenCalled();
  });

  it('reports `modified` when the local read THROWS — unknown is never a match', async () => {
    /*
     * `spec/fail-loud.md`'s asymmetry, applied to a review screen: reporting an unreadable file as
     * unchanged HIDES a real change from the one surface built to show it, while reporting it as
     * changed costs the user one extra row they can look at. A sandbox read fails transiently (a dead
     * connection, a file mid-write), so this is an ordinary state, not an exotic one.
     */
    const diff = await compareTrees(
      { [`${STORE}/public/logo.png`]: localBinary(ORIGINAL.length) },
      { 'public/logo.png': remoteBinary(ORIGINAL) },
      {
        readLocalBytes: async () => {
          throw new Error('sandbox connection lost');
        },
      },
    );

    expect(statusOf(diff.changes, 'public/logo.png')).toBe('modified');
  });

  it('reports `modified` when BOTH sides are unreadable — `null` is UNKNOWN, never a match', async () => {
    /*
     * The half of `digestOrNull`'s contract that a one-sided failure cannot pin. With the local read
     * throwing and the remote entry carrying no `content` at all (a provider tree that truncated a
     * large blob, or any malformed response), both digests are unknown — and a sentinel that COLLIDES
     * with itself (`''`, `'?'`, `-1`) makes the two unknowns compare EQUAL and reports the file as
     * unchanged. That is the silent direction: an unreadable asset vanishes from the review screen.
     *
     * Verified by mutation: replacing `digestOrNull`'s `null` with `''` passes every other test in
     * this describe and fails only this one.
     */
    const diff = await compareTrees(
      { [`${STORE}/public/logo.png`]: localBinary(ORIGINAL.length) },
      {
        'public/logo.png': {
          type: 'file',
          content: undefined as unknown as string,
          isBinary: true,
          size: ORIGINAL.length,
        },
      },
      {
        readLocalBytes: async () => {
          throw new Error('sandbox connection lost');
        },
      },
    );

    expect(statusOf(diff.changes, 'public/logo.png')).toBe('modified');
  });

  it('a throwing read does not reject the whole call, and the other files are still classified', async () => {
    const diff = await compareTrees(
      {
        [`${STORE}/public/logo.png`]: localBinary(ORIGINAL.length),
        [`${STORE}/src/main.ts`]: localText('edited'),
        [`${STORE}/README.md`]: localText('untouched'),
      },
      {
        'public/logo.png': remoteBinary(ORIGINAL),
        'src/main.ts': remoteText('before'),
        'README.md': remoteText('untouched'),
      },
      {
        readLocalBytes: async () => {
          throw new Error('sandbox connection lost');
        },
      },
    );

    expect(paths(diff.changes)).toEqual(['public/logo.png', 'src/main.ts']);
  });

  /**
   * Pinned so a future change is DELIBERATE. With no reader the bytes are genuinely unknown, and the
   * module chooses "unchanged" rather than inventing a `modified` row for every asset in the project.
   * That is the opposite of the throwing-read policy above on purpose: a caller that passed no reader
   * asked a cheaper question, while a caller that passed one and got an error was told something went
   * wrong. Anyone flipping this must flip it knowing both.
   */
  it('with NO reader supplied, same-size binaries are reported unchanged (documented behaviour)', async () => {
    const diff = await compareTrees(
      { [`${STORE}/public/logo.png`]: localBinary(ORIGINAL.length) },
      { 'public/logo.png': remoteBinary(REGENERATED) },
    );

    expect(diff.changes).toEqual([]);
  });

  it('still classifies added and deleted binaries with no reader — size-only is enough for those', async () => {
    const diff = await compareTrees(
      { [`${STORE}/public/new.png`]: localBinary(12) },
      { 'public/old.png': remoteBinary(ORIGINAL) },
    );

    expect(diff.changes).toEqual([
      { path: 'public/new.png', status: 'added', bytes: { to: 12 }, isBinary: true },
      { path: 'public/old.png', status: 'deleted', bytes: { from: ORIGINAL.length }, isBinary: true },
    ]);
  });
});

/**
 * A file that changed KIND is a change by definition, and neither comparison can be trusted across
 * that boundary. The text→binary direction happens to come out right by accident (a real string
 * against the sandbox's empty `''`); the binary→text direction does NOT, which is why the kind check
 * is explicit rather than emergent.
 */
describe('a file whose kind changed', () => {
  it('reports text → binary as modified', async () => {
    const diff = await compareTrees(
      { [`${STORE}/asset.dat`]: localBinary(3) },
      { 'asset.dat': remoteText('plain text') },
      { readLocalBytes: async () => bytes(1, 2, 3) },
    );

    expect(statusOf(diff.changes, 'asset.dat')).toBe('modified');
  });

  it('reports binary → text as modified, even when the sizes agree', async () => {
    /*
     * The direction that cannot come out right by accident: the local side is TEXT with real content,
     * the remote side is a binary whose `content` is base64. Sizes are equal, so a size-only or a
     * kind-blind comparison has nothing to go on.
     */
    const diff = await compareTrees(
      { [`${STORE}/asset.dat`]: localText('abc') },
      { 'asset.dat': remoteBinary(bytes(1, 2, 3)) },
      { readLocalBytes: async () => bytes(1, 2, 3) },
    );

    expect(statusOf(diff.changes, 'asset.dat')).toBe('modified');
  });
});

describe('things that are not files', () => {
  it('ignores folders on both sides', async () => {
    const diff = await compareTrees(
      { [`${STORE}/src`]: { type: 'folder' }, [`${STORE}/src/main.ts`]: localText('same') },
      { src: { type: 'folder' }, 'src/main.ts': remoteText('same'), public: { type: 'folder' } },
    );

    expect(diff.changes).toEqual([]);
  });

  it('ignores a hole in the map rather than reporting it', async () => {
    // `FileMap` is `Record<string, Dirent | undefined>` — a deleted entry leaves an `undefined` value.
    const diff = await compareTrees(
      { [`${STORE}/gone.ts`]: undefined, [`${STORE}/main.ts`]: localText('same') },
      { 'gone.ts': undefined, 'main.ts': remoteText('same') },
    );

    expect(diff.changes).toEqual([]);
  });

  it('drops a key that normalises to nothing — the workdir root itself is not a file', async () => {
    const diff = await compareTrees({ [STORE]: localText('impossible') }, {});

    expect(diff.changes).toEqual([]);
  });
});

/**
 * The list is SORTED before it is capped, so a truncated list is stable: the same tree always shows
 * the same rows, and re-opening the dialog does not shuffle them. `Object.entries` order on the
 * sandbox side is watcher-ARRIVAL order — the same reason `createFilesContext` sorts.
 *
 * Mutation to verify: remove the `changes.sort(...)`. The scrambled-insertion test must fail.
 */
describe('ordering', () => {
  it('returns changes in path order whatever order the map was built in', async () => {
    const local: FileMap = {};

    /*
     * Deliberately scrambled — this is what a watcher hands you, not an accident of the fixture.
     *
     * All lowercase here so this test isolates ORDERING from COLLATION; the case-sensitivity rule is
     * pinned separately in the test below, which is the one that owns it.
     */
    for (const path of ['src/zeta.ts', 'readme.md', 'src/alpha.ts', 'public/logo.svg', 'package.json']) {
      local[`${STORE}/${path}`] = localText(path);
    }

    const diff = await compareTrees(local, {});

    expect(paths(diff.changes)).toEqual([
      'package.json',
      'public/logo.svg',
      'readme.md',
      'src/alpha.ts',
      'src/zeta.ts',
    ]);
  });

  /**
   * 🔴 CODEPOINT ORDER, NOT COLLATION — and this is the test that owns that rule.
   *
   * `localeCompare` compares at primary strength, so it puts `package.json` BEFORE `README.md`;
   * codepoint order puts `README.md` first. Either is defensible as an aesthetic, and the choice
   * stops being aesthetic the moment the cap above keeps only the first N rows: a locale-dependent
   * order means two users looking at the same over-cap tree are shown DIFFERENT SUBSETS of it, and
   * a bug report from one of them cannot be reproduced by the other.
   *
   * Without this test the rule lives only in a comment, and a comment cannot fail — which is the
   * failure class this codebase has recorded four separate times.
   */
  it("orders by codepoint, so the capped subset does not depend on the reader's locale", async () => {
    const local: FileMap = {};

    for (const path of ['package.json', 'README.md', 'Makefile', 'src/main.ts']) {
      local[`${STORE}/${path}`] = localText(path);
    }

    const diff = await compareTrees(local, {});

    // Uppercase first. Under `localeCompare` this reads ['Makefile','package.json','README.md',...].
    expect(paths(diff.changes)).toEqual(['Makefile', 'README.md', 'package.json', 'src/main.ts']);
  });

  it('interleaves deletions into the same order rather than appending them', async () => {
    const diff = await compareTrees(
      { [`${STORE}/c.ts`]: localText('new'), [`${STORE}/a.ts`]: localText('new') },
      { 'b.ts': remoteText('gone'), 'd.ts': remoteText('gone') },
    );

    expect(paths(diff.changes)).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
  });
});

/**
 * Open Question 3, decided: capped, HONESTLY. Refusing to show a list is worse than a truncated one
 * that says it is truncated — but a cap with no report is worse than both, because a short list reads
 * as "this is everything" and the user commits believing it.
 *
 * Mutation to verify: return the slice without `truncated`. These tests must fail.
 */
describe('the cap reports the overflow rather than hiding it', () => {
  function manyAdded(count: number): FileMap {
    const local: FileMap = {};

    for (let i = 0; i < count; i += 1) {
      local[`${STORE}/src/file-${String(i).padStart(4, '0')}.ts`] = localText(`file ${i}`);
    }

    return local;
  }

  it('reports honest counts and returns exactly `shown` rows', async () => {
    const diff = await compareTrees(manyAdded(25), {}, { maxFiles: 10 });

    expect(diff.truncated).toEqual({ shown: 10, total: 25 });
    expect(diff.changes).toHaveLength(10);
    expect(diff.changes).toHaveLength(diff.truncated?.shown ?? -1);
  });

  it('keeps the FIRST rows of the sorted list, so the truncation is stable across re-opens', async () => {
    const diff = await compareTrees(manyAdded(25), {}, { maxFiles: 3 });

    expect(paths(diff.changes)).toEqual(['src/file-0000.ts', 'src/file-0001.ts', 'src/file-0002.ts']);
  });

  it('says nothing when the list fits — `truncated` present at all means the user is missing rows', async () => {
    const diff = await compareTrees(manyAdded(10), {}, { maxFiles: 10 });

    expect(diff.truncated).toBeUndefined();
    expect(diff.changes).toHaveLength(10);
  });

  it('does not truncate at exactly the cap (the boundary is `>`, not `>=`)', async () => {
    const diff = await compareTrees(manyAdded(4), {}, { maxFiles: 4 });

    expect(diff.truncated).toBeUndefined();

    const overBy = await compareTrees(manyAdded(5), {}, { maxFiles: 4 });
    expect(overBy.truncated).toEqual({ shown: 4, total: 5 });
  });

  it('uses DIFF_MAX_FILES when no override is given', async () => {
    /*
     * Asserted against the exported constant rather than a re-typed literal: a copied number pins this
     * file's memory of the cap, which is the same shape as the defect the cap exists to prevent.
     */
    const diff = await compareTrees(manyAdded(DIFF_MAX_FILES + 2), {});

    expect(diff.changes).toHaveLength(DIFF_MAX_FILES);
    expect(diff.truncated).toEqual({ shown: DIFF_MAX_FILES, total: DIFF_MAX_FILES + 2 });
  });
});
