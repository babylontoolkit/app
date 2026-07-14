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
});
