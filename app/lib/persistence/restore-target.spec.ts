/**
 * Which checkpoint "restore" restores to (§4.12).
 *
 * The failure mode this guards is the nastiest one in the product: restoring the WRONG checkpoint
 * silently overwrites the project with the wrong bytes, so the button the user reached for to undo a
 * mistake BECOMES the mistake. An off-by-one is invisible until someone loses an afternoon.
 *
 * The rule that makes it easy to get wrong: **checkpoints are taken AFTER a generation is applied**, so
 * the checkpoint anchored to a message is the state that message PRODUCED — and "before this change" is
 * therefore the PREVIOUS checkpoint, not this one.
 *
 * ## The duplicate-`messageId` block
 *
 * A turn does not end when the generation does: §4.16 media lands ~25s later and an editor save later
 * still, so a **top-up checkpoint** is appended carrying the SAME `messageId` as the generation
 * checkpoint it completes. One message, two (or more) rows — and the two modes resolve the tie at
 * OPPOSITE ends of that run: `'after'` takes the LAST match (the turn, complete), `'before'` steps back
 * from the FIRST match (past every row belonging to the turn). Those tests exist because the naive
 * `findIndex` returns the pre-top-up row, i.e. "restore to after this change" would restore the project
 * to the moment before its own images existed — wrong bytes, silently, from the undo button.
 *
 * **Mutation-verified (hand-discharged, 2026-08-15):** reverting `'after'` to
 * `return { ok: true, snapshot: snapshots[index] }` (the pre-T2 `findIndex` behaviour) fails **exactly
 * 4** tests, all of them in the duplicate-`messageId` block below — `resolves "after" to the NEWER of a
 * duplicated pair`, `takes the newest of a THREE-row run`, `resolves the last match when the duplicate
 * pair ends the history`, and `scans past an unanchored row to the last match`. No pre-existing test
 * fails, which is the point: the single-match behaviour is unchanged.
 */
import { describe, expect, it } from 'vitest';
import { selectRestoreTarget, type RestorableSnapshot } from './restore-target';

/** Oldest-first, as `listSnapshots` returns them — the version history reads forward. */
const history: RestorableSnapshot[] = [
  { id: 'snap_1', messageId: 'msg_create' }, // the project was created
  { id: 'snap_2', messageId: 'msg_boost' }, // "add a boost mechanic"
  { id: 'snap_3', messageId: 'msg_wreck' }, // "redo the landing page" — this is the one that broke it
];

describe('restore target', () => {
  /* The common case: "that last change wrecked it, undo it." */
  it('restores to the PREVIOUS checkpoint for "before this change"', () => {
    const target = selectRestoreTarget(history, 'msg_wreck', 'before');

    expect(target).toEqual({ ok: true, snapshot: history[1] });
  });

  it('restores to THIS checkpoint for "after this change"', () => {
    const target = selectRestoreTarget(history, 'msg_wreck', 'after');

    expect(target).toEqual({ ok: true, snapshot: history[2] });
  });

  /*
   * The off-by-one that would destroy work: "before msg_boost" must be the CREATE checkpoint, never
   * msg_boost's own — that would "undo" a change by restoring the very state it produced, i.e. do
   * nothing while telling the user it worked.
   */
  it('does not confuse "before X" with X\'s own checkpoint', () => {
    const before = selectRestoreTarget(history, 'msg_boost', 'before');
    const after = selectRestoreTarget(history, 'msg_boost', 'after');

    expect(before).toEqual({ ok: true, snapshot: history[0] });
    expect(after).toEqual({ ok: true, snapshot: history[1] });
    expect(before).not.toEqual(after);
  });

  /*
   * There is no state before the first change. Silently restoring to the oldest checkpoint we happen to
   * have would hand the user a different project than the one they asked for.
   */
  it('refuses "before" the very first checkpoint rather than guessing', () => {
    expect(selectRestoreTarget(history, 'msg_create', 'before')).toEqual({ ok: false, reason: 'nothing-before' });
  });

  it('still restores "after" the very first checkpoint', () => {
    expect(selectRestoreTarget(history, 'msg_create', 'after')).toEqual({ ok: true, snapshot: history[0] });
  });

  it('reports a message that has no checkpoint', () => {
    expect(selectRestoreTarget(history, 'msg_unknown', 'before')).toEqual({
      ok: false,
      reason: 'no-checkpoint-for-message',
    });
  });

  it('handles an empty history', () => {
    expect(selectRestoreTarget([], 'msg_create', 'after')).toEqual({ ok: false, reason: 'no-checkpoint-for-message' });
  });

  /*
   * One message, several checkpoints — the shape a top-up creates. Every test here would pass against a
   * plain `findIndex`, EXCEPT the `'after'` ones, which is exactly the bug: the pre-top-up row and the
   * topped-up row are both "the checkpoint for this message", and picking the wrong one hands the user
   * back a project missing the very files the turn was slow to produce.
   */
  describe('when a message has more than one checkpoint (top-up)', () => {
    /** `snap_media` is the generation checkpoint; `snap_media_topup` is the same turn once its images landed. */
    const toppedUp: RestorableSnapshot[] = [
      { id: 'snap_create', messageId: 'msg_create' },
      { id: 'snap_media', messageId: 'msg_media' },
      { id: 'snap_media_topup', messageId: 'msg_media' },
      { id: 'snap_later', messageId: 'msg_later' },
    ];

    /*
     * THE defect T2 exists for. "Restore to after this change" must mean the turn INCLUDING its late
     * arrivals; the first match is that turn's state before its own images existed, and restoring it
     * deletes them — from the one button pressed specifically to not lose work.
     */
    it('resolves "after" to the NEWER of a duplicated pair', () => {
      expect(selectRestoreTarget(toppedUp, 'msg_media', 'after')).toEqual({ ok: true, snapshot: toppedUp[2] });
    });

    /*
     * The mirror rule, and it points the OTHER way on purpose: every row carrying this messageId belongs
     * to this turn, so "before it" has to step past all of them — i.e. back from the FIRST match. Landing
     * on `snap_media` would "undo" the turn by restoring a state the turn itself produced.
     */
    it('resolves "before" to the checkpoint preceding the OLDER of a duplicated pair', () => {
      expect(selectRestoreTarget(toppedUp, 'msg_media', 'before')).toEqual({ ok: true, snapshot: toppedUp[0] });
    });

    /*
     * Two rows is the case anyone writing the fix pictures; a media burst plus a later editor save makes
     * three. A loop that steps back only one row from the end passes the pair test and fails here.
     */
    it('takes the newest of a THREE-row run for "after", and steps past all three for "before"', () => {
      const burst: RestorableSnapshot[] = [
        { id: 'snap_create', messageId: 'msg_create' },
        { id: 'snap_burst', messageId: 'msg_burst' },
        { id: 'snap_burst_media', messageId: 'msg_burst' },
        { id: 'snap_burst_save', messageId: 'msg_burst' },
        { id: 'snap_later', messageId: 'msg_later' },
      ];

      expect(selectRestoreTarget(burst, 'msg_burst', 'after')).toEqual({ ok: true, snapshot: burst[3] });
      expect(selectRestoreTarget(burst, 'msg_burst', 'before')).toEqual({ ok: true, snapshot: burst[0] });
    });

    /*
     * The off-by-one a mid-history fixture cannot see: the newest turn is the one a user undoes, so its
     * top-up is the FINAL element. A reverse scan starting at `length - 2` (or a loop bounded `>= index`
     * the wrong way) still passes the pair test above and breaks precisely here.
     */
    it('resolves the last match when the duplicate pair ENDS the history', () => {
      const newest: RestorableSnapshot[] = [
        { id: 'snap_create', messageId: 'msg_create' },
        { id: 'snap_boost', messageId: 'msg_boost' },
        { id: 'snap_latest', messageId: 'msg_latest' },
        { id: 'snap_latest_topup', messageId: 'msg_latest' },
      ];

      expect(selectRestoreTarget(newest, 'msg_latest', 'after')).toEqual({ ok: true, snapshot: newest[3] });
    });

    /*
     * The rows of a turn need not be contiguous, and they must not be assumed to be: a checkpoint with no
     * `messageId` at all is representable (the type makes it optional). A forward scan that stops at the
     * first NON-match — the other obvious way to write this — returns the pre-top-up row here.
     */
    it('scans past an unanchored row to the last match', () => {
      const interleaved: RestorableSnapshot[] = [
        { id: 'snap_create', messageId: 'msg_create' },
        { id: 'snap_media', messageId: 'msg_media' },
        { id: 'snap_orphan' },
        { id: 'snap_media_topup', messageId: 'msg_media' },
      ];

      expect(selectRestoreTarget(interleaved, 'msg_media', 'after')).toEqual({ ok: true, snapshot: interleaved[3] });
    });

    /*
     * A duplicated run at the very start still has nothing before it. Refusing beats silently restoring
     * the oldest row we happen to hold, which is a different project.
     */
    it('still refuses "before" when the duplicated run is the oldest thing we have', () => {
      const fromTheStart: RestorableSnapshot[] = [
        { id: 'snap_create', messageId: 'msg_create' },
        { id: 'snap_create_topup', messageId: 'msg_create' },
        { id: 'snap_later', messageId: 'msg_later' },
      ];

      expect(selectRestoreTarget(fromTheStart, 'msg_create', 'before')).toEqual({
        ok: false,
        reason: 'nothing-before',
      });
    });

    /*
     * CONTROL. The duplicate handling must not leak across message boundaries: a single-match message
     * sitting in a history that contains duplicates elsewhere resolves to its own row, exactly as it did
     * before T2 — the whole point being that T2 changed how a RUN of matching rows is resolved, not
     * which rows match. It pins the property the duplicate tests cannot: that a message with one
     * checkpoint is untouched by duplicates existing elsewhere in the same history.
     */
    it('leaves a single-match message alone even when the history contains duplicates', () => {
      expect(selectRestoreTarget(toppedUp, 'msg_later', 'after')).toEqual({ ok: true, snapshot: toppedUp[3] });
      expect(selectRestoreTarget(toppedUp, 'msg_later', 'before')).toEqual({ ok: true, snapshot: toppedUp[2] });
      expect(selectRestoreTarget(toppedUp, 'msg_create', 'after')).toEqual({ ok: true, snapshot: toppedUp[0] });
    });

    /* An unknown message is still unknown, duplicates or not. */
    it('still reports a message with no checkpoint at all', () => {
      expect(selectRestoreTarget(toppedUp, 'msg_unknown', 'after')).toEqual({
        ok: false,
        reason: 'no-checkpoint-for-message',
      });
    });
  });
});
