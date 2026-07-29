/**
 * Undoing a project registration whose creation never landed (SPEC §4.4, §4.5.5).
 *
 * 🔴 **The project record is created FIRST now** — a server-backed sandbox cannot be booted for a
 * project that does not exist, so `createProject` moved to the top of phase 1. That order is correct
 * and it has a consequence: everything after it — the starter fetch, the sandbox boot, the mount —
 * can now fail with a project already on the books, where the old order left nothing behind at all.
 *
 * An empty project is not harmless. It lists on the dashboard as a card with no game in it, which
 * reads as data loss rather than as a failure that has already been reported; and it counts against
 * the per-user create budget on the retry the user is about to make.
 *
 * Rollback rather than adopt-on-retry: nothing was written, so there is nothing to adopt, and
 * "delete the row we made a second ago" needs no reconciliation rules to be correct.
 *
 * Extracted from the component that used to hold it inline, for the reason this codebase keeps
 * relearning: code that DELETES a user's project must be testable on its own, because every way it
 * can be wrong is silent. Its dependencies are injected for the same reason.
 */
export interface CreationRollback {
  /** The project registered at the top of phase 1, if registration got that far. */
  projectId?: string;

  /** How the row is removed — `deleteProject` in production, a double in tests. */
  remove: (projectId: string) => Promise<void>;

  /**
   * Drop every client-side pointer to the project BEFORE the row goes.
   *
   * Ordered deliberately: a chat saved in the window between the delete and the clear would name a
   * row that no longer exists, and its transcript would have nowhere to live (§4.5.6).
   *
   * Optional because not every caller has one to drop: an import registers its project without ever
   * publishing it to the stores, so there is genuinely nothing pointing at it.
   */
  clear?: () => void;

  /** Where a failed cleanup is reported. Never the user — see below. */
  onError?: (error: unknown) => void;
}

/**
 * Roll back an empty project registration.
 *
 * Never rejects. The creation failure is what the user needs to hear, and replacing it with "we could
 * not clean up" would report the wrong problem to the one person who cannot act on it.
 *
 * @returns whether there was a registration to roll back.
 */
export async function rollbackRegisteredProject(options: CreationRollback): Promise<boolean> {
  const { projectId, remove, clear, onError } = options;

  if (!projectId) {
    return false;
  }

  clear?.();

  try {
    await remove(projectId);
  } catch (error) {
    onError?.(error);
  }

  return true;
}
