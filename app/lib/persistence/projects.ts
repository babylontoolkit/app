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
import type { SerializedFileMap } from '~/lib/binary/binary-files';
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

    return { files: payload.files, head: payload.head };
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

    return payload;
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
export async function saveWorkingCopy(projectId: string, seq: number, files: SerializedFileMap): Promise<void> {
  await api<{ ok: true; seq: number }>(`/api/projects/${projectId}/working`, {
    method: 'PUT',
    body: JSON.stringify({ seq, files }),
  });
}

/**
 * The server's recovery copy, or `null` when there is none.
 *
 * `null` means "this project has no copy" — an ordinary state for a project that has never
 * checkpointed, and also what the server returns for bytes it could not parse or order. It is never a
 * reason to fail a mount: the caller falls back to its other sources (`mount-source.ts`).
 */
export async function loadWorkingCopy(
  projectId: string,
): Promise<{ seq: number; updatedAt: string; files: SerializedFileMap } | null> {
  try {
    const { copy } = await api<{ copy: { seq: number; updatedAt: string; files: SerializedFileMap } }>(
      `/api/projects/${projectId}/working`,
    );
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
