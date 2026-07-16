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
  type EnsureRepoInput,
  type EnsureRepoResult,
  type FastForwardPushInput,
  type FetchTreeResult,
  type GitProvider,
  type PushResult,
  type RepoRef,
} from './provider';
import { classifyFetchedBlob } from './fetch-decode';
import { runBounded, withRetry } from './bounded-queue';
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

async function mapErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toGitHubError(error);
  }
}

export class GitHubProvider implements GitProvider {
  readonly id = 'github' as const;

  private readonly _octokit: Octokit;

  constructor(token: string, octokit?: Octokit) {
    this._octokit = octokit ?? new Octokit({ auth: token });
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
   */
  async ensureRepo(input: EnsureRepoInput): Promise<EnsureRepoResult> {
    const { login } = await this.getCurrentUser();

    try {
      const { data } = await mapErrors(() =>
        this._octokit.repos.createForAuthenticatedUser({
          name: input.name,
          private: input.private,
          description: input.description,
          auto_init: false,
        }),
      );

      logger.info(`Created repo ${data.full_name} (private=${input.private}).`);

      return { fullName: data.full_name, defaultBranch: data.default_branch ?? 'main', created: true };
    } catch (error) {
      const providerError = toGitHubError(error);

      // 422 = "name already exists on this account" → adopt it.
      if (providerError.status !== 422) {
        throw providerError;
      }

      const { data } = await mapErrors(() => this._octokit.repos.get({ owner: login, repo: input.name }));

      logger.info(`Adopted existing repo ${data.full_name}.`);

      return { fullName: data.full_name, defaultBranch: data.default_branch ?? 'main', created: false };
    }
  }

  async getBranchHead(ref: RepoRef): Promise<string | null> {
    try {
      const { data } = await mapErrors(() =>
        this._octokit.git.getRef({ owner: ref.owner, repo: ref.repo, ref: `heads/${ref.branch}` }),
      );

      return data.object.sha;
    } catch (error) {
      if (error instanceof GitProviderError && error.kind === 'not-found') {
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

    const blobs = mapToTreeBlobs(files);

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
