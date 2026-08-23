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

/**
 * Does this provider message mean "that branch is already there"?
 *
 * 🔴 **A MESSAGE CHECK, DELIBERATELY — and the opposite call from `isEmptyRepository`, for a reason
 * worth stating.** Both providers report a duplicate branch name with the SAME status they use for an
 * invalid source sha (GitLab 400, GitHub 422), so the status alone cannot tell the two apart, and a
 * blanket mapping told a user "a branch named X already exists" when their sha was bad — a refusal
 * naming the wrong cause, which sends them to rename and hit the identical failure.
 *
 * `isEmptyRepository` chose status-over-message because there a drifting message would silently
 * RESTORE a bug (every first save failing). Here the failure direction is the safe one: if a provider
 * rewords its error this stops matching, and the user sees the provider's own sentence through the
 * ordinary mapper instead of a friendlier one of ours. A degraded explanation, never a wrong action.
 */
export function namesAnExistingBranch(message: string): boolean {
  return /already exists|already been taken/i.test(message);
}

/**
 * One sentence for both adapters. A branch list that hit its cap is the same problem on either
 * provider, and two independently-worded refusals for one condition is how they drift apart.
 */
export const TOO_MANY_BRANCHES =
  'This repository has too many branches to list here. Open it locally with git, or use the provider’s own branch page.';

/**
 * The history cursor is opaque at the seam and a page number underneath. Anything unparseable — a
 * hand-edited query string, a cursor minted by the other provider — falls back to page 1 rather than
 * throwing: a bad cursor should show the first page of history, never an error card. (`Number('')` is
 * `0`, which both providers reject, so the guard is `> 0` and not merely `isFinite`.)
 */
export function parseCursor(cursor: string | undefined): number {
  const page = Number(cursor);

  return Number.isInteger(page) && page > 0 ? page : 1;
}

/**
 * The commit SUBJECT. A commit body is unbounded — a squash-merge routinely carries dozens of lines —
 * and every one of them would ride into a list that renders one row per commit.
 */
export function firstLine(message: string): string {
  return message.split('\n', 1)[0];
}

/** One branch, as the branch picker and the switch decision need it. */
export interface BranchSummary {
  name: string;

  /** The branch's head commit sha — what a create-from-here branches off. */
  head: string;

  /** The repository's default branch. Not a guess: `main` is a convention, not a rule. */
  isDefault: boolean;

  /**
   * The provider will refuse a push (and usually a delete). Advisory only — it is a snapshot of a
   * rule the provider owns and enforces, so the UI may DIM a branch with it but must never treat its
   * absence as permission. The authoritative answer is the provider's own refusal.
   */
  protected: boolean;
}

/**
 * One commit, for the history list.
 *
 * 🔴 **SHORT MESSAGE ONLY — never file contents, never a diff.** The temptation is real (a history
 * list wants to show what changed) and the cost is not local: an unbounded read of a large
 * repository's contents is an availability problem for everyone sharing the process, which is the
 * lesson `assertFetchedTreeUsable` exists for. A user who wants the diff has the provider's own
 * commit page, and `provider-urls.ts` links to it.
 */
export interface CommitSummary {
  sha: string;

  /** The first line only. A commit body can be arbitrarily long and no list renders it. */
  message: string;

  /** A display name. Never an email — that is PII we have no reason to move or render. */
  author: string;

  /** ISO 8601, as the provider reported it. Formatting is the UI's business. */
  date: string;
}

export interface ListCommitsOptions {
  /** Hard bound, applied by the CALLER's policy and again by the route. Never unbounded. */
  limit: number;

  /** Opaque to everyone but the adapter that issued it — a page number on both providers today. */
  cursor?: string;
}

export interface ListCommitsResult {
  commits: CommitSummary[];

  /** Absent = the end of the history. Never an empty string, which reads as "there is more". */
  nextCursor?: string;
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

  /**
   * The repository's default branch, or null when the repository does not exist (or is not visible to
   * this token — GitLab answers 404 for a private project rather than 403, deliberately, so the API
   * cannot be used to enumerate).
   *
   * Import needs this and nothing else does: `StarterTemplates` links to `/git?url=…` with **no
   * branch**, and a user pasting a repository URL is under no obligation to know whether it calls its
   * trunk `main`, `master` or `develop`. Guessing `main` is not a fallback, it is a wrong answer that
   * reads as "repository not found".
   *
   * ⚠️ It takes only the COORDINATE, not a `RepoRef` — asking for a branch in order to discover the
   * branch is a contradiction, and a caller forced to invent one (`branch: ''`, `branch: 'main'`) has
   * been handed the very guess this method exists to remove. A `RepoRef` **value** still satisfies it
   * structurally; an inline object literal carrying `branch` does not (TS excess-property checking),
   * which is the compiler making the same point.
   *
   * Absent is `null`, never a throw — the `getBranchHead` rule, for the same reason: a caller must be
   * able to tell "there is no such repo" from "we could not ask", and an exception collapses them.
   */
  getDefaultBranch(ref: Pick<RepoRef, 'owner' | 'repo'>): Promise<string | null>;

  /** The branch's head commit sha, or null when the branch does not exist. */
  getBranchHead(ref: RepoRef): Promise<string | null>;

  /**
   * The whole branch as a byte-faithful file map, or null when the branch does not exist.
   *
   * This is the RELOAD path (§4.5.4b) — the only way a project comes back on a new device — so a
   * partial result is unacceptable and MUST throw rather than return a truncated map.
   */
  fetchTree(ref: RepoRef): Promise<FetchTreeResult | null>;

  /**
   * Every branch in the repository, paginated to the end.
   *
   * ⚠️ **A repository with no commits returns `[]`, not an error** — and the two providers disagree
   * about how they say so: GitHub answers **409** (`isEmptyRepository`, the same quirk that broke
   * every first save in 2026-07) and GitLab answers **404**. Both normalise here, because "this
   * repository has no branches yet" is an ordinary state for a repo Save created moments ago, and a
   * caller made to distinguish two provider status codes has been handed the adapter's job.
   *
   * ⚠️ COORDINATE, not `RepoRef` — the `getDefaultBranch` rule. Asking which branch to look at in
   * order to list the branches is the contradiction that method's comment already names.
   */
  listBranches(ref: Pick<RepoRef, 'owner' | 'repo'>): Promise<BranchSummary[]>;

  /**
   * Create a branch at `fromSha`. Returns the head it was created at.
   *
   * 🔴 **IT MUST NEVER FORCE-UPDATE AN EXISTING REF.** A create that moved somebody's branch is a
   * force-push wearing a friendlier verb, and it destroys commits nobody read — the precise thing
   * §4.13's fast-forward-only rule exists to prevent, arriving through a door that does not look like
   * a push. An existing name raises `GitProviderError{ kind: 'name-taken' }`, reusing `ensureRepo`'s
   * kind because the caller's recovery is identical: show the name back and let the user pick another.
   *
   * ⚠️ COORDINATE plus an explicit `name`, so a caller cannot accidentally create the branch it is
   * currently on by passing a stale `RepoRef`.
   */
  createBranch(ref: Pick<RepoRef, 'owner' | 'repo'>, name: string, fromSha: string): Promise<{ head: string }>;

  /**
   * Delete a branch.
   *
   * ⚠️ **An absent branch is SUCCESS, not an error.** The intent — "this branch should not exist" —
   * is already satisfied, and a second click, a double-submit or a retry after a dropped response
   * must not produce a red error for a state the user asked for and got. A provider REFUSAL
   * (protected branch, insufficient permission) is different in kind and surfaces with the provider's
   * own reason through the existing mappers, because that is a rule we do not own.
   *
   * 🔴 There is no undo. A checkpoint snapshots FILES (§4.12) and cannot restore a remote ref, which
   * is why this is the one operation in the feature whose confirmation says so plainly.
   */
  deleteBranch(ref: Pick<RepoRef, 'owner' | 'repo'>, name: string): Promise<void>;

  /**
   * A bounded page of the branch's history, newest first.
   *
   * Takes a full `RepoRef` — unlike the three above, this one is asking about a specific branch, so
   * the branch is not a guess the caller was forced to invent.
   */
  listCommits(ref: RepoRef, options: ListCommitsOptions): Promise<ListCommitsResult>;

  /** Commit + push the working copy, fast-forward only. The atomic write primitive. */
  fastForwardPush(input: FastForwardPushInput): Promise<PushResult>;
}
