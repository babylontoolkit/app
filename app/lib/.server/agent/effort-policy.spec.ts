/**
 * Per-turn effort (§4.2a) — a MONEY path, and one that is easy to talk yourself into getting wrong.
 *
 * Thinking tokens are billed as OUTPUT tokens, so "how hard does it think" is the biggest single line
 * on the bill. The obvious optimisation is to make cheap-looking turns think less. We measured that,
 * and it was WRONG — the tests below encode why, so nobody re-derives the bad idea from first
 * principles in six months.
 */
import { describe, expect, it } from 'vitest';
import { effortForTurn } from './effort-policy';

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
   *
   * `undefined` IS the contract, not a gap: it means "no opinion, use the operator's default", which
   * the provider resolves to `THINKING_EFFORT` else `medium` (`providers/anthropic.ts`, whose spec
   * owns the precedence chain and the `low` clamp — this file must not grow a second copy of them).
   */
  it('does NOT downgrade an ordinary edit turn — `low` breached a read-only zone when we measured it', () => {
    expect(effortForTurn(EDIT)).toBeUndefined();
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

  /**
   * Escalation beats operator config: a failing build is not the place to economise. The policy speaks
   * (a concrete level) rather than staying silent, and the provider's `options.effort ?? …` chain takes
   * whatever it says first — so a `THINKING_EFFORT=medium` operator still gets `xhigh` on a 2nd repair.
   */
  it('speaks up on a repair rather than deferring to the operator default', () => {
    expect(effortForTurn({ isRepair: true, repairAttempt: 2, isSlashInvocation: false })).toBe('xhigh');
    expect(effortForTurn(EDIT)).toBeUndefined();
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
