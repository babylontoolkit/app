/**
 * 🔴 A PAUSED PLAN RESUMES BY ITSELF AFTER THE USER'S ONE PRESS — a source scan of `Chat.client.tsx`.
 *
 * `decideNextCreationTurn` returns `pause` for as long as `phasePause` is set. The pause used to be
 * cleared ONLY by `/clear`, so after the user pressed the alert's action ("Keep building" / "Fix the
 * errors") and that phase turn finished, the next phase was armed and then never ran — the user had to
 * type "continue" for every remaining step. And a continue queued after a stale pause leaked into a
 * later phase run.
 *
 * ⚠️ A scan sees names in places, not execution order; the decider itself is pinned in
 * `creation-plan-runner.spec.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CHAT = readFileSync(join(process.cwd(), 'app/components/chat/Chat.client.tsx'), 'utf8');

/** The text from `start` up to the next `stop` after it, or '' when `start` is absent. */
function region(start: string, stop: string): string {
  const from = CHAT.indexOf(start);

  if (from < 0) {
    return '';
  }

  const to = CHAT.indexOf(stop, from + start.length);

  return CHAT.slice(from, to < 0 ? undefined : to);
}

describe('a phase send ends the pause', () => {
  /* The send path that decides whether this message carries a phase. */
  const send = region('phaseTurnRef.current = Boolean(phaseId);', 'body: { ...liveTurnBody()');

  it('clears phasePause when the send carries a phase', () => {
    expect(send).not.toBe('');
    expect(send).toMatch(/if \(phaseId\) \{\s*setPhasePause\(null\);\s*\}/);
  });

  /* CONTROL — the clear is conditional: an ordinary message must never end a pause it is not resuming. */
  it('CONTROL — it is gated on the send actually carrying a phase', () => {
    const ungated = send.replace(/if \(phaseId\) \{\s*setPhasePause\(null\);\s*\}/, '');
    expect(ungated).not.toContain('setPhasePause(null)');
  });
});

describe('setting a pause drops any pending continue', () => {
  const pause = region("action === 'pause-incomplete' || action === 'pause-budget'", '} else {');

  it('both pause branches reset continueMessageRef and the auto-continue count, then pause', () => {
    expect(pause).not.toBe('');
    expect(pause).toMatch(/continueMessageRef\.current = null;/);
    expect(pause).toMatch(/autoContinueRef\.current = \{ index: -1, used: 0 \};/);
    expect(pause).toMatch(/setPhasePause\(action === 'pause-budget' \? 'budget' : 'incomplete'\)/);
    expect(pause.indexOf('continueMessageRef.current = null')).toBeLessThan(pause.indexOf('setPhasePause('));
  });

  it('/clear also drops a pending continue', () => {
    const clear = region('phaseTurnRef.current = false;\n      setPhasePause(null);', 'clearedMode');
    expect(clear).toMatch(/continueMessageRef\.current = null;/);
    expect(clear).toMatch(/autoContinueRef\.current = \{ index: -1, used: 0 \};/);
  });

  /* CONTROL — the auto-continue branch must still SET the message, or the reset above is vacuous. */
  it('CONTROL — the auto-continue branch still queues KEEP_BUILDING_MESSAGE', () => {
    expect(CHAT).toMatch(/continueMessageRef\.current = KEEP_BUILDING_MESSAGE;/);
  });
});
