/**
 * The GitHub `GitProvider` (SPEC §4.5.4b, §4.13).
 *
 * The §4.13 Git Data API machinery (trees/commits/refs via Octokit) refactored behind the seam. **No
 * git binary anywhere, and WebContainers never run git** (§4.13): the whole exchange is REST.
 * All decisions live in the shared pure core (`sync-logic.ts`); this file is I/O and error mapping.
 *
 * Three things changed on the way in, each because §4.5.4b makes this the SAVE path rather than an
 * optional bridge:
 *   - `ensureRepo` exists at all. §4.13 only ever stored a pointer to a repo the user had already
 *     created by hand, which is fine for a developer bridge and impossible for "click Save".
 *   - Blob uploads go through `runBounded`, not `Promise.all` (see `bounded-queue.ts`).
 *   - `fetchTree` decodes instead of guessing, and REFUSES a truncated tree (see below).
 *
 * Availability: ALL users, never gated (§4.13). Sync operations involve no LLM and cost no credits.
 */
import { Octokit } from '@octokit/rest';
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import { buildCommitMessage, detectPushDivergence, mapToTreeBlobs } from './sync-logic';
import {
  GitProviderError,
  firstLine,
  namesAnExistingBranch,
  parseCursor,
  TOO_MANY_BRANCHES,
  type BranchSummary,
  type EnsureRepoInput,
  type EnsureRepoResult,
  type FastForwardPushInput,
  type FetchTreeResult,
  type GitProvider,
  type ListCommitsOptions,
  type ListCommitsResult,
  type PushResult,
  type RepoRef,
} from './provider';
import { classifyFetchedBlob } from './fetch-decode';
import { runBounded, withRetry } from './bounded-queue';
import { GITHUB_API_VERSION, GITHUB_API_VERSION_HEADER } from '~/lib/.server/github-api-version';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('git.github');

interface HttpishError {
  status?: number;
  message?: string;
  response?: { headers?: Record<string, string | undefined> };
}

/**
 * Map an Octokit error onto the typed seam error.
 *
 * GitHub signals a rate limit as a **403**, not a 429, and distinguishes it from a genuine permission
 * denial only by headers (`x-ratelimit-remaining: 0`) or the message text ("secondary rate limit").
 * Getting this wrong in either direction is costly: read a rate limit as `forbidden` and the save dies
 * loudly when it should have waited; read a permission denial as `rate-limit` and we retry four times
 * against a door that will never open, then report the wrong cause.
 */
export function toGitHubError(error: unknown): GitProviderError {
  if (error instanceof GitProviderError) {
    return error;
  }

  const err = error as HttpishError;
  const status = err?.status;
  const message = err?.message ?? 'GitHub request failed.';
  const headers = err?.response?.headers ?? {};
  const remaining = headers['x-ratelimit-remaining'];
  const retryAfterHeader = headers['retry-after'];
  const looksRateLimited =
    remaining === '0' || /secondary rate limit|abuse detection|rate limit/i.test(message) || Boolean(retryAfterHeader);

  if (status === 401) {
    return new GitProviderError({
      kind: 'auth',
      message: 'Your GitHub connection has expired. Reconnect GitHub to keep saving.',
      status,
      cause: error,
    });
  }

  if (status === 403 && looksRateLimited) {
    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;

    return new GitProviderError({
      kind: 'rate-limit',
      message: 'GitHub is rate limiting this save. Retrying shortly.',
      retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
      status,
      cause: error,
    });
  }

  if (status === 429) {
    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;

    return new GitProviderError({
      kind: 'rate-limit',
      message: 'GitHub is rate limiting this save. Retrying shortly.',
      retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
      status,
      cause: error,
    });
  }

  if (status === 403) {
    return new GitProviderError({
      kind: 'forbidden',
      message: 'GitHub refused this action. Check that your connection can write to this repository.',
      status,
      cause: error,
    });
  }

  if (status === 404) {
    return new GitProviderError({ kind: 'not-found', message, status, cause: error });
  }

  if (status && status >= 500) {
    return new GitProviderError({ kind: 'unavailable', message: 'GitHub is unavailable.', status, cause: error });
  }

  if (status && status >= 400) {
    return new GitProviderError({ kind: 'invalid', message, status, cause: error });
  }

  // No status at all = transport failure (DNS, socket, abort). Retryable.
  return new GitProviderError({ kind: 'unavailable', message, cause: error });
}

/**
 * Is this the 409 GitHub returns from a REF READ against a repository with no commits?
 *
 * ⚠️ **Deliberately NOT folded into `toGitHubError`, and deliberately NOT matched on the message.**
 *
 * Not in `toGitHubError`, because 409 is endpoint-specific: on a ref READ it means "the repo is empty";
 * on a ref UPDATE it means the ref moved under us — a genuine conflict, and treating THAT as "no such
 * branch" would let a push force-create over commits it never saw. The meaning belongs to the caller
 * that knows which endpoint it asked, so only `getBranchHead` may use this.
 *
 * Not on the message ("Git Repository is empty."), because GitHub's prose is not an API contract, and
 * the failure modes are wildly asymmetric: a message check that stops matching after a GitHub copy edit
 * silently restores a bug that breaks EVERY first save, reported to the user only as "Not saved". A
 * status check that is too broad can only mis-handle a 409 that this read endpoint does not return.
 * Prefer the failure that cannot hide.
 */
export function isEmptyRepository(error: unknown): boolean {
  return error instanceof GitProviderError && error.status === 409;
}

/**
 * An Octokit that pins the REST API version on every call it makes (`github-api-version.ts`).
 *
 * 🔴 A request HOOK, not a constructor option. `@octokit/core` builds its default headers from a fixed
 * list (`userAgent`, `timeZone`, `previews`) and **silently ignores an arbitrary `headers` option** —
 * so `new Octokit({ headers: { 'x-github-api-version': … } })` type-checks, reads as correct in review,
 * and sends nothing. The hook is the same seam `auth` wraps, so it covers every `octokit.*` method,
 * including any this file starts calling later.
 *
 * Spreading rather than replacing `options.headers` is load-bearing: Octokit has already put `accept`,
 * `user-agent` and the credential there, and clobbering the bag would 401 every request.
 */
function pinnedOctokit(token: string): Octokit {
  const octokit = new Octokit({ auth: token });

  octokit.hook.before('request', (options) => {
    options.headers = { ...options.headers, [GITHUB_API_VERSION_HEADER]: GITHUB_API_VERSION };
  });

  return octokit;
}

async function mapErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toGitHubError(error);
  }
}

/**
 * Page size for branch listing. GitHub's maximum, so the common repository is one request.
 *
 * `MAX_BRANCH_PAGES` is a hard stop, not a policy: a repository with more than this many branches is
 * pathological, and the alternative to a bound is an unbounded loop driven by a remote server —
 * `_listTree`'s `maxPages` for the same reason.
 */
const BRANCH_PAGE_SIZE = 100;
const MAX_BRANCH_PAGES = 20;

export class GitHubProvider implements GitProvider {
  readonly id = 'github' as const;

  private readonly _octokit: Octokit;

  /**
   * `octokit` is a TEST SEAM — production always takes the `pinnedOctokit` branch (`resolve.ts` is the
   * only producer, and it passes a token alone). The injected double is a hand-rolled partial that
   * models GitHub's *behaviour*, not Octokit's internals, so it carries no `hook`; the version pin is
   * proven against the REAL client in `github-api-version.spec.ts` instead of being faked here.
   */
  constructor(token: string, octokit?: Octokit) {
    this._octokit = octokit ?? pinnedOctokit(token);
  }

  async getCurrentUser(): Promise<{ login: string }> {
    const { data } = await mapErrors(() => this._octokit.users.getAuthenticated());
    return { login: data.login };
  }

  /**
   * Create the repo in the user's account, or adopt theirs if the name is taken.
   *
   * "Adopt" is scoped hard: only a repo the AUTHENTICATED USER owns. A 422 from GitHub means the name
   * exists under this account, so we re-read it and link. Any other owner is a `forbidden` — silently
   * linking a project to a repo the user does not own would make every later save fail with a
   * permission error nobody could explain.
   *
   * 🔴 **`auto_init` MUST BE TRUE: GITHUB'S GIT DATA API DOES NOT WORK ON AN EMPTY REPOSITORY** (found by
   * pushing to real github.com, 2026-07-17). This shipped `false` — the tidier-looking choice, since we
   * are about to push the real files and want no stray README — and it broke **every first save**, which
   * is the only path a new project can take (§4.5.4b). An empty repo answers 409 to the whole API:
   *
   *   GET  /git/ref/heads/{branch}  -> 409 "Git Repository is empty."
   *   POST /git/blobs               -> 409   <- and this one is the real wall
   *
   * The ref read can be interpreted away (`isEmptyRepository`), but blobs/trees/commits cannot: there is
   * no way to write the first commit through the Git Data API at all. The repo needs one commit to exist
   * before that API will speak to it, and `auto_init: true` is GitHub's own supported way to get one.
   *
   * The stray README does not survive: `fastForwardPush` builds its tree with **no `base_tree`**, so the
   * first save replaces the tree wholesale and the README is gone in that commit. And it is a true
   * fast-forward, not a clobber — `detectPushDivergence` returns `first-push` when the project has no
   * `lastSyncedCommitSha`, and the commit's parent IS the auto-init head, so `updateRef` runs with
   * `force: false` and GitHub accepts it. The cost is one extra commit in the user's history.
   *
   * ⚠️ Do not "clean this up" back to `false`. It reads like a harmless tidy and it is a total outage of
   * Save, reported to the user as nothing more than "Not saved".
   */
  async ensureRepo(input: EnsureRepoInput): Promise<EnsureRepoResult> {
    const { login } = await this.getCurrentUser();

    try {
      const { data } = await mapErrors(() =>
        this._octokit.repos.createForAuthenticatedUser({
          name: input.name,
          private: input.private,
          description: input.description,
          auto_init: true,
        }),
      );

      logger.info(`Created repo ${data.full_name} (private=${input.private}).`);

      return { fullName: data.full_name, defaultBranch: data.default_branch ?? 'main', created: true };
    } catch (error) {
      const providerError = toGitHubError(error);

      // 422 = "name already exists on this account".
      if (providerError.status !== 422) {
        throw providerError;
      }

      /*
       * Adopting is a DESTRUCTIVE default and must be asked for (see `EnsureRepoInput.adoptExisting`).
       * A caller that derived this name rather than being handed it — Save — wants the next free name,
       * not someone's unrelated repository.
       */
      if (!input.adoptExisting) {
        throw new GitProviderError({
          kind: 'name-taken',
          message: `A repository named ${input.name} already exists on this account.`,
          status: 422,
          cause: error,
        });
      }

      const { data } = await mapErrors(() => this._octokit.repos.get({ owner: login, repo: input.name }));

      logger.info(`Adopted existing repo ${data.full_name}.`);

      return { fullName: data.full_name, defaultBranch: data.default_branch ?? 'main', created: false };
    }
  }

  /**
   * The branch's head sha, or `null` when the branch has no commits.
   *
   * 🔴 **AN EMPTY REPOSITORY ANSWERS 409, NOT 404 — AND THAT BROKE EVERY FIRST SAVE (found live
   * 2026-07-17).** `Save` CREATES the repo (§4.5.4b), so the very next thing it does is ask a repo that
   * is empty *by construction* for its branch head. GitHub replies:
   *
   *   GET /repos/{owner}/{repo}/git/ref/heads%2F{branch} -> 409 "Git Repository is empty."
   *
   * which `toGitHubError` mapped to `kind:'invalid'` (the `status >= 400` catch-all), so this threw and
   * the save failed with "Not saved". **The one path that every new project must take had never worked
   * against real GitHub.** Every test passed because our fake server returns 404 for a missing ref — a
   * reasonable guess that is simply not what GitHub does on an empty repo. CLAUDE.md predicted this exact
   * failure ("every test points at a fake server we wrote to match our own understanding of the API");
   * this is what it looks like.
   *
   * ⚠️ **The 409 is swallowed HERE and must never be swallowed in `toGitHubError`.** 409 is
   * endpoint-specific: on a ref UPDATE it means the ref moved under us (a real conflict), and mapping
   * that to "the branch does not exist" would let a push force-create over someone else's commits. The
   * only endpoint where 409 means "empty" is this read.
   *
   * ⚠️ And it returns `null` (branch empty), never `undefined` (could not ask) — collapsing those two
   * lets a flaky connection declare the browser authoritative and push over a repo it never read
   * (`mount-source.ts`). An empty repo genuinely HAS no branch, so `null` is the honest answer.
   */
  /**
   * The repository's default branch (see `GitProvider.getDefaultBranch`).
   *
   * `repos.get` is the right endpoint and not merely a convenient one: it answers on a repository with
   * **no commits at all**, where every Git Data API endpoint returns 409 (see `getBranchHead` above).
   * A freshly created empty repo therefore still reports the branch it WOULD use, which is exactly
   * what an import of somebody's just-initialised repo needs.
   */
  async getDefaultBranch(ref: Pick<RepoRef, 'owner' | 'repo'>): Promise<string | null> {
    try {
      const { data } = await mapErrors(() => this._octokit.repos.get({ owner: ref.owner, repo: ref.repo }));

      return data.default_branch ?? null;
    } catch (error) {
      if (error instanceof GitProviderError && error.kind === 'not-found') {
        return null;
      }

      throw error;
    }
  }

  async getBranchHead(ref: RepoRef): Promise<string | null> {
    try {
      const { data } = await mapErrors(() =>
        this._octokit.git.getRef({ owner: ref.owner, repo: ref.repo, ref: `heads/${ref.branch}` }),
      );

      return data.object.sha;
    } catch (error) {
      if (error instanceof GitProviderError && (error.kind === 'not-found' || isEmptyRepository(error))) {
        return null;
      }

      throw error;
    }
  }

  /**
   * The whole branch as a byte-faithful file map.
   *
   * **A truncated tree throws.** GitHub silently caps a recursive tree response and sets
   * `truncated: true`; the code this replaces never read that flag, so an over-large repo pulled a
   * PARTIAL file map that looked completely normal. Under §4.13 that corrupted a sync. Under §4.5.4b
   * this is the reload path — a partial map would mount a project missing arbitrary files and then
   * happily push that back as the new truth, destroying the rest. Refusing loudly is the only safe
   * behaviour (§4.5.4b names the repo-size cap as an owned risk).
   */
  async fetchTree(ref: RepoRef): Promise<FetchTreeResult | null> {
    const head = await this.getBranchHead(ref);

    if (!head) {
      return null;
    }

    const { data: commit } = await mapErrors(() =>
      this._octokit.git.getCommit({ owner: ref.owner, repo: ref.repo, commit_sha: head }),
    );

    const { data: tree } = await mapErrors(() =>
      this._octokit.git.getTree({ owner: ref.owner, repo: ref.repo, tree_sha: commit.tree.sha, recursive: 'true' }),
    );

    if (tree.truncated) {
      throw new GitProviderError({
        kind: 'invalid',
        message:
          'This repository is too large to load in one request. Open it locally with git — the platform supports repositories under the size cap only.',
      });
    }

    const blobs = tree.tree.filter(
      (entry): entry is typeof entry & { path: string; sha: string } =>
        entry.type === 'blob' && Boolean(entry.path) && Boolean(entry.sha),
    );

    const files: SerializedFileMap = {};

    const entries = await runBounded(blobs, async (entry) => {
      const { data: blob } = await mapErrors(() =>
        this._octokit.git.getBlob({ owner: ref.owner, repo: ref.repo, file_sha: entry.sha }),
      );

      return { path: entry.path, dirent: classifyFetchedBlob(entry.path, blob.content) };
    });

    for (const entry of entries) {
      files[entry.path] = entry.dirent;
    }

    logger.info(`Fetched ${entries.length} files from ${ref.owner}/${ref.repo}@${ref.branch} @ ${head}`);

    return { files, head };
  }

  /**
   * Every branch, paginated to the end (see `GitProvider.listBranches`).
   *
   * ⚠️ **The 409 is swallowed here for the same endpoint-specific reason `getBranchHead` documents.**
   * A repository with no commits has no branches, and Save creates exactly such a repository moments
   * before this is first called, so "empty" is an ordinary state and not a failure. `isEmptyRepository`
   * is deliberately the shared predicate rather than a second status check.
   *
   * The default branch costs one extra call and is worth it: `repos.listBranches` does not report
   * which branch is the default, and inferring it from the name `main` is precisely the guess
   * `getDefaultBranch`'s comment refuses. It is skipped entirely when there are no branches.
   */
  async listBranches(ref: Pick<RepoRef, 'owner' | 'repo'>): Promise<BranchSummary[]> {
    const raw: Array<{ name: string; commit: { sha: string }; protected?: boolean }> = [];

    /*
     * ⚠️ The default branch costs one extra call and cannot be inferred. `repos.listBranches` does not
     * report which branch is the default, and reading `main` as the answer is precisely the guess
     * `getDefaultBranch`'s comment refuses — a repository whose trunk is `master` or `develop` would
     * be reported as having no default at all. Skipped entirely when there are no branches.
     */
    const finish = async (branches: typeof raw): Promise<BranchSummary[]> => {
      if (branches.length === 0) {
        return [];
      }

      const defaultBranch = await this.getDefaultBranch(ref);

      return branches.map((branch) => ({
        name: branch.name,
        head: branch.commit.sha,
        isDefault: branch.name === defaultBranch,
        protected: branch.protected === true,
      }));
    };

    try {
      for (let page = 1; page <= MAX_BRANCH_PAGES; page++) {
        const { data } = await withRetry(() =>
          mapErrors(() =>
            this._octokit.repos.listBranches({
              owner: ref.owner,
              repo: ref.repo,
              per_page: BRANCH_PAGE_SIZE,
              page,
            }),
          ),
        );

        raw.push(...data);

        /* A short page is the last page — the only end signal that needs no extra request. */
        if (data.length < BRANCH_PAGE_SIZE) {
          return finish(raw);
        }
      }

      /*
       * 🔴 THE CAP REFUSES; IT DOES NOT TRUNCATE. Falling out of the loop and returning what we had
       * would hand back a silently partial branch list — the same class of bug as GitHub's unread
       * `truncated` flag that `_listTree` names, and it would diverge from the GitLab adapter, which
       * throws. A seam whose two implementations answer an identical condition differently is exactly
       * what the seam exists to absorb, and the silent half is always the one that gets shipped.
       */
      throw new GitProviderError({ kind: 'invalid', message: TOO_MANY_BRANCHES });
    } catch (error) {
      if (isEmptyRepository(error)) {
        return [];
      }

      throw error;
    }
  }

  /**
   * Create a branch at `fromSha` (see `GitProvider.createBranch`).
   *
   * `git.createRef` is the whole safety argument: unlike `updateRef` it has no `force` and CANNOT
   * move an existing ref — GitHub answers 422 "Reference already exists" instead. So the never-clobber
   * rule is enforced by the endpoint rather than by a flag somebody could pass differently later.
   */
  async createBranch(ref: Pick<RepoRef, 'owner' | 'repo'>, name: string, fromSha: string): Promise<{ head: string }> {
    try {
      await withRetry(() =>
        mapErrors(() =>
          this._octokit.git.createRef({
            owner: ref.owner,
            repo: ref.repo,
            ref: `refs/heads/${name}`,
            sha: fromSha,
          }),
        ),
      );
    } catch (error) {
      /*
       * ⚠️ 422 ALSO covers an invalid source sha ("Object does not exist"), so the status alone maps a
       * bad `fromSha` onto "that name is taken" — a refusal naming the wrong cause, which sends the
       * user to rename and hit the identical failure. See `namesAnExistingBranch` for why this one is
       * a message check where `isEmptyRepository` is deliberately not.
       */
      if (error instanceof GitProviderError && error.status === 422 && namesAnExistingBranch(error.message)) {
        throw new GitProviderError({
          kind: 'name-taken',
          message: `A branch named ${name} already exists.`,
          status: 422,
          cause: error,
        });
      }

      throw error;
    }

    return { head: fromSha };
  }

  /**
   * Delete a branch (see `GitProvider.deleteBranch`).
   *
   * ⚠️ **GitHub reports an absent ref as 422, not 404**, and both mean "there is nothing to delete",
   * so both resolve. Scoped to THIS endpoint deliberately — the same reasoning `isEmptyRepository`
   * spells out for 409: 422 on a ref DELETE is "no such ref", while 422 elsewhere (a create, a push)
   * is a real refusal, and swallowing it globally would hide a failed write.
   */
  async deleteBranch(ref: Pick<RepoRef, 'owner' | 'repo'>, name: string): Promise<void> {
    try {
      await withRetry(() =>
        mapErrors(() =>
          this._octokit.git.deleteRef({
            owner: ref.owner,
            repo: ref.repo,
            ref: `heads/${name}`,
          }),
        ),
      );
    } catch (error) {
      if (error instanceof GitProviderError && (error.status === 404 || error.status === 422)) {
        logger.info(`Branch ${name} was already absent from ${ref.owner}/${ref.repo} — nothing to delete.`);
        return;
      }

      throw error;
    }
  }

  /** A bounded page of history (see `GitProvider.listCommits`). The cursor is a page number. */
  async listCommits(ref: RepoRef, options: ListCommitsOptions): Promise<ListCommitsResult> {
    const page = parseCursor(options.cursor);

    let data: Array<{
      sha: string;
      commit: { message: string; author: { name?: string | null; date?: string | null } | null };
    }>;

    try {
      ({ data } = await withRetry(() =>
        mapErrors(() =>
          this._octokit.repos.listCommits({
            owner: ref.owner,
            repo: ref.repo,
            sha: ref.branch,
            per_page: options.limit,
            page,
          }),
        ),
      ));
    } catch (error) {
      /* An empty repository has no history. Same normalisation as `listBranches`, same reason. */
      if (isEmptyRepository(error)) {
        return { commits: [] };
      }

      throw error;
    }

    return {
      commits: data.map((entry) => ({
        sha: entry.sha,
        message: firstLine(entry.commit.message),
        author: entry.commit.author?.name ?? '',
        date: entry.commit.author?.date ?? '',
      })),

      /*
       * A FULL page means there may be more; a short one is definitively the end. Never an empty
       * string — the seam's own comment says an empty cursor reads as "there is more".
       */
      nextCursor: data.length === options.limit ? String(page + 1) : undefined,
    };
  }

  async fastForwardPush(input: FastForwardPushInput): Promise<PushResult> {
    const { ref, files } = input;
    const remoteHead = await this.getBranchHead(ref);
    const divergence = detectPushDivergence(remoteHead, input.lastSyncedCommitSha);

    if (divergence.kind === 'diverged') {
      logger.info(`Push refused for ${ref.owner}/${ref.repo}@${ref.branch}: remote moved (divergence).`);
      return { ok: false, divergence };
    }

    if (!remoteHead && input.createBranchIfMissing === false) {
      throw new GitProviderError({
        kind: 'not-found',
        message: `Branch "${ref.branch}" does not exist.`,
      });
    }

    const blobs = mapToTreeBlobs(files, (path) =>
      logger.warn(
        `Dropped "${path}" from the push: the map calls it a file, but it has children (see mapToTreeBlobs).`,
      ),
    );

    const tree = await runBounded(
      blobs,
      async (blob) => {
        const { data } = await mapErrors(() =>
          this._octokit.git.createBlob({
            owner: ref.owner,
            repo: ref.repo,
            content: blob.content,
            encoding: blob.encoding,
          }),
        );

        return { path: blob.path, mode: '100644' as const, type: 'blob' as const, sha: data.sha };
      },
      { onRetry: (attempt, error) => logger.warn(`Blob upload retry ${attempt}: ${error.message}`) },
    );

    /*
     * The terminal writes retry too, but only on a rate limit — see `withRetry`. Without this a 403
     * from the secondary limiter on the very last call dropped an otherwise-complete save.
     */
    const { data: createdTree } = await withRetry(() =>
      mapErrors(() => this._octokit.git.createTree({ owner: ref.owner, repo: ref.repo, tree })),
    );

    const { data: commit } = await withRetry(() =>
      mapErrors(() =>
        this._octokit.git.createCommit({
          owner: ref.owner,
          repo: ref.repo,
          message: buildCommitMessage(input.summary),
          tree: createdTree.sha,
          parents: remoteHead ? [remoteHead] : [],
        }),
      ),
    );

    if (remoteHead) {
      await withRetry(() =>
        mapErrors(() =>
          this._octokit.git.updateRef({
            owner: ref.owner,
            repo: ref.repo,
            ref: `heads/${ref.branch}`,
            sha: commit.sha,
            force: false, // fast-forward only — never clobber remote history (§4.13)
          }),
        ),
      );
    } else {
      await withRetry(() =>
        mapErrors(() =>
          this._octokit.git.createRef({
            owner: ref.owner,
            repo: ref.repo,
            ref: `refs/heads/${ref.branch}`,
            sha: commit.sha,
          }),
        ),
      );
    }

    logger.info(`Pushed ${blobs.length} files to ${ref.owner}/${ref.repo}@${ref.branch} → ${commit.sha}`);

    return { ok: true, commitSha: commit.sha };
  }
}
