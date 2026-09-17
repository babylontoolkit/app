/**
 * The write-through MIRROR: every change in the sandbox lands in the project's folder on disk
 * (SPEC §4.5.4d). The disk is the copy the user can open in VS Code, so it must always equal what is
 * on screen — not "at the next checkpoint", but as each file lands.
 *
 * ## Where the changes come from
 *
 * The same stream that fills `FilesStore`: `sandbox.watchPaths`. It is VFS-level on Nodepod, so it sees
 * an agent's `<boltAction type="file">`, an editor save, a `restoreFiles` (undo, pull, remix seed), a
 * media render landing, a folder import — every writer, with no writer needing to know the mirror
 * exists. That is the property that makes this a mirror rather than a sixth "when do we save" rule.
 *
 * ## Coalesced, and RESTORE-AWARE
 *
 * Writes are queued per path and drained on a short trailing window (`CoalescedTask`), never while a
 * restore is in flight. A restore is the one writer whose bytes may ALREADY be on disk — a mount FROM
 * the disk folder replays the whole project through the watcher — and rewriting 30 MB of media on every
 * open is the kind of cost that does not throw. So an event queued during a restore is marked, and the
 * drain COMPARES bytes before writing those. The same compare runs whenever the disk's stamp differs
 * from the one the mirror last recorded, which is how an external edit (VS Code) that the poll has
 * just copied INTO the sandbox does not bounce straight back out.
 *
 * ## Failures are LOUD and never poison the queue
 *
 * `spec/fail-loud.md`, and the execution-queue lesson: one throwing entry must not stop every later
 * one. Each entry is tried on its own, an error is reported through `onStatus` (the Settings card and
 * the ⋯ menu render it) and retried a bounded number of times; the rest of the queue proceeds.
 */
import { CoalescedTask } from '~/lib/persistence/coalesce';
import { toProjectRelativePath } from '~/lib/common/sandbox-paths';
import type { SandboxProvider, SandboxWatchEvent } from '~/lib/sandbox/types';
import type { ProjectFolder } from './fsa-store';
import { sameBytes } from './scan';
import type { DiskIndex } from './types';

type QueuedOp = 'write' | 'delete' | 'mkdir';

interface QueueEntry {
  op: QueuedOp;

  /** Queued while a restore was in flight → compare with the disk before writing. */
  compare: boolean;
  attempts: number;
}

export interface MirrorStatus {
  pending: number;
  lastWriteAt?: number;
  error?: string;
}

export interface MirrorDeps {
  sandbox: Pick<SandboxProvider, 'fs' | 'watchPaths' | 'workdir'>;
  folder: ProjectFolder;
  excludeGlobs: readonly string[];
  isRestoreInFlight: () => boolean;
  onStatus: (status: MirrorStatus) => void;
  delayMs?: number;
  maxAttempts?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const DEFAULT_DELAY_MS = 300;
const DEFAULT_MAX_ATTEMPTS = 3;

export class LocalMirror {
  /** `rel → stamp` of what the mirror last saw on disk. Shared with the external-change poll. */
  readonly index: DiskIndex;

  #queue = new Map<string, QueueEntry>();

  /** Paths whose next event is the ECHO of a write the poll just made into the sandbox — compare, once. */
  #compareNext = new Set<string>();
  #task: CoalescedTask;
  #deps: MirrorDeps;
  #lastWriteAt?: number;
  #error?: string;
  #unsubscribe?: () => void;
  #stopped = false;

  constructor(deps: MirrorDeps, initialIndex: DiskIndex = {}) {
    this.#deps = deps;
    this.index = { ...initialIndex };
    this.#task = new CoalescedTask({
      delayMs: deps.delayMs ?? DEFAULT_DELAY_MS,
      isBusy: deps.isRestoreInFlight,
      run: () => this.drain(),
      setTimer: deps.setTimer,
      clearTimer: deps.clearTimer,
      onError: (error) => this.#report(error),
    });
  }

  get pending(): number {
    return this.#queue.size;
  }

  /** Subscribe to the sandbox. Returns the stop function; `stop()` is the same thing. */
  start(): () => void {
    const { sandbox, excludeGlobs } = this.#deps;

    this.#unsubscribe = sandbox.watchPaths(
      { include: [`${sandbox.workdir}/**`], exclude: [...excludeGlobs], includeContent: false },
      (events) => this.#onEvents(events),
    );

    return () => this.stop();
  }

  stop(): void {
    this.#stopped = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#task.cancel();
    this.#queue.clear();
  }

  /**
   * The external-change poll is about to write `rel` INTO the sandbox from the disk. The watcher will
   * report that write back here; without this the mirror would write the same bytes out again with a
   * new mtime, which the next poll would read as another external change — a loop that never throws.
   */
  expectEcho(rel: string): void {
    this.#compareNext.add(rel);
  }

  /** Feed events directly — the watcher's callback, exposed for tests. */
  accept(events: SandboxWatchEvent[]): void {
    this.#onEvents(events);
  }

  /**
   * Write EVERY file the store knows to disk — a newly created project, or a project mounted from
   * somewhere other than the disk into a folder that did not exist yet. Compare-before-write, so a
   * folder that already holds the bytes costs a read per file rather than a write.
   */
  async syncAll(relPaths: readonly string[]): Promise<void> {
    for (const rel of relPaths) {
      if (this.#deps.folder.isIgnored(rel)) {
        continue;
      }

      this.#enqueue(rel, 'write', true);
    }

    await this.drain();
  }

  /** Drain the queue now. Serial, in insertion order — a delete under a directory must follow it. */
  async drain(): Promise<void> {
    while (this.#queue.size > 0 && !this.#stopped) {
      const [rel, entry] = this.#queue.entries().next().value as [string, QueueEntry];
      this.#queue.delete(rel);

      try {
        await this.#apply(rel, entry);
        this.#error = undefined;
      } catch (error) {
        entry.attempts++;

        if (entry.attempts < (this.#deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
          // Back of the queue, so one bad file cannot starve the rest.
          this.#queue.set(rel, entry);
          this.#task.request();
        }

        this.#report(error, rel);
      }

      this.#publish();
    }
  }

  #onEvents(events: SandboxWatchEvent[]): void {
    if (this.#stopped) {
      return;
    }

    const compare = this.#deps.isRestoreInFlight();

    for (const event of events) {
      const rel = toProjectRelativePath(event.path);

      if (rel.length === 0 || this.#deps.folder.isIgnored(rel)) {
        continue;
      }

      switch (event.type) {
        case 'add_file':
        case 'change':
          this.#enqueue(rel, 'write', compare);
          break;
        case 'remove_file':
        case 'remove_dir':
          this.#enqueue(rel, 'delete', compare);
          break;
        case 'add_dir':
          this.#enqueue(rel, 'mkdir', compare);
          break;
        default:
          break;
      }
    }

    this.#publish();
    this.#task.request();
  }

  #enqueue(rel: string, op: QueuedOp, compare: boolean): void {
    /*
     * A delete of a directory supersedes every queued entry beneath it — writing `src/a.ts` after
     * `rm -r src` would resurrect a file the user just removed. Re-inserting moves the key to the END
     * of the map so ordering stays the order things happened.
     */
    if (op === 'delete') {
      for (const key of [...this.#queue.keys()]) {
        if (key === rel || key.startsWith(`${rel}/`)) {
          this.#queue.delete(key);
        }
      }
    } else {
      this.#queue.delete(rel);
    }

    this.#queue.set(rel, { op, compare, attempts: 0 });
  }

  async #apply(rel: string, entry: QueueEntry): Promise<void> {
    const { folder, sandbox } = this.#deps;

    if (entry.op === 'delete') {
      await folder.remove(rel);

      for (const key of Object.keys(this.index)) {
        if (key === rel || key.startsWith(`${rel}/`)) {
          delete this.index[key];
        }
      }

      return;
    }

    if (entry.op === 'mkdir') {
      await folder.mkdir(rel);
      return;
    }

    let bytes: Uint8Array;

    try {
      // COPY: the provider's bytes are on loan (spec/sandbox-seam.md).
      bytes = new Uint8Array(await sandbox.fs.readFile(rel));
    } catch {
      // Gone between the event and now; the removal that follows will speak for it.
      return;
    }

    /*
     * Compare before writing when (a) the event came from a restore, or (b) the disk moved since we
     * last recorded it — i.e. someone else wrote this file (an external edit the poll has just copied
     * in). Either way the bytes may already be identical, and an identical write is pure cost — plus,
     * on (b), the write would bounce the external edit straight back out with a new stamp.
     */
    const known = this.index[rel];
    let shouldCompare = entry.compare || this.#compareNext.delete(rel);

    if (!shouldCompare) {
      const stamp = await folder.stat(rel);
      shouldCompare = stamp !== undefined && (known === undefined || stamp.lastModified !== known.lastModified);
    }

    if (shouldCompare) {
      const onDisk = await folder.readFile(rel);

      if (onDisk && sameBytes(onDisk, bytes)) {
        const stamp = await folder.stat(rel);

        if (stamp) {
          this.index[rel] = stamp;
        }

        return;
      }
    }

    this.index[rel] = await folder.writeFile(rel, bytes);
    this.#lastWriteAt = (this.#deps.now ?? Date.now)();
  }

  #report(error: unknown, rel?: string): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#error = rel ? `${rel}: ${message}` : message;
    this.#publish();
  }

  #publish(): void {
    this.#deps.onStatus({ pending: this.#queue.size, lastWriteAt: this.#lastWriteAt, error: this.#error });
  }
}
