/**
 * Re-push the server working copy for files that arrive AFTER a checkpoint (SPEC §4.5.4c, §4.16).
 *
 * ## The gap this closes
 *
 * `checkpointProject` writes the working copy when a generation finishes — which is the right moment
 * for code, and the wrong moment for art. §4.16's media generation is **async-enqueue**: the tool
 * returns the destination path immediately and the render lands ~25s later, well after the generation
 * has settled and checkpointed. So the working copy captured `<img src="/assets/generated/hero.jpg">`
 * and *not* `hero.jpg`, and recovering from it would produce a project whose landing page references
 * four images that do not exist — the exact broken-image failure §4.16's `refreshPreviews` fixed in
 * the live preview, reappearing one layer down in the recovery copy.
 *
 * ## Why the seq is REUSED, not incremented
 *
 * The working copy shares the LOCAL checkpoint's `seq` so the two can be ordered against each other on
 * resume (`mount-source.ts`). A late asset is not a new logical state — it is the same checkpoint,
 * finally complete — so it keeps that checkpoint's seq and simply carries more files. Minting a fresh
 * number here would invent a state the local history has no counterpart for, and inventing an ordering
 * is how a stale copy wins a comparison it should have lost.
 *
 * ⚠️ It follows that this must never run BEFORE the first checkpoint: with no local snapshot there is
 * no seq to borrow, and it does nothing rather than guessing one.
 *
 * ## Coalesced
 *
 * A creation commissions up to four images that land seconds apart, and every write is the WHOLE
 * project (~3MB post-`output_format: "jpg"`, ~30MB before it). One upload per image is four uploads of
 * the same project for one logical change, competing with the preview the user is watching. The
 * trailing debounce means a batch of deliveries produces a single write carrying all of them.
 */
import { streamingState } from '~/lib/stores/streaming';
import { projectId as projectIdStore } from '~/lib/persistence/useChatHistory';
import { db } from '~/lib/persistence/useChatHistory';
import { readCurrentLocalSnapshot } from '~/lib/persistence/local-snapshots';
import { writeWorkingCopyFromStore } from '~/lib/persistence/working-copy-writer';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('working-copy-refresh');

/**
 * Long enough to absorb a batch of renders landing together, short enough that a crash moments later
 * is unlikely to fall inside it. This is a coalescing window, never a correctness guarantee — the
 * checkpoint copy is what makes the data safe; this only tops it up.
 */
const COALESCE_MS = 4_000;

let timer: ReturnType<typeof setTimeout> | undefined;

/** Push the current files under the LAST checkpoint's seq. Best-effort; never throws to the caller. */
async function push(reason: string): Promise<void> {
  const pid = projectIdStore.get();

  if (!pid || !db) {
    return;
  }

  /*
   * 🔴 NEVER serialize mid-generation. Serializing the project (base64 every binary + assemble the
   * envelope) competes with the live stream for the main thread and memory — and it was firing 4s after
   * the FIRST media render landed, i.e. squarely mid-stream, while more renders were still arriving.
   * That contention, on top of several large PNGs, is what froze the tab (§4.16 media crash). Defer:
   * reschedule until the stream ends, at which point a burst of deliveries collapses into ONE save.
   */
  if (streamingState.get()) {
    refreshWorkingCopySoon(reason);
    return;
  }

  try {
    const current = await readCurrentLocalSnapshot(db, pid);

    /*
     * No checkpoint yet means no seq to borrow. Skipping is correct: there is also nothing for this
     * copy to be a top-up OF, and the next checkpoint writes the whole thing anyway.
     */
    if (!current) {
      return;
    }

    /*
     * Reads bytes async, encodes + uploads off the main thread (a worker), and size-gates a project too
     * large to be worth an off-thread copy. Never throws; returns why it did or did not save.
     */
    const result = await writeWorkingCopyFromStore(pid, current.seq);

    if (result === 'saved') {
      logger.info(`Working copy refreshed for ${pid} at seq ${current.seq} (${reason})`);
    } else if (result === 'skipped-too-large') {
      logger.warn(`Working copy top-up skipped for ${pid}: project exceeds the client budget (${reason})`);
    } else if (result === 'failed') {
      logger.warn(`Working copy top-up failed for ${pid} (${reason})`);
    }
  } catch (error) {
    /* The local checkpoint is intact either way — a failed top-up must never surface to the user. */
    logger.warn(`Working copy refresh failed for ${pid} (${reason}): ${(error as Error)?.message}`);
  }
}

/**
 * Ask for a refresh. Coalesces bursts into one write.
 *
 * Fire-and-forget on purpose: callers are delivery paths whose own success must not depend on ours.
 */
export function refreshWorkingCopySoon(reason: string): void {
  if (timer) {
    clearTimeout(timer);
  }

  timer = setTimeout(() => {
    timer = undefined;
    void push(reason);
  }, COALESCE_MS);
}
