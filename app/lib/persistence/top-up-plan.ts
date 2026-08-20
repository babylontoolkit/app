/**
 * Should we top up the saved copies right now, and what should we write? (SPEC §4.5.4c, §4.12, §4.16)
 *
 * ## Why this is a pure function
 *
 * A top-up WRITES A CHECKPOINT, and a checkpoint is what a `protectNothing` restore treats as the whole
 * truth of the project (`restore-plan.ts`). So this decision can delete the user's files — the same
 * category as `selectMountSource`, `selectRestoreTarget` and `planRestore`, all of which are pure and
 * exhaustively tested for exactly that reason (`CLAUDE.md` — "anything that overwrites the user's
 * project is a pure function with exhaustive tests"). Every wrong answer here is silent:
 *
 *   - top up mid-stream → serializing the whole project competes with the live generation for the main
 *     thread and memory, which is the shape that froze the tab on a media-heavy run (§4.16);
 *   - top up during a RESTORE → the restore's own writes and deletes are photographed as if the user had
 *     made them, so a §4.12 undo is immediately followed by a checkpoint of the state it undid;
 *   - append every time → the 20-slot history (`MAX_CHECKPOINTS_PER_PROJECT`) fills with auto-saves and
 *     evicts the generation checkpoints undo actually reaches for;
 *   - amend the wrong row → after an undo the pointer is parked on an OLDER checkpoint
 *     (`Messages.client.tsx`), and rewriting "the current snapshot" would overwrite the user's undo
 *     target with the very state they undid from.
 *
 * ## The rules, in precedence order
 *
 * 1. **No project / no database → skip.** Nothing to write, and nothing to write it to.
 * 2. **A restore is in flight → skip.** See above. `skip` is terminal rather than `defer` on purpose: a
 *    restore replaces the tree wholesale, so whatever change asked for this top-up no longer exists.
 * 3. **The stream is live → defer.** Never serialize mid-generation; re-arm and ask again later. This is
 *    a DEFER and not a skip because the change is real and still needs saving once the stream ends.
 * 4. **No checkpoint yet → append** with no `messageId`. This is what closes the
 *    media-delivered-before-the-first-checkpoint hole: the old code returned early because it had no
 *    `seq` to borrow, so the very first render of a brand-new project reached neither saved copy.
 * 5. **The current checkpoint is a top-up, is the newest row, and is the current pointer → amend it.**
 *    All three conditions are required; any one of them failing falls through to `append`.
 * 6. **Otherwise → append**, carrying the current checkpoint's `messageId` FORWARD. A checkpoint that
 *    cannot say which turn it contains makes `checkUnappliedTurn` re-offer the §4.5.4c apply dialog
 *    forever (`useChatHistory.ts`).
 */

/** The `kind` marker on a checkpoint. Absent means an ordinary generation checkpoint. */
export type LocalSnapshotKind = 'top-up';

/** Why a top-up did nothing. A string the caller logs — never surfaced to the user (best-effort). */
export type TopUpSkipReason = 'no-project' | 'no-db' | 'restore-in-flight';

/** What the caller knows about the checkpoint the project is currently pointing at. */
export interface TopUpCurrentSnapshot {
  id: string;
  seq: number;
  messageId?: string;
  kind?: LocalSnapshotKind;

  /** Is this the highest-`seq` checkpoint for the project? False after a §4.12 undo. */
  isNewest: boolean;

  /** Is this the project's `currentSnapshotId`? False while the pointer is parked on an older row. */
  isCurrent: boolean;
}

export interface TopUpFacts {
  hasProject: boolean;
  hasDb: boolean;
  streaming: boolean;
  restoreInFlight: boolean;
  current?: TopUpCurrentSnapshot;
}

export type TopUpPlan =
  | { action: 'defer' }
  | { action: 'skip'; reason: TopUpSkipReason }
  | { action: 'append'; messageId?: string }
  | { action: 'amend'; snapshotId: string; seq: number; messageId?: string };

export function planTopUp(facts: TopUpFacts): TopUpPlan {
  /*
   * Skip before defer. Deferring with no project re-arms a timer that can never do anything, so the
   * "come back later" answer has to be reserved for states that can actually resolve.
   */
  if (!facts.hasProject) {
    return { action: 'skip', reason: 'no-project' };
  }

  if (!facts.hasDb) {
    return { action: 'skip', reason: 'no-db' };
  }

  /*
   * 🔴 Before the streaming check, and terminal. A restore writes and deletes files as its normal
   * operation, so a top-up landing inside one checkpoints the restore itself — appending a duplicate on
   * every mount, and after an undo appending a checkpoint of the undone state. Deferring instead would
   * simply move that same capture a few seconds later, once the restore had finished.
   */
  if (facts.restoreInFlight) {
    return { action: 'skip', reason: 'restore-in-flight' };
  }

  /*
   * 🔴 NEVER serialize mid-generation (§4.16 — the freeze). Serializing base64s every binary and
   * assembles the whole envelope on the main thread, and this used to fire ~4s after the FIRST media
   * render landed, i.e. squarely mid-stream while more renders were still arriving.
   */
  if (facts.streaming) {
    return { action: 'defer' };
  }

  const current = facts.current;

  /*
   * No checkpoint yet. Previously a silent no-op ("no seq to borrow"), which meant the first asset of a
   * brand-new project reached NEITHER saved copy. A top-up is a real checkpoint now, so it can simply
   * be the first one — there is no seq to borrow because it allocates its own.
   */
  if (!current) {
    return { action: 'append' };
  }

  /*
   * Amend requires ALL THREE. `kind` keeps the amend away from a real generation checkpoint (history is
   * append-only for those); `isNewest` and `isCurrent` keep it away from a row the §4.12 pointer is
   * parked on — rewriting that row would overwrite the user's undo target with the state they undid
   * from. Any one missing degrades to `append`, which is always safe: it only ever adds history.
   */
  if (current.kind === 'top-up' && current.isNewest && current.isCurrent) {
    return { action: 'amend', snapshotId: current.id, seq: current.seq, messageId: current.messageId };
  }

  /*
   * Carry the current checkpoint's `messageId` FORWARD. A top-up that cannot name the turn it contains
   * becomes the current snapshot and makes `checkUnappliedTurn` re-offer the §4.5.4c apply dialog on
   * every mount, forever.
   */
  return { action: 'append', messageId: current.messageId };
}
