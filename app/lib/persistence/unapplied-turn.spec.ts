/**
 * Data-loss tests (SPEC §4.5.4c, §4.12, §4.13).
 *
 * A wrong `apply` writes an old artifact over a live project — the silent corruption deviation 7
 * records. A wrong `none` leaves the user charged for work they never received, which is the measured
 * 427-credit failure this exists for. `offer` is the answer whenever the facts cannot tell those apart.
 */
import { describe, expect, it } from 'vitest';
import { detectUnappliedTurn, type UnappliedTurnFacts } from './unapplied-turn';

const base: UnappliedTurnFacts = {
  source: 'local',
  lastAssistantMessageId: 'msg-9',
  hasFileActions: true,
  mountedMessageId: 'msg-7',
};

describe('nothing to do', () => {
  /* The ordinary, healthy case after every successful generation. */
  it('does nothing when the mounted copy already carries that turn', () => {
    expect(detectUnappliedTurn({ ...base, mountedMessageId: 'msg-9' })).toEqual({ action: 'none' });
  });

  it('does nothing when there is no assistant turn at all', () => {
    expect(detectUnappliedTurn({ ...base, lastAssistantMessageId: undefined })).toEqual({ action: 'none' });
  });

  /* A prose answer writes nothing — offering to "apply" it would be an offer to do nothing. */
  it('does nothing when the turn wrote no files', () => {
    expect(detectUnappliedTurn({ ...base, hasFileActions: false })).toEqual({ action: 'none' });
  });
});

describe('it never writes over a repo, and never resolves a divergence', () => {
  /*
   * 🔴 The repo is the user's own committed history. Writing a local artifact over it is the silent
   * merge §4.13 forbids outright.
   */
  it('does nothing when the files came from the repo', () => {
    expect(detectUnappliedTurn({ ...base, source: 'repo' })).toEqual({ action: 'none' });
  });

  /* The divergence dialog exists to ask this question — answering it by writing files pre-empts it. */
  it('does nothing on a divergence', () => {
    expect(detectUnappliedTurn({ ...base, source: 'diverged' })).toEqual({ action: 'none' });
  });
});

describe('applying without asking, only when nothing can be destroyed', () => {
  it('applies when the project has no files from any source', () => {
    expect(detectUnappliedTurn({ ...base, source: 'empty', mountedMessageId: undefined })).toEqual({
      action: 'apply',
      messageId: 'msg-9',
    });
  });

  it('still does nothing on an empty project whose last turn wrote no files', () => {
    expect(detectUnappliedTurn({ ...base, source: 'empty', hasFileActions: false })).toEqual({ action: 'none' });
  });
});

describe('otherwise it ASKS', () => {
  /*
   * 🔴 THE TRAP. A crash before the checkpoint and a deliberate §4.12 undo both leave the mounted copy
   * older than the last assistant turn, and the facts here cannot tell them apart. Auto-applying would
   * silently undo the user's undo, so the answer is the §4.13 posture: ask.
   */
  it('offers rather than applying when a local copy is behind the last turn', () => {
    expect(detectUnappliedTurn(base)).toEqual({ action: 'offer', messageId: 'msg-9' });
  });

  it('offers when a recovered working copy is behind the last turn', () => {
    expect(detectUnappliedTurn({ ...base, source: 'working' })).toEqual({ action: 'offer', messageId: 'msg-9' });
  });

  /* A copy with no recorded message id says nothing about which turns it contains — still ask. */
  it('offers when the mounted copy records no message id', () => {
    expect(detectUnappliedTurn({ ...base, mountedMessageId: undefined })).toEqual({
      action: 'offer',
      messageId: 'msg-9',
    });
  });
});
