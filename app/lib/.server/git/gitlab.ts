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
  repoFullName,
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
   * Every blob path on the branch, following pagination to the end.
   *
   * GitLab caps a tree page at 100 and paginates; the failure mode of ignoring that is a SILENTLY
   * partial file list — the same class of bug as GitHub's unread `truncated` flag, and the reason
   * `fetchTree` is the reload path's biggest correctness risk. `x-next-page` is empty on the last page.
   */
  private async _listTree(ref: RepoRef, sha: string): Promise<GitLabTreeEntry[]> {
    const entries: GitLabTreeEntry[] = [];
    let page = 1;

    // A hard stop so a misbehaving pagination header can never spin forever.
    const maxPages = 200;

    while (page <= maxPages) {
      const url = `${this._host}/api/v4/projects/${this._projectId(ref)}/repository/tree?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(sha)}`;

      let response: Response;

      try {
        /*
         * 🔴 NO TOKEN → NO HEADER, the same rule as `_request` — and this is the SECOND door.
         *
         * `_request` was made anonymous-safe for the import path (`git/clone.ts`) and this method,
         * which builds its own request because of the pagination headers, kept sending `Bearer `.
         * GitLab rejects a malformed bearer outright, so an anonymous clone of a PUBLIC project read
         * the branch head fine and then 401-ed on the tree — surfacing to the user as a connect prompt
         * for a repository that needs no connection. One rule, both doors.
         */
        response = await this._fetch(url, {
          headers: this._token ? { Authorization: `Bearer ${this._token}` } : {},
        });
      } catch (error) {
        throw new GitProviderError({ kind: 'unavailable', message: 'GitLab is unreachable.', cause: error });
      }

      if (!response.ok) {
        throw await this._toError(response);
      }

      const batch = (await response.json()) as GitLabTreeEntry[];
      entries.push(...batch);

      const next = response.headers.get('x-next-page');

      if (!next) {
        return entries;
      }

      page = Number(next);

      if (!Number.isFinite(page) || page <= 0) {
        return entries;
      }
    }

    throw new GitProviderError({
      kind: 'invalid',
      message:
        'This repository is too large to load in one request. Open it locally with git — the platform supports repositories under the size cap only.',
    });
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
