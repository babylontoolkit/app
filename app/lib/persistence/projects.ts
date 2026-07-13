/**
 * The client's door to server-side persistence (SPEC §4.5, §4.5.5, §4.12).
 *
 * Everything the browser knows about projects and checkpoints goes through here. Two rules hold the
 * design together:
 *
 * 1. **The server is the source of truth for FILES.** Upstream bolt.diy keeps one snapshot per chat in
 *    IndexedDB, overwritten on every message — so a project lives in exactly one browser, has no
 *    history, and dies with the tab. Everything Stage 4 wants (share, gallery, remix, GitHub sync)
 *    means handing someone else a project, which is impossible if the project only exists locally.
 *
 * 2. **Never send a `projectId` we did not get from the server.** It is checked on every route
 *    (`requireOwnedProject`), and a project that is not yours reports 404 — not 403 — because a 403
 *    would confirm the id exists and turn the route into an enumeration oracle (§4.5.3).
 *
 * Snapshot payloads are `SerializedFileMap`: the same codec the WebContainer serializes to, so binary
 * bytes survive the round trip base64-encoded as a WIRE format (never as live store state).
 */
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import type { Project, SnapshotList, SnapshotSummary } from '~/types/project';
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

/* --------------------------------------------------------------- snapshots */

/**
 * Take a checkpoint (§4.12).
 *
 * `messageId` is what makes the version history usable: it anchors the checkpoint to the assistant
 * message that produced it, which is how "restore to before this change" knows where "before" is.
 */
export async function createSnapshot(
  projectId: string,
  input: { files: SerializedFileMap; messageId?: string; label?: string },
): Promise<SnapshotSummary> {
  const { snapshot } = await api<{ snapshot: SnapshotSummary }>(`/api/projects/${projectId}/snapshots`, {
    method: 'POST',
    body: JSON.stringify(input),
  });

  return snapshot;
}

export async function listSnapshots(projectId: string): Promise<SnapshotList> {
  return api<SnapshotList>(`/api/projects/${projectId}/snapshots`);
}

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
 * Move the project's `currentSnapshotId` pointer.
 *
 * NOTE the route's shape: this is a POST. `DELETE` on the same URL does NOT delete a snapshot — there
 * is no snapshot-delete endpoint at all, by design. History is append-only: a restore adds a new
 * checkpoint rather than destroying the ones after it, so a user can always get back to where they
 * were (§4.12).
 */
export async function setCurrentSnapshot(projectId: string, snapshotId: string): Promise<void> {
  await api<{ ok: true }>(`/api/projects/${projectId}/snapshots/${snapshotId}`, { method: 'POST' });
}

/**
 * Fetch the files of the checkpoint the project currently points at — the "resume" read.
 *
 * Returns `{ files: undefined }` for a project with no checkpoint yet, which is a normal state (it
 * exists between "project created" and "first snapshot taken"), not an error.
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
