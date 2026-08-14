/**
 * The decider that starts a generation nobody asked for (§4.4e).
 *
 * Same category as `auto-repair.spec.ts`: every `run` spends the user's credits, so the branches that
 * say *don't* are the subject of this file rather than edge cases around it. Exhaustive and
 * mutation-verified — the failure modes are (a) a loop that bills a generation per render and (b) a
 * plan that silently stops, stranding a half-built project.
 */
import { describe, expect, it } from 'vitest';
import { advanceCreationPlan, newCreationPlan, type CreationPlan } from '~/lib/agent/creation-plan';
import {
  MAX_CREATION_PHASE_RETRIES,
  creationPlanActive,
  decideCreationPhaseRetry,
  decideNextCreationTurn,
  type CreationRetryInput,
  type CreationTurnInput,
} from './creation-plan-runner';

const PROJECT = 'prj_1';

/** A plan advanced `n` phases, i.e. `next === n`. */
function planAt(n: number): CreationPlan {
  let plan = newCreationPlan();

  for (let i = 0; i < n; i++) {
    plan = advanceCreationPlan(plan, {
      id: plan.phases[plan.next],
      generationId: `gen_${i}`,
      at: '2026-08-14T00:00:00.000Z',
      state: 'finished',
    });
  }

  return plan;
}

/** The happy state: a plan armed for its next phase, nothing in flight. */
function ready(overrides: Partial<CreationTurnInput> = {}): CreationTurnInput {
  return {
    plan: planAt(1),
    projectId: PROJECT,
    isLoading: false,
    hasError: false,
    armedIndex: 1,
    lastOutcome: 'finished',
    paused: null,
    retrying: false,
    ...overrides,
  };
}

describe('decideNextCreationTurn', () => {
  it('runs the armed phase when nothing is in flight', () => {
    expect(decideNextCreationTurn(ready())).toEqual({ kind: 'run', index: 1 });
  });

  it('reports done when the plan is complete', () => {
    expect(decideNextCreationTurn(ready({ plan: planAt(newCreationPlan().phases.length), armedIndex: null }))).toEqual({
      kind: 'done',
    });
  });

  describe('the ways it must NOT run', () => {
    it('waits while a generation is streaming', () => {
      expect(decideNextCreationTurn(ready({ isLoading: true }))).toEqual({ kind: 'wait' });
    });

    /**
     * 🔴 THE LATCH — one comparison covering both halves (`armedIndex === plan.next`).
     *
     * ⚠️ These three cases are ONE test on purpose. Written as two — a `null` case and a stale-arm
     * case — the `null` one is vacuous: it passes with the null guard deleted, because the equality
     * check catches it anyway. Mutation testing found that, and the redundant guard was removed
     * rather than the test left claiming to cover it.
     *
     * Unarmed is the loop this whole shape prevents: the effect re-runs on every render, so a `run`
     * without a fresh arm is a full generation per render on the user's bill. A stale arm is the
     * other direction — another tab advanced the row, or a retry arrived out of order — and the row
     * wins, because `mergeCreationPlan` is monotonic server-side exactly so a client cannot rewind it.
     */
    it('waits unless the arm matches the phase the server believes is next', () => {
      expect(decideNextCreationTurn(ready({ armedIndex: null }))).toEqual({ kind: 'wait' });
      expect(decideNextCreationTurn(ready({ armedIndex: 3 }))).toEqual({ kind: 'wait' });
      expect(decideNextCreationTurn(ready({ armedIndex: 0 }))).toEqual({ kind: 'wait' });
    });

    it('waits when there is no plan or no project', () => {
      expect(decideNextCreationTurn(ready({ plan: null }))).toEqual({ kind: 'wait' });
      expect(decideNextCreationTurn(ready({ plan: undefined }))).toEqual({ kind: 'wait' });
      expect(decideNextCreationTurn(ready({ projectId: undefined }))).toEqual({ kind: 'wait' });
    });
  });

  describe('the ways it must PAUSE', () => {
    /**
     * The next phase builds on the files this one wrote, so continuing past an error compounds a
     * broken tree AND bills for it — and only the user can see whether the failure was transient.
     */
    it('pauses on an error', () => {
      expect(decideNextCreationTurn(ready({ hasError: true }))).toEqual({ kind: 'pause', reason: 'error' });
    });

    it('pauses when the server judged the last turn incomplete', () => {
      expect(decideNextCreationTurn(ready({ lastOutcome: 'incomplete' }))).toEqual({
        kind: 'pause',
        reason: 'incomplete',
      });
    });

    /** A rescued turn DID finish — it just needed a second pass. It must not stop the plan. */
    it('does not pause on a rescued turn', () => {
      expect(decideNextCreationTurn(ready({ lastOutcome: 'rescued' }))).toEqual({ kind: 'run', index: 1 });
    });

    /**
     * 🔴 A pause is terminal until the user acts. Re-deriving it every render is how a paused plan
     * starts running again on its own — the opposite failure to the loop, and quieter.
     */
    it('stays paused, and does not re-decide', () => {
      expect(decideNextCreationTurn(ready({ paused: 'unsettled' }))).toEqual({ kind: 'pause', reason: 'unsettled' });
    });

    /** An error outranks the arm: a turn that errored AFTER arming must not slip through. */
    it('pauses on an error even when armed and idle', () => {
      expect(decideNextCreationTurn(ready({ hasError: true, armedIndex: 1 }))).toEqual({
        kind: 'pause',
        reason: 'error',
      });
    });
  });
});

/**
 * 🔴 THE AUTOMATIC RETRY OF A FAILED PHASE (owner, 2026-08-14 — *"just please make it finish"*).
 *
 * Third mechanism in the product that starts a generation with no user action, so the same rule as
 * `decideAutoRepair` and `decideNextCreationTurn`: the branches that say NO are the subject here.
 *
 * It is defensible with the user's money for one reason — a hard failure REFUNDS in full, so the
 * retry is the first actual charge for that step. The arithmetic is why it exists: at the measured
 * ~1-in-8 per-phase failure rate a three-step build finishes ~68% of the time, and one retry per step
 * takes it to ~96%.
 */
describe('decideCreationPhaseRetry', () => {
  const failing = (overrides: Partial<CreationRetryInput> = {}): CreationRetryInput => ({
    plan: planAt(1),
    attempts: 0,
    stopped: false,
    unaffordable: false,
    ...overrides,
  });

  it('retries the phase that failed', () => {
    expect(decideCreationPhaseRetry(failing())).toEqual({ kind: 'retry', index: 1 });
  });

  describe('the ways it must NOT retry', () => {
    /**
     * 🔴 A STOP IS A DECISION, NOT A FAILURE. It reaches the error path as an aborted fetch, so
     * without this the product answers "cancel that" by immediately re-running it, and bills for it.
     */
    it('never retries a turn the user stopped', () => {
      expect(decideCreationPhaseRetry(failing({ stopped: true }))).toEqual({ kind: 'stop', reason: 'stopped' });
    });

    /**
     * 🔴 OUT OF CREDIT FAILS AGAIN, IDENTICALLY. It is the one failure only the user can resolve, and
     * a second identical refusal reads as the product being broken rather than as an empty wallet.
     */
    it('never retries a 402', () => {
      expect(decideCreationPhaseRetry(failing({ unaffordable: true }))).toEqual({
        kind: 'stop',
        reason: 'unaffordable',
      });
    });

    it('retries ONCE — a phase that fails twice is not intermittent', () => {
      expect(decideCreationPhaseRetry(failing({ attempts: MAX_CREATION_PHASE_RETRIES }))).toEqual({
        kind: 'stop',
        reason: 'exhausted',
      });
    });

    /* An ordinary edit that fails is the user's to retry — they typed it and can see what happened. */
    it('does nothing outside a plan', () => {
      expect(decideCreationPhaseRetry(failing({ plan: null }))).toEqual({ kind: 'stop', reason: 'no-plan' });
      expect(decideCreationPhaseRetry(failing({ plan: undefined }))).toEqual({ kind: 'stop', reason: 'no-plan' });
    });

    it('does nothing once the plan is complete', () => {
      const done = planAt(newCreationPlan().phases.length);
      expect(decideCreationPhaseRetry(failing({ plan: done }))).toEqual({ kind: 'stop', reason: 'complete' });
    });
  });

  /**
   * 🔴 ORDER: a Stop and a 402 are ANSWERS, not transients, so they must not consume the one retry a
   * genuinely transient failure is owed. Without this a user who stops a phase, then hits a real
   * provider truncation on the same step, gets no retry at all.
   */
  it('a stop or a 402 does not spend the retry a transient failure is owed', () => {
    expect(decideCreationPhaseRetry(failing({ stopped: true, attempts: 0 })).kind).toBe('stop');
    expect(decideCreationPhaseRetry(failing({ attempts: 0 }))).toEqual({ kind: 'retry', index: 1 });
  });
});

/**
 * 🔴 THE RETRY AND THE ERROR-PAUSE MUST NOT DEADLOCK.
 *
 * `useChat` keeps `error` set until the next request starts, so a re-armed phase meets a decider that
 * still sees `hasError`. Without `retrying` the plan pauses anyway and the automatic retry does
 * nothing at all — silently, which is how every inert feature in this file's history behaved.
 */
describe('decideNextCreationTurn — the retry suppression', () => {
  it('runs the re-armed phase despite the error that caused the retry', () => {
    expect(decideNextCreationTurn(ready({ hasError: true, retrying: true }))).toEqual({ kind: 'run', index: 1 });
  });

  /* CONTROL — without it the error still pauses, so this is a one-shot suppression and not a hole. */
  it('CONTROL — an error with no retry armed still pauses', () => {
    expect(decideNextCreationTurn(ready({ hasError: true }))).toEqual({ kind: 'pause', reason: 'error' });
  });

  /**
   * 🔴 It suppresses the ERROR pause and NOTHING else. `incomplete` and `unsettled` describe the TREE
   * — a truncated or half-written project — and re-running a phase over one is the corruption the
   * pause exists to prevent.
   */
  it('does not suppress a pause about the state of the project', () => {
    expect(decideNextCreationTurn(ready({ retrying: true, lastOutcome: 'incomplete' }))).toEqual({
      kind: 'pause',
      reason: 'incomplete',
    });
    expect(decideNextCreationTurn(ready({ retrying: true, paused: 'unsettled' }))).toEqual({
      kind: 'pause',
      reason: 'unsettled',
    });
  });
});

describe('creationPlanActive — the auto-repair disarm (trap 2)', () => {
  /**
   * A compile error between phases is NORMAL: the frontend phase imports art the art phase has not
   * rendered yet. Without this, `decideAutoRepair` fires between every pair of phases — billing the
   * user to fix what the next phase fixes, and colliding with it for the in-flight claim.
   */
  it('is true while phases remain', () => {
    const last = newCreationPlan().phases.length - 1;

    expect(creationPlanActive(planAt(0))).toBe(true);

    /*
     * Derived from the plan's own length: the default list lost `verify` on 2026-08-14, and a literal
     * index here silently became "a COMPLETE plan" — which asserts the opposite of what it says.
     */
    expect(creationPlanActive(planAt(last))).toBe(true);
  });

  /**
   * The CONTROL, and the load-bearing half: once the plan is done, self-healing must come BACK. The
   * last phase's output is real code with nothing after it to fix a mistake — that is the turn
   * auto-repair exists for, and a guard that stayed on forever would disable it silently.
   */
  it('is false once the plan completes, so self-healing returns', () => {
    expect(creationPlanActive(planAt(newCreationPlan().phases.length))).toBe(false);
    expect(creationPlanActive(null)).toBe(false);
    expect(creationPlanActive(undefined)).toBe(false);
  });
});
