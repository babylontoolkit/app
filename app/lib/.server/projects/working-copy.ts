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
import { envNumber } from '~/lib/.server/env';
import { DEFAULT_PROJECT_SOURCE_MAX_MB } from '~/lib/.server/storage/limits';
import { isSecretPath } from '~/lib/git/paths';
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
 * Cap on the serialized copy — **configurable**, `WORKING_COPY_MAX_MB`, default 256MB.
 *
 * There IS a cap because §5 requires one: client-supplied bytes written to object storage are
 * unbounded S3 + egress on the platform's bill for any verified user, and unlike a publish or a remix
 * seed this write fires on EVERY checkpoint — the most repeatable upload in the product. That rule
 * exists because it already shipped broken twice (the publish build and the remix seed).
 *
 * It is 256MB and env-tunable because the FIRST version was neither: it was hard-coded at 75MB, copied
 * from `MAX_SEED_BYTES` without asking whether a seed and a live recovery buffer want the same number.
 * They do not — a seed is deposited once, deliberately, for a game the user chose to publish, while
 * this holds whatever the project happens to weigh today. A measured project carrying four 2K PNGs ran
 * 46MB serialized, i.e. already ⅔ of the way through the old ceiling, and the operator had no way to
 * move it without a code change and a deploy.
 *
 * Set `WORKING_COPY_MAX_MB` in the environment (SSM → container env, see DEPLOY.md) to change it.
 *
 * The default is SHARED with the remix seed (`storage/limits.ts`) — a project the platform is willing to
 * hold for recovery is one it is willing to hold for remix, and two independently-chosen numbers is how
 * a game became publishable but un-remixable with nothing reporting it.
 */
export const DEFAULT_WORKING_COPY_MAX_MB = DEFAULT_PROJECT_SOURCE_MAX_MB;

export function maxWorkingCopyBytes(context?: unknown): number {
  const mb = envNumber(context, 'WORKING_COPY_MAX_MB', DEFAULT_WORKING_COPY_MAX_MB);

  /*
   * A nonsensical override must not disable the cap or make every checkpoint fail — the same
   * "ignore a bad override rather than obey it" rule the Unity licence price ladder uses.
   */
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_WORKING_COPY_MAX_MB) * 1024 * 1024;
}

export class WorkingCopyTooLargeError extends Error {
  readonly statusCode = 413;
  readonly isRetryable = false;

  /** Says the SIZE and the LIMIT — "too large" alone gives the operator nothing to act on. */
  constructor(bytes: number, limit: number) {
    super(
      `This project is ${(bytes / 1048576).toFixed(1)}MB, over the ${Math.round(limit / 1048576)}MB ` +
        'recovery-copy limit, so it is NOT protected against losing this browser. Reduce the project ' +
        'size (large generated PNGs are the usual cause) or raise WORKING_COPY_MAX_MB.',
    );
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

  /**
   * The assistant turn these files contain — the same id the local checkpoint records.
   *
   * 🔴 **Its absence was a bug, not a simplification (fixed 2026-07-26).** `detectUnappliedTurn` asks
   * "does the mounted copy already carry the last paid turn?", and a copy that cannot answer is read
   * as "no". So every recovery mount raised the "your last change isn't on this device" dialog —
   * about work that was very often right there in this very object — and the recovery then wrote a
   * local checkpoint that ALSO had no id, so the question repeated on every subsequent mount forever.
   *
   * Optional because copies written before this field existed have none; absent still means "cannot
   * say", which degrades to the old ask-the-user behaviour rather than to a silent wrong answer.
   */
  messageId?: string;

  /**
   * Which branch these files came from (§4.13a).
   *
   * 🔴 There is exactly ONE copy per project, overwritten in place, so the moment a branch switch
   * lands it describes a tree the project is no longer on — with nothing in the object saying so.
   * `selectMountSource` never ranks this copy against a local checkpoint, which narrows the blast
   * radius to one state: a fresh browser, a linked project, and a remote we could not reach. In
   * exactly that state a recovery would silently restore another branch's tree over a project whose
   * link tuple names a different one, and the user would find a game they did not write.
   *
   * ⚠️ **Optional, and absent means UNKNOWN — never a match.** Every copy written before this field
   * existed has none, and reading silence as agreement is the `remoteHead` `undefined`-vs-`null`
   * mistake one file over: it would let precisely the oldest, most stale copies through the check.
   */
  branch?: string;

  files: SerializedFileMap;
}

/**
 * Store the latest state. Overwrites the previous copy — there is only ever one.
 *
 * 🔴 **Secrets are stripped HERE, not only in the client.** `saveWorkingCopy` already filters before
 * upload, and that was the whole defence until a live test drove this route directly and watched
 * `.env` and `.env.production` land in the store. Every other secret boundary in this codebase is
 * defence-in-depth — the shell allow-list is enforced client-side AND stripped server-side (§4.2.5,
 * §5) — and this one was a single client-side filter guarding the user's API keys on OUR
 * infrastructure. One caller that forgets, or one client bug, and the keys are ours to lose.
 *
 * Same `isSecretPath` as the push and the remix seed: one rule, one place, applied at every door.
 */
export async function putWorkingCopy(projectId: string, copy: WorkingCopy, context?: unknown): Promise<void> {
  const files: SerializedFileMap = {};

  for (const [path, entry] of Object.entries(copy.files)) {
    if (!isSecretPath(path)) {
      files[path] = entry;
    }
  }

  const bytes = new TextEncoder().encode(JSON.stringify({ ...copy, files }));
  const limit = maxWorkingCopyBytes(context);

  if (bytes.byteLength > limit) {
    throw new WorkingCopyTooLargeError(bytes.byteLength, limit);
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

    /*
     * A non-string `messageId` is dropped rather than passed on: it feeds an identity comparison that
     * decides whether to offer to overwrite the user's files, and `undefined` (= "cannot say", ask)
     * is the safe reading of anything we do not recognise.
     */
    /*
     * Both optional fields are normalised the same way, and for the same reason: each feeds a
     * comparison that decides whether to overwrite the user's files, so anything we do not recognise
     * becomes `undefined` — "cannot say" — rather than a value the comparison might accidentally
     * match. A non-string `branch` that survived would be compared against `linked_branch` and could
     * never equal it, which happens to be safe today and is safe by accident rather than by rule.
     */
    return {
      ...parsed,
      messageId: typeof parsed.messageId === 'string' ? parsed.messageId : undefined,
      branch: typeof parsed.branch === 'string' && parsed.branch ? parsed.branch : undefined,
    };
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
