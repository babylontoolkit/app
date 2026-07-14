/**
 * The remix handoff (SPEC §4.8).
 *
 * `/remix/:shareId` clones a game server-side, then navigates to the builder. But the builder is the
 * only place the WebContainer and workbench exist, so the newly-cloned project's files must be mounted
 * THERE, not on the remix page. This tiny module is the baton: the remix page writes the new project
 * id, the builder reads it once on load and mounts the project through the same server-checkpoint path
 * a normal resume uses.
 *
 * sessionStorage (not a query param) because it survives the `navigate('/')` without putting a project
 * id in the URL, and it is same-tab only — a second tab does not accidentally inherit the remix.
 */
export const PENDING_REMIX_KEY = 'pendingRemixProjectId';

export function takePendingRemix(): string | null {
  if (typeof sessionStorage === 'undefined') {
    return null;
  }

  const id = sessionStorage.getItem(PENDING_REMIX_KEY);

  if (id) {
    // Read-once: clear immediately so a refresh does not re-mount the remix over later work.
    sessionStorage.removeItem(PENDING_REMIX_KEY);
  }

  return id;
}
