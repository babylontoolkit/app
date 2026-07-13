/**
 * The second wall (SPEC §4.5.3).
 *
 * RLS is the backstop. THIS is the front door: every server route that touches a project resolves the
 * session and then proves that this user owns that project. The two are not redundant —
 *
 * - RLS alone cannot protect the paths that legitimately use the service-role key (grants, Stripe
 *   webhooks, entitlement upserts), because service-role BYPASSES RLS by design. Our project store
 *   uses the admin client, so without this check there would be NO ownership enforcement at all.
 * - This check alone cannot survive a route that forgets to call it. RLS catches that.
 *
 * The single most likely way to leak another user's game is a route that reads `params.projectId`
 * straight from the URL and trusts it. `requireOwnedProject` is the only correct way to turn a
 * project id from the client into a project.
 */
import { createScopedLogger } from '~/utils/logger';
import { ForbiddenError, type AuthUser } from '~/lib/.server/supabase/auth';
import { getProjectStore } from './store';
import type { Project } from './types';

const logger = createScopedLogger('ownership');

export class NotFoundError extends Error {
  readonly statusCode = 404;
  readonly isRetryable = false;

  constructor(message = 'Not found.') {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * Resolve a client-supplied project id to a project this user owns, or throw.
 *
 * A project owned by someone else reports **404, not 403**. 403 would confirm the id exists, turning
 * this endpoint into an oracle that lets an attacker enumerate valid project ids. The user is told
 * only what a user with no such project would be told.
 */
export async function requireOwnedProject(user: AuthUser, projectId: string, context?: unknown): Promise<Project> {
  const project = await getProjectStore(context).get(projectId);

  if (!project) {
    throw new NotFoundError('That project does not exist.');
  }

  if (project.userId !== user.id) {
    logger.warn(`Ownership denied: user ${user.id} requested project ${projectId} owned by ${project.userId}`);
    throw new NotFoundError('That project does not exist.');
  }

  return project;
}

/** Same, for routes that also need the snapshot to belong to that project. */
export async function assertSnapshotBelongsTo(project: Project, snapshotProjectId: string): Promise<void> {
  if (snapshotProjectId !== project.id) {
    logger.warn(`Snapshot/project mismatch: snapshot belongs to ${snapshotProjectId}, not ${project.id}`);
    throw new ForbiddenError('That checkpoint does not belong to this project.');
  }
}
