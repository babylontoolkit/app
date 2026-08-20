/**
 * Top up BOTH saved copies for files that arrive AFTER a checkpoint (SPEC §4.5.4c, §4.12, §4.16).
 *
 * ## The gap this closes
 *
 * `checkpointProject` writes the local checkpoint and the server working copy when a generation
 * finishes — the right moment for code, and the wrong moment for everything that lands later:
 *
 *   - §4.16 media is **async-enqueue**: the tool returns the destination path immediately and the render
 *     lands ~25s after the generation settled and checkpointed;
 *   - a manual editor save can land minutes later, and used to reach NEITHER copy;
 *   - a file created or deleted from the file tree, likewise.
 *
 * So the checkpoint captured `<img src="/assets/generated/hero.jpg">` and not `hero.jpg`. That alone
 * would be a recovery-only defect — but the local checkpoint is restored with `protectNothing` on every
 * ordinary reload (`useChatHistory.ts`, and `decideLiveSandboxIsTruth` can never open the warm-sandbox
 * escape on the shipped providers), and a `protectNothing` restore DELETES what the incoming map does
 * not have. So the late file was not merely un-backed-up: it was actively removed on the next refresh.
 * That is the owner's report — *"they were created and showing, but a refresh LOSES them"*.
 *
 * ## Why this used to write only the SERVER copy, and why that was the bug
 *
 * This module shipped as `refresh-working-copy.ts`: it read the current local checkpoint purely to
 * BORROW its `seq` and then wrote the server copy under it. §4.5.4c invariant 4 says the working copy is
 * *"written on the same trigger as a local checkpoint — one concept, one moment. A second, independent
 * 'when do we save' rule is how two writers end up disagreeing."* This was exactly that second rule, and
 * the two copies duly disagreed: the server one had the images, the local one did not, and the local one
 * is the one that wins on reload (`selectMountSource` branches on the PRESENCE of a local copy, never on
 * freshness — correct, because `seq` is a per-browser counter). The fix is to make the trigger write
 * both, which restores the invariant rather than deviating from it.
 *
 * ## Why the seq MOVES now
 *
 * The old header argued the seq must be reused, because a late asset "is not a new logical state". True
 * of the working copy in isolation, and false once a real checkpoint is written: `unsavedWork` is
 * `localSeq > syncedSeq` (`mount-source.ts`), so folding a late file into the seq the project was
 * already synced at reports *"everything saved"* while a genuinely unpushed file exists. Allocating a
 * new seq makes `unsavedWork` true for free, which is the truthful answer. The history churn that would
 * otherwise cause is bounded by amending (`amendLocalSnapshot`), not by standing still.
 *
 * ## Coalesced, and never mid-stream
 *
 * Every write is the WHOLE project. A creation commissions up to four images that land seconds apart, and
 * a burst of editor saves is worse — hence a trailing debounce, and hence `planTopUp` returning `defer`
 * while the stream is live (serializing mid-generation is what froze the tab, §4.16).
 */
import { streamingState } from '~/lib/stores/streaming';
import { isRestoreInFlight } from '~/lib/stores/restore-flag';
import { workbenchStore } from '~/lib/stores/workbench';
import { projectId as projectIdStore, db, unsavedWork } from '~/lib/persistence/useChatHistory';
import {
  amendLocalSnapshot,
  createLocalSnapshot,
  getCurrentLocalSnapshotId,
  listLocalSnapshots,
} from '~/lib/persistence/local-snapshots';
import { runCheckpointSerialize } from '~/lib/persistence/checkpoint-run';
import { planTopUp, type TopUpCurrentSnapshot } from '~/lib/persistence/top-up-plan';
import { writeWorkingCopyFromStore } from '~/lib/persistence/working-copy-writer';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('saved-copies-refresh');

/**
 * Long enough to absorb a batch of renders (or a burst of editor saves) landing together, short enough
 * that a crash moments later is unlikely to fall inside it.
 */
const COALESCE_MS = 4_000;

/**
 * The §4.12 history copy for a top-up. A SMALL FIXED SET, never the caller's `reason` string — that is a
 * log line ("media med_abc123", "editor save"), and putting it here would put internal identifiers in the
 * version list the user reads.
 */
const TOP_UP_LABEL = 'Unsaved changes';

let timer: ReturnType<typeof setTimeout> | undefined;

/** What `planTopUp` needs to know about the checkpoint the project is pointing at — metadata only. */
async function readCurrentSnapshotFacts(
  database: IDBDatabase,
  projectId: string,
): Promise<TopUpCurrentSnapshot | undefined> {
  /*
   * Summaries, NOT `readCurrentLocalSnapshot`. That reads the whole `files` map — every byte of the
   * project, base64 — to answer four questions about metadata. On a project with a few GLBs that is
   * megabytes of structured-clone work, on a timer, for a decision that may well be "skip".
   */
  const [summaries, currentId] = await Promise.all([
    listLocalSnapshots(database, projectId),
    getCurrentLocalSnapshotId(database, projectId),
  ]);

  const current = summaries.find((s) => s.id === currentId);

  if (!current) {
    return undefined;
  }

  // Oldest-first (`listLocalSnapshots`' contract), so the newest is the last element.
  const newest = summaries[summaries.length - 1];

  return {
    id: current.id,
    seq: current.seq,
    messageId: current.messageId,
    kind: current.kind,
    isNewest: current.id === newest?.id,
    isCurrent: true,
  };
}

/** Top up both saved copies. Best-effort; never throws to the caller. */
async function push(reason: string): Promise<void> {
  const pid = projectIdStore.get();
  const database = db;

  /*
   * The cheap gates first, so a turn we are going to skip or defer never pays for an IndexedDB read —
   * let alone a project-sized strict serialize. `planTopUp` re-asserts all of them below; this is an
   * ordering optimisation, not a second copy of the rules (the decision lives in one place, and the call
   * below is the authoritative one).
   */
  const preflight = planTopUp({
    hasProject: Boolean(pid),
    hasDb: Boolean(database),
    streaming: streamingState.get(),
    restoreInFlight: isRestoreInFlight(),
  });

  if (preflight.action === 'defer') {
    refreshSavedCopiesSoon(reason);
    return;
  }

  if (preflight.action === 'skip') {
    logger.debug(`Top-up skipped (${preflight.reason}) for ${reason}`);
    return;
  }

  try {
    const current = await readCurrentSnapshotFacts(database!, pid!);

    const plan = planTopUp({
      hasProject: true,
      hasDb: true,
      streaming: streamingState.get(),
      restoreInFlight: isRestoreInFlight(),
      current,
    });

    if (plan.action === 'defer') {
      refreshSavedCopiesSoon(reason);
      return;
    }

    if (plan.action === 'skip') {
      logger.debug(`Top-up skipped (${plan.reason}) for ${reason}`);
      return;
    }

    /*
     * 🔴 STRICT, and the same policy the real checkpoint uses rather than a second timeout/retry rule of
     * this module's own invention (`checkpoint-run.ts`: a dead sandbox connection HANGS rather than
     * erroring, so an unbounded serialize simply never settles).
     *
     * Strict is not caution here, it is the difference between a top-up and a deletion: a lax
     * `serializeFiles` OMITS binaries it could not read, and this map is restored as the whole truth
     * under `protectNothing` — so a lax top-up would arrange for `havok.wasm` to be deleted on the next
     * reload. That is the very defect this module exists to fix, wearing the fix's clothes.
     *
     * No `waitForWrites`: a top-up only ever runs post-stream (see `defer` above), so there is no
     * action queue to settle — and asking for one would make a media delivery wait on a runner that
     * finished minutes ago.
     */
    const outcome = await runCheckpointSerialize({
      serialize: () => workbenchStore.serializeFiles({ strict: true }),
    });

    /*
     * 🔴 RE-CHECK AFTER THE SERIALIZE, because the serialize is the long part.
     *
     * The gates above ran before a whole-project strict read — seconds on a real project, with retries.
     * A restore that STARTS inside that window makes the map we are holding a photograph of a tree
     * mid-rewrite: half the old project, half the new one. Written as a checkpoint, that is precisely
     * the torn state a later `protectNothing` restore adopts as the whole truth. Discard it and let the
     * next trigger take a clean one — a top-up is best-effort, and the cheap failure here is doing
     * nothing.
     */
    if (isRestoreInFlight()) {
      logger.debug(`Top-up discarded (restore started during serialize) for ${reason}`);
      return;
    }

    let snapshot: { seq: number; messageId?: string } | undefined;

    if (outcome.kind === 'ok') {
      try {
        const append = () =>
          createLocalSnapshot(database!, {
            projectId: pid!,
            files: outcome.files,
            messageId: plan.messageId,
            label: TOP_UP_LABEL,
            kind: 'top-up',
          });

        if (plan.action === 'amend') {
          /*
           * Rewrite the previous top-up rather than adding another one — otherwise a long editing
           * session pushes twenty auto-saves through the twenty-slot history and evicts every generation
           * checkpoint §4.12's undo reaches for.
           *
           * The store re-asserts the three guards for itself, because this read and that write are not
           * one transaction. A refusal means the row moved out from under us (a generation landed, or the
           * user hit undo), and it is not a failure: appending is always safe, so we fall back to it.
           */
          const amended = await amendLocalSnapshot(database!, { snapshotId: plan.snapshotId, files: outcome.files });

          snapshot = amended ? { seq: plan.seq, messageId: plan.messageId } : await append();
        } else {
          snapshot = await append();
        }

        /*
         * A late file is genuinely unpushed. The seq moved, so the mount-time computation
         * (`mount-source.ts`) will agree on the next reload — this only brings the CURRENT session's
         * chip into line with it.
         */
        unsavedWork.set(true);
      } catch (error) {
        /*
         * `QuotaExceededError` is a real outcome on a 5–10MB map (`local-snapshots.ts`), not an
         * exceptional one. It must not take the server copy down with it — that copy is the recovery
         * path for precisely the browser whose storage is full.
         */
        logger.warn(`Local top-up checkpoint failed for ${pid} (${reason}): ${(error as Error)?.message}`);
      }
    } else {
      /*
       * LOUD, and the local checkpoint is left exactly as it was. Writing a lax map instead is the
       * deletion described above; writing nothing costs one debounce, because the next edit or delivery
       * schedules another attempt and the next generation's checkpoint writes the whole project anyway.
       */
      logger.warn(
        `Top-up serialize failed for ${pid} (${reason}): ${outcome.reason} — ${outcome.detail} ` +
          `(${outcome.attempts} attempt(s)); the existing checkpoint is untouched`,
      );
    }

    /*
     * The server copy is written under whichever checkpoint it is a top-up OF: the new one when we
     * managed to write it, the PREVIOUS one otherwise. The fallback is what this module did before it
     * wrote local checkpoints at all, so a failed local write degrades to the old behaviour rather than
     * to nothing — and `selectMountSource` never ranks the two by seq (it consults the working copy as a
     * BOOLEAN), so the copies carrying different seqs cannot mislead a mount.
     */
    const target = snapshot ?? current;

    if (!target) {
      return;
    }

    const result = await writeWorkingCopyFromStore(pid!, target.seq, target.messageId);

    if (result === 'saved') {
      logger.info(`Saved copies topped up for ${pid} at seq ${target.seq} (${reason})`);
    } else if (result === 'skipped-too-large') {
      logger.warn(`Working copy top-up skipped for ${pid}: project exceeds the client budget (${reason})`);
    } else if (result === 'failed') {
      logger.warn(`Working copy top-up failed for ${pid} (${reason})`);
    }
  } catch (error) {
    /* Best-effort by design (`spec/fail-loud.md`): logged with its reason, never surfaced to the user. */
    logger.warn(`Saved-copy refresh failed for ${pid} (${reason}): ${(error as Error)?.message}`);
  }
}

/**
 * Ask for a top-up of both saved copies. Coalesces bursts into one write.
 *
 * Fire-and-forget on purpose: callers are delivery and save paths whose own success must not depend on
 * ours.
 */
export function refreshSavedCopiesSoon(reason: string): void {
  if (timer) {
    clearTimeout(timer);
  }

  timer = setTimeout(() => {
    timer = undefined;
    void push(reason);
  }, COALESCE_MS);
}
