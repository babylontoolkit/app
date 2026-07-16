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
  input: { files: SerializedFileMap; summary?: string },
): Promise<SaveOutcome> {
  let response: Response;

  try {
    response = await fetch(`/api/projects/${projectId}/github`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
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

/* --------------------------------------------------------------- snapshots */

/**
 * 🔴 There is no `createSnapshot` here any more (§4.5.4b), and adding one back is the regression.
 *
 * The browser used to POST the entire project to `/api/projects/:id/snapshots` after every generation.
 * Under repo-primary persistence the platform does not hold the user's code: checkpoints live in
 * IndexedDB (`local-snapshots.ts`) and saved work lives in the user's own repo. The server route
 * refuses the write, so a call added here would fail at runtime rather than quietly re-enable the old
 * model — but the honest place to say so is here, where someone reaching for "save the project" looks
 * first.
 *
 * `listSnapshots` and `setCurrentSnapshot` are gone for the same reason: the history they described is
 * local now.
 */

/** Read a checkpoint's payload back. This is the only call that moves real bytes — use it sparingly. */
export async function readSnapshot(
  projectId: string,
  snapshotId: string,
): Promise<{ snapshot: { id: string; label?: string; createdAt: string }; files: SerializedFileMap }> {
  return api<{ snapshot: { id: string; label?: string; createdAt: string }; files: SerializedFileMap }>(
    `/api/projects/${projectId}/snapshots/${snapshotId}`,
  );
}

/**
 * Read the project's server-side SEED, if it has one.
 *
 * The name is now slightly generous: this is not "the latest checkpoint", because the platform no
 * longer takes checkpoints. The only thing it can return is a remix seed — the one-time copy
 * `api.remix` leaves so a clone of a shared game has something to open, which exists because the
 * source's own repo belongs to a different person (§4.8, §4.5.4b).
 *
 * Returns `{}` for everything else, which is the normal case, not an error.
 */
export async function restoreLatestServerCheckpoint(
  projectId: string,
): Promise<{ snapshotId?: string; files?: SerializedFileMap }> {
  const project = await getProject(projectId);

  if (!project.currentSnapshotId) {
    return {};
  }

  const { files } = await readSnapshot(projectId, project.currentSnapshotId);

  return { snapshotId: project.currentSnapshotId, files };
}

/* ---------------------------------------------------------------- messages */

export async function saveMessages(projectId: string, messages: unknown[]): Promise<void> {
  await api<{ ok: true }>(`/api/projects/${projectId}/messages`, {
    method: 'PUT',
    body: JSON.stringify({ messages }),
  });
}

export async function loadMessages<T = unknown>(projectId: string): Promise<T[]> {
  const { messages } = await api<{ messages: T[] }>(`/api/projects/${projectId}/messages`);
  return messages;
}
