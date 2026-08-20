/**
 * Which checkpoint does "restore" actually restore to? (§4.12)
 *
 * Pure, and tested, because getting it wrong is the worst bug this feature can have: restoring the
 * WRONG checkpoint silently overwrites the user's project with the wrong bytes, and the thing they
 * reached for to undo a mistake becomes the mistake. An off-by-one here is indistinguishable from
 * working code until someone loses an afternoon's work.
 *
 * The subtlety: **checkpoints are taken AFTER a generation is applied.** So the checkpoint anchored to
 * an assistant message is the state that message *produced* — which means the state from *before* that
 * message is the PREVIOUS checkpoint, not this one.
 *
 * ## One message can have TWO checkpoints, and the two modes resolve the tie in OPPOSITE directions
 *
 * A turn is not finished when the generation is. §4.16 media lands ~25s after `onFinish`, and an editor
 * save can land minutes later — so a **top-up checkpoint** (`top-up-plan.ts`) is appended carrying the
 * same `messageId` as the generation checkpoint it completes. Two rows, one message, and which one this
 * function picks is the difference between the user getting their images back and not.
 *
 *   - `'after'` — "the state this change produced" — resolves to the **LAST** match. The generation
 *     checkpoint is that turn's state *as far as it had got*; the top-up is that same turn, complete.
 *     Taking the first match restores the project to the moment before its own images existed, silently,
 *     from the one button a user presses specifically to not lose work.
 *   - `'before'` — "the state the previous generation left behind" — resolves to the checkpoint
 *     preceding the **FIRST** match. Every row carrying this `messageId` is part of this turn, so
 *     "before" has to step past all of them, and the first match is the earliest of them.
 *
 * They differ because they are anchored to opposite ENDS of the same run of rows, not because one of
 * them is a special case.
 */
export interface RestorableSnapshot {
  id: string;
  messageId?: string;
}

export type RestoreMode = 'before' | 'after';

export type RestoreTarget =
  | { ok: true; snapshot: RestorableSnapshot }
  | { ok: false; reason: 'no-checkpoint-for-message' | 'nothing-before' };

/**
 * @param snapshots Oldest-first (the order `listSnapshots` returns — the version history reads forward).
 */
export function selectRestoreTarget(
  snapshots: RestorableSnapshot[],
  messageId: string,
  mode: RestoreMode,
): RestoreTarget {
  const index = snapshots.findIndex((s) => s.messageId === messageId);

  if (index === -1) {
    return { ok: false, reason: 'no-checkpoint-for-message' };
  }

  if (mode === 'after') {
    /*
     * The LAST row for this message — the turn including whatever landed late (see the header). A plain
     * reverse loop rather than `findLastIndex`, which needs `lib: ES2023`: a selection this dangerous
     * should not acquire a tsconfig dependency to express three lines of arithmetic.
     */
    let last = index;

    for (let i = snapshots.length - 1; i > index; i--) {
      if (snapshots[i].messageId === messageId) {
        last = i;
        break;
      }
    }

    return { ok: true, snapshot: snapshots[last] };
  }

  /*
   * "Before this change" = the state the previous generation left behind, so it steps back from the
   * FIRST row of this turn — deliberately the opposite end from `'after'` above. If this is the FIRST
   * checkpoint there is no earlier state — and we say so rather than silently restoring to the oldest
   * one we happen to have, which would be a different project entirely.
   */
  const previous = snapshots[index - 1];

  return previous ? { ok: true, snapshot: previous } : { ok: false, reason: 'nothing-before' };
}
