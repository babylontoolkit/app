/**
 * Estimating a project's serialized weight BEFORE serializing it (SPEC §4.5.4c, §4.16).
 *
 * ## Why this exists
 *
 * The server working copy is a base64-JSON envelope of the whole file map. Building that envelope means
 * reading every binary's bytes, base64-encoding them (×1.37), assembling one object, and `JSON.stringify`-
 * ing it — a synchronous, un-yieldable, memory-doubling pass on the main thread. With a landing brief's
 * worth of large PNG renders that pass grew to gigabytes and froze the tab (the §4.16 media crash).
 *
 * The fix has two halves. One shrinks the payload (jpg default) and moves the encode off-thread (the
 * worker). The other, HERE, refuses to attempt the encode at all when the project is so large that even
 * the off-thread copy is not worth the bandwidth — the working copy is a best-effort crash-recovery
 * buffer, not a durability guarantee (§4.5.4c), and the local IndexedDB checkpoint is written either
 * way. Skipping is a documented degradation; freezing the tab is a bug.
 *
 * The estimate is computed from the file map's METADATA — a binary file already carries its byte `size`,
 * and a text file its `content` — so it costs nothing and, crucially, can be checked BEFORE any bytes
 * are read or encoded. It is deliberately an over-estimate (base64 inflation + JSON escaping headroom):
 * the failure we are guarding against is under-estimating and proceeding into the freeze.
 */
import type { FileMap } from '~/lib/stores/files';

/**
 * The ceiling above which the client will not build/upload a working copy. Not the server's hard cap
 * (`WORKING_COPY_MAX_MB`, 256MB) — that bounds what the server will STORE; this bounds what the client
 * will spend main-thread time and memory PRODUCING. It sits below the server cap on purpose: a payload
 * the server would reject is one there is no point encoding, and the point of pain on the client (the
 * base64 + clone + upload) arrives well before 256MB.
 *
 * A soft, best-effort limit — a project over it keeps its local checkpoint and simply has no server
 * recovery copy until it shrinks (e.g. the user removes a heavy generated asset, or a render lands as
 * jpg instead of png). `withinWorkingCopyBudget` accepts an override for callers that have a tuned
 * value; the constant is the client default (no server env is readable from the browser).
 */
export const DEFAULT_CLIENT_WORKING_COPY_MAX_MB = 96;

/** base64 inflates bytes by 4/3; add headroom for JSON quoting/escaping of the assembled envelope. */
const BASE64_INFLATION = 4 / 3;
const JSON_OVERHEAD = 1.05;

/**
 * Estimate the serialized (base64-JSON) byte weight of a file map, WITHOUT reading or encoding anything.
 *
 * Binary files contribute their on-disk `size` inflated for base64; text files contribute their
 * content length; every entry adds a little for its path and JSON structure. Folders are ~free.
 */
export function estimateSerializedBytes(files: FileMap): number {
  let total = 0;

  for (const [path, dirent] of Object.entries(files)) {
    if (!dirent) {
      continue;
    }

    // Every entry costs its path plus a bit of JSON structure ("path":{...},).
    total += path.length + 24;

    if (dirent.type === 'folder') {
      continue;
    }

    if (dirent.isBinary) {
      total += (dirent.size ?? 0) * BASE64_INFLATION;
    } else {
      total += dirent.content.length;
    }
  }

  return Math.ceil(total * JSON_OVERHEAD);
}

/**
 * Is this map small enough to be worth producing a server working copy for?
 *
 * `maxBytes` defaults to {@link DEFAULT_CLIENT_WORKING_COPY_MAX_MB}; callers reading an env override
 * pass it in. A non-positive or non-finite limit disables the gate (never silently blocks all saves).
 */
export function withinWorkingCopyBudget(files: FileMap, maxBytes?: number): boolean {
  const limit = maxBytes ?? DEFAULT_CLIENT_WORKING_COPY_MAX_MB * 1024 * 1024;

  if (!Number.isFinite(limit) || limit <= 0) {
    return true;
  }

  return estimateSerializedBytes(files) <= limit;
}
