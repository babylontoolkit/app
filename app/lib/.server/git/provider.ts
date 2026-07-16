/**
 * The `GitProvider` seam (SPEC §4.5.4b).
 *
 * §4.5.4b makes the user's own repository the ONLY permanent home for their game code — our servers
 * keep the project record, never the files. That promotes what was an optional GitHub bridge (§4.13)
 * into the storage backbone, and a storage backbone may not be welded to one vendor: GitHub and GitLab
 * are both first-class, and a third could follow. Everything above this seam (save, reload, checkpoint
 * auto-push, the divergence flow) is written once against this interface.
 *
 * ## What is in the seam, and what deliberately is not
 *
 * SPEC §4.5.4b lists `buildCommit` as a seam method. It is NOT one here, and the reason is worth
 * recording: GitHub composes a commit from four calls (blobs → tree → commit → ref) while GitLab's
 * commits API takes the whole thing atomically in ONE call with an `actions[]` array. Exposing
 * `buildCommit` would force GitLab to fake a tree step it does not have, and would let a caller
 * assemble a commit that is never pushed — a half-written save, which is exactly the failure §4.5.4b
 * calls out ("a failed save is LOUD"). So the seam's write primitive is `fastForwardPush`: one call,
 * atomic per provider, either the branch moved or it did not. Commit construction is an
 * implementation detail of each adapter.
 *
 * ## The contract every implementation owes (pinned by `git-provider-contract.spec.ts`)
 *
 * 1. **Byte-identity.** A PNG or GLB pushed and re-fetched is sha256-identical. Binaries cross as
 *    base64 in the `SerializedFileMap` and MUST be decoded to bytes exactly once, by the provider,
 *    with no text path anywhere near them (spec/binary-files.md).
 * 2. **`fetchTree` never guesses.** Providers return base64 for everything; the decision "is this
 *    binary" is made by the SAME classifier the rest of the platform uses (`classifyFetchedBlob`),
 *    never by an extension allowlist. The property is not "text is text" but "a file pulled from a
 *    repo is typed exactly as the same file written by the agent" — see `fetch-decode.ts`.
 * 3. **Fast-forward only.** `fastForwardPush` returns `{ok:false, divergence}` when the remote moved;
 *    it never force-pushes, and it never merges.
 * 4. **Secrets never leave.** Every push filters through `mapToTreeBlobs`/`isSecretPath`.
 * 5. **Failures are typed and LOUD.** A rate limit is `retryable: true`; a revoked token is
 *    `kind: 'auth'` so the UI can demand a re-connect. Nothing is swallowed — under §4.5.4b a
 *    swallowed error is a lost save.
 */
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import type { Divergence } from './sync-logic';

export type GitProviderId = 'github' | 'gitlab';

/**
 * A repo + branch coordinate.
 *
 * `owner`/`repo` is GitHub's shape; GitLab calls the pair a project path (`group/subgroup/project`)
 * and permits nesting, so adapters join and split rather than assuming two segments.
 */
export interface RepoRef {
  owner: string;
  repo: string;
  branch: string;
}

/** `owner/repo` → `RepoRef`. GitLab paths may nest, so only the LAST segment is the repo. */
export function parseRepo(fullName: string, branch: string): RepoRef {
  const trimmed = fullName.trim().replace(/^\/+|\/+$/g, '');
  const segments = trimmed.split('/').filter(Boolean);

  if (segments.length < 2) {
    throw new GitProviderError({
      kind: 'invalid',
      message: `Invalid repository "${fullName}" — expected "owner/repo".`,
    });
  }

  return { owner: segments.slice(0, -1).join('/'), repo: segments[segments.length - 1], branch };
}

/** `RepoRef` → `owner/repo`. */
export function repoFullName(ref: Pick<RepoRef, 'owner' | 'repo'>): string {
  return `${ref.owner}/${ref.repo}`;
}

/**
 * How a provider failure is classified. The UI and the retry queue both branch on this.
 *
 * - `auth` — token missing, expired, or revoked → the user must re-connect. Never retried silently.
 * - `forbidden` — token valid but lacks permission on this repo (or it is someone else's).
 * - `not-found` — repo/branch/blob does not exist.
 * - `rate-limit` — provider rate limit or secondary limit. Always retryable.
 * - `invalid` — caller error: a malformed repo name, an over-cap repo. Not retryable.
 * - `name-taken` — that repo name already exists on the account. Not retryable, and NOT an error the
 *   user should ever see: Save catches it and tries the next name (`save.ts`). It is a distinct kind
 *   because "the name is used" and "the name is bad" are both 4xx and lead to opposite behaviour.
 * - `unavailable` — transport/5xx/unknown. Retryable.
 */
export type GitErrorKind = 'auth' | 'forbidden' | 'not-found' | 'rate-limit' | 'invalid' | 'name-taken' | 'unavailable';

/**
 * A typed provider failure.
 *
 * §4.5.4b: "a failed save is LOUD". This type exists so the save path can never degrade a real failure
 * into a shrug — the UI branches on `kind` (re-connect prompt vs retry queue) and the queue branches on
 * `retryable`. `retryAfterMs` carries the provider's own backoff hint when it sends one.
 */
export class GitProviderError extends Error {
  readonly kind: GitErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly status?: number;

  constructor(input: { kind: GitErrorKind; message: string; retryAfterMs?: number; status?: number; cause?: unknown }) {
    super(input.message, { cause: input.cause });
    this.name = 'GitProviderError';
    this.kind = input.kind;
    this.retryAfterMs = input.retryAfterMs;
    this.status = input.status;

    // Retryability is derived from the kind, never passed in — one rule, one place.
    this.retryable = input.kind === 'rate-limit' || input.kind === 'unavailable';
  }
}

export interface EnsureRepoInput {
  /** Repo name only (no owner) — it is always created in the authenticated user's own account. */
  name: string;

  /**
   * §4.5.4b creates the user's game repo PRIVATE. This is not a default to be flipped by a caller's
   * omission: the field is required so a new call site must state the intent.
   */
  private: boolean;
  description?: string;

  /**
   * What to do when a repo of this name already exists on the account.
   *
   * 🔴 **Required, and `false` is what Save passes.** This started as unconditional adopt-on-conflict,
   * which is correct for "link this project to the repo I just named" and destructive for "Save":
   * Save derives a name from the project title, so a user with an unrelated `my-game` repo would have
   * had it silently adopted, and the first push — `first-push`, since this project had never synced —
   * builds ON its head. Their repo's HEAD becomes our game. Nothing is lost to git, and nothing looks
   * like an error; they just find a different project in their repository.
   *
   * So the intent must be stated. `false` raises `name-taken` and lets the caller pick another name;
   * `true` is only for a repo the user explicitly named and therefore explicitly meant.
   */
  adoptExisting: boolean;
}

export interface EnsureRepoResult {
  /** `owner/repo` as the provider actually named it (it may slugify what we asked for). */
  fullName: string;
  defaultBranch: string;

  /** False when an existing repo was adopted rather than created — the UI says so. */
  created: boolean;
}

export type PushResult =
  | { ok: true; commitSha: string }
  | { ok: false; divergence: Extract<Divergence, { kind: 'diverged' }> };

export interface FastForwardPushInput {
  ref: RepoRef;
  files: SerializedFileMap;

  /**
   * The commit this project last synced FROM. `undefined` = never synced → the push bases itself on
   * the current head (or creates the branch). A mismatch against the live head is a divergence and the
   * push is REFUSED — see `detectPushDivergence`.
   */
  lastSyncedCommitSha?: string;
  summary?: string;

  /** Create the branch if absent (the initial save). */
  createBranchIfMissing?: boolean;
}

export interface FetchTreeResult {
  files: SerializedFileMap;
  head: string;
}

/**
 * The storage backbone contract. One instance is bound to ONE authenticated user's token.
 *
 * Implementations MUST be stateless beyond that token: the save path retries by calling again, and a
 * provider holding request-scoped state would make a retry mean something different from the first
 * attempt.
 */
export interface GitProvider {
  readonly id: GitProviderId;

  /** The authenticated user's account name — the owner a new repo is created under. */
  getCurrentUser(): Promise<{ login: string }>;

  /** Create the repo in the user's account, or adopt it if the name is already taken by them. */
  ensureRepo(input: EnsureRepoInput): Promise<EnsureRepoResult>;

  /** The branch's head commit sha, or null when the branch does not exist. */
  getBranchHead(ref: RepoRef): Promise<string | null>;

  /**
   * The whole branch as a byte-faithful file map, or null when the branch does not exist.
   *
   * This is the RELOAD path (§4.5.4b) — the only way a project comes back on a new device — so a
   * partial result is unacceptable and MUST throw rather than return a truncated map.
   */
  fetchTree(ref: RepoRef): Promise<FetchTreeResult | null>;

  /** Commit + push the working copy, fast-forward only. The atomic write primitive. */
  fastForwardPush(input: FastForwardPushInput): Promise<PushResult>;
}
