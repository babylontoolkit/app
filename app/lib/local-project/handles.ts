/**
 * The persisted PARENT folder handle + the browser capability check (SPEC §4.5.4d).
 *
 * A `FileSystemDirectoryHandle` is structured-cloneable, so it can be stored in IndexedDB and read back
 * on the next visit — that is what turns "pick a folder" from a per-session chore into a one-time
 * setup. What does NOT persist is the PERMISSION: browsers re-ask once per session (Chrome 122+ can
 * remember it for an installed PWA), and `requestPermission` must run inside a user gesture, so the
 * boot path cannot re-grant it silently. Hence the split here: `query` is free and silent, `request`
 * is for a button.
 *
 * Its own tiny database, not a new store in `boltHistory`: that schema is upstream's plus three
 * versions of ours, and a handle keyed by ACCOUNT (§4.5.3a third wall) has nothing to do with chats.
 */
import type { LocalViewer } from '~/lib/persistence/local-owner';
import type { LocalDirectoryHandle, LocalPermission } from './types';

const DB_NAME = 'btk-local-projects';
const STORE = 'parents';

/** Is the File System Access API — with WRITE access to a picked folder — available here? */
export function isLocalFolderSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
  );
}

/**
 * Which account's parent folder. A signed-in user's id; in local mode `viewerFromSession` already
 * names the single developer (`LOCAL_SINGLE_USER_ID`), so it is the same rule. `unknown` (session not
 * loaded) and `nobody` (accounts exist, nobody signed in) both answer `undefined`: a folder on this
 * machine is scoped to an account (§4.5.3a), and an anonymous browser gets none.
 */
export function ownerKeyFor(viewer: LocalViewer): string | undefined {
  return viewer.status === 'user' ? viewer.id : undefined;
}

function openDb(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(undefined);
  }

  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'owner' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadParentHandle(owner: string): Promise<LocalDirectoryHandle | undefined> {
  const db = await openDb();

  if (!db) {
    return undefined;
  }

  try {
    const row = await requestToPromise(db.transaction(STORE, 'readonly').objectStore(STORE).get(owner));
    return (row as { handle?: LocalDirectoryHandle } | undefined)?.handle;
  } finally {
    db.close();
  }
}

export async function saveParentHandle(owner: string, handle: LocalDirectoryHandle): Promise<void> {
  const db = await openDb();

  if (!db) {
    throw new Error('IndexedDB is not available, so the folder cannot be remembered.');
  }

  try {
    await requestToPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).put({ owner, handle }));
  } finally {
    db.close();
  }
}

export async function clearParentHandle(owner: string): Promise<void> {
  const db = await openDb();

  if (!db) {
    return;
  }

  try {
    await requestToPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(owner));
  } finally {
    db.close();
  }
}

/** Silent. A handle from an implementation without the permission API is treated as granted. */
export async function queryFolderPermission(handle: LocalDirectoryHandle): Promise<LocalPermission> {
  if (!handle.queryPermission) {
    return 'granted';
  }

  try {
    return await handle.queryPermission({ mode: 'readwrite' });
  } catch {
    return 'denied';
  }
}

/** MUST run inside a user gesture (a click), or the browser answers `denied` without asking. */
export async function requestFolderPermission(handle: LocalDirectoryHandle): Promise<LocalPermission> {
  if (!handle.requestPermission) {
    return 'granted';
  }

  try {
    return await handle.requestPermission({ mode: 'readwrite' });
  } catch {
    return 'denied';
  }
}

/** The picker. User gesture only; `undefined` when the user cancelled. */
export async function pickParentFolder(): Promise<LocalDirectoryHandle | undefined> {
  const picker = (
    window as unknown as {
      showDirectoryPicker: (options?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<LocalDirectoryHandle>;
    }
  ).showDirectoryPicker;

  try {
    return await picker({ mode: 'readwrite', id: 'btk-projects' });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return undefined;
    }

    throw error;
  }
}
