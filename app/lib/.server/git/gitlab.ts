/**
 * The GitLab `GitProvider` (SPEC §4.5.4b).
 *
 * GitLab's REST API, via `fetch` — no SDK dependency, and no git binary (§4.13). The inherited
 * bolt.diy GitLab code (`stores/gitlabConnection.ts`, `services/gitlabApiService.ts`) is CLIENT-side
 * connect/browse/one-shot-push machinery and is deliberately not reused here: §4.5.4b requires the
 * save path to run server-side against a server-held token.
 *
 * ## The shape difference that the seam exists to absorb
 *
 * GitHub composes a commit from four calls (blobs → tree → commit → ref). GitLab takes the whole
 * commit ATOMICALLY in one POST with an `actions[]` array, each action carrying `encoding: 'base64'`
 * for binaries. That is why `buildCommit` is not a seam method (see `provider.ts`) — there is no tree
 * step here to expose.
 *
 * ## Two honest limitations, documented rather than papered over
 *
 * 1. **No compare-and-swap.** GitLab's commits API takes no expected-parent, so the fast-forward rule
 *    is check-then-commit with a real (small) race window: if someone pushes between our head read and
 *    our commit, GitLab bases our commit on THEIR head. Nothing is lost — their commit stays in
 *    history and is recoverable with git — but our tree wins. We detect it after the fact via the
 *    returned `parent_ids` and report it loudly rather than let it pass as a clean save. GitHub's
 *    `updateRef` with `force:false` has no such window.
 * 2. **Deletes skip the secret family.** A full push makes the branch match the working copy, which
 *    means deleting remote files we no longer have. `isSecretPath` files are exempt in BOTH
 *    directions: we never push a `.env`, so we must never conclude from its absence locally that the
 *    user wants theirs deleted from their own repo.
 */
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import { buildCommitMessage, detectPushDivergence, isSecretPath, mapToTreeBlobs } from './sync-logic';
import {
  GitProviderError,
  firstLine,
  namesAnExistingBranch,
  parseCursor,
  TOO_MANY_BRANCHES,
  repoFullName,
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
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('git.gitlab');

export const GITLAB_DEFAULT_HOST = 'https://gitlab.com';

interface GitLabTreeEntry {
  id: string;
  path: string;
  type: 'blob' | 'tree';
}

interface GitLabCommitAction {
  action: 'create' | 'update' | 'delete';
  file_path: string;
  content?: string;
  encoding?: 'base64' | 'text';
}

/** GitLab's maximum page size; `MAX_BRANCH_PAGES` bounds a remote-driven loop, as `_listTree` does. */
const MAX_BRANCH_PAGES = 20;

export class GitLabProvider implements GitProvider {
  readonly id = 'gitlab' as const;

  private readonly _token: string;
  private readonly _host: string;
  private readonly _fetch: typeof fetch;

  constructor(token: string, options: { host?: string; fetchImpl?: typeof fetch } = {}) {
    this._token = token;
    this._host = (options.host ?? GITLAB_DEFAULT_HOST).replace(/\/+$/, '');
    this._fetch = options.fetchImpl ?? fetch;
  }

  /** `group/subgroup/project` → the URL-encoded id GitLab wants in a path segment. */
  private _projectId(ref: Pick<RepoRef, 'owner' | 'repo'>): string {
    return encodeURIComponent(repoFullName(ref));
  }

  private async _request<T>(path: string, init: RequestInit & { rawQuery?: string } = {}): Promise<T> {
    const url = `${this._host}/api/v4${path}${init.rawQuery ? `?${init.rawQuery}` : ''}`;

    let response: Response;

    try {
      response = await this._fetch(url, {
        ...init,
        headers: {
          /*
           * No token → NO header, rather than an empty `Bearer `. The import path (`git/clone.ts`)
           * builds an anonymous provider so a PUBLIC repository clones for a user who has never
           * connected an account — a first-class path, not a degraded one. GitLab rejects a malformed
           * bearer header outright, so sending an empty one would turn every anonymous public read into
           * a 401 and, downstream, into a connect prompt for a repository that needs no connection.
           */
          ...(this._token ? { Authorization: `Bearer ${this._token}` } : {}),
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      // Transport failure (DNS, socket, abort) — no status at all. Retryable.
      throw new GitProviderError({ kind: 'unavailable', message: 'GitLab is unreachable.', cause: error });
    }

    if (!response.ok) {
      throw await this._toError(response);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  /**
   * Map a GitLab HTTP response onto the typed seam error.
   *
   * GitLab differs from GitHub in a way that matters: it uses a real **429** with `RateLimit-Reset`
   * (an epoch SECOND, not a delta) rather than GitHub's overloaded 403, and it returns **404** where
   * it means "forbidden" for private projects (deliberate, so the API cannot be used to enumerate).
   * The seam hides both quirks; callers just see `kind`.
   */
  private async _toError(response: Response): Promise<GitProviderError> {
    const status = response.status;

    let message = `GitLab request failed (${status}).`;

    try {
      const body = (await response.json()) as { message?: unknown; error?: unknown };
      const raw = body?.message ?? body?.error;

      if (typeof raw === 'string') {
        message = raw;
      } else if (raw) {
        message = JSON.stringify(raw);
      }
    } catch {
      // A non-JSON body (an HTML error page from a proxy) — keep the status-derived message.
    }

    if (status === 401) {
      return new GitProviderError({
        kind: 'auth',
        message: 'Your GitLab connection has expired. Reconnect GitLab to keep saving.',
        status,
      });
    }

    if (status === 429) {
      const reset = response.headers.get('ratelimit-reset');
      const retryAfter = response.headers.get('retry-after');

      let retryAfterMs: number | undefined;

      if (retryAfter && Number.isFinite(Number(retryAfter))) {
        retryAfterMs = Number(retryAfter) * 1000;
      } else if (reset && Number.isFinite(Number(reset))) {
        // RateLimit-Reset is an absolute epoch second — convert to a delta, and never go negative.
        retryAfterMs = Math.max(0, Number(reset) * 1000 - Date.now());
      }

      return new GitProviderError({
        kind: 'rate-limit',
        message: 'GitLab is rate limiting this save. Retrying shortly.',
        retryAfterMs,
        status,
      });
    }

    if (status === 403) {
      return new GitProviderError({ kind: 'forbidden', message, status });
    }

    if (status === 404) {
      return new GitProviderError({ kind: 'not-found', message, status });
    }

    if (status >= 500) {
      return new GitProviderError({ kind: 'unavailable', message: 'GitLab is unavailable.', status });
    }

    return new GitProviderError({ kind: 'invalid', message, status });
  }

  async getCurrentUser(): Promise<{ login: string }> {
    const user = await this._request<{ username: string }>('/user');
    return { login: user.username };
  }

  async ensureRepo(input: EnsureRepoInput): Promise<EnsureRepoResult> {
    const { login } = await this.getCurrentUser();

    try {
      const created = await this._request<{ path_with_namespace: string; default_branch: string | null }>('/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: input.name,
          path: input.name,
          visibility: input.private ? 'private' : 'public',
          description: input.description,
          initialize_with_readme: false,
        }),
      });

      logger.info(`Created project ${created.path_with_namespace} (private=${input.private}).`);

      return {
        fullName: created.path_with_namespace,
        defaultBranch: created.default_branch ?? 'main',
        created: true,
      };
    } catch (error) {
      const providerError = error instanceof GitProviderError ? error : null;

      // 400 = "has already been taken" on this account, the GitHub 422 path's twin.
      if (providerError?.kind !== 'invalid') {
        throw error;
      }

      // Adopting is destructive and must be asked for — see `EnsureRepoInput.adoptExisting`.
      if (!input.adoptExisting) {
        throw new GitProviderError({
          kind: 'name-taken',
          message: `A project named ${input.name} already exists on this account.`,
          status: providerError.status,
          cause: error,
        });
      }

      const existing = await this._request<{ path_with_namespace: string; default_branch: string | null }>(
        `/projects/${encodeURIComponent(`${login}/${input.name}`)}`,
      );

      logger.info(`Adopted existing project ${existing.path_with_namespace}.`);

      return {
        fullName: existing.path_with_namespace,
        defaultBranch: existing.default_branch ?? 'main',
        created: false,
      };
    }
  }

  /**
   * The project's default branch (see `GitProvider.getDefaultBranch`).
   *
   * The project path must be URL-ENCODED into one segment (`_projectId`) — GitLab has no
   * `/projects/:group/:name` form, and a nested `group/subgroup/project` sent raw addresses a
   * different, usually non-existent, resource. That is why this cannot be a shared string template
   * with the GitHub adapter.
   *
   * ⚠️ GitLab answers **404 for a private project** a token cannot see, on purpose, so it cannot be
   * used to enumerate. `null` here therefore means "no repository we can reach", not "no repository" —
   * which is the honest answer to give an importer either way.
   */
  async getDefaultBranch(ref: Pick<RepoRef, 'owner' | 'repo'>): Promise<string | null> {
    try {
      const project = await this._request<{ default_branch: string | null }>(`/projects/${this._projectId(ref)}`);

      return project.default_branch ?? null;
    } catch (error) {
      if (error instanceof GitProviderError && error.kind === 'not-found') {
        return null;
      }

      throw error;
    }
  }

  async getBranchHead(ref: RepoRef): Promise<string | null> {
    try {
      const branch = await this._request<{ commit: { id: string } }>(
        `/projects/${this._projectId(ref)}/repository/branches/${encodeURIComponent(ref.branch)}`,
      );

      return branch.commit.id;
    } catch (error) {
      if (error instanceof GitProviderError && error.kind === 'not-found') {
        return null;
      }

      throw error;
    }
  }

  /**
   * GET a paginated collection, following `x-next-page` to the end. **The one raw-fetch door.**
   *
   * It exists because `_request` cannot see response HEADERS, and GitLab's page cursor lives in one.
   * That gap previously produced a SECOND door — `_listTree` built its own `fetch` and kept sending
   * `Bearer ` after `_request` was made anonymous-safe, so an anonymous clone of a PUBLIC project read
   * the branch head fine and then 401-ed on the tree, surfacing as a connect prompt for a repository
   * that needs no connection. Branch and commit listing are both paginated too, so the choice here was
   * one door or FOUR. One rule, one place — the `isSecretPath` discipline.
   *
   * ⚠️ **NO TOKEN → NO HEADER**, never an empty `Bearer `: GitLab rejects a malformed bearer outright,
   * which turns every anonymous public read into a 401.
   *
   * `maxPages` is a hard stop so a misbehaving pagination header can never spin forever, and
   * `onExhausted` supplies the message, because "too large" means something different to a caller
   * reading a whole tree than to one paging through history.
   */
  private async _paginate<T>(
    path: string,
    query: string,
    options: { maxPages: number; onExhausted: () => GitProviderError },
  ): Promise<T[]> {
    const items: T[] = [];
    let page = 1;

    for (let requests = 0; requests < options.maxPages; requests++) {
      const url = `${this._host}/api/v4${path}?${query}&page=${page}`;

      let response: Response;

      try {
        response = await this._fetch(url, {
          headers: this._token ? { Authorization: `Bearer ${this._token}` } : {},
        });
      } catch (error) {
        throw new GitProviderError({ kind: 'unavailable', message: 'GitLab is unreachable.', cause: error });
      }

      if (!response.ok) {
        throw await this._toError(response);
      }

      items.push(...((await response.json()) as T[]));

      const next = response.headers.get('x-next-page');

      /* Empty on the last page. A non-numeric or non-positive value is treated the same way. */
      if (!next) {
        return items;
      }

      const parsed = Number(next);

      if (!Number.isFinite(parsed) || parsed <= 0) {
        return items;
      }

      page = parsed;
    }

    throw options.onExhausted();
  }

  /**
   * Every blob path on the branch, following pagination to the end.
   *
   * GitLab caps a tree page at 100 and paginates; the failure mode of ignoring that is a SILENTLY
   * partial file list — the same class of bug as GitHub's unread `truncated` flag, and the reason
   * `fetchTree` is the reload path's biggest correctness risk.
   */
  private async _listTree(ref: RepoRef, sha: string): Promise<GitLabTreeEntry[]> {
    return this._paginate<GitLabTreeEntry>(
      `/projects/${this._projectId(ref)}/repository/tree`,
      `recursive=true&per_page=100&ref=${encodeURIComponent(sha)}`,
      {
        maxPages: 200,
        onExhausted: () =>
          new GitProviderError({
            kind: 'invalid',
            message:
              'This repository is too large to load in one request. Open it locally with git — the platform supports repositories under the size cap only.',
          }),
      },
    );
  }

  async fetchTree(ref: RepoRef): Promise<FetchTreeResult | null> {
    const head = await this.getBranchHead(ref);

    if (!head) {
      return null;
    }

    const tree = await this._listTree(ref, head);
    const blobs = tree.filter((entry) => entry.type === 'blob');
    const files: SerializedFileMap = {};

    const entries = await runBounded(blobs, async (entry) => {
      const blob = await this._request<{ content: string; encoding: string }>(
        `/projects/${this._projectId(ref)}/repository/blobs/${entry.id}`,
      );

      return { path: entry.path, dirent: classifyFetchedBlob(entry.path, blob.content) };
    });

    for (const entry of entries) {
      files[entry.path] = entry.dirent;
    }

    logger.info(`Fetched ${entries.length} files from ${repoFullName(ref)}@${ref.branch} @ ${head}`);

    return { files, head };
  }

  /**
   * Every branch, paginated to the end (see `GitProvider.listBranches`).
   *
   * ⚠️ **GitLab reports an empty repository as 404, where GitHub uses 409.** Both are "there are no
   * branches yet" and both normalise to `[]` — the divergence is exactly what the seam exists to
   * absorb. ⚠️ 404 is ALSO what GitLab returns for a project a token cannot see (deliberately, so the
   * API cannot enumerate private projects), so an unreachable project reports as empty here. That is
   * the same conflation `getDefaultBranch` already documents and accepts: from the caller's side
   * "no branches we can reach" is the honest answer either way, and the linked-repo gate upstream has
   * already established that this project is ours.
   *
   * Unlike GitHub, `default` and `protected` come back on the row, so no second request is needed.
   */
  async listBranches(ref: Pick<RepoRef, 'owner' | 'repo'>): Promise<BranchSummary[]> {
    try {
      const branches = await this._paginate<{
        name: string;
        commit: { id: string };
        default?: boolean;
        protected?: boolean;
      }>(`/projects/${this._projectId(ref)}/repository/branches`, 'per_page=100', {
        maxPages: MAX_BRANCH_PAGES,
        onExhausted: () =>
          new GitProviderError({
            kind: 'invalid',
            message: TOO_MANY_BRANCHES,
          }),
      });

      return branches.map((branch) => ({
        name: branch.name,
        head: branch.commit.id,
        isDefault: branch.default === true,
        protected: branch.protected === true,
      }));
    } catch (error) {
      if (error instanceof GitProviderError && error.kind === 'not-found') {
        return [];
      }

      throw error;
    }
  }

  /**
   * Create a branch at `fromSha` (see `GitProvider.createBranch`).
   *
   * The FIRST `POST /repository/branches` call in this codebase — branch creation was previously only
   * reachable as a side effect of `fastForwardPush({ createBranchIfMissing })`, which commits at the
   * same time. This creates a branch and touches no file, which is the whole point: the user's
   * in-progress work stays exactly where it is and simply belongs to a new branch.
   *
   * ⚠️ **`branch` and `ref` are QUERY parameters, not a JSON body** — GitLab accepts both, and the
   * query form is what keeps the branch name out of a body that would need its own encoding rules.
   * The name is encoded because a branch legally contains `/` and `#`.
   *
   * An existing name is a **400** here (GitLab validates rather than conflicting), so the mapping to
   * `name-taken` is a status check on this endpoint only — the `isEmptyRepository` discipline again.
   */
  async createBranch(ref: Pick<RepoRef, 'owner' | 'repo'>, name: string, fromSha: string): Promise<{ head: string }> {
    try {
      const branch = await withRetry(() =>
        this._request<{ commit: { id: string } }>(`/projects/${this._projectId(ref)}/repository/branches`, {
          method: 'POST',
          rawQuery: `branch=${encodeURIComponent(name)}&ref=${encodeURIComponent(fromSha)}`,
        }),
      );

      return { head: branch.commit?.id ?? fromSha };
    } catch (error) {
      if (error instanceof GitProviderError && error.status === 400 && namesAnExistingBranch(error.message)) {
        throw new GitProviderError({
          kind: 'name-taken',
          message: `A branch named ${name} already exists.`,
          status: 400,
          cause: error,
        });
      }

      throw error;
    }
  }

  /** Delete a branch; an absent one is success (see `GitProvider.deleteBranch`). */
  async deleteBranch(ref: Pick<RepoRef, 'owner' | 'repo'>, name: string): Promise<void> {
    try {
      await withRetry(() =>
        this._request<void>(`/projects/${this._projectId(ref)}/repository/branches/${encodeURIComponent(name)}`, {
          method: 'DELETE',
        }),
      );
    } catch (error) {
      if (error instanceof GitProviderError && error.kind === 'not-found') {
        logger.info(`Branch ${name} was already absent from ${repoFullName(ref)} — nothing to delete.`);
        return;
      }

      throw error;
    }
  }

  /**
   * A bounded page of history (see `GitProvider.listCommits`). The cursor is a page number.
   *
   * ONE page, deliberately not `_paginate` — that helper walks to the END, which is the opposite of
   * what a cursor-paged history wants. Reusing it here would read the entire history of the
   * repository to render the first twenty rows.
   */
  async listCommits(ref: RepoRef, options: ListCommitsOptions): Promise<ListCommitsResult> {
    const page = parseCursor(options.cursor);

    let commits: Array<{ id: string; title?: string; message?: string; author_name?: string; created_at?: string }>;

    try {
      commits = await this._request<typeof commits>(`/projects/${this._projectId(ref)}/repository/commits`, {
        rawQuery: `ref_name=${encodeURIComponent(ref.branch)}&per_page=${options.limit}&page=${page}`,
      });
    } catch (error) {
      /* No repository we can reach, or no commits on it — an empty history, not a failure. */
      if (error instanceof GitProviderError && error.kind === 'not-found') {
        return { commits: [] };
      }

      throw error;
    }

    return {
      commits: commits.map((commit) => ({
        sha: commit.id,

        /* GitLab already sends the subject as `title`; `message` is the fallback for a fake or an old API. */
        message: commit.title ?? firstLine(commit.message ?? ''),
        author: commit.author_name ?? '',
        date: commit.created_at ?? '',
      })),
      nextCursor: commits.length === options.limit ? String(page + 1) : undefined,
    };
  }

  async fastForwardPush(input: FastForwardPushInput): Promise<PushResult> {
    const { ref, files } = input;
    const remoteHead = await this.getBranchHead(ref);
    const divergence = detectPushDivergence(remoteHead, input.lastSyncedCommitSha);

    if (divergence.kind === 'diverged') {
      logger.info(`Push refused for ${repoFullName(ref)}@${ref.branch}: remote moved (divergence).`);
      return { ok: false, divergence };
    }

    if (!remoteHead && input.createBranchIfMissing === false) {
      throw new GitProviderError({ kind: 'not-found', message: `Branch "${ref.branch}" does not exist.` });
    }

    const blobs = mapToTreeBlobs(files, (path) =>
      logger.warn(
        `Dropped "${path}" from the push: the map calls it a file, but it has children (see mapToTreeBlobs).`,
      ),
    );
    const localPaths = new Set(blobs.map((blob) => blob.path));

    /*
     * GitLab has no upsert: 'create' fails on an existing path and 'update' fails on a missing one, so
     * we need the remote path set to pick the verb per file. (GitHub needs none of this — a tree
     * without `base_tree` replaces wholesale.)
     */
    const remotePaths = remoteHead
      ? new Set((await this._listTree(ref, remoteHead)).filter((e) => e.type === 'blob').map((e) => e.path))
      : new Set<string>();

    const actions: GitLabCommitAction[] = blobs.map((blob) => ({
      action: remotePaths.has(blob.path) ? 'update' : 'create',
      file_path: blob.path,
      content: blob.content,
      encoding: blob.encoding === 'base64' ? 'base64' : 'text',
    }));

    // Make the branch match the working copy — but never delete a secret file we deliberately never push.
    for (const remotePath of remotePaths) {
      if (!localPaths.has(remotePath) && !isSecretPath(remotePath)) {
        actions.push({ action: 'delete', file_path: remotePath });
      }
    }

    if (actions.length === 0) {
      throw new GitProviderError({ kind: 'invalid', message: 'There is nothing to save yet.' });
    }

    /*
     * Retries on a rate limit only — see `withRetry`. GitLab's commit is one atomic POST, so unlike
     * GitHub there is no partial state to resume from; a dropped save here is the whole save.
     */
    const commit = await withRetry(() =>
      this._request<{ id: string; parent_ids: string[] }>(`/projects/${this._projectId(ref)}/repository/commits`, {
        method: 'POST',

        /*
         * No `start_branch`: it means "branch off THIS existing ref", and our only target is
         * `ref.branch` itself. On an empty repo `branch` alone creates the first commit; on an existing
         * branch `branch` alone commits to it. Passing `start_branch: ref.branch` when the branch does
         * not exist asks GitLab to branch from something absent, which it rejects.
         */
        body: JSON.stringify({
          branch: ref.branch,
          commit_message: buildCommitMessage(input.summary),
          actions,
        }),
      }),
    );

    /*
     * The race window this API cannot close (see the header): if the remote moved between our head read
     * and this commit, GitLab silently based us on their head. Nothing is lost, but it is not the clean
     * fast-forward we promised — so say so rather than let it pass.
     */
    if (remoteHead && commit.parent_ids?.[0] && commit.parent_ids[0] !== remoteHead) {
      logger.warn(
        `GitLab commit ${commit.id} landed on parent ${commit.parent_ids[0]}, not the head we checked (${remoteHead}) — the remote moved mid-save.`,
      );
    }

    logger.info(`Pushed ${blobs.length} files to ${repoFullName(ref)}@${ref.branch} → ${commit.id}`);

    return { ok: true, commitSha: commit.id };
  }
}
