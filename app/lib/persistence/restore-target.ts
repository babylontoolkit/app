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
    return { ok: true, snapshot: snapshots[index] };
  }

  /*
   * "Before this change" = the state the previous generation left behind. If this is the FIRST
   * checkpoint there is no earlier state — and we say so rather than silently restoring to the oldest
   * one we happen to have, which would be a different project entirely.
   */
  const previous = snapshots[index - 1];

  return previous ? { ok: true, snapshot: previous } : { ok: false, reason: 'nothing-before' };
}
