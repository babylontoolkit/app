/**
 * The phase plan is a MONEY path and a DATA path: it decides which turns run (each one billed) and
 * it arrives in a browser body. Every assertion here is mutation-verified — break the rule, watch
 * the named test fail.
 */
import { describe, expect, it } from 'vitest';
import { CREATION_BRIEF_MARKER } from '~/types/creation';
import {
  CREATION_PHASES,
  CREATION_PLAN_VERSION,
  DEFAULT_CREATION_PHASES,
  MAX_CREATION_PHASES,
  advanceCreationPlan,
  creationPhaseMessage,
  currentCreationPhase,
  describeCreationPlan,
  describeCreationPlanOutcome,
  isCreationPlanComplete,
  mergeCreationPlan,
  newCreationPlan,
  parseCreationPhaseId,
  parseCreationPlan,
  phaseAllowsMedia,
  type CreationPlan,
} from './creation-plan';

const record = (id: any, state: any = 'finished') => ({ id, generationId: 'gen_1', at: '2026-08-08T00:00:00Z', state });

describe('the phase table', () => {
  it('is Game -> Frontend -> Art -> Verify, in that order', () => {
    expect(DEFAULT_CREATION_PHASES).toEqual(['game', 'frontend', 'art', 'verify']);
  });

  /*
   * The order is what survives a failure, not what looks best first. Fail after `game` and you have a
   * playable project with a stock page; the reverse buys a pretty page in front of no game.
   */
  it('puts the game before the front end', () => {
    const ids = DEFAULT_CREATION_PHASES;
    expect(ids.indexOf('game')).toBeLessThan(ids.indexOf('frontend'));
  });

  it('gives media to EXACTLY ONE phase, and it is the art phase', () => {
    const withMedia = CREATION_PHASES.filter((p) => p.allowsMedia).map((p) => p.id);
    expect(withMedia).toEqual(['art']);
  });

  it('phaseAllowsMedia is false for every non-art phase and for no phase at all', () => {
    expect(phaseAllowsMedia('art')).toBe(true);
    expect(phaseAllowsMedia('game')).toBe(false);
    expect(phaseAllowsMedia('frontend')).toBe(false);
    expect(phaseAllowsMedia('verify')).toBe(false);
    expect(phaseAllowsMedia(null)).toBe(false);
  });

  /*
   * The narrow-request escape hatch. "just add a rotating cube" must not trigger a full landing
   * redesign, and the ONLY sanctioned mechanism is the task telling the model to write nothing —
   * never a classifier over the request (the fourth one in this codebase) and never over the model's
   * own output (worse).
   */
  it('every phase task tells the model it may write nothing', () => {
    for (const phase of CREATION_PHASES) {
      if (phase.id === 'verify') {
        continue; // a repair turn is only ever run when there is something to repair
      }

      expect(phase.task.toLowerCase()).toMatch(/say so in one line/);
    }
  });

  it('the game phase is told NOT to touch the landing page or chrome', () => {
    const game = CREATION_PHASES.find((p) => p.id === 'game')!;
    expect(game.task).toMatch(/do NOT touch the landing page/i);
  });

  it('the art phase forbids inventing an asset path', () => {
    const art = CREATION_PHASES.find((p) => p.id === 'art')!;
    expect(art.task).toMatch(/never a path you expect it to return/i);
  });
});

describe('parseCreationPhaseId — resolves DOWN', () => {
  it.each(['game', 'frontend', 'art', 'verify'])('accepts %s', (id) => {
    expect(parseCreationPhaseId(id)).toBe(id);
  });

  /*
   * This value arrives in a browser body and selects a toolset — the art phase can spend credits on
   * renders. Inventing a more capable phase than the caller named is the expensive direction.
   */
  it.each([['unknown'], [''], [null], [undefined], [42], [{ id: 'art' }], [['art']]])(
    'refuses %s rather than defaulting',
    (value) => {
      expect(parseCreationPhaseId(value)).toBeNull();
    },
  );
});

describe('parseCreationPlan', () => {
  const valid: CreationPlan = {
    v: CREATION_PLAN_VERSION,
    phases: ['game', 'frontend'],
    next: 1,
    done: [record('game')],
  };

  it('round-trips a well-formed plan', () => {
    expect(parseCreationPlan(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
  });

  /*
   * An unrecognised version degrades to the pre-phase single turn — survivable. Running a plan whose
   * meaning this build does not know is not.
   */
  it('treats an unknown version as NO plan', () => {
    expect(parseCreationPlan({ ...valid, v: 99 })).toBeUndefined();
    expect(parseCreationPlan({ ...valid, v: undefined })).toBeUndefined();
  });

  it.each([[null], [undefined], ['plan'], [42], [{}], [{ v: CREATION_PLAN_VERSION }]])(
    'returns undefined for %s',
    (value) => {
      expect(parseCreationPlan(value)).toBeUndefined();
    },
  );

  it('drops unknown phase ids, and returns no plan when none survive', () => {
    expect(parseCreationPlan({ ...valid, phases: ['game', 'nope'] })?.phases).toEqual(['game']);
    expect(parseCreationPlan({ ...valid, phases: ['nope', 'nah'] })).toBeUndefined();
  });

  it('caps the phase list', () => {
    const many = Array.from({ length: 50 }, () => 'game');
    expect(parseCreationPlan({ ...valid, phases: many })!.phases.length).toBe(MAX_CREATION_PHASES);
  });

  it('caps the done list', () => {
    const many = Array.from({ length: 50 }, () => record('game'));
    expect(parseCreationPlan({ ...valid, done: many })!.done.length).toBeLessThanOrEqual(MAX_CREATION_PHASES);
  });

  /*
   * A `next` past the end silently reports a plan as complete; a negative one re-runs a finished
   * phase and pays for it.
   */
  it.each([
    [-5, 0],
    [99, 2],
    [1.7, 1],
  ])('clamps next=%s to %s', (next, expected) => {
    expect(parseCreationPlan({ ...valid, phases: ['game', 'frontend'], next })!.next).toBe(expected);
  });

  /*
   * A value that is not a finite number falls to 0 — "run from the start" — and NOT to the end.
   * Both are wrong answers to a corrupt payload, but they fail in opposite directions: 0 re-runs
   * work visibly and recoverably, while `phases.length` reports a half-built project as complete and
   * strands it silently. `mergeCreationPlan` then absorbs it entirely, because the stored `next`
   * always wins over a lower one — so a corrupt client cannot rewind a real plan.
   */
  it.each([['1' as any], [NaN], [Infinity], [-Infinity], [null], [undefined]])(
    'treats a non-finite next (%s) as 0, never as complete',
    (next) => {
      expect(parseCreationPlan({ ...valid, phases: ['game', 'frontend'], next })!.next).toBe(0);
    },
  );

  it('and the merge makes that harmless — a corrupt next cannot rewind a stored plan', () => {
    const stored = parseCreationPlan({ ...valid, next: 2 })!;
    const corrupt = parseCreationPlan({ ...valid, next: NaN })!;
    expect(mergeCreationPlan(stored, corrupt)!.next).toBe(2);
  });

  it('degrades a corrupt done entry rather than dropping the plan', () => {
    const parsed = parseCreationPlan({ ...valid, done: [{ id: 'game', state: 'nonsense' }] })!;
    expect(parsed.done).toEqual([{ id: 'game', generationId: '', at: '', state: 'finished' }]);
  });

  it('drops a done entry whose phase id is unknown', () => {
    expect(parseCreationPlan({ ...valid, done: [record('nope')] })!.done).toEqual([]);
  });
});

describe('mergeCreationPlan — next only ever moves FORWARD', () => {
  const at = (next: number, done: any[] = []) => ({
    v: CREATION_PLAN_VERSION,
    phases: ['game', 'frontend'],
    next,
    done,
  });

  /*
   * A full replace lets a second tab or an out-of-order retry rewind the counter and re-run a phase
   * that already ran — paying twice and overwriting files that were correct.
   */
  it('keeps the higher next when the incoming plan is behind', () => {
    expect(mergeCreationPlan(at(2) as any, at(0) as any)!.next).toBe(2);
  });

  it('takes the incoming next when it is ahead', () => {
    expect(mergeCreationPlan(at(0) as any, at(2) as any)!.next).toBe(2);
  });

  it('unions done, and a stale client cannot erase a completed phase', () => {
    const merged = mergeCreationPlan(at(1, [record('game')]) as any, at(1, []) as any)!;
    expect(merged.done.map((d) => d.id)).toEqual(['game']);
  });

  it('adds a newly completed phase without duplicating an existing one', () => {
    const merged = mergeCreationPlan(
      at(1, [record('game')]) as any,
      at(2, [record('game'), record('frontend')]) as any,
    )!;
    expect(merged.done.map((d) => d.id)).toEqual(['game', 'frontend']);
  });

  it('passes either side through when the other is absent', () => {
    expect(mergeCreationPlan(undefined, at(1) as any)!.next).toBe(1);
    expect(mergeCreationPlan(at(1) as any, undefined)!.next).toBe(1);
    expect(mergeCreationPlan(undefined, undefined)).toBeUndefined();
  });
});

describe('advance / complete', () => {
  it('advances one step and records the phase', () => {
    const plan = advanceCreationPlan(newCreationPlan(), record('game'));
    expect(plan.next).toBe(1);
    expect(plan.done.map((d) => d.id)).toEqual(['game']);
  });

  it('never advances past the end', () => {
    let plan = newCreationPlan(['game']);
    plan = advanceCreationPlan(plan, record('game'));
    plan = advanceCreationPlan(plan, record('game'));
    expect(plan.next).toBe(1);
  });

  it('does not double-record a phase', () => {
    let plan = newCreationPlan(['game', 'frontend']);
    plan = advanceCreationPlan(plan, record('game'));
    plan = advanceCreationPlan(plan, record('game'));
    expect(plan.done.length).toBe(1);
  });

  it('isCreationPlanComplete is true at the end, and for no plan at all', () => {
    expect(isCreationPlanComplete(newCreationPlan())).toBe(false);
    expect(isCreationPlanComplete({ ...newCreationPlan(['game']), next: 1 })).toBe(true);
    expect(isCreationPlanComplete(undefined)).toBe(true);
    expect(isCreationPlanComplete(null)).toBe(true);
  });

  it('currentCreationPhase points at the next phase, and is null when complete', () => {
    expect(currentCreationPhase(newCreationPlan())?.id).toBe('game');
    expect(currentCreationPhase({ ...newCreationPlan(['game']), next: 1 })).toBeNull();
    expect(currentCreationPhase(undefined)).toBeNull();
  });
});

describe('creationPhaseMessage', () => {
  const plan = newCreationPlan();

  /*
   * 🔴 The marker is what makes a phase a FIRST BUILD TURN. Ten protections hang off it, including
   * `owesFiles` (which makes a turn that writes nothing a failure rather than a success) and
   * `describeTurnOutcome`, which returns `finished` for any turn that is not one. Drop it and phases
   * 2..N silently become ordinary edits.
   */
  it('carries CREATION_BRIEF_MARKER verbatim on EVERY phase', () => {
    for (let n = 0; n < plan.phases.length; n++) {
      expect(creationPhaseMessage(plan, n)).toContain(CREATION_BRIEF_MARKER);
    }
  });

  it('names the step and the total', () => {
    expect(creationPhaseMessage(plan, 0)).toContain('Step 1 of 4');
    expect(creationPhaseMessage(plan, 2)).toContain('Step 3 of 4');
  });

  it('carries that phase task and no other', () => {
    const message = creationPhaseMessage(plan, 0);
    expect(message).toContain('Write the GAME');
    expect(message).not.toContain('bt-landing skill');
  });

  /*
   * The brief rode on phase 0 and is already in the conversation. Re-sending it per phase pays for it
   * again on every turn, forever, in an UNCACHED history.
   */
  it('does NOT repeat the brief — it points at it', () => {
    const message = creationPhaseMessage(plan, 1);
    expect(message).toContain('in the brief earlier in this conversation');
    expect(message.length).toBeLessThan(2_000);
  });

  it('tells a phase not to rewrite what is already correct', () => {
    expect(creationPhaseMessage(plan, 1)).toMatch(/Do NOT rewrite files that are already correct/i);
  });

  it("defaults to the plan's own next phase", () => {
    expect(creationPhaseMessage({ ...plan, next: 1 })).toContain('Step 2 of 4');
  });
});

describe('describeCreationPlan', () => {
  it('marks done / current / pending in order', () => {
    const view = describeCreationPlan({ ...newCreationPlan(), next: 1, done: [record('game')] });
    expect(view.rows.map((r) => r.state)).toEqual(['done', 'current', 'pending', 'pending']);
    expect(view.step).toBe('Step 2 of 4');
    expect(view.complete).toBe(false);
  });

  it("carries each completed phase's own outcome", () => {
    const view = describeCreationPlan({ ...newCreationPlan(), next: 1, done: [record('game', 'rescued')] });
    expect(view.rows[0].outcome).toBe('rescued');
    expect(view.rows[1].outcome).toBeUndefined();
  });

  it('reports complete with no step', () => {
    const view = describeCreationPlan({ ...newCreationPlan(), next: 4 });
    expect(view.complete).toBe(true);
    expect(view.step).toBeNull();
  });
});

describe('describeCreationPlanOutcome — the plan-level verdict', () => {
  /*
   * The per-turn verdict cannot see this: a creation that completed two phases and stopped on the
   * third is a broken project made entirely of `finished` turns. That is the `wastedOutput` shape —
   * a metric defined against a failure it no longer detects, reporting health.
   */
  it('is INCOMPLETE while phases remain, naming how many and which is next', () => {
    const outcome = describeCreationPlanOutcome({ ...newCreationPlan(), next: 1, done: [record('game')] });
    expect(outcome.state).toBe('incomplete');
    expect(outcome.detail).toContain('3 of 4 steps');
    expect(outcome.detail).toContain('front end');
  });

  it('is FINISHED when every phase completed cleanly', () => {
    const done = DEFAULT_CREATION_PHASES.map((id) => record(id));
    expect(describeCreationPlanOutcome({ ...newCreationPlan(), next: 4, done }).state).toBe('finished');
  });

  it('is RESCUED when complete but a phase needed a second pass', () => {
    const done = DEFAULT_CREATION_PHASES.map((id, n) => record(id, n === 1 ? 'rescued' : 'finished'));
    expect(describeCreationPlanOutcome({ ...newCreationPlan(), next: 4, done }).state).toBe('rescued');
  });

  /*
   * CONTROL: incomplete OUTRANKS rescued. A plan that stopped early AND had a rescued phase is still
   * unfinished — reporting the rescue would describe the treatment while hiding the injury.
   */
  it('CONTROL: an unfinished plan with a rescued phase still reports incomplete', () => {
    const outcome = describeCreationPlanOutcome({
      ...newCreationPlan(),
      next: 2,
      done: [record('game'), record('frontend', 'rescued')],
    });
    expect(outcome.state).toBe('incomplete');
  });

  it('CONTROL: a finished plan says nothing — the common case must stay silent', () => {
    const done = DEFAULT_CREATION_PHASES.map((id) => record(id));
    const outcome = describeCreationPlanOutcome({ ...newCreationPlan(), next: 4, done });
    expect(outcome.headline).toBe('');
    expect(outcome.detail).toBe('');
  });
});
