/**
 * The user's local Unity dev-server origin, remembered per project (D52). Lives here — not in the
 * bridge store — so local-scene code never depends on the bridge being paired or even loaded.
 *
 * `localStorage` can throw (private window, blocked site data), so every access is guarded: a read
 * that throws is "nothing remembered", a write that throws is a no-op. Neither may break the caller.
 */

const keyFor = (projectId: string) => `bt_local_scene_server:${projectId}`;

export function readLocalSceneServer(projectId: string): string | null {
  try {
    return localStorage.getItem(keyFor(projectId));
  } catch {
    return null;
  }
}

/** `null` forgets the origin. */
export function saveLocalSceneServer(projectId: string, origin: string | null): void {
  try {
    if (origin === null) {
      localStorage.removeItem(keyFor(projectId));
    } else {
      localStorage.setItem(keyFor(projectId), origin);
    }
  } catch {
    /* Remembering is a convenience; failing to remember must never fail the import. */
  }
}
