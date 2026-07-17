/**
 * Save — the click that makes a project permanent (SPEC §4.5.4b).
 *
 * Two things are tested here and they carry different weight.
 *
 * `deriveRepoName` is cosmetic-looking and is not: it names a real, permanent thing in someone else's
 * account, from text they wrote as a game title. A name the provider rejects is a Save that fails for
 * a reason the user cannot see or fix.
 *
 * `saveToNewRepo` is the destructive one. It creates a repo from a DERIVED name — the user never typed
 * it and never approved it — so every collision is a chance to claim a repository that already means
 * something to them.
 */
import { describe, expect, it } from 'vitest';
import { createFakeGitHub } from './fake-servers';
import { GitHubProvider, toGitHubError } from './github';
import { FALLBACK_REPO_NAME, candidateRepoName, deriveRepoName } from './repo-name';
import { saveToNewRepo } from './save';
import { bytesToBase64, type SerializedFileMap } from '~/lib/binary/binary-files';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const files = (): SerializedFileMap => ({
  '/home/project/src/game.ts': { type: 'file', content: 'export const speed = 10;\n', isBinary: false },
  '/home/project/public/logo.png': { type: 'file', content: bytesToBase64(PNG), isBinary: true },
});

function harness() {
  const fake = createFakeGitHub();

  return { ...fake, provider: new GitHubProvider('token', fake.octokit) };
}

/**
 * 🔴 THE BUG THAT BROKE EVERY FIRST SAVE, AND THE ONLY THING THAT FOUND IT WAS REAL GITHUB.
 *
 * `Save` CREATES the repo (§4.5.4b), so the next thing it does is ask a repository that is empty BY
 * CONSTRUCTION for its branch head. Real GitHub answers **409 "Git Repository is empty."** — not 404.
 * `getBranchHead` mapped only 404 to null, so it threw, and the save died. The user saw "Not saved".
 *
 * **The one path every new project must take had never worked against real github.com**, and the whole
 * suite was green — because `fake-servers.ts` returned 404 for any missing branch. The fake was wrong in
 * exactly the same direction as the code, so the tests agreed with the bug. Reverting the `github.ts`
 * fix against the CORRECTED fake turns this file red, which is the proof the tests were always right and
 * only the fake lied.
 *
 * These tests exist so the 409 is a named, deliberate behaviour rather than a line someone tidies away.
 */
describe('a brand-new repo is EMPTY, and GitHub says 409 — not 404', () => {
  it('treats the empty-repo 409 as "no branch yet" instead of throwing', async () => {
    const { provider, store } = harness();
    store.repos.add('testuser/fresh-repo');

    expect(store.commits.size, 'precondition: the repo has no commits — it was just created').toBe(0);

    await expect(
      provider.getBranchHead({ owner: 'testuser', repo: 'fresh-repo', branch: 'main' }),
      'a 409 here is "empty", and an empty repo genuinely has no branch',
    ).resolves.toBeNull();
  });

  /*
   * The other half of the distinction the fake used to collapse. Once a repo HAS commits, a missing
   * branch is an ordinary 404 — and that must still resolve to null, not throw.
   */
  it('still treats a missing branch on a NON-empty repo as "no branch yet"', async () => {
    const { provider, store } = harness();
    store.repos.add('testuser/has-commits');

    const tree = store.putTree([{ path: 'README.md', sha: store.putBlobUtf8('# hi\n') }]);
    store.commits.set('c1', { treeSha: tree, parents: [], message: 'init' });
    store.branches.set('main', 'c1');

    await expect(
      provider.getBranchHead({ owner: 'testuser', repo: 'has-commits', branch: 'nonexistent' }),
    ).resolves.toBeNull();
  });

  /**
   * ⚠️ THE FIX MUST NOT BECOME "409 MEANS NO BRANCH" EVERYWHERE.
   *
   * 409 is endpoint-specific. On a ref UPDATE it means the ref moved under us — a genuine conflict — and
   * if `toGitHubError` mapped 409 to `not-found` globally, `getBranchHead` would report "no branch" for a
   * branch that very much exists, and the push above it would force-create over commits it never read.
   * That is data loss on the only copy of someone's game (§4.5.4b).
   *
   * So the interpretation lives in `isEmptyRepository`, applied ONLY by `getBranchHead`; the shared error
   * mapper must keep a 409 as a plain, un-special error.
   */
  it('keeps 409 OUT of the shared error mapper — only the ref read may interpret it', () => {
    const mapped = toGitHubError({ status: 409, message: 'Reference cannot be updated' });

    expect(mapped.kind, 'a global 409 -> not-found would let a push force-create over real commits').not.toBe(
      'not-found',
    );
    expect(mapped.status).toBe(409);
  });
});

describe('deriveRepoName', () => {
  it.each([
    ['My Racing Game', 'my-racing-game'],
    ['My Racing Game', 'my-racing-game'],
    ['Kart  --  Chaos!!!', 'kart-chaos'],
    ['  Leading and trailing  ', 'leading-and-trailing'],
    ['Already-slugged', 'already-slugged'],
    ['UPPERCASE', 'uppercase'],
    ['Numbers 123 ok', 'numbers-123-ok'],
  ])('turns %j into %j', (input, expected) => {
    expect(deriveRepoName(input)).toBe(expected);
  });

  /**
   * Dots are dropped entirely rather than special-cased. It sidesteps GitHub's `.`/`..` rule and
   * GitLab's "may not end in .git or .atom" in one move, and no one misses a dot in a repo name.
   */
  it.each([
    ['v1.0 racer', 'v1-0-racer'],
    ['my.game.git', 'my-game-git'],
    ['feed.atom', 'feed-atom'],
    ['...', FALLBACK_REPO_NAME],
    ['..', FALLBACK_REPO_NAME],
  ])('never emits a dot: %j → %j', (input, expected) => {
    expect(deriveRepoName(input)).toBe(expected);
    expect(deriveRepoName(input)).not.toContain('.');
  });

  /**
   * Not exotic — a game titled purely in a non-Latin script, or with an emoji, slugifies to nothing.
   * That user must still be able to press Save.
   */
  it.each(['🏎️', 'レーシング', '', '   ', '---', '!!!'])('falls back rather than producing garbage for %j', (input) => {
    expect(deriveRepoName(input)).toBe(FALLBACK_REPO_NAME);
  });

  /**
   * A title that is PARTLY Latin keeps the part we can use rather than falling back — "3d" is a
   * perfectly good repo name derived from the user's own words, and `babylon-game` would be worse.
   */
  it('keeps whatever Latin remains instead of discarding a mixed-script title', () => {
    expect(deriveRepoName('3D レーシング')).toBe('3d');
    expect(deriveRepoName('Kart レーシング 2')).toBe('kart-2');
  });

  it('starts with a letter or digit, as GitLab requires', () => {
    expect(deriveRepoName('-leading-hyphen')).toBe('leading-hyphen');
    expect(deriveRepoName('_underscore start')).toBe('underscore-start');
  });

  /** A cut that lands mid-separator leaves a trailing hyphen — which GitLab rejects. */
  it('never ends in a hyphen, however unlucky the length', () => {
    const name = deriveRepoName(`${'a'.repeat(59)} tail`);

    expect(name.length).toBeLessThanOrEqual(60);
    expect(name.endsWith('-')).toBe(false);
  });

  it('caps the length', () => {
    expect(deriveRepoName('word '.repeat(50)).length).toBeLessThanOrEqual(60);
  });
});

describe('candidateRepoName', () => {
  it('numbers from 2 — there is no my-game-1', () => {
    expect(candidateRepoName('my-game', 0)).toBe('my-game');
    expect(candidateRepoName('my-game', 1)).toBe('my-game-2');
    expect(candidateRepoName('my-game', 2)).toBe('my-game-3');
  });

  it('keeps the suffix inside the cap rather than producing a name the provider rejects', () => {
    const long = 'a'.repeat(60);
    const name = candidateRepoName(long, 1);

    expect(name.length).toBeLessThanOrEqual(60);
    expect(name.endsWith('-2')).toBe(true);
  });
});

describe('saveToNewRepo', () => {
  it('creates a PRIVATE repo named after the project and pushes into it', async () => {
    const h = harness();
    const result = await saveToNewRepo({ provider: h.provider, projectName: 'My Racing Game', files: files() });

    expect(result).toMatchObject({
      provider: 'github',
      repo: 'testuser/my-racing-game',
      branch: 'main',
      created: true,
    });
    expect(result.commitSha).toBeTruthy();

    // Assert on the serialized body — a repo created public would expose every user's game.
    const create = h.requests.find((r) => r.method === 'POST' && /\/user\/repos$/.test(r.path));
    expect((create?.body as { private: boolean }).private).toBe(true);
  });

  it('actually lands the files, binaries included', async () => {
    const h = harness();
    await saveToNewRepo({ provider: h.provider, projectName: 'My Game', files: files() });

    // `filesAt` returns a Map — `Object.keys` on it is silently empty, which passes nothing.
    expect([...h.store.filesAt('main').keys()]).toEqual(expect.arrayContaining(['src/game.ts', 'public/logo.png']));
  });

  /**
   * 🔴 The whole point of this module.
   *
   * The user already has `my-game` — an unrelated repo, full of unrelated work. Save derived that name
   * from the title; they never chose it. Adopting would push this project onto their repo's head.
   */
  it('never claims a repo that already exists — it takes the next name', async () => {
    const h = harness();

    // Their existing, unrelated repository.
    await h.provider.ensureRepo({ name: 'my-game', private: true, adoptExisting: false });

    const result = await saveToNewRepo({ provider: h.provider, projectName: 'My Game', files: files() });

    expect(result.repo).toBe('testuser/my-game-2');
  });

  it('keeps walking past several collisions', async () => {
    const h = harness();
    await h.provider.ensureRepo({ name: 'my-game', private: true, adoptExisting: false });
    await h.provider.ensureRepo({ name: 'my-game-2', private: true, adoptExisting: false });
    await h.provider.ensureRepo({ name: 'my-game-3', private: true, adoptExisting: false });

    const result = await saveToNewRepo({ provider: h.provider, projectName: 'My Game', files: files() });

    expect(result.repo).toBe('testuser/my-game-4');
  });

  it('gives up with an actionable message rather than spinning forever', async () => {
    const h = harness();

    for (let i = 0; i < 10; i++) {
      await h.provider.ensureRepo({ name: candidateRepoName('my-game', i), private: true, adoptExisting: false });
    }

    await expect(saveToNewRepo({ provider: h.provider, projectName: 'My Game', files: files() })).rejects.toThrow(
      /Rename this project/i,
    );
  });

  /**
   * A name collision is the ONLY thing that may be retried with a different name. Everything else is a
   * real failure — and treating, say, a permission error as "try another name" would burn ten
   * round-trips and then report the wrong cause.
   */
  it('does not mistake a real failure for a name collision', async () => {
    const h = harness();
    h.failWith({ match: '/user/repos', status: 401 });

    await expect(saveToNewRepo({ provider: h.provider, projectName: 'My Game', files: files() })).rejects.toMatchObject(
      {
        kind: 'auth',
      },
    );

    // One attempt, not ten.
    expect(h.requests.filter((r) => r.method === 'POST' && /\/user\/repos$/.test(r.path))).toHaveLength(1);
  });

  /** §4.5.4b: a failed save is LOUD. A rate limit is retryable and must surface as such, not as done. */
  it('surfaces a provider failure rather than reporting a save that did not happen', async () => {
    const h = harness();
    h.failWith({ match: '/git/blobs', status: 503 });

    await expect(saveToNewRepo({ provider: h.provider, projectName: 'My Game', files: files() })).rejects.toMatchObject(
      {
        kind: 'unavailable',
        retryable: true,
      },
    );
  });

  it('falls back to a usable name for a title that slugifies to nothing', async () => {
    const h = harness();
    const result = await saveToNewRepo({ provider: h.provider, projectName: '🏎️', files: files() });

    expect(result.repo).toBe(`testuser/${FALLBACK_REPO_NAME}`);
  });
});
