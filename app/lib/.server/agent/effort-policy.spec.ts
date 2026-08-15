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

const EDIT = { isRepair: false, repairAttempt: 1 };

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
    expect(effortForTurn({ isRepair: true, repairAttempt: 1 })).toBe('high');
  });

  it('escalates a SECOND repair to `xhigh` — it has now failed twice', () => {
    expect(effortForTurn({ isRepair: true, repairAttempt: 2 })).toBe('xhigh');
  });

  /**
   * Escalation beats operator config: a failing build is not the place to economise. The policy speaks
   * (a concrete level) rather than staying silent, and the provider's `options.effort ?? …` chain takes
   * whatever it says first — so a `THINKING_EFFORT=medium` operator still gets `xhigh` on a 2nd repair.
   */
  it('speaks up on a repair rather than deferring to the operator default', () => {
    expect(effortForTurn({ isRepair: true, repairAttempt: 2 })).toBe('xhigh');
    expect(effortForTurn(EDIT)).toBeUndefined();
  });

  /**
   * 🔴 A `/slash` INVOCATION IS NOT SPECIAL (owner, 2026-08-14) — it used to escalate to `high`.
   *
   * The old rule guessed at DIFFICULTY ("a spec is deep work"), which is the prompt classifier this
   * file forbids, one rung more abstract. And it silently overrode the one user-facing dial in the
   * system: a `medium` session ran `/bt-landing`, logged `effort=high`, and read as the setting being
   * broken. Escalation is now EVIDENCE-only, and a repair is the only evidence there is.
   *
   * Asserted as an ABSENCE, which is the shape that rots quietly — `TurnShape` no longer carries a
   * slash field, so re-adding the rule means re-adding the field, and this test is what makes that a
   * decision rather than a patch.
   */
  it('does NOT escalate a `/slash` skill invocation — evidence only', () => {
    expect(effortForTurn({ isRepair: false, repairAttempt: 1 })).toBeUndefined();
    expect(effortForTurn({ isRepair: false, repairAttempt: 1, baseEffort: 'medium' })).toBe('medium');
  });

  /** There is no signal here but the repair — a slash turn that is ALSO a repair is simply a repair. */
  it('still escalates a repair, whatever the turn was invoked as', () => {
    expect(effortForTurn({ isRepair: true, repairAttempt: 2 })).toBe('xhigh');
  });

  /**
   * The user's `/effort` choice (§4.2.9). It is a FLOOR — the only user-facing dial in the whole effort
   * system, and it may only ever raise. Each test below is a way the floor could silently cost money or
   * silently do nothing.
   */
  describe('the user-chosen base effort is a floor, never a cap', () => {
    it('takes the user floor on an ordinary edit turn', () => {
      expect(effortForTurn({ ...EDIT, baseEffort: 'high' })).toBe('high');
    });

    /**
     * `medium` is ALSO the operator default, so sending it explicitly and staying silent are the same
     * request — but they must not be conflated in the other direction: the user picking `medium` is a
     * positive choice, and an operator running `THINKING_EFFORT=high` should still see it honoured as the
     * default when the user has said nothing. That is why `undefined` (no choice) stays `undefined`.
     */
    it('says nothing when the user never chose — the operator default stays authoritative', () => {
      expect(effortForTurn(EDIT)).toBeUndefined();
      expect(effortForTurn({ ...EDIT, baseEffort: undefined })).toBeUndefined();
    });

    it('honours an explicit `medium`', () => {
      expect(effortForTurn({ ...EDIT, baseEffort: 'medium' })).toBe('medium');
    });

    /**
     * THE LOAD-BEARING ONE. A `high` floor must not become a ceiling: a repair that has already failed
     * twice is exactly the turn that needs `xhigh`, and taking the floor here instead would mean choosing
     * `high` makes hard failures think LESS than the default session does. Silent, and backwards.
     */
    it('still escalates a second repair to `xhigh` above a `high` floor', () => {
      expect(effortForTurn({ isRepair: true, repairAttempt: 2, baseEffort: 'high' })).toBe('xhigh');
    });

    it('still escalates a first repair to `high` from a `medium` floor', () => {
      expect(effortForTurn({ isRepair: true, repairAttempt: 1, baseEffort: 'medium' })).toBe('high');
    });

    /**
     * A `high` floor and a first repair AGREE, and the answer is `high` — not a rung above it.
     *
     * `atLeast` takes the higher of the two; it must never add them. Compounding would put an ordinary
     * first repair at `xhigh` for anyone who chose `high`, i.e. spend the evidence tier on a turn that
     * has failed once, and it would do it only for the users who opted into thinking harder.
     */
    it('does not compound a floor with an equal escalation', () => {
      expect(effortForTurn({ isRepair: true, repairAttempt: 1, baseEffort: 'high' })).toBe('high');
    });
  });
});
