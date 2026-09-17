/**
 * An in-memory `LocalDirectoryHandle` — the TEST DOUBLE for everything in this folder.
 *
 * 🔴 It performs the destructive half of every operation for real: `createWritable().close()`
 * replaces the bytes and bumps `lastModified`, `removeEntry` deletes, a missing entry throws the DOM's
 * `NotFoundError`. A double that stubs `write` proves nothing about a mirror (the working-copy detach
 * bug survived exactly such a stub — `working-copy-detach.spec.ts`). Not imported by app code.
 */
import type { LocalDirectoryHandle, LocalFileHandle, LocalPermission, LocalWritable } from './types';

function domError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;

  return error;
}

export class MemoryFile implements LocalFileHandle {
  readonly kind = 'file' as const;
  bytes: Uint8Array;
  lastModified: number;
  writes = 0;

  constructor(
    readonly name: string,
    bytes: Uint8Array,
    private readonly _clock: () => number,
  ) {
    this.bytes = bytes;
    this.lastModified = _clock();
  }

  async getFile(): Promise<File> {
    return new File([this.bytes], this.name, { lastModified: this.lastModified });
  }

  async createWritable(): Promise<LocalWritable> {
    const chunks: Uint8Array[] = [];

    return {
      write: async (data) => {
        chunks.push(typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));
      },
      close: async () => {
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const merged = new Uint8Array(total);
        let offset = 0;

        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.byteLength;
        }

        this.bytes = merged;
        this.lastModified = this._clock();
        this.writes++;
      },
    };
  }
}

export class MemoryDirectory implements LocalDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, MemoryDirectory | MemoryFile>();
  permission: LocalPermission;
  requests = 0;

  constructor(
    readonly name: string,
    private readonly _clock: () => number = createClock(),
    permission: LocalPermission = 'granted',
  ) {
    this.permission = permission;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<LocalDirectoryHandle> {
    const existing = this.children.get(name);

    if (existing) {
      if (existing.kind !== 'directory') {
        throw domError('TypeMismatchError', `${name} is a file`);
      }

      return existing;
    }

    if (!options?.create) {
      throw domError('NotFoundError', `${name} not found`);
    }

    const dir = new MemoryDirectory(name, this._clock, this.permission);
    this.children.set(name, dir);

    return dir;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<LocalFileHandle> {
    const existing = this.children.get(name);

    if (existing) {
      if (existing.kind !== 'file') {
        throw domError('TypeMismatchError', `${name} is a directory`);
      }

      return existing;
    }

    if (!options?.create) {
      throw domError('NotFoundError', `${name} not found`);
    }

    const file = new MemoryFile(name, new Uint8Array(0), this._clock);
    this.children.set(name, file);

    return file;
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    const existing = this.children.get(name);

    if (!existing) {
      throw domError('NotFoundError', `${name} not found`);
    }

    if (existing.kind === 'directory' && existing.children.size > 0 && !options?.recursive) {
      throw domError('InvalidModificationError', `${name} is not empty`);
    }

    this.children.delete(name);
  }

  async *entries(): AsyncIterableIterator<[string, LocalFileHandle | LocalDirectoryHandle]> {
    for (const [name, entry] of this.children) {
      yield [name, entry];
    }
  }

  async queryPermission(): Promise<LocalPermission> {
    return this.permission;
  }

  async requestPermission(): Promise<LocalPermission> {
    this.requests++;

    if (this.permission === 'prompt') {
      this.permission = 'granted';
    }

    return this.permission;
  }

  /* ------------------------------------------------------------- test helpers, project-relative */

  /** The file at `rel`, or undefined. */
  file(rel: string): MemoryFile | undefined {
    const segments = rel.split('/');
    let current: MemoryDirectory = this;

    for (const segment of segments.slice(0, -1)) {
      const next = current.children.get(segment);

      if (!next || next.kind !== 'directory') {
        return undefined;
      }

      current = next;
    }

    const leaf = current.children.get(segments[segments.length - 1]);

    return leaf?.kind === 'file' ? leaf : undefined;
  }

  text(rel: string): string | undefined {
    const file = this.file(rel);
    return file ? new TextDecoder().decode(file.bytes) : undefined;
  }

  /** Put a file directly, bypassing the store — "someone edited this in VS Code". */
  async put(rel: string, content: string | Uint8Array): Promise<MemoryFile> {
    const segments = rel.split('/');
    let current: MemoryDirectory = this;

    for (const segment of segments.slice(0, -1)) {
      current = (await current.getDirectoryHandle(segment, { create: true })) as MemoryDirectory;
    }

    const handle = (await current.getFileHandle(segments[segments.length - 1], { create: true })) as MemoryFile;
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();

    return handle;
  }

  /** Every file path under this directory, sorted. */
  paths(prefix = ''): string[] {
    const out: string[] = [];

    for (const [name, entry] of this.children) {
      const rel = prefix ? `${prefix}/${name}` : name;

      if (entry.kind === 'file') {
        out.push(rel);
      } else {
        out.push(...entry.paths(rel));
      }
    }

    return out.sort();
  }
}

/** A monotonic clock so two writes never share a `lastModified`. */
export function createClock(start = 1_000): () => number {
  let now = start;
  return () => ++now;
}
