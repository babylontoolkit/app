/**
 * The client's door to the server (SPEC §4.5, §4.5.4b, §4.12).
 *
 * 🔴 **This header used to say "the server is the source of truth for FILES". That is now FALSE**, and
 * the correction is the most important thing on this page — §4.5.4b inverted it. The server holds the
 * project RECORD, the chat, and a pointer to the user's repo. It does not hold their code:
 *
 *   - before Save, the project lives in this browser and nowhere else (`local-snapshots.ts`);
 *   - after Save, it lives in the user's own repository, which is the only permanent copy;
 *   - the platform relays between the two (`saveProjectToRepo`) and stores nothing on the way through.
 *
 * The one exception is narrow and worth naming so it is not mistaken for the old model: a REMIX SEED,
 * the one-time copy `api.remix` writes so a clone of a shared game has something to open — necessary
 * because the source's own repo belongs to someone else.
 *
 * The rule that did NOT change: **never send a `projectId` we did not get from the server.** It is
 * checked on every route (`requireOwnedProject`), and a project that is not yours reports 404 — not
 * 403 — because a 403 would confirm the id exists and turn the route into an enumeration oracle
 * (§4.5.3).
 *
 * File payloads are `SerializedFileMap`: the same codec the WebContainer serializes to, so binary
 * bytes survive the round trip base64-encoded as a WIRE format (never as live store state).
 */
import { isSecretPath, normalizeRepoFileMap } from '~/lib/git/paths';
import { branchForWorkingCopy } from './repo-status';
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import type { CreationPlan } from '~/lib/agent/creation-plan';
import type { Project } from '~/types/project';
import type { ServerChat } from './chat-list';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('projects-client');

/** The uniform error envelope every server route returns (`app/lib/.server/http.ts`). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly isRetryable: boolean,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,

    /*
     * The session is an httpOnly cookie. Without this, every one of these calls is anonymous — which
     * in local mode silently "works" (there is no 401) and in production silently 401s. Both failure
     * modes are confusing enough to be worth the explicit flag.
     */
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    let isRetryable = response.status >= 500;

    try {
      const body = (await response.json()) as { message?: string; isRetryable?: boolean };
      message = body.message ?? message;
      isRetryable = body.isRetryable ?? isRetryable;
    } catch {
      // A non-JSON error body is not worth failing differently over.
    }

    logger.error(`${init?.method ?? 'GET'} ${path} -> ${response.status}: ${message}`);

    throw new ApiError(message, response.status, isRetryable);
  }

  return response.json() as Promise<T>;
}

/* ---------------------------------------------------------------- projects */

export async function createProject(input: { name: string; templateId: string }): Promise<Project> {
  const { project } = await api<{ project: Project }>('/api/projects', {
    method: 'POST',
    body: JSON.stringify(input),
  });

  logger.info(`Created project ${project.id} ("${project.name}")`);

  return project;
}

export async function listProjects(): Promise<Project[]> {
  const { projects } = await api<{ projects: Project[] }>('/api/projects');
  return projects;
}

export async function getProject(projectId: string): Promise<Project> {
  const { project } = await api<{ project: Project }>(`/api/projects/${projectId}`);
  return project;
}

export async function renameProject(projectId: string, name: string): Promise<Project> {
  const { project } = await api<{ project: Project }>(`/api/projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });

  return project;
}

/**
 * Store (or clear, with `null`) the creation handoff on the project row (§4.4a, migration 0016).
 *
 * 🔴 On the PROJECT, not in `localStorage`, because "created but never built" is a fact about the
 * project: held in one browser, an unbuilt project opened on a second device showed no handoff card
 * and lost the carried prompt. The machine-written `brief` field is retired (owner, 2026-08-08).
 */
export async function saveCreationHandoff(
  projectId: string,
  handoff: { userPrompt?: string; plan?: CreationPlan } | null,
): Promise<void> {
  await api<{ project: Project }>(`/api/projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify({ creationHandoff: handoff }),
  });
}

export async function deleteProject(projectId: string): Promise<void> {
  await api<{ ok: true }>(`/api/projects/${projectId}`, { method: 'DELETE' });
}

/* ------------------------------------------------------------------- saving */

export interface RepoStatus {
  linked: boolean;
  provider?: 'github' | 'gitlab';
  repo?: string;
  branch?: string;
  lastSyncedCommitSha?: string;
  autoPush?: boolean;

  /**
   * The repo's head. `null` = the branch has no commits. **ABSENT = we could not ask** (offline, or a
   * lapsed token) — which `selectMountSource` treats as "unknown", never as "empty".
   */
  remoteHead?: string | null;

  /** True when the provider could not be reached. `remoteHead` is then absent, not null. */
  unreachable?: boolean;

  /**
   * Which git providers this deployment has OAuth configured for. Drives the first-save provider
   * choice: an unlinked project with more than one option must ask where it should live rather than
   * defaulting silently to one. Absent/one entry → no choice to offer.
   */
  configuredProviders?: Array<'github' | 'gitlab'>;
}

/**
 * Where this project is saved, and where its repo is right now.
 *
 * Returns `{linked: false}` rather than throwing when the server cannot be reached — opening a project
 * must work offline, and an unlinked-looking answer with no `remoteHead` is exactly what
 * `selectMountSource` needs to fall back to the local copy.
 */
export async function getRepoStatus(projectId: string): Promise<RepoStatus> {
  try {
    const response = await fetch(`/api/projects/${projectId}/github`, { credentials: 'same-origin' });

    if (!response.ok) {
      return { linked: false, unreachable: true };
    }

    return (await response.json()) as RepoStatus;
  } catch {
    return { linked: false, unreachable: true };
  }
}

/** Pull the linked repo's files. The caller checkpoints before applying them (§4.12). */
export async function pullFromRepo(
  projectId: string,
): Promise<{ files?: SerializedFileMap; head?: string; message?: string }> {
  try {
    const response = await fetch(`/api/projects/${projectId}/github`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'pull' }),
    });

    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      files?: SerializedFileMap;
      head?: string;
      message?: string;
    } | null;

    if (!payload?.ok) {
      return { message: payload?.message ?? `Could not read the repository (${response.status}).` };
    }

    /*
     * Fetch-boundary normalization: a damaged repo (nested workdir prefix) must not round-trip
     * its damage into the sandbox — see `normalizeRepoFileMap`.
     */
    return { files: payload.files ? normalizeRepoFileMap(payload.files) : payload.files, head: payload.head };
  } catch {
    return { message: 'Could not reach the server.' };
  }
}

/** The two buttons (§4.13). There is deliberately no third option, and `merge` is not coming. */
export type DivergenceChoice = 'pull-overwrite' | 'push-to-new-branch';

export interface ResolveOutcome {
  ok: boolean;

  /** `pull-overwrite` — the repo's files, to mount. The caller checkpoints BEFORE applying them. */
  files?: SerializedFileMap;

  /** `push-to-new-branch` — where the user's work went. Worth showing them; it is theirs to find. */
  branch?: string;

  reconnect?: boolean;
  message?: string;
}

/**
 * Answer a divergence (§4.13) — the repo moved AND this browser has work that was never saved.
 *
 * The platform never merges, so there are exactly two answers and the user picks one. Both are
 * lossless: `pull-overwrite` is preceded by a local checkpoint (the caller's job — it holds the files),
 * and `push-to-new-branch` puts the user's version somewhere new rather than over anything.
 */
export async function resolveDivergence(
  projectId: string,
  choice: DivergenceChoice,
  input?: { files?: SerializedFileMap; summary?: string },
): Promise<ResolveOutcome> {
  try {
    const response = await fetch(`/api/projects/${projectId}/github`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'resolve', choice, ...input }),
    });

    const payload = (await response.json().catch(() => null)) as ResolveOutcome | null;

    if (!payload) {
      return { ok: false, message: `The server returned an error (${response.status}).` };
    }

    if (!payload.ok) {
      logger.error(`Resolve (${choice}) failed for ${projectId}: ${payload.message ?? response.status}`);
    }

    // Same fetch-boundary normalization as `pullFromRepo` — pull-overwrite mounts these files.
    return payload.files ? { ...payload, files: normalizeRepoFileMap(payload.files) } : payload;
  } catch {
    return { ok: false, message: 'Could not reach the server. Your work is still here — try again.' };
  }
}

export interface SaveOutcome {
  ok: boolean;

  /** The repo the project now lives in, `owner/name`. */
  repo?: string;
  branch?: string;
  provider?: 'github' | 'gitlab';
  commitSha?: string;

  /** True when Save created the repository (first save) rather than pushing to an existing link. */
  created?: boolean;

  /** The remote moved — the caller must offer the two-button choice (§4.13). Never merge. */
  divergence?: boolean;

  /** The provider connection lapsed; send the user back through OAuth. */
  reconnect?: boolean;

  /** Worth trying again (rate limit, transport). Terminal failures are not. */
  retryable?: boolean;
  message?: string;
}

/**
 * Save (§4.5.4b) — make this project permanent, in the user's own repository.
 *
 * On first save the server creates a private repo named after the project, pushes, and records the
 * link; afterwards this is a push to the repo they already have. Either way the FILES travel in the
 * body: they exist in this browser and nowhere else until this call succeeds.
 *
 * Never throws on a failed save — it returns the outcome. §4.5.4b requires a failed save to be LOUD,
 * and a thrown exception at a call site that forgot a `catch` is the opposite of loud: it is a spinner
 * that stops and a user who believes they are saved. The caller must read `ok`.
 */
export async function saveProjectToRepo(
  projectId: string,
  input: { files: SerializedFileMap; summary?: string; provider?: 'github' | 'gitlab' },
): Promise<SaveOutcome> {
  let response: Response;

  try {
    response = await fetch(`/api/projects/${projectId}/github`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },

      /*
       * `provider` matters only on the FIRST save of an unlinked project — it names which account the
       * repo is created in. Once linked, the server ignores it and uses the project's own provider
       * (the link is authoritative, §4.5.4b), so sending it on every push is harmless.
       */
      body: JSON.stringify({ op: 'save', ...input }),
    });
  } catch {
    return { ok: false, retryable: true, message: 'Could not reach the server. Your work is still here — try again.' };
  }

  const payload = (await response.json().catch(() => null)) as SaveOutcome | null;

  if (!payload) {
    // A non-JSON body (an HTML 500 page) must not become a silent success or an unhandled throw.
    return {
      ok: false,
      retryable: response.status >= 500,
      message: `The server returned an error (${response.status}).`,
    };
  }

  if (!payload.ok) {
    logger.error(`Save failed for ${projectId}: ${payload.message ?? response.status}`);
  }

  return payload;
}

/* ------------------------------------------------------------------ import */

export interface CloneOutcome {
  ok: boolean;

  /** The repository's tree, ready to write to the sandbox. Normalised at the fetch boundary. */
  files?: SerializedFileMap;
  head?: string;

  /** How the server resolved the coordinate — `owner/name`, and the branch it actually read. */
  repo?: string;
  branch?: string;
  provider?: 'github' | 'gitlab';

  /** Secret files the import declined to carry. Reported, never silently dropped. */
  skippedSecrets?: string[];

  /** The repository needs a connection this user does not have; send them through OAuth. */
  reconnect?: boolean;

  /** Worth trying again (rate limit, transport). A bad repo name is not. */
  retryable?: boolean;
  message?: string;
}

/**
 * Import an existing repository into this project (§4.13).
 *
 * The server resolves the credential from the caller's session, fetches the tree, and hands it back;
 * **the browser sends no credential and never sees one** — which is the whole point of the operation
 * that replaced upstream's `window.prompt` + plaintext `git:<domain>` cookie. `repo` is whatever the
 * user typed (a URL, an `scp` address, or a bare `owner/repo`); reducing it to a coordinate is the
 * server's job, because it is also the SSRF wall (`git/clone.ts`).
 *
 * ⚠️ Returns an OUTCOME and never throws, deliberately — the convention the other git helpers here use
 * rather than `api()`'s throw. An import is a long, visible, expensive operation with a project already
 * registered behind it, so a failure has to be LOUD at the call site; a thrown error at a caller that
 * forgot a `catch` is a spinner that stops and a user who does not know why (§4.5.4b's "a failed save
 * is LOUD", one door over). The caller must read `ok`.
 */
export async function cloneRepoIntoProject(
  projectId: string,
  input: { repo: string; branch?: string; provider?: 'github' | 'gitlab' },
): Promise<CloneOutcome> {
  let response: Response;

  try {
    response = await fetch(`/api/projects/${projectId}/github`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'clone', ...input }),
    });
  } catch {
    return { ok: false, retryable: true, message: 'Could not reach the server. Try the import again.' };
  }

  const payload = (await response.json().catch(() => null)) as CloneOutcome | null;

  if (!payload) {
    // A non-JSON body (an HTML 500 page) must not become a silent success or an unhandled throw.
    return {
      ok: false,
      retryable: response.status >= 500,
      message: `The server returned an error (${response.status}).`,
    };
  }

  if (!payload.ok) {
    logger.error(`Clone failed for ${projectId}: ${payload.message ?? response.status}`);
    return payload;
  }

  /*
   * The same fetch-boundary normalization `getRepoStatus`/`pullFromRepo` apply: a damaged repo (one
   * carrying a nested workdir prefix) must not round-trip its damage into the sandbox — see
   * `normalizeRepoFileMap`. An import is the FIRST thing that ever happens to these files, so getting
   * it wrong here means every later path inherits paths that are wrong from the start.
   */
  return payload.files ? { ...payload, files: normalizeRepoFileMap(payload.files) } : payload;
}

export interface LinkOutcome {
  ok: boolean;
  message?: string;
}

/**
 * Record where this project lives, as a COMPLETE tuple (§4.5.4b).
 *
 * 🔴 **All three fields or none.** `provider` + `linked_repo` + `linked_branch` are one fact, enforced
 * by migration 0006's `projects_link_complete_check` — a repo with no provider names no adapter, so the
 * project would read as LINKED while every save silently had nowhere to go. That constraint caught two
 * live half-link writers on the way in, which is why the rule is a database check and not a convention.
 *
 * ⚠️ **`provider` is REQUIRED here, deliberately, where the route defaults it to `github`.** The route's
 * default exists for rows linked before §4.5.4b; a new caller relying on it is a bug waiting for its
 * first GitLab user, because a GitLab-linked project that records `github` resolves the wrong token
 * against the wrong host on every push. Requiring it is what makes that impossible to forget.
 *
 * 🔴 **`GitHubSyncButton.link()` still posts `op: 'link'` INLINE with no provider, and that is a real
 * pre-existing defect, not a safe exception.** An earlier draft of this comment claimed it was
 * "GitHub-only by construction" because it checks `c.provider === 'github'` — that check proves the
 * user has a GitHub CONNECTION, not that the repository being linked is on GitHub, and the dialog is
 * now reached from `GitStatusChip`, whose provider radio group can be set to GitLab and is NOT threaded
 * through to it. So a user with both providers connected can link a GitLab repo and have `github`
 * recorded. It is outside this feature's scope and is logged in SPEC §10; do not treat it as precedent,
 * and do not re-add a wrapper-free second writer.
 *
 * Returns an outcome and never throws: an IMPORT calls this after the files have already landed, and a
 * link that fails there must leave an honestly-unlinked project rather than take down a successful
 * import.
 */
export async function linkProjectToRepo(
  projectId: string,
  input: { repo: string; branch: string; provider: 'github' | 'gitlab'; head?: string },
): Promise<LinkOutcome> {
  let response: Response;

  try {
    response = await fetch(`/api/projects/${projectId}/github`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'link', ...input }),
    });
  } catch {
    return { ok: false, message: 'Could not reach the server to record where this project is saved.' };
  }

  const payload = (await response.json().catch(() => null)) as { ok?: boolean; message?: string } | null;

  if (!payload?.ok) {
    const message = payload?.message ?? `The server returned an error (${response.status}).`;
    logger.error(`Link failed for ${projectId}: ${message}`);

    return { ok: false, message };
  }

  return { ok: true };
}

/* -------------------------------------------------------------- remix seed */

/**
 * 🔴 There is no snapshot API here any more (§4.5.4b), and adding one back is the regression.
 *
 * The browser used to POST the entire project to `/api/projects/:id/snapshots` after every generation,
 * and read a version history back. Under repo-primary persistence the platform does not hold the user's
 * code: checkpoints live in IndexedDB (`local-snapshots.ts`) and saved work lives in the user's own
 * repo. The server routes are gone entirely — `createSnapshot`, `listSnapshots`, `setCurrentSnapshot`
 * and `readSnapshot` with them — so a call added here has nothing to reach. The honest place to say so
 * is here, where someone reaching for "save the project on the server" looks first.
 *
 * `no-server-storage.spec.ts` scans this directory for anyone re-adding one.
 */

/**
 * Read the project's remix SEED, if it has one.
 *
 * The one thing the platform still stores of a user's source: the copy left behind when a shared game
 * is published, so that a clone of it has something to open (§4.8). It is not a checkpoint and not a
 * backup — an ordinary project has no seed, which is why `{}` here is the normal case rather than an
 * error.
 *
 * Skips the request entirely unless the project record says a seed exists, so the common path costs
 * nothing. `remixSeedAt` is only a hint: if it disagrees with storage the fetch 404s and this returns
 * `{}` anyway, which is the same answer.
 */
export async function readRemixSeed(projectId: string): Promise<{ files?: SerializedFileMap }> {
  const project = await getProject(projectId);

  if (!project.remixSeedAt) {
    return {};
  }

  return api<{ files: SerializedFileMap }>(`/api/projects/${projectId}/seed`);
}

/* ---------------------------------------------------------------- messages */

/** A conversation as the server holds it, without its body (§4.5.6). */
export interface ChatSummary {
  serverChatId: string;
  projectId: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/**
 * Mint a chat's server identity (§4.5.6).
 *
 * 🔴 **Never use the local chat id for this.** `getNextId` is `max(local keys) + 1` — a per-browser
 * counter — so every browser's first chat is "1". Keying the server transcript by it makes this
 * laptop's chat "1" and that desktop's chat "1" the same object, and one silently destroys the other.
 * A UUID is minted here, at first save, and lives in the chat's metadata from then on.
 */
export function mintServerChatId(): string {
  return crypto.randomUUID();
}

/** What a chat id is — the shared rule (`chat-id.ts`), re-exported so callers here have it to hand. */
export { isServerChatId } from './chat-id';

/** Every conversation on a project, newest activity first. */
export async function listChats(projectId: string): Promise<ChatSummary[]> {
  const { chats } = await api<{ chats: ChatSummary[] }>(`/api/projects/${projectId}/messages`);
  return chats;
}

/**
 * Every conversation the user has, across every project — the server-backed sidebar (§4.5.6).
 *
 * This is what makes chats follow the user between devices. The sidebar was `getAll(indexedDb)`, so it
 * showed whatever THIS browser happened to know; the transcripts were on the server the whole time with
 * nothing listing them.
 */
export async function listAllChats(): Promise<ServerChat[]> {
  const { chats } = await api<{ chats: ServerChat[] }>('/api/chats');
  return chats;
}

export async function saveMessages(
  projectId: string,
  serverChatId: string,
  messages: unknown[],
  meta?: { title?: string; createdAt?: string },
): Promise<void> {
  await api<{ ok: true }>(`/api/projects/${projectId}/messages/${serverChatId}`, {
    method: 'PUT',
    body: JSON.stringify({ messages, ...meta }),
  });
}

/**
 * Push the project's files to the server WORKING COPY (SPEC §4.5.4c).
 *
 * One object per project, overwritten — a crash-recovery buffer, never a history. `seq` is the LOCAL
 * checkpoint's seq, deliberately: resume has to order this copy against the browser's checkpoints, and
 * sharing one monotonic counter is what makes that comparison meaningful. Never a timestamp.
 *
 * ⚠️ **Best-effort by design — never let this fail the checkpoint.** The local checkpoint is written
 * first and is the copy the user is about to rely on; a failed upload must degrade to "no recovery
 * copy", never to "no checkpoint". Callers swallow the error and say so in the log.
 */
export async function saveWorkingCopy(
  projectId: string,
  seq: number,
  files: SerializedFileMap,
  messageId?: string,
): Promise<void> {
  /*
   * 🔴 SECRETS NEVER LEAVE THE BROWSER, and this uses the SAME rule as every other path that sends a
   * user's files anywhere (`isSecretPath`, one rule in one place, already shared by the push and the
   * remix seed). The working copy is on OUR infrastructure, so shipping `.env` here would put every
   * user's API keys in our object storage — a bigger exposure than the push it is modelled on, since
   * that at least goes to a repo the user owns.
   *
   * The cost is honest and matches a repo restore: recovering onto a fresh browser does not bring the
   * keys back, and the user re-enters them. Recovering onto a browser that still has them keeps them,
   * because the restore protects exactly these paths (`protectForRepoRestore`) rather than treating
   * this map as the whole truth.
   */
  const safe: SerializedFileMap = {};

  for (const [path, entry] of Object.entries(files)) {
    if (!isSecretPath(path)) {
      safe[path] = entry;
    }
  }

  /*
   * 🔴 THE BRANCH STAMP (§4.13a T17), read from the store rather than taken as a parameter — for the
   * same reason `writeWorkingCopyFromStore` does it, and because THIS is the writer that made that
   * reason concrete.
   *
   * There is ONE working copy per project and a PUT replaces the whole object. This function is the
   * per-generation checkpoint's writer, i.e. the most frequent working-copy write in the product, and
   * while it could not reach `repoStatus` (an import cycle: `useChatHistory` imports this file) it
   * wrote every copy unstamped. Two silent consequences: the mismatch guard was inert on the common
   * path, and it ACTIVELY UN-STAMPED — `applyBranchTree` would stamp `feature/hud` and the very next
   * generation would overwrite the copy with nothing, giving the protection a lifetime of one turn.
   *
   * Threading it through this signature was the other option and was rejected: it restores exactly the
   * forgettable shape the store-read exists to eliminate, and there would then be two rules for one
   * field. `repo-status.ts` was extracted instead so both writers read the same answer.
   */
  await api<{ ok: true; seq: number }>(`/api/projects/${projectId}/working`, {
    method: 'PUT',
    body: JSON.stringify({ seq, messageId, branch: branchForWorkingCopy(), files: safe }),
  });
}

/**
 * The server's recovery copy, or `null` when there is none.
 *
 * `null` means "this project has no copy" — an ordinary state for a project that has never
 * checkpointed, and also what the server returns for bytes it could not parse or order. It is never a
 * reason to fail a mount: the caller falls back to its other sources (`mount-source.ts`).
 */
export interface WorkingCopySummary {
  seq: number;
  updatedAt: string;
  files: SerializedFileMap;
  messageId?: string;

  /**
   * Which branch these files came from (§4.13a).
   *
   * ⚠️ Absent means the copy predates the stamp, and `selectMountSource` treats that as UNKNOWN — it
   * never reads silence as agreement. See `WorkingCopy.branch` for why that direction matters.
   */
  branch?: string;
}

export async function loadWorkingCopy(projectId: string): Promise<WorkingCopySummary | null> {
  try {
    const { copy } = await api<{ copy: WorkingCopySummary }>(`/api/projects/${projectId}/working`);
    return copy;
  } catch {
    return null;
  }
}

export async function loadMessages<T = unknown>(projectId: string, serverChatId: string): Promise<T[]> {
  const { chat } = await api<{ chat: { messages: T[] } }>(`/api/projects/${projectId}/messages/${serverChatId}`);
  return chat.messages;
}

/**
 * Forget one conversation. The project and its other chats survive.
 *
 * Absent-is-fine: a chat that was never saved to the server (nothing in it yet, or an older local-only
 * chat) has no server id, so the caller simply does not call this.
 */
export async function deleteChat(projectId: string, serverChatId: string): Promise<void> {
  await api<{ ok: true }>(`/api/projects/${projectId}/messages/${serverChatId}`, { method: 'DELETE' });
}

/**
 * Rename one conversation ON THE SERVER (§4.5.6).
 *
 * The sidebar is the server's chat list, so this is the write that makes a rename real: a rename that
 * only touched IndexedDB was overwritten on the next list refresh (the server title wins in
 * `mergeChatList`) and never existed on any other device — which read as "renames don't save".
 */
export async function renameServerChat(projectId: string, serverChatId: string, title: string): Promise<void> {
  await api<{ ok: true }>(`/api/projects/${projectId}/messages/${serverChatId}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
}

/* ------------------------------------------------------------------ branches */

/*
 * The branch client (§4.13a).
 *
 * Every helper below follows the OUTCOME convention the git functions on this page deliberately use
 * rather than `api()`'s throw. These operations replace the user's whole working tree or write to
 * their own account, so a failure has to be LOUD at the call site — and a thrown error at a caller
 * that forgot a `catch` is the opposite of loud: it is a spinner that stops and a user who does not
 * know why. The caller must read `ok`.
 *
 * ⚠️ **None of them accepts or forwards a credential.** The server resolves it from the session
 * (`no-client-token.spec.ts`); a `token` parameter here would be the deleted browser-PAT flow coming
 * back through a new door.
 *
 * The summary shapes are declared HERE rather than imported from `~/lib/.server/git/provider`, which
 * is server-only — importing it would pull the adapters (and their secrets reach) into the client
 * bundle. They are the wire shape, so they must stay structurally identical to the server's.
 */

/** One branch, as the picker and the switch decision need it. Mirrors the server's `BranchSummary`. */
export interface BranchSummary {
  name: string;
  head: string;
  isDefault: boolean;

  /** Advisory. The provider owns the rule — DIM a protected branch, never treat its absence as permission. */
  protected: boolean;
}

/** One commit for the history list. Short message only — never a diff. Mirrors `CommitSummary`. */
export interface CommitSummary {
  sha: string;
  message: string;
  author: string;
  date: string;
}

/** What every branch helper returns when it did not work. */
export interface BranchOutcomeBase {
  ok: boolean;

  /** The provider connection lapsed; send the user back through OAuth. */
  reconnect?: boolean;

  /** Worth trying again (rate limit, transport). A refused branch name is not. */
  retryable?: boolean;
  message?: string;
}

export interface ListBranchesOutcome extends BranchOutcomeBase {
  branches?: BranchSummary[];
}

export interface ListCommitsOutcome extends BranchOutcomeBase {
  commits?: CommitSummary[];

  /** Absent = the end of the history. Never an empty string, which reads as "there is more". */
  nextCursor?: string;
}

/** A read or a replacement that carries a tree. `files` is normalised at the fetch boundary. */
export interface BranchTreeOutcome extends BranchOutcomeBase {
  files?: SerializedFileMap;
  head?: string;
  branch?: string;
}

export interface BranchWriteOutcome extends BranchOutcomeBase {
  branch?: string;
  head?: string;

  /**
   * `'name-taken'` — the branch already exists. The route echoes the TYPED name back in `name` so
   * the dialog can put it straight back in the field for editing; it never suffixes to `-2` and
   * never adopts, for `ensureRepo`'s reason (a name the user did not choose is a surprise, and
   * adopting somebody else's branch is destructive).
   *
   * ⚠️ Read the wire's own field rather than re-deriving a boolean here: the server already decides
   * this, and a second predicate on the client is two readers of one fact.
   */
  kind?: string;
  name?: string;
}

/**
 * One POST to the project git route, parsed into an outcome.
 *
 * ⚠️ Written ONCE, for the reason `isSecretPath` is one rule in one place: seven copies of the
 * "parse, fall back on a non-JSON body, log a failure" dance is seven chances for one of them to
 * turn an HTML 500 page into an unhandled `SyntaxError` at the call site.
 */
async function postGitOp<T extends BranchOutcomeBase>(
  projectId: string,
  body: Record<string, unknown>,
  transportMessage: string,
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`/api/projects/${projectId}/github`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, retryable: true, message: transportMessage } as T;
  }

  const payload = (await response.json().catch(() => null)) as (T & { error?: boolean; isRetryable?: boolean }) | null;

  if (!payload) {
    // A non-JSON body (an HTML 500 page) must not become a silent success or an unhandled throw.
    return {
      ok: false,
      retryable: response.status >= 500,
      message: `The server returned an error (${response.status}).`,
    } as T;
  }

  if (!payload.ok) {
    logger.error(`Git op ${String(body.op)} failed for ${projectId}: ${payload.message ?? response.status}`);

    /*
     * The route's refusals carry `{ error: true, message }` and no `ok` at all, so an outcome built
     * from the payload alone would be `{ ok: undefined }` — falsy, but not the `false` the callers
     * and their tests read. Normalised here so every refusal has the same shape.
     */
    /*
     * ⚠️ THE RETRY SIGNAL HAS TWO SPELLINGS ON THE WIRE, and reading only one reports every failure
     * of the other class as "not worth retrying".
     *
     * `providerErrorResponse` (the git route's own mapper) sends `retryable`. Anything that is NOT a
     * `GitProviderError` — a store failure, a bug — rethrows to `http.ts`'s uniform envelope, which
     * sends **`isRetryable`**. Same fact, two field names, and the second one is invisible to a
     * client that only knows the first: a JSON-bodied 500 would arrive as `retryable: undefined`
     * while the NON-JSON 500 path two lines up correctly infers `true` from the status. Collapsed
     * here, at the one boundary that sees both, rather than at each of the seven call sites.
     */
    return {
      ...payload,
      ok: false,
      retryable: payload.retryable ?? payload.isRetryable ?? response.status >= 500,
      message: payload.message ?? `The server returned an error (${response.status}).`,
    };
  }

  return payload;
}

/** Every branch in the project's linked repository. An empty repository legitimately returns `[]`. */
export async function listBranches(projectId: string): Promise<ListBranchesOutcome> {
  return postGitOp<ListBranchesOutcome>(
    projectId,
    { op: 'branches' },
    'Could not reach the server to read the branches.',
  );
}

/** One bounded page of a branch's history. `limit` is clamped server-side; a bad value never refuses. */
export async function listCommits(
  projectId: string,
  input: { branch?: string; limit?: number; cursor?: string } = {},
): Promise<ListCommitsOutcome> {
  return postGitOp<ListCommitsOutcome>(
    projectId,
    { op: 'commits', ...input },
    'Could not reach the server to read the history.',
  );
}

/**
 * Read a branch's tree WITHOUT agreeing with it — the Review-changes read.
 *
 * The difference between this and `pullFromRepo` is a line the server deliberately omits: it does not
 * move `lastSyncedCommitSha`. Looking at a branch is not agreeing with it.
 */
export async function readBranchTree(projectId: string, input: { branch?: string } = {}): Promise<BranchTreeOutcome> {
  const outcome = await postGitOp<BranchTreeOutcome>(
    projectId,
    { op: 'tree', ...input },
    'Could not reach the server to read the branch.',
  );

  return withNormalizedFiles(outcome);
}

/**
 * Create a branch from what the user is looking at, and point the project at it.
 *
 * **No file is touched** — the in-progress work carries onto the new branch, which is the whole
 * feature. A collision returns `kind: 'name-taken'` with the typed name intact in `name` for
 * editing; it never suffixes and never adopts.
 */
export async function createBranch(projectId: string, name: string): Promise<BranchWriteOutcome> {
  return postGitOp<BranchWriteOutcome>(
    projectId,
    { op: 'create-branch', name },
    'Could not reach the server to create the branch.',
  );
}

/**
 * Delete a branch in the user's own repository.
 *
 * ⚠️ The one operation in this group with **no undo** — a checkpoint is a snapshot of FILES and
 * cannot restore a remote ref. The current branch and the repository default are refused server-side,
 * each with its own sentence.
 */
export async function deleteBranch(projectId: string, name: string): Promise<BranchWriteOutcome> {
  return postGitOp<BranchWriteOutcome>(
    projectId,
    { op: 'delete-branch', name },
    'Could not reach the server to delete the branch.',
  );
}

/**
 * Switch the project to another branch: read its tree and move the link tuple to it.
 *
 * The server writes BOTH tuple fields in one update against the head it actually just read. The
 * caller applies the returned files through `applyBranchTree` — never by re-mounting.
 */
export async function switchBranch(projectId: string, branch: string): Promise<BranchTreeOutcome> {
  const outcome = await postGitOp<BranchTreeOutcome>(
    projectId,
    { op: 'switch-branch', branch },
    'Could not reach the server to switch branches. Your work is still here — try again.',
  );

  return withNormalizedFiles(outcome);
}

/**
 * Read the project's own branch back, so the client can reset to it.
 *
 * The pointer is NOT moved — it already names this branch, and the client is the party that decides
 * whether the reset landed. Refused for an unlinked project: there is nothing to reset *to*, and it
 * must never degrade to "delete everything".
 */
export async function discardChanges(projectId: string): Promise<BranchTreeOutcome> {
  const outcome = await postGitOp<BranchTreeOutcome>(
    projectId,
    { op: 'discard' },
    'Could not reach the server. Your work is still here — try again.',
  );

  return withNormalizedFiles(outcome);
}

/**
 * Fetch-boundary normalization, exactly as `getRepoStatus`/`pullFromRepo`/`cloneRepoIntoProject` do.
 *
 * A damaged repo (one carrying a nested workdir prefix) must not round-trip its damage into the
 * sandbox — and these files are about to REPLACE the working tree, so a wrong prefix here is not a
 * cosmetic path bug, it is a restore that deletes everything it failed to match.
 */
function withNormalizedFiles(outcome: BranchTreeOutcome): BranchTreeOutcome {
  return outcome.files ? { ...outcome, files: normalizeRepoFileMap(outcome.files) } : outcome;
}
