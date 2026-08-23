/**
 * Server-side repository CLONE — the import path's read primitive (SPEC §4.13, §4.5.4b, §5).
 *
 * ## Why this exists
 *
 * A user who has already connected GitHub — whose encrypted token sits in `git_tokens`, service-role
 * only, driving link/push/pull for every project — was nevertheless asked by `window.prompt` for a
 * username and a personal access token when they cloned a repo, and that credential was stored in a
 * plaintext, non-httpOnly `git:<domain>` cookie and sent as browser Basic auth through
 * `/api/git-proxy`. The platform therefore held two unrelated GitHub identities, and the one the user
 * explicitly authorized was the one clone could not see.
 *
 * This module makes clone what every other repo operation already is: a `GitProvider` call made by the
 * server, with the token resolved from the caller's session identity and the browser never holding or
 * sending a credential. It is an EXTENSION of an existing seam to a new entry point, not a second
 * fetch implementation — `fetchTree` is the same byte-faithful read the repo-primary mount uses, and
 * `classifyFetchedBlob` already re-encodes provider base64 from decoded bytes so wrapping cannot leak
 * downstream (`fetch-decode.ts`).
 *
 * ## The two things a clone can do that a pull cannot
 *
 * 1. **It names a repository the project is not linked to** — a user-typed reference. That is the first
 *    caller-influenced fetch target in the product, so §5's SSRF rule binds. The primary wall is an
 *    ORIGIN ALLOW-LIST: `parseCloneTarget` reduces whatever the user typed to a `provider` +
 *    `owner/repo` coordinate and **no raw user URL is ever fetched** — the provider adapters build
 *    every URL themselves from `github.com` / the operator-configured GitLab host. `assertPublicUrl`
 *    is applied to that base as defense-in-depth, which is also why a private-network or self-hosted
 *    host is out of scope by DESIGN rather than merely unimplemented (`net/ssrf.ts` refuses private
 *    addresses so the platform can never be pointed at the operator's own network).
 *
 * 2. **It can run with no credential at all.** A public repository cloned by a user who has never
 *    connected an account is a first-class, silent path — not a degraded one. `resolveProvider` throws
 *    `auth` when there is no stored token, and that is correct for SAVE (a lapsed token must never
 *    silently drop a save) but wrong for a public read, so this module catches exactly that case and
 *    falls back to an ANONYMOUS provider. Only a repo the anonymous read genuinely cannot see escalates
 *    — and it escalates to a **connect** prompt, never a credential prompt.
 *
 * ⚠️ An unconnected user reading a private repo and an unconnected user typing a repo that does not
 * exist are the SAME observation: GitHub answers 404 for both, deliberately, so its API cannot be used
 * to enumerate private repositories. They are therefore reported as one `auth` outcome whose message
 * names both possibilities. Reporting it as `not-found` would tell a user with a real (private) repo
 * that their repository does not exist; reporting a typo as `auth` merely offers a connect button. The
 * cheap direction is the one that keeps a real repository reachable.
 */
import { base64ToBytes, type SerializedFileMap } from '~/lib/binary/binary-files';
import { envNumber } from '~/lib/.server/env';
import { DEFAULT_PROJECT_SOURCE_MAX_MB } from '~/lib/.server/storage/limits';
import { assertPublicUrl } from '~/lib/.server/net/ssrf';
import { GitProviderError, type FetchTreeResult, type GitProvider, type GitProviderId, type RepoRef } from './provider';
import { isSecretPath } from './sync-logic';
import { getOAuthConfig } from './oauth';
import { buildProvider, resolveProvider } from './resolve';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('git.clone');

/** GitLab's own host, when the operator has not configured a self-hosted one. */
const GITLAB_DEFAULT_HOST = 'https://gitlab.com';

/** GitHub's API origin — the only URL the GitHub adapter ever builds. */
const GITHUB_API_ORIGIN = 'https://api.github.com';

/**
 * A clone coordinate: which adapter, which repository, and (optionally) which branch.
 *
 * `branch` is optional ON PURPOSE — `StarterTemplates` links to `/git?url=…` with no branch at all, and
 * a user pasting a repository URL is under no obligation to know whether its trunk is called `main`,
 * `master` or `develop`. `getDefaultBranch` answers that; guessing does not.
 */
export interface CloneTarget {
  provider: GitProviderId;
  owner: string;
  repo: string;
  branch?: string;
}

/** A host we will not clone from. 400 — the caller asked for something outside the product. */
export class UnsupportedGitHostError extends Error {
  readonly statusCode = 400;
  readonly name = 'UnsupportedGitHostError';
  readonly isRetryable = false;
}

/**
 * Which door a tree is arriving through, for the refusal wording only.
 *
 * The RULE is identical for every door — same ceiling, same env var, same LFS test — and that is the
 * point of `assertFetchedTreeUsable`. This exists because a user pressing Sync on a linked project is
 * not importing anything, and a refusal that describes the wrong operation reads as the wrong button
 * being broken (`share/build-failure.ts`). A user pressing **Discard** is importing even less.
 */
export type TreeIngestOperation = 'import' | 'sync' | 'switch' | 'discard' | 'review';

/**
 * The verb each door uses, in the user's words.
 *
 * 🔴 **A `Record` over the union, so a new door cannot compile without answering.** The wording was
 * two ternaries (`operation === 'import' ? … : …`) while there were two doors; at five that shape
 * degrades into a chain whose default silently describes the wrong button — and the whole reason this
 * type exists is that describing the wrong button is the defect. A missing key here is `TS2741`,
 * which is the same guard `FIELD_COVERAGE` uses for a different money path.
 *
 * `limit` names the ceiling ("the 256MB import limit"), `gerund` completes "…, so it cannot be X",
 * and `active` completes "X it would …". ⚠️ `limit` is a separate word rather than a reuse of the
 * union member because the three new doors read badly in that slot ("the 256MB discard limit"), and
 * because `import` and `sync` must keep their existing sentences BYTE-FOR-BYTE — those are pinned by
 * `clone.spec.ts`, and quietly rewording a shipped refusal to suit a refactor is how a test gets
 * edited to match the code instead of the other way round.
 */
const OPERATION_WORDS: Record<TreeIngestOperation, { limit: string; gerund: string; active: string }> = {
  import: { limit: 'import', gerund: 'imported', active: 'importing' },
  sync: { limit: 'sync', gerund: 'pulled into this project', active: 'pulling' },
  switch: { limit: 'branch', gerund: 'switched to', active: 'switching to' },
  discard: { limit: 'branch', gerund: 'restored', active: 'discarding your changes and restoring' },
  review: { limit: 'branch', gerund: 'compared with your project', active: 'reviewing' },
};

/** A repository whose source exceeds the shared project-source ceiling. */
export class CloneTooLargeError extends Error {
  readonly statusCode = 413;
  readonly name = 'CloneTooLargeError';
  readonly isRetryable = false;

  constructor(bytes: number, limit: number, operation: TreeIngestOperation = 'import') {
    super(
      `That repository's source is ${(bytes / (1024 * 1024)).toFixed(1)}MB, over the ` +
        `${Math.round(limit / (1024 * 1024))}MB ${OPERATION_WORDS[operation].limit} limit, so it cannot be ` +
        `${OPERATION_WORDS[operation].gerund}. ` +
        'Raise GIT_CLONE_MAX_MB to allow it.',
    );
  }
}

/**
 * A repository whose content is stored in Git-LFS.
 *
 * LFS is out of scope (§4.5.4c declares it so for the save direction; an import inherits the same
 * boundary). What matters is that it fails INFORMATIVELY: the git tree hands us 130-byte pointer text
 * in place of every large asset, so importing it silently produces a project whose every model, texture
 * and sound is a stub — a project that looks complete, mounts cleanly, and cannot run.
 */
export class LfsPointerError extends Error {
  readonly statusCode = 422;
  readonly name = 'LfsPointerError';
  readonly isRetryable = false;

  constructor(paths: string[], operation: TreeIngestOperation = 'import') {
    const shown = paths.slice(0, 3).join(', ');
    super(
      `That repository stores ${paths.length} file(s) in Git-LFS (${shown}${paths.length > 3 ? ', …' : ''}), ` +
        `which is not supported yet — ${OPERATION_WORDS[operation].active} it would ` +
        'replace those files with placeholder text.',
    );
  }
}

/** The ceiling on an imported repository's source — **configurable**, `GIT_CLONE_MAX_MB`. */
export const DEFAULT_GIT_CLONE_MAX_MB = DEFAULT_PROJECT_SOURCE_MAX_MB;

export function maxCloneBytes(context?: unknown): number {
  const mb = envNumber(context, 'GIT_CLONE_MAX_MB', DEFAULT_GIT_CLONE_MAX_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_GIT_CLONE_MAX_MB) * 1024 * 1024;
}

/** The API origin an adapter will actually talk to — what `assertPublicUrl` is applied to. */
function apiOriginFor(provider: GitProviderId, host: string | undefined): string {
  return provider === 'github' ? GITHUB_API_ORIGIN : (host ?? GITLAB_DEFAULT_HOST).replace(/\/+$/, '');
}

/**
 * Which adapter serves a hostname, or `null` when none does.
 *
 * The GitLab arm is keyed off the OPERATOR's configured host rather than off the string "gitlab", so a
 * deployment pointed at `git.example.com` can import from it.
 *
 * ⚠️ `gitlab.com` is accepted whether or not GitLab OAuth is configured, and that is deliberate: an
 * anonymous read of a PUBLIC repository needs no OAuth app, so refusing it because the operator has not
 * set up connect-and-save would turn a working import into "that host is not supported". A PRIVATE
 * GitLab repo on such a deployment fails later, at the point it actually needs a credential, with the
 * connect prompt — which is the honest failure. (An earlier draft of this comment claimed the opposite
 * rule; the code never implemented it. A false claim in a comment is how a defect survives review.)
 */
function providerForHost(hostname: string, gitlabHost: string | undefined): GitProviderId | null {
  const host = hostname.toLowerCase().replace(/^www\./, '');

  if (host === 'github.com') {
    return 'github';
  }

  let gitlabHostname: string;

  try {
    gitlabHostname = new URL(gitlabHost ?? GITLAB_DEFAULT_HOST).hostname.toLowerCase();
  } catch {
    gitlabHostname = 'gitlab.com';
  }

  return host === gitlabHostname ? 'gitlab' : null;
}

/**
 * Reduce whatever the user typed to a coordinate — **the primary SSRF wall** (§5, FR7).
 *
 * Accepts an `https://` URL, an `scp`-style `git@host:owner/repo.git`, or a bare `owner/repo`. Whatever
 * comes in, what comes out is a provider id plus path segments; the raw string is never fetched, so
 * there is no URL for a caller to smuggle a redirect, a port, a userinfo section or an IP literal into.
 *
 * A host we do not serve is refused **by name** rather than generically (Open Question 4): "we do not
 * support Bitbucket" is a product boundary a user can act on, and "import failed" is a bug report.
 */
export function parseCloneTarget(raw: string, options: { gitlabHost?: string; provider?: string } = {}): CloneTarget {
  const input = (raw ?? '').trim();

  if (!input) {
    throw new UnsupportedGitHostError('Enter a repository to import, for example github.com/owner/repo.');
  }

  // `git@github.com:owner/repo.git` → a URL we can parse with the same code as every other form.
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/)(.+)$/.exec(input);
  const normalized = scp ? `https://${scp[1]}/${scp[2]}` : input;

  let provider: GitProviderId | null = null;
  let path: string;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized) || /^[\w.-]+\.[a-z]{2,}\//i.test(normalized)) {
    let url: URL;

    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized) ? normalized : `https://${normalized}`);
    } catch {
      throw new UnsupportedGitHostError(`"${input}" is not a repository address we recognise.`);
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'git:') {
      throw new UnsupportedGitHostError(`Only https repository addresses can be imported, not "${url.protocol}//".`);
    }

    provider = providerForHost(url.hostname, options.gitlabHost);

    if (!provider) {
      throw new UnsupportedGitHostError(
        `Only GitHub and GitLab repositories can be imported — ${url.hostname} is not supported.`,
      );
    }

    path = url.pathname;
  } else {
    // A bare `owner/repo`. The caller states the provider; GitHub stays the default, as everywhere else.
    provider = options.provider === 'gitlab' ? 'gitlab' : 'github';
    path = input;
  }

  let segments = path
    .replace(/\.git$/i, '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);

  /*
   * A pasted browse URL carries the branch after `/tree/` (GitHub) or `/-/tree/` (GitLab). Dropping the
   * suffix without reading it would clone `owner/repo/tree` — a repository that does not exist, reported
   * as "not found" for a URL the user copied out of their own address bar.
   */
  let branch: string | undefined;
  const treeAt = segments.findIndex((s, i) => i >= 2 && (s === 'tree' || s === 'blob'));

  if (treeAt > 0) {
    branch = segments[treeAt + 1];
    segments = segments.slice(0, treeAt).filter((s) => s !== '-');
  }

  if (segments.length < 2) {
    throw new UnsupportedGitHostError(`"${input}" is not a repository — expected something like owner/repo.`);
  }

  return {
    provider,
    owner: segments.slice(0, -1).join('/'),
    repo: segments[segments.length - 1],
    branch,
  };
}

/**
 * The decoded source weight of a fetched map, in bytes.
 *
 * Measured from what is already in hand — binaries carry base64, whose decoded length is exact
 * arithmetic — so nothing is decoded, re-encoded or stringified to answer the question. It is the
 * PROJECT SOURCE size, which is what `DEFAULT_PROJECT_SOURCE_MAX_MB` names and what the working copy
 * and the remix seed are measured against, so the three cannot mean different things by one number.
 */
export function serializedSourceBytes(files: SerializedFileMap): number {
  let total = 0;

  for (const dirent of Object.values(files)) {
    if (!dirent || dirent.type !== 'file') {
      continue;
    }

    if (dirent.isBinary) {
      const b64 = dirent.content;
      const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
      total += Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
    } else {
      total += dirent.content.length;
    }
  }

  return total;
}

/** The Git-LFS pointer preamble. A pointer file is small, ASCII, and starts with exactly this. */
const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1';

/**
 * A real pointer is ~130 bytes. The cap is what makes decoding safe: nothing large is ever decoded to
 * ask this question, so the check costs nothing on a repository full of genuine assets.
 */
const LFS_POINTER_MAX_BYTES = 1024;

/**
 * 🔴 A POINTER IS ALMOST ALWAYS CLASSIFIED **BINARY**, AND CHECKING ONLY TEXT ENTRIES NEVER FIRES.
 *
 * `classifyFetchedBlob` lets the PATH veto a text verdict — a `.glb`, `.png`, `.psd` or `.mp4` is an
 * asset whatever its first bytes sniff as (`fetch-decode.ts`, and that override is correct). But LFS
 * exists precisely for those files, so a `!isBinary` test excluded every path a pointer is ever found
 * at: the guard read as present, cost nothing, and could not fire. The failure it exists to prevent is
 * the silent one — a project whose every model, texture and sound is 130 bytes of placeholder text,
 * which mounts cleanly, looks complete, and cannot run.
 *
 * So the DECODED bytes decide, not the classification.
 */
function isLfsPointer(dirent: SerializedFileMap[string]): boolean {
  if (!dirent || dirent.type !== 'file') {
    return false;
  }

  if (!dirent.isBinary) {
    return dirent.content.startsWith(LFS_POINTER_PREFIX);
  }

  // base64 is 4 chars per 3 bytes — an upper bound is enough to reject anything that cannot be a pointer.
  if (Math.floor((dirent.content.length * 3) / 4) > LFS_POINTER_MAX_BYTES) {
    return false;
  }

  return new TextDecoder().decode(base64ToBytes(dirent.content)).startsWith(LFS_POINTER_PREFIX);
}

/** Which paths came back as LFS pointers rather than as content. */
export function findLfsPointers(files: SerializedFileMap): string[] {
  const found: string[] = [];

  for (const [path, dirent] of Object.entries(files)) {
    if (isLfsPointer(dirent)) {
      found.push(path);
    }
  }

  return found;
}

/**
 * 🔴 THE ONE RULE FOR TURNING SOMEBODY'S GIT TREE INTO THIS PROJECT'S FILES — BOTH DOORS (2026-08-19).
 *
 * Two paths fetch a tree and hand it to the client: `cloneRepository` (import) and the project git
 * route's `pull` helper (Sync, and the divergence dialog's "use the version from my repository").
 * Only the one with *import* in its name was checking anything, so the guards below were walked around
 * by the ordinary workflow they were written for — save a small project to GitHub, add gigabytes of
 * glTF from a git client, press Sync:
 *
 *   - **Size.** A pull runs THROUGH the server, so an unbounded tree is held in this process and
 *     base64-serialised into one JSON body. That makes it an availability problem for every user
 *     sharing the process, not merely a bad experience for the one who pressed the button — and
 *     downstream it silently disables the client's crash-recovery copy (`working-copy-size.ts`).
 *   - **LFS.** A pointer is 130 bytes of text where a model, texture or sound should be, so the
 *     project mounts cleanly, looks complete, and cannot run. That is the failure `LfsPointerError`
 *     exists to make loud, and it was loud on one door and silent on the other.
 *
 * It is ONE exported function rather than the same four lines in two places for `isSecretPath`'s
 * reason: a rule with two copies is a rule that will be fixed once. And callers pass their whole
 * fetched map — never a pre-filtered one — because both questions are about what ARRIVED.
 */
export function assertFetchedTreeUsable(
  files: SerializedFileMap,
  options: { context?: unknown; operation?: TreeIngestOperation } = {},
): void {
  const operation = options.operation ?? 'import';

  const bytes = serializedSourceBytes(files);
  const limit = maxCloneBytes(options.context);

  if (bytes > limit) {
    throw new CloneTooLargeError(bytes, limit, operation);
  }

  const pointers = findLfsPointers(files);

  if (pointers.length > 0) {
    throw new LfsPointerError(pointers, operation);
  }
}

/**
 * Read a branch's whole tree and prove it is usable — **without recording agreement with it.**
 *
 * 🔴 **THE SEPARATION IS THE POINT OF THIS FUNCTION.** `pull()` used to do two things in one body:
 * read a tree, and stamp `lastSyncedCommitSha`. That second half means "this project has agreed with
 * that commit", and the next push's fast-forward check is measured against it. Every new door onto
 * this read — Review changes, Switch, Discard — wants the FIRST half only, and the cheap way to build
 * them (call `pull()`) silently stamps the pointer for a branch the user merely looked at. The next
 * push then measures against a commit this project never held and fast-forwards straight over the
 * work in the repository. Nothing throws; the user loses commits.
 *
 * So: this reads and refuses. The caller that genuinely agreed with the bytes moves the pointer, and
 * it is one line at that call site where it can be seen.
 *
 * ⚠️ **The guard runs BEFORE anything is returned**, for the reason `pull()`'s own comment gives:
 * refusing a tree after handing it back is not refusing it. And `operation` is required rather than
 * defaulted, so a new door must state which words its refusal uses instead of inheriting "import"
 * from whichever door was written first.
 *
 * `null` = the branch has no commits. NEVER an empty file map: `planRestore` refuses an empty
 * incoming map by design ("a restore is never a wipe"), so a caller handed `{}` would restore nothing
 * and report success. The caller decides the sentence, because "that branch is empty" means something
 * different when switching to it than when discarding onto it.
 */
export async function readBranchTree(input: {
  provider: GitProvider;
  ref: RepoRef;
  context: unknown;
  operation: TreeIngestOperation;
}): Promise<FetchTreeResult | null> {
  const read = await input.provider.fetchTree(input.ref);

  if (!read) {
    return null;
  }

  assertFetchedTreeUsable(read.files, { context: input.context, operation: input.operation });

  return read;
}

/**
 * Drop the `.env` family from a clone, through the ONE rule (`git/sync-logic.ts`).
 *
 * A repository the user is importing may well be their own, and their own `.env` may well be in it (a
 * repository is not obliged to gitignore anything). Carrying it into a fresh project would put someone's
 * production credentials into a sandbox they are about to share — and, worse, into a project that can be
 * published and remixed. The same rule that keeps a secret from ever leaving on a push keeps it from
 * arriving on an import; a second definition of "is this a secret" is how the two drift.
 */
export function stripSecrets(files: SerializedFileMap): { files: SerializedFileMap; removed: string[] } {
  const kept: SerializedFileMap = {};
  const removed: string[] = [];

  for (const [path, dirent] of Object.entries(files)) {
    if (isSecretPath(path)) {
      removed.push(path);
      continue;
    }

    kept[path] = dirent;
  }

  return { files: kept, removed };
}

export interface CloneResult {
  files: SerializedFileMap;
  head: string;
  repo: string;
  branch: string;
  provider: GitProviderId;

  /** Secrets the import declined to carry — reported, never silently dropped. */
  skippedSecrets: string[];
}

/**
 * A provider for this clone, and whether it carries the user's credential.
 *
 * The fallback is scoped to `auth` alone. Any other failure from `resolveProvider` (a broken token
 * store, a provider outage mid-refresh) is a genuine platform failure and must surface as one — turning
 * it into an anonymous read would report "that repository is private" for an outage of ours.
 */
async function providerForClone(
  context: unknown,
  userId: string,
  provider: GitProviderId,
  host: string | undefined,
): Promise<{ provider: GitProvider; authenticated: boolean }> {
  try {
    return { provider: await resolveProvider(context, userId, provider), authenticated: true };
  } catch (error) {
    if (error instanceof GitProviderError && error.kind === 'auth') {
      return { provider: buildProvider(provider, '', host), authenticated: false };
    }

    throw error;
  }
}

/** The connect prompt an unconnected user gets for a repository an anonymous read cannot see. */
function connectPrompt(provider: GitProviderId): GitProviderError {
  const name = provider === 'github' ? 'GitHub' : 'GitLab';

  return new GitProviderError({
    kind: 'auth',
    message: `We could not find that repository. If it is private, connect ${name} and try again.`,
    status: 401,
  });
}

/**
 * Clone a repository into a `SerializedFileMap`, server-side.
 *
 * Order is load-bearing: the coordinate is reduced (so no user URL is fetched), the origin is checked,
 * the credential is resolved from the SESSION, the branch is resolved by asking rather than guessing,
 * the tree is fetched, and only then is it measured and filtered. Every refusal that can be made before
 * the bytes exist is made before the bytes exist.
 */
export async function cloneRepository(input: {
  context: unknown;
  userId: string;
  target: CloneTarget;
}): Promise<CloneResult> {
  const { context, userId, target } = input;
  const host = getOAuthConfig(context, target.provider)?.host;

  /*
   * Defense-in-depth, not the primary wall (§5, FR7). Nothing caller-supplied reaches this string — the
   * adapters build every URL from it — so there is no redirect hop for a caller to steer. What it DOES
   * cover is an operator who has pointed `GITLAB_HOST` at a private-network address, which would make
   * the platform reachable inward from a user-typed repository name.
   */
  await assertPublicUrl(apiOriginFor(target.provider, host));

  const { provider, authenticated } = await providerForClone(context, userId, target.provider, host);
  const coordinate = { owner: target.owner, repo: target.repo };
  const fullName = `${target.owner}/${target.repo}`;

  let branch = target.branch;

  if (!branch) {
    const resolved = await provider.getDefaultBranch(coordinate);

    if (resolved === null) {
      // Absent to an anonymous read is indistinguishable from private — see the module header.
      throw authenticated
        ? new GitProviderError({ kind: 'not-found', message: `We could not find the repository ${fullName}.` })
        : connectPrompt(target.provider);
    }

    branch = resolved;
  }

  let fetched: Awaited<ReturnType<GitProvider['fetchTree']>>;

  try {
    fetched = await provider.fetchTree({ ...coordinate, branch });
  } catch (error) {
    if (!authenticated && error instanceof GitProviderError && (error.kind === 'not-found' || error.kind === 'auth')) {
      throw connectPrompt(target.provider);
    }

    throw error;
  }

  if (!fetched) {
    /*
     * `null` is "the branch has no commits", NOT "we could not ask" — `fetchTree` throws for the
     * latter. Collapsing them here would report an empty repository as a platform failure, or a
     * platform failure as an empty repository.
     */
    throw new GitProviderError({
      kind: 'not-found',
      message: `${fullName}@${branch} has no commits to import.`,
    });
  }

  assertFetchedTreeUsable(fetched.files, { context, operation: 'import' });

  const { files, removed } = stripSecrets(fetched.files);

  logger.info(
    `Cloned ${Object.keys(files).length} files from ${fullName}@${branch} ` +
      `(${authenticated ? 'authenticated' : 'anonymous'}, ${removed.length} secret(s) skipped).`,
  );

  return { files, head: fetched.head, repo: fullName, branch, provider: target.provider, skippedSecrets: removed };
}
