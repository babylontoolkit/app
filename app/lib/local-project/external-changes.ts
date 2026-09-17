/**
 * Edits made OUTSIDE the builder — VS Code on the same folder — flowing back in (SPEC §4.5.4d).
 *
 * The File System Access API has no watch for a picked folder (`FileSystemObserver` is Chromium-only
 * and still experimental for local directories), so this is a poll of file STAMPS (size + mtime, no
 * bytes) against the mirror's index. A file whose stamp moved is read and written into the sandbox;
 * a file that vanished is removed from it. The watcher then updates `FilesStore` exactly as it would
 * for any other write, and the mirror's compare-before-write keeps the copy from bouncing back out.
 *
 * Never while a generation streams or a restore runs — a half-written sandbox file compared against
 * the disk is a false "external change", and applying it mid-generation would overwrite the model's
 * output with the stale disk copy. Deferred, never skipped: the next quiet tick picks it up.
 */
import type { SandboxProvider } from '~/lib/sandbox/types';
import type { ProjectFolder } from './fsa-store';
import type { LocalMirror } from './mirror';
import type { DiskIndex } from './types';

export interface DiskDiff {
  changed: string[];
  removed: string[];
}

/** Pure. `known` is what the mirror last recorded; `current` is what the disk holds now. */
export function diffDiskIndex(known: DiskIndex, current: DiskIndex): DiskDiff {
  const changed: string[] = [];
  const removed: string[] = [];

  for (const [rel, stamp] of Object.entries(current)) {
    const was = known[rel];

    if (!was || was.size !== stamp.size || was.lastModified !== stamp.lastModified) {
      changed.push(rel);
    }
  }

  for (const rel of Object.keys(known)) {
    if (!(rel in current)) {
      removed.push(rel);
    }
  }

  return { changed, removed };
}

export interface ExternalChangeDeps {
  folder: ProjectFolder;
  mirror: LocalMirror;
  sandbox: Pick<SandboxProvider, 'fs'>;
  isBusy: () => boolean;
  isVisible: () => boolean;
  intervalMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onApplied?: (diff: DiskDiff) => void;
  onError?: (error: unknown) => void;
}

/** One pass: read stamps, diff, apply. Exposed so tests and "Reload from disk" can run it directly. */
export async function applyExternalChanges(
  deps: Pick<ExternalChangeDeps, 'folder' | 'mirror' | 'sandbox'>,
): Promise<DiskDiff> {
  const { folder, mirror, sandbox } = deps;
  const { index } = await folder.readTree({ withBytes: false });
  const diff = diffDiskIndex(mirror.index, index);

  for (const rel of diff.changed) {
    const bytes = await folder.readFile(rel);

    if (!bytes) {
      continue;
    }

    /*
     * Record the disk's stamp and tell the mirror the next event for this path is an ECHO, BEFORE
     * writing into the sandbox: the watcher reports the write back, the mirror compares bytes, finds
     * them identical and skips — which is what keeps an external edit from bouncing out to disk again
     * with a new mtime, which the next poll would read as yet another external change.
     */
    mirror.index[rel] = index[rel];
    mirror.expectEcho(rel);

    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';

    if (parent) {
      await sandbox.fs.mkdir(parent, { recursive: true });
    }

    await sandbox.fs.writeFile(rel, bytes);
  }

  for (const rel of diff.removed) {
    delete mirror.index[rel];
    await sandbox.fs.rm(rel, { force: true, recursive: true });
  }

  return diff;
}

const DEFAULT_INTERVAL_MS = 2_000;

/** Start polling. Returns the stop function. */
export function startExternalChangePoll(deps: ExternalChangeDeps): () => void {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const interval = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  let stopped = false;
  let handle: unknown;
  let running = false;

  const tick = async () => {
    if (stopped) {
      return;
    }

    if (!running && deps.isVisible() && !deps.isBusy() && deps.mirror.pending === 0) {
      running = true;

      try {
        const diff = await applyExternalChanges(deps);

        if (diff.changed.length > 0 || diff.removed.length > 0) {
          deps.onApplied?.(diff);
        }
      } catch (error) {
        deps.onError?.(error);
      } finally {
        running = false;
      }
    }

    if (!stopped) {
      handle = setTimer(() => void tick(), interval);
    }
  };

  handle = setTimer(() => void tick(), interval);

  return () => {
    stopped = true;
    clearTimer(handle);
  };
}
