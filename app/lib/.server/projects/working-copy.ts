/**
 * The server WORKING COPY — one per project, for crash recovery (SPEC §4.5.4c).
 *
 * ## What this is, and the thing it is deliberately NOT
 *
 * It is a **recovery buffer**: the latest state of a project's files, so a browser that dies does not
 * take the user's work with it. It is **not** a version history, **not** a backup product, and **not**
 * the `snapshots` table returning under a new name.
 *
 * The distinction is the whole design. Migration 0007 deleted a per-generation snapshot history —
 * unbounded retention, one object per turn, addressed by a caller-supplied id. What replaces it here is
 * **exactly one object per project, overwritten in place, at a key derived from the project id**. Those
 * two properties are what make this cheap and safe where the old one was expensive and dangerous:
 *
 *   - **One object** bounds storage to the size of the project rather than the size of its history.
 *     ⚠️ "Let's keep the last few" is precisely how the deleted system grows back. The count is ONE.
 *   - **A derived key** means there is no id for a caller to supply, so `requireOwnedProject` alone is
 *     sufficient. The old route needed `assertSnapshotBelongsTo` for exactly this reason: it took an id
 *     from the client, which is what let project A's owner name project B's snapshot in A's URL. That
 *     reasoning holds only while the key stays a pure function of the project id — never re-introduce a
 *     caller-supplied storage id on this path without bringing the second wall back with it.
 *
 * ## Why it exists at all, measured
 *
 * A `/bt-landing` redesign ran to completion on an unlinked project — `finish=stop`, 20,364 output
 * tokens, 8 files rewritten, four generated images — and settled at **427 credits**. The tab then died.
 * Re-opening showed the state from BEFORE the run: no redesign, no assets, and nothing in the
 * conversation to say it had happened. Repo-primary (§4.5.4b) makes the user's repo the home of their
 * code, which is right; it never meant a paid generation should be one tab-crash from oblivion. §4.12
 * sells checkpoints as "the single most important safety net for non-developers" — the users least
 * likely to have a git remote — and that net lived only in IndexedDB.
 *
 * ## `linked` is not `pushed`
 *
 * This copy exists whether or not the project has a repo. Deleting it once a repo is LINKED was
 * considered and rejected: linking does not push, so the common "linked early, pushed late" case would
 * lose exactly as much as before, and a wrong deletion condition destroys someone's only copy.
 *
 * ## Bytes
 *
 * A `SerializedFileMap` is JSON — text inline, binaries base64 (`spec/binary-files.md`). Encoded once
 * here and decoded once here; base64 stays a wire format and nothing on this path reinterprets it,
 * which is the only reason a `havok.wasm` survives the round trip.
 */
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import { getObjectStore } from '~/lib/.server/storage';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('working-copy');

/**
 * ONE working copy per project, at a key derived from the project id.
 *
 * Never keyed by checkpoint, generation, or anything a caller supplies — see the module note. The
 * prefix is its own so a project delete can sweep it alongside `messages/` and `seeds/`.
 */
export function workingCopyKey(projectId: string): string {
  return `working/${projectId}.json`;
}

/**
 * Cap on the serialized copy (SPEC §5).
 *
 * Client-supplied bytes written to object storage are unbounded S3 + egress on the platform's bill for
 * any verified user, and unlike a publish this one is written on EVERY checkpoint. Sized to match
 * `MAX_SEED_BYTES`: a real game with source and assets fits comfortably. A measured project carrying
 * 2K PNGs ran ~30MB; the same project under §4.16's `output_format: "jpg"` guidance runs ~3MB.
 */
export const MAX_WORKING_COPY_BYTES = 75 * 1024 * 1024;

export class WorkingCopyTooLargeError extends Error {
  readonly statusCode = 413;
  readonly isRetryable = false;

  constructor() {
    super('This project is too large to keep a recovery copy of.');
    this.name = 'WorkingCopyTooLargeError';
  }
}

export interface WorkingCopy {
  projectId: string;

  /**
   * Monotonic, supplied by the writer — NEVER a clock.
   *
   * Resume has to decide between this copy and the browser's local checkpoint, and ordering that
   * choice by timestamp is the bug migration 0003 fixed in the ledger and §4.5.4b deviation 3 fixed in
   * local checkpoints: same-millisecond writes tie, and the tiebreak then decides which version of
   * someone's game wins. Clocks also go backwards. This mirrors `local-snapshots.ts`'s `seq` so the two
   * are directly comparable.
   */
  seq: number;

  /** For display only ("recovered from 3 minutes ago"). Never used to order anything. */
  updatedAt: string;

  files: SerializedFileMap;
}

/** Store the latest state. Overwrites the previous copy — there is only ever one. */
export async function putWorkingCopy(projectId: string, copy: WorkingCopy, context?: unknown): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(copy));

  if (bytes.byteLength > MAX_WORKING_COPY_BYTES) {
    throw new WorkingCopyTooLargeError();
  }

  await getObjectStore(context).put(workingCopyKey(projectId), bytes, 'application/json');
}

/**
 * The project's working copy, or null when it has none.
 *
 * A miss is NORMAL (a project that has never checkpointed), so it is a value rather than an exception.
 * Corrupt bytes are also null: the honest fallback is the same either way, and a recovery buffer must
 * never be the reason a project fails to open — it exists to prevent loss, not to cause it.
 */
export async function getWorkingCopy(projectId: string, context?: unknown): Promise<WorkingCopy | null> {
  const bytes = await getObjectStore(context).get(workingCopyKey(projectId));

  if (!bytes) {
    return null;
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as WorkingCopy;

    /*
     * A copy with no usable `seq` cannot be ordered against a local checkpoint, and guessing one would
     * let a stale copy win. Treated as absent — the same "when in doubt, do nothing" bias the whole
     * restore path takes.
     */
    if (typeof parsed?.seq !== 'number' || !parsed.files) {
      logger.error(`Working copy for ${projectId} is malformed — ignoring it.`);
      return null;
    }

    return parsed;
  } catch (error) {
    logger.error(`Working copy for ${projectId} could not be parsed: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Forget the copy.
 *
 * Called when the project is deleted. Bytes must never outlive the record that named them — the orphan
 * shape §4.5.4b keeps finding, and the reason a project delete sweeps prefixes rather than keys.
 */
export async function deleteWorkingCopy(projectId: string, context?: unknown): Promise<void> {
  await getObjectStore(context).delete(workingCopyKey(projectId));
}
