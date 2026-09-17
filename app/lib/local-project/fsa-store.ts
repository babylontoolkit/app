/**
 * A project folder over a `LocalDirectoryHandle` (SPEC §4.5.4d).
 *
 * The one place that walks, reads and writes the user's disk. Everything is project-relative and
 * validated: the mirror hands in paths the SANDBOX reported, and a sandbox path that somehow escaped
 * the project (`../`, an absolute path) must never be able to write outside the folder the user chose.
 * That is a wall, not tidiness — this module has write access to a real directory on a real machine.
 */
import {
  PROJECT_MARKER_FILE,
  type DiskFileStamp,
  type DiskIndex,
  type LocalDirectoryHandle,
  type ProjectMarker,
} from './types';
import { buildProjectMarker, candidateDirNames, parseProjectMarker, slugForFolder } from './dir-name';

export class LocalPathError extends Error {
  constructor(rel: string, reason: string) {
    super(`Refusing to touch "${rel}" on disk: ${reason}`);
    this.name = 'LocalPathError';
  }
}

export class FolderTooLargeError extends Error {
  constructor(
    readonly count: number,
    readonly limit: number,
  ) {
    super(`This folder holds more than ${limit.toLocaleString()} files (${count.toLocaleString()} counted).`);
    this.name = 'FolderTooLargeError';
  }
}

/** Split a project-relative path into segments, refusing anything that could leave the folder. */
export function splitRelativePath(rel: string): string[] {
  if (rel.length === 0 || rel.startsWith('/') || rel.startsWith('\\') || /^[a-zA-Z]:/.test(rel)) {
    throw new LocalPathError(rel, 'not a project-relative path');
  }

  const segments = rel.split('/');

  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || segment.includes('\\')) {
      throw new LocalPathError(rel, 'contains an empty, "." or ".." segment');
    }
  }

  return segments;
}

export interface ProjectFolderOptions {
  /** Directory NAMES never read or written, at any depth — `MAP_EXCLUDED_DIRS` at the call site. */
  isExcludedDir: (name: string) => boolean;

  /** Refuse to read a folder holding more files than this. */
  maxFiles?: number;
}

export interface DiskTree {
  /** Project-relative path → bytes, files only. */
  files: Record<string, Uint8Array>;

  /** Project-relative paths of every directory seen, so empty folders survive the round trip. */
  directories: string[];
  index: DiskIndex;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError');
}

export class ProjectFolder {
  constructor(
    readonly root: LocalDirectoryHandle,
    private readonly _options: ProjectFolderOptions,
  ) {}

  get name(): string {
    return this.root.name;
  }

  /** Is this path one the mirror should ignore entirely (excluded dir at any depth, or the marker)? */
  isIgnored(rel: string): boolean {
    const segments = rel.split('/');

    if (segments.length === 1 && segments[0] === PROJECT_MARKER_FILE) {
      return true;
    }

    return segments.slice(0, -1).some((segment) => this._options.isExcludedDir(segment));
  }

  private async _dir(segments: string[], create: boolean): Promise<LocalDirectoryHandle | undefined> {
    let current = this.root;

    for (const segment of segments) {
      try {
        current = await current.getDirectoryHandle(segment, { create });
      } catch (error) {
        if (!create && isNotFound(error)) {
          return undefined;
        }

        throw error;
      }
    }

    return current;
  }

  async readFile(rel: string): Promise<Uint8Array | undefined> {
    const segments = splitRelativePath(rel);
    const dir = await this._dir(segments.slice(0, -1), false);

    if (!dir) {
      return undefined;
    }

    try {
      const handle = await dir.getFileHandle(segments[segments.length - 1]);
      const file = await handle.getFile();

      return new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }

      throw error;
    }
  }

  async stat(rel: string): Promise<DiskFileStamp | undefined> {
    const segments = splitRelativePath(rel);
    const dir = await this._dir(segments.slice(0, -1), false);

    if (!dir) {
      return undefined;
    }

    try {
      const file = await (await dir.getFileHandle(segments[segments.length - 1])).getFile();
      return { size: file.size, lastModified: file.lastModified };
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }

      throw error;
    }
  }

  /** Write bytes, creating parent directories. Returns the stamp the file carries afterwards. */
  async writeFile(rel: string, data: Uint8Array | string): Promise<DiskFileStamp> {
    const segments = splitRelativePath(rel);
    const dir = (await this._dir(segments.slice(0, -1), true))!;
    const handle = await dir.getFileHandle(segments[segments.length - 1], { create: true });
    const writable = await handle.createWritable();

    /*
     * A `Uint8Array` that is a VIEW into a larger buffer (a slice of the sandbox's storage) must be
     * written as its own bytes — `write()` takes the view's bytes, not the whole buffer, but the
     * caller may hand us borrowed memory (spec/sandbox-seam.md: bytes are ON LOAN), so copy first.
     */
    await writable.write(typeof data === 'string' ? data : new Uint8Array(data));
    await writable.close();

    const file = await handle.getFile();

    return { size: file.size, lastModified: file.lastModified };
  }

  async mkdir(rel: string): Promise<void> {
    await this._dir(splitRelativePath(rel), true);
  }

  /** Remove a file or directory (recursively). A path that is already gone is not an error. */
  async remove(rel: string): Promise<void> {
    const segments = splitRelativePath(rel);
    const dir = await this._dir(segments.slice(0, -1), false);

    if (!dir) {
      return;
    }

    try {
      await dir.removeEntry(segments[segments.length - 1], { recursive: true });
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }

  /**
   * Walk the folder. `withBytes: false` reads only stamps (the change poll); `true` reads every file
   * (a mount). Excluded directory names are skipped at any depth and the marker is never included.
   */
  async readTree(options: { withBytes: boolean }): Promise<DiskTree> {
    const files: Record<string, Uint8Array> = {};
    const directories: string[] = [];
    const index: DiskIndex = {};
    const limit = this._options.maxFiles ?? Number.POSITIVE_INFINITY;
    let count = 0;

    const walk = async (dir: LocalDirectoryHandle, prefix: string): Promise<void> => {
      for await (const [name, entry] of dir.entries()) {
        const rel = prefix ? `${prefix}/${name}` : name;

        if (entry.kind === 'directory') {
          if (this._options.isExcludedDir(name)) {
            continue;
          }

          directories.push(rel);
          await walk(entry, rel);
          continue;
        }

        if (!prefix && name === PROJECT_MARKER_FILE) {
          continue;
        }

        count++;

        if (count > limit) {
          throw new FolderTooLargeError(count, limit);
        }

        const file = await entry.getFile();
        index[rel] = { size: file.size, lastModified: file.lastModified };

        if (options.withBytes) {
          files[rel] = new Uint8Array(await file.arrayBuffer());
        }
      }
    };

    await walk(this.root, '');

    return { files, directories, index };
  }

  async readMarker(): Promise<ProjectMarker | undefined> {
    const bytes = await this.readFile(PROJECT_MARKER_FILE);
    return bytes ? parseProjectMarker(new TextDecoder().decode(bytes)) : undefined;
  }

  async writeMarker(marker: ProjectMarker): Promise<void> {
    await this.writeFile(PROJECT_MARKER_FILE, JSON.stringify(marker, null, 2) + '\n');
  }
}

/* ----------------------------------------------------------------- locating a project's folder */

async function markerOf(dir: LocalDirectoryHandle, options: ProjectFolderOptions): Promise<ProjectMarker | undefined> {
  try {
    return await new ProjectFolder(dir, options).readMarker();
  } catch {
    return undefined;
  }
}

/**
 * Find THIS project's folder under the parent, by MARKER — never by name. Tries the slug first (the
 * common case, one read), then every subfolder's marker (a rename, or a project created before the
 * slug rule changed). `undefined` = no folder on this disk belongs to the project.
 */
export async function findProjectFolder(
  parent: LocalDirectoryHandle,
  projectId: string,
  name: string | undefined,
  options: ProjectFolderOptions,
): Promise<ProjectFolder | undefined> {
  const slug = slugForFolder(name);

  try {
    const dir = await parent.getDirectoryHandle(slug);
    const marker = await markerOf(dir, options);

    if (marker?.projectId === projectId) {
      return new ProjectFolder(dir, options);
    }
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }

  for await (const [, entry] of parent.entries()) {
    if (entry.kind !== 'directory') {
      continue;
    }

    const marker = await markerOf(entry, options);

    if (marker?.projectId === projectId) {
      return new ProjectFolder(entry, options);
    }
  }

  return undefined;
}

/**
 * Create the project's folder under the parent: the slug, or `slug-2`, `slug-3`… when a folder of
 * that name already exists and is NOT this project's (a marker naming another project, or no marker at
 * all — a folder we did not make is never adopted, for the same reason Save never adopts a repo).
 */
export async function createProjectFolder(
  parent: LocalDirectoryHandle,
  projectId: string,
  name: string | undefined,
  options: ProjectFolderOptions,
): Promise<ProjectFolder> {
  const existing = await findProjectFolder(parent, projectId, name, options);

  if (existing) {
    return existing;
  }

  for (const dirName of candidateDirNames(slugForFolder(name))) {
    let taken = true;

    try {
      await parent.getDirectoryHandle(dirName);
    } catch (error) {
      if (isNotFound(error)) {
        taken = false;
      } else {
        throw error;
      }
    }

    if (taken) {
      continue;
    }

    const dir = await parent.getDirectoryHandle(dirName, { create: true });
    const folder = new ProjectFolder(dir, options);
    await folder.writeMarker(buildProjectMarker(projectId, name ?? ''));

    return folder;
  }

  throw new Error(`Could not find a free folder name for "${name}" in ${parent.name}.`);
}
