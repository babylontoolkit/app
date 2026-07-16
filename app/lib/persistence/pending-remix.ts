/**
 * The remix / open handoff (SPEC §4.8, §4.1).
 *
 * `/remix/:shareId` clones a game server-side, then navigates to the builder. But the builder is the
 * only place the WebContainer and workbench exist, so the newly-cloned project's files must be mounted
 * THERE, not on the remix page. This tiny module is the baton: the remix page writes the new project
 * id, the builder reads it once on load and mounts the project through the same server-checkpoint path
 * a normal resume uses.
 *
 * The Dashboard ("All Projects", §4.1) needs the exact same baton for a different reason: a project the
 * platform owns may have NO local chat in *this* browser (created on another device, or a remix the
 * user navigated away from before the first message persisted). When there is no `/chat/:urlId` to open,
 * the dashboard drops the project id here and lets the builder mount its files fresh — same mechanism,
 * different key so the two intents never get confused.
 *
 * sessionStorage (not a query param) because it survives the `navigate('/')` without putting a project
 * id in the URL, and it is same-tab only — a second tab does not accidentally inherit the mount.
 */
export const PENDING_REMIX_KEY = 'pendingRemixProjectId';
export const PENDING_OPEN_KEY = 'pendingOpenProjectId';

/** Park a project id for the builder to mount on its next load (dashboard "Open" with no local chat). */
export function setPendingOpenProject(projectId: string): void {
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.setItem(PENDING_OPEN_KEY, projectId);
  }
}

function takeKey(key: string): string | null {
  if (typeof sessionStorage === 'undefined') {
    return null;
  }

  const id = sessionStorage.getItem(key);

  if (id) {
    // Read-once: clear immediately so a refresh does not re-mount over later work.
    sessionStorage.removeItem(key);
  }

  return id;
}

export function takePendingRemix(): string | null {
  return takeKey(PENDING_REMIX_KEY);
}

/**
 * The single reader the builder calls on a fresh mount: either a just-cloned remix or a dashboard
 * "open" resolves to the same thing — a project id whose files should be mounted into a fresh chat.
 * Open takes precedence (it is the more explicit user action), then remix.
 */
export function takePendingProjectMount(): string | null {
  return takeKey(PENDING_OPEN_KEY) ?? takeKey(PENDING_REMIX_KEY);
}
