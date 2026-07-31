/**
 * The IMPORT handoff — "the load you are about to do is a folder/repo import" (SPEC §4.1a).
 *
 * A sibling of `pending-remix.ts`, and for a sibling reason: the thing that knows an import is
 * happening (`ImportFolderButton`, `GitCloneButton`, the `/git` route) is not the thing that has to
 * draw the wait. `importChat` finishes by setting `window.location.href`, so the importing page is
 * TORN DOWN — every React state, store and promise it was holding goes with it, and the load that
 * comes back has no way of telling an import apart from an ordinary open of an existing chat.
 *
 * 🔴 That matters because import is the one door where the files cannot arrive before the chat does.
 * Both importers build a chat whose assistant message is a `<boltArtifact>` of every file, and those
 * land through the message parser's action replay — which only runs once the chat is rendered. So the
 * splash cannot be a `ready` gate here the way it is for a mount (that would deadlock: no chat, no
 * replay, no files). It has to be the overlay, and the overlay needs to know to draw itself.
 *
 * sessionStorage for the same reasons as the mount baton: it survives a full page load without putting
 * anything in the URL, and it is same-tab only, so a second tab never inherits somebody else's import.
 * Read-once, so a later refresh of the same chat does not re-open a splash over a project whose files
 * landed long ago.
 */
export const PENDING_IMPORT_KEY = 'pendingImportInProgress';

/**
 * Mark the next page load as the tail of an import.
 *
 * Called by `importChat` — the single choke point every importer already goes through — rather than by
 * each importer, so a new import surface gets the splash by construction instead of by remembering.
 */
export function setPendingImport(): void {
  if (typeof sessionStorage === 'undefined') {
    return;
  }

  sessionStorage.setItem(PENDING_IMPORT_KEY, '1');
}

/**
 * Non-consuming peek. Exists so a first render can decide what to draw, before the effect that
 * consumes the baton has run — the same split `hasPendingProjectMount` documents.
 */
export function hasPendingImport(): boolean {
  if (typeof sessionStorage === 'undefined') {
    return false;
  }

  return sessionStorage.getItem(PENDING_IMPORT_KEY) !== null;
}

/** The consuming read: true once, for the load that follows the import. */
export function takePendingImport(): boolean {
  if (typeof sessionStorage === 'undefined') {
    return false;
  }

  const pending = sessionStorage.getItem(PENDING_IMPORT_KEY) !== null;

  if (pending) {
    sessionStorage.removeItem(PENDING_IMPORT_KEY);
  }

  return pending;
}
