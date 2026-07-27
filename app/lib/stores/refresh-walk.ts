/**
 * The tree walk behind `FilesStore.refreshFiles`, extracted so its concurrency is testable.
 *
 * On WebContainer, `fs` calls are ~free (in-process memory). On a server provider EVERY call is a
 * network round trip — the exact hazard `spec/sandbox-seam.md` flags. Measured live on CodeSandbox
 * (2026-07-27): the serial walk this replaces spent ~17s re-scanning a 75-file project (~230ms per
 * RTT), all of it inside the blank-screen window that the chat's `ready` flag gates, and it was the
 * dominant cost of opening a project on a warm sandbox. Sibling directories now list concurrently
 * and file reads run through a bounded worker pool, so the wall clock is roughly
 * `files / concurrency` round trips instead of `files` of them.
 */
import type { SandboxDirent } from '~/lib/sandbox';

/** The two calls the walk needs — `SandboxFileSystem` satisfies this structurally. */
export interface WalkFs {
  readdir(path: string, options: { withFileTypes: true }): Promise<SandboxDirent[]>;
  readFile(path: string, encoding?: null): Promise<Uint8Array>;
}

export interface WalkedFile {
  /** Path relative to the walk root (the provider's working directory). */
  relPath: string;

  /** Present when the read succeeded. */
  buffer?: Uint8Array;

  /** Present when the read failed — the caller decides whether the file keeps its prior entry. */
  error?: unknown;
}

export interface WalkResult {
  /** Every directory seen, relative paths, discovery order. */
  folders: string[];

  /** Every file the walk attempted to read (success or failure). */
  files: WalkedFile[];
}

/**
 * How many file reads may be in flight at once. High enough to collapse a project-sized scan into a
 * handful of round-trip rounds, low enough not to starve the provider socket's own traffic (watcher
 * events and terminal output share the same Pitcher connection on CodeSandbox).
 */
export const REFRESH_READ_CONCURRENCY = 8;

export async function walkSandboxTree(
  fs: WalkFs,
  opts: {
    /** Names never entered or listed at any depth (`node_modules`, `.git`). */
    exclude: (name: string) => boolean;

    /** Relative paths pruned from the result — a skipped directory's subtree is never listed. */
    skip?: (relPath: string) => boolean;

    /** Progress for a UI: called after each read completes with (done, total). */
    onFileRead?: (done: number, total: number) => void;

    /** Override for tests; defaults to {@link REFRESH_READ_CONCURRENCY}. */
    concurrency?: number;
  },
): Promise<WalkResult> {
  const folders: string[] = [];
  const filePaths: string[] = [];

  const walk = async (relDir: string): Promise<void> => {
    const dirents = await fs.readdir(relDir || '.', { withFileTypes: true });
    const subdirs: Array<Promise<void>> = [];

    for (const dirent of dirents) {
      if (opts.exclude(dirent.name)) {
        continue;
      }

      const relPath = relDir ? `${relDir}/${dirent.name}` : dirent.name;

      if (opts.skip?.(relPath)) {
        continue;
      }

      if (dirent.isDirectory()) {
        folders.push(relPath);
        subdirs.push(walk(relPath));
        continue;
      }

      if (dirent.isFile()) {
        filePaths.push(relPath);
      }
    }

    await Promise.all(subdirs);
  };

  await walk('');

  const files: WalkedFile[] = [];
  const limit = Math.max(1, opts.concurrency ?? REFRESH_READ_CONCURRENCY);
  let cursor = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    while (cursor < filePaths.length) {
      const relPath = filePaths[cursor++];

      try {
        files.push({ relPath, buffer: await fs.readFile(relPath) });
      } catch (error) {
        files.push({ relPath, error });
      }

      opts.onFileRead?.(++done, filePaths.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, filePaths.length) }, () => worker()));

  return { folders, files };
}
