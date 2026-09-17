/**
 * A project folder on the user's OWN disk (SPEC §4.5.4d).
 *
 * The interface declares its own types on purpose — the same rule as `app/lib/sandbox/types.ts`. The
 * browser backend is the File System Access API (`FileSystemDirectoryHandle`), whose TypeScript lib
 * typings are incomplete (no `entries()`, no `queryPermission`), and an Electron backend would be a
 * `node:fs` bridge over IPC. Feature code sees only these shapes, so neither vendor leaks past here.
 *
 * Paths are PROJECT-RELATIVE (`src/main.ts`), never sandbox-absolute: a folder on disk has no
 * `/home/project`, and a caller that hands one in would create a `home/project/` subtree on the user's
 * disk. `fsa-store.ts` refuses absolute and traversing segments for that reason.
 */

export type LocalPermission = 'granted' | 'prompt' | 'denied';

/** The structural subset of the DOM `FileSystemFileHandle` this module uses. */
export interface LocalFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<LocalWritable>;
}

export interface LocalWritable {
  write(data: Uint8Array | string): Promise<void>;
  close(): Promise<void>;
}

/** The structural subset of the DOM `FileSystemDirectoryHandle` this module uses. */
export interface LocalDirectoryHandle {
  readonly kind: 'directory';
  readonly name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<LocalDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<LocalFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterableIterator<[string, LocalFileHandle | LocalDirectoryHandle]>;
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<LocalPermission>;
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<LocalPermission>;
}

/** One entry of a disk index — what a cheap "did anything change out there?" comparison needs. */
export interface DiskFileStamp {
  size: number;
  lastModified: number;
}

/** `rel → stamp` for every file in the folder that the mirror cares about. */
export type DiskIndex = Record<string, DiskFileStamp>;

/**
 * The marker written at the root of every project folder. It is what answers "does this folder belong
 * to THIS project?" — the folder NAME cannot, because two projects called "Kart Racer" on one machine
 * are ordinary, and mounting the wrong one would be a silent catastrophe (someone else's game, on
 * screen, pushed to this project's repo).
 */
export interface ProjectMarker {
  projectId: string;
  name: string;
  createdAt: string;
}

export const PROJECT_MARKER_FILE = '.btk-project.json';
