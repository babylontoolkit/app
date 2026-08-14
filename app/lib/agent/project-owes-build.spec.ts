/**
 * THE ASSERTION NOBODY WROTE: a real creation IS a first build turn (§4.4a, §4.4e).
 *
 * ## Why this file exists
 *
 * `first-build-turn.spec.ts` pins ten consumers of `isFirstBuildTurn`, each twice, mutation-verified,
 * with the flag true AND false. It is a good file. It was also completely green for the six days the
 * flag was returning `false` on **every creation in production**, because every assertion in it is of
 * the form *"when the marker is present, X happens"* — and after 2026-08-08 nothing sent the marker.
 *
 * The missing assertion was never about a consumer. It was about the INPUT: *does a real creation
 * actually produce a true here?* That question had no test because it had no seam — the derivation was
 * a bare `includes()` on a string, inlined at one call site.
 *
 * This is the cache warmer's `expect(result.skipped).toContain('not KIE')` again: a test can only
 * assert the behaviour someone wrote down, and it cannot notice that the behaviour stopped being the
 * one you wanted. So the tests here are written against the LIFECYCLE — created, building, built —
 * rather than against the signal, and they would have failed on 2026-08-08.
 */
import { describe, expect, it } from 'vitest';
import {
  advanceCreationPlan,
  isCreationPlanComplete,
  newCreationPlan,
  projectOwesBuild,
  type CreationPlan,
} from './creation-plan';

/** Walk a plan to completion the way `onFinish` does, one finished phase at a time. */
function runToCompletion(plan: CreationPlan): CreationPlan {
  let current = plan;

  while (!isCreationPlanComplete(current)) {
    current = advanceCreationPlan(current, {
      id: current.phases[current.next],
      generationId: `gen_${current.next}`,
      at: '2026-08-14T00:00:00.000Z',
      state: 'finished',
    });
  }

  return current;
}

describe('the project lifecycle decides whether a turn is a build', () => {
  /**
   * 🔴 THE REGRESSION TEST FOR THE SIX-DAY OUTAGE.
   *
   * A project that has been created and never built owes a build. This is the state
   * `gen_msswm3qx_u4u2bt` was in — created 12:04, built 12:09 — and the server called it an `edit`,
   * so `owesFiles` was false and 117 credits were charged for zero files with no refund.
   */
  it('a created, never-built project owes a build', () => {
    expect(projectOwesBuild({})).toBe(true);
    expect(projectOwesBuild({ userPrompt: 'a mario kart style racing system' })).toBe(true);
  });

  it('a project mid-plan still owes a build, on every phase', () => {
    let plan = newCreationPlan();

    // Every phase up to the last one must still read as a build turn — all ten protections apply.
    while (!isCreationPlanComplete(plan)) {
      expect(projectOwesBuild({ plan })).toBe(true);

      plan = advanceCreationPlan(plan, {
        id: plan.phases[plan.next],
        generationId: 'gen_x',
        at: '2026-08-14T00:00:00.000Z',
        state: 'finished',
      });
    }
  });

  it('a completed plan owes nothing — the build is over', () => {
    expect(projectOwesBuild({ plan: runToCompletion(newCreationPlan()) })).toBe(false);
  });

  /**
   * The end state. `saveCreationHandoff(id, null)` runs when the last phase completes, and from then
   * on every turn is an ordinary edit — which is what stops a year-old project's every message being
   * treated as a creation (bounded tool rounds, preloaded skills, and a refund if it writes no files).
   */
  it('a cleared handoff owes nothing', () => {
    expect(projectOwesBuild(null)).toBe(false);
    expect(projectOwesBuild(undefined)).toBe(false);
  });

  /**
   * 🔴 THE ASYMMETRY THAT MAKES THIS FUNCTION NECESSARY.
   *
   * `isCreationPlanComplete(undefined)` is `true` — correct for a PLAN, which may never have existed.
   * For a PROJECT, a handoff with no plan is one whose build has not started: the most owed a build
   * can be. Reusing the plan predicate here would return `false` for exactly the turn this exists to
   * identify, silently, which is the shape of the original bug.
   *
   * The CONTROL is the point: it proves the two predicates genuinely disagree on this input, so a
   * "simplification" that routes one through the other fails here rather than in production.
   */
  it('disagrees with isCreationPlanComplete on the no-plan case, deliberately', () => {
    expect(isCreationPlanComplete(undefined)).toBe(true);
    expect(projectOwesBuild({})).toBe(true);
  });
});
