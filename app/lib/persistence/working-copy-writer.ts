/**
 * Writing the server working copy from the live file store, off the main thread (SPEC §4.5.4c, §4.16).
 *
 * ## The freeze this replaces
 *
 * The old path was `workbenchStore.serializeFiles()` (base64 every binary on the main thread) followed
 * by `saveWorkingCopy` (`JSON.stringify` the whole base64 map — one synchronous, un-yieldable,
 * memory-doubling call). With a landing brief's worth of large PNG renders that grew to gigabytes and
 * pinned the tab so hard a no-op timed out. Measured live: a fresh remix + `/bt-landing` froze at 8 GB.
 *
 * ## The shape of the fix
 *
 * Reading bytes is async and cheap on the main thread; ENCODING and STRINGIFYING are what pin it. So
 * this reads each binary's bytes (async), TRANSFERS the ArrayBuffers to a Web Worker (zero-copy), and
 * lets the worker base64 + stringify + PUT. The UI thread never does the heavy pass.
 *
 * Three guards, each a way the old path failed silently:
 *   - **Size gate** — a project over the client budget keeps its local checkpoint and simply gets no
 *     server copy (`withinWorkingCopyBudget`). Best-effort recovery, never a freeze.
 *   - **Secrets stripped before bytes are read** — `isSecretPath`, the one rule every file-shipping path
 *     shares; a secret's bytes never even enter the worker.
 *   - **Worker-optional** — if a Worker cannot be constructed (unsupported, SSR), it encodes inline. The
 *     inline path is bounded by the same size gate, so it cannot reach the pathological freeze.
 *
 * ⚠️ Stays ENVELOPE-COMPATIBLE with `saveWorkingCopy` in `projects.ts`: same route, same `{ seq, files }`
 * base64 shape, same secret rule. The two differ only in WHERE the encode runs (here: a worker; there:
 * inline, for the checkpoint path that already holds a serialized map). If you change the envelope,
 * change both.
 */
import { workbenchStore } from '~/lib/stores/workbench';
import { isSecretPath } from '~/lib/git/paths';
import { withinWorkingCopyBudget } from './working-copy-size';
import { buildWorkingCopyBody, type WorkingCopyEntry } from './working-copy-envelope';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('working-copy-writer');

export type WorkingCopyWriteResult = 'saved' | 'skipped-too-large' | 'skipped-empty' | 'failed';

/** How long to wait for the worker before giving up on THIS save (best-effort; the next one retries). */
const WORKER_TIMEOUT_MS = 60_000;

/** `undefined` = not yet attempted, `null` = unavailable (fall back inline), else the live worker. */
let worker: Worker | null | undefined;
let nextRequestId = 1;
const pending = new Map<number, (result: { ok: boolean }) => void>();

function getWorker(): Worker | null {
  if (worker !== undefined) {
    return worker;
  }

  try {
    if (typeof Worker === 'undefined') {
      worker = null;
      return null;
    }

    const instance = new Worker(new URL('./working-copy.worker.ts', import.meta.url), { type: 'module' });

    instance.onmessage = (event: MessageEvent<{ requestId: number; ok: boolean }>) => {
      const resolve = pending.get(event.data.requestId);

      if (resolve) {
        pending.delete(event.data.requestId);
        resolve({ ok: event.data.ok });
      }
    };

    instance.onerror = () => {
      /*
       * A worker-level error resolves every in-flight save as failed (the caller falls back / re-warns);
       * the worker is discarded so the next call reconstructs or goes inline.
       */
      for (const resolve of pending.values()) {
        resolve({ ok: false });
      }

      pending.clear();
      worker = null;
    };

    worker = instance;

    return instance;
  } catch {
    worker = null;
    return null;
  }
}

function saveViaWorker(
  w: Worker,
  url: string,
  seq: number,
  entries: WorkingCopyEntry[],
  transfer: Transferable[],
): Promise<boolean> {
  const requestId = nextRequestId++;

  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      resolve(false);
    }, WORKER_TIMEOUT_MS);

    pending.set(requestId, ({ ok }) => {
      clearTimeout(timeout);
      resolve(ok);
    });

    try {
      w.postMessage({ requestId, url, seq, entries }, transfer);
    } catch {
      clearTimeout(timeout);
      pending.delete(requestId);
      resolve(false);
    }
  });
}

/**
 * Serialize the current project and write it as the server working copy under `seq`.
 *
 * Returns why it did or did not save so the caller can log/degrade — never throws (a failed recovery
 * top-up must not surface to the user; the local checkpoint is the durable copy).
 */
export async function writeWorkingCopyFromStore(projectId: string, seq: number): Promise<WorkingCopyWriteResult> {
  const files = workbenchStore.files.get();

  if (!withinWorkingCopyBudget(files)) {
    return 'skipped-too-large';
  }

  const entries: WorkingCopyEntry[] = [];
  const transfer: Transferable[] = [];

  for (const [path, dirent] of Object.entries(files)) {
    if (!dirent || dirent.type !== 'file' || isSecretPath(path)) {
      continue;
    }

    if (dirent.isBinary) {
      try {
        const bytes = await workbenchStore.readBinaryFile(path);
        entries.push({ path, isBinary: true, size: bytes.byteLength, bytes });
        transfer.push(bytes.buffer);
      } catch (error) {
        // A binary we cannot read is dropped, not fatal — the rest of the project is still worth saving.
        logger.warn(`Skipping unreadable binary during working-copy save: ${path} (${(error as Error)?.message})`);
      }
    } else {
      entries.push({ path, isBinary: false, size: dirent.size, text: dirent.content });
    }
  }

  if (entries.length === 0) {
    return 'skipped-empty';
  }

  const url = `/api/projects/${projectId}/working`;
  const w = getWorker();

  if (w) {
    /*
     * Buffers were transferred (zero-copy) — the main thread no longer owns them, so there is no inline
     * fallback from here: a worker failure returns 'failed' and the caller re-warns rather than re-reads
     * detached bytes.
     */
    const ok = await saveViaWorker(w, url, seq, entries, transfer);
    return ok ? 'saved' : 'failed';
  }

  // No worker (unsupported / SSR): encode inline. Bounded by the size gate above, so no freeze risk.
  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: buildWorkingCopyBody(seq, entries),
      credentials: 'same-origin',
    });

    return response.ok ? 'saved' : 'failed';
  } catch {
    return 'failed';
  }
}
