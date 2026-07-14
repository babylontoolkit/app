/**
 * Per-turn effort (§4.2a) — a MONEY path, and one that is easy to talk yourself into getting wrong.
 *
 * Thinking tokens are billed as OUTPUT tokens, so "how hard does it think" is the biggest single line
 * on the bill. The obvious optimisation is to make cheap-looking turns think less. We measured that,
 * and it was WRONG — the tests below encode why, so nobody re-derives the bad idea from first
 * principles in six months.
 */
import { describe, expect, it } from 'vitest';
import { effortForTurn, resolveEffort } from './effort-policy';

const EDIT = { isRepair: false, repairAttempt: 1, isSlashInvocation: false };

describe('effortForTurn', () => {
  /**
   * THE LOAD-BEARING TEST. The original plan was to drop edit turns to `low` and pocket the savings.
   * On a real substantial edit ("add a boost mechanic") against the real project:
   *
   *   low     67 credits — edited `src/routing/router.tsx`, which is READ-ONLY SHELL (§4.4c), and
   *                        rewrote whole files instead of patching them.
   *   medium 125 credits — created `src/scripts/BoostController.ts` in the correct zone and patched
   *                        the rest; 5/5 search-replace blocks matched cleanly.
   *
   * `low` was not cheaper, it was WRONG: a never-violate zone breach is a correctness bug, not a
   * missing polish. So an ordinary turn takes the configured default and this policy stays silent.
   */
  it('does NOT downgrade an ordinary edit turn — `low` breached a read-only zone when we measured it', () => {
    expect(effortForTurn(EDIT)).toBeUndefined();
    expect(resolveEffort(EDIT)).toBe('medium');
  });

  it('leaves the operator config authoritative on ordinary turns', () => {
    expect(resolveEffort(EDIT, 'high')).toBe('high');
    expect(resolveEffort(EDIT, 'xhigh')).toBe('xhigh');
  });

  /**
   * `low` is not merely unused — it is unreachable. An operator who sets `THINKING_EFFORT=low` in
   * `.env.local` (a string file; the type system cannot stop them) gets clamped back up to `medium`,
   * because the measurement above says `low` is a correctness bug wearing a discount's clothes.
   */
  it('refuses a `low` operator config and clamps it to `medium`', () => {
    expect(resolveEffort(EDIT, 'low')).toBe('medium');
  });

  it('falls back to the default on a typo rather than putting garbage on the wire', () => {
    expect(resolveEffort(EDIT, 'hgih')).toBe('medium');
    expect(resolveEffort(EDIT, '')).toBe('medium');
  });

  /**
   * The actual value of this policy. A repair turn is the model staring at a compile error IT caused —
   * and until now it thought exactly as hard as the turn that just failed, which is backwards.
   */
  it('escalates a first repair to `high`', () => {
    expect(effortForTurn({ isRepair: true, repairAttempt: 1, isSlashInvocation: false })).toBe('high');
  });

  it('escalates a SECOND repair to `xhigh` — it has now failed twice', () => {
    expect(effortForTurn({ isRepair: true, repairAttempt: 2, isSlashInvocation: false })).toBe('xhigh');
  });

  /** Escalation beats operator config: a failing build is not the place to economise. */
  it('escalates a repair even when the operator configured a cheaper default', () => {
    expect(resolveEffort({ isRepair: true, repairAttempt: 2, isSlashInvocation: false }, 'medium')).toBe('xhigh');
  });

  /** `/bt-spec`, `/bt-prototype` — the user explicitly asked for deep work. Answer the question asked. */
  it('gives an explicitly invoked skill `high`', () => {
    expect(effortForTurn({ isRepair: false, repairAttempt: 1, isSlashInvocation: true })).toBe('high');
  });

  /** A repair inside a slash invocation is still a repair — the stronger signal wins. */
  it('prefers the repair signal over the slash signal', () => {
    expect(effortForTurn({ isRepair: true, repairAttempt: 2, isSlashInvocation: true })).toBe('xhigh');
  });
});
