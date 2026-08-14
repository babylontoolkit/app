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
  creationPhaseNote,
  phaseById,
  phaseOwesFiles,
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
  it('DECLARES Frontend -> Art -> Game -> Game systems -> Verify, in that order', () => {
    expect(CREATION_PHASES.map((p) => p.id)).toEqual(['frontend', 'art', 'game', 'game-systems', 'verify']);
  });

  /**
   * 🔴 THE ROW LABELS ARE UNIFORM AND NO TWO SHARE A WORD (owner, 2026-08-14).
   *
   * *"make uniform looking"*, and then, on the split: *"pick something better for step 4 and not say
   * `Game` in step 4… they are all different, front end, art work, game mode… then something else
   * fitting."* Front end · Art work · Game code.
   *
   * These are read as a LIST, and a list is where an inconsistency shows — which is exactly what
   * nothing in a code review shows you (§4.1a's toolbar lesson, one level down). Two rows sharing a
   * word read as two halves of one step; a one-word row reads as a different kind of thing.
   *
   * ⚠️ Scoped to the SCHEDULED phases. `verify` is not in the default plan and never appears beside
   * the others, so holding it to a rule about how a list reads would be asserting a constraint nobody
   * can see.
   */
  it('gives every scheduled step a distinct two-word name, sharing no word with another', () => {
    const labels = DEFAULT_CREATION_PHASES.map((id) => phaseById(id).label);
    const seen = new Map<string, string>();

    for (const label of labels) {
      const words = label.toLowerCase().split(' ');
      expect(words.length).toBe(2);

      for (const word of words) {
        expect(seen.get(word) ?? label).toBe(label);
        seen.set(word, label);
      }
    }
  });

  /* The panel line is present tense and addressed to the user — a different string, not the label. */
  it('every phase names what it is DOING while it runs', () => {
    for (const phase of CREATION_PHASES) {
      expect(phase.activeLabel).toMatch(/ing your /);
      expect(phase.activeLabel).not.toBe(phase.label);
    }
  });

  /*
   * Owner decision 2026-08-08, reversing `game → frontend`. The order is decided by which body of
   * work is BOUNDED, not by what survives a failure: the front end is one page plus three chrome
   * files whatever the game is, while the game scales with the request unpredictably. Whatever runs
   * LAST is what a length-truncated response mangles, so the fixed cost goes first.
   */
  it('puts the front end before the game', () => {
    const ids = DEFAULT_CREATION_PHASES;
    expect(ids.indexOf('frontend')).toBeLessThan(ids.indexOf('game'));
  });

  /*
   * `art` renders the list `frontend` wrote into DESIGN.md and wires the returned paths into the
   * files `frontend` just created. Putting the game between them would break that hand-off.
   */
  it('keeps art immediately after the front end', () => {
    const ids = DEFAULT_CREATION_PHASES;
    expect(ids.indexOf('art')).toBe(ids.indexOf('frontend') + 1);
  });

  /* The repair pass can only run once there is something to repair. */
  it('leaves verify last in the TABLE (it is not scheduled by default — see "the default plan")', () => {
    expect(CREATION_PHASES[CREATION_PHASES.length - 1].id).toBe('verify');
  });

  it('gives media to EXACTLY ONE phase, and it is the art phase', () => {
    const withMedia = CREATION_PHASES.filter((p) => p.allowsMedia).map((p) => p.id);
    expect(withMedia).toEqual(['art']);
  });

  it('phaseAllowsMedia is false for every non-art phase and for no phase at all', () => {
    expect(phaseAllowsMedia('art')).toBe(true);
    expect(phaseAllowsMedia(null)).toBe(false);

    /*
     * Derived from the table, not a list of the phases someone happened to think of: a new phase that
     * quietly arrives with `allowsMedia: true` is a step that can spend credits on renders, and a
     * hand-written list of the OTHER phases cannot notice one.
     */
    for (const phase of CREATION_PHASES) {
      expect(phaseAllowsMedia(phase.id)).toBe(phase.id === 'art');
    }
  });

  /*
   * The narrow-request escape hatch, where it is HONEST. When a step can legitimately be a no-op the
   * ONLY sanctioned mechanism is the task telling the model to write nothing — never a classifier over
   * the request (the fourth one in this codebase) and never over the model's own output (worse).
   *
   * 🔴 **`frontend` is deliberately NOT in this list (owner, 2026-08-14).** This test used to say
   * EVERY phase, and that was the rule the owner overruled: *"FIRST BUILD MUST redesign the landing
   * pages and chrome as a part of the first initial build."* A plan only ever runs on a first build,
   * so the page `frontend` was being allowed to leave alone is always the stock starter — the clause
   * was an invitation to skip the one mandatory step, and it was written for edits that never reach it.
   */
  it('a phase that may legitimately do nothing says so', () => {
    for (const phase of CREATION_PHASES) {
      if (phase.id === 'verify' || phase.id === 'frontend') {
        continue; // `verify` only runs when there is something to repair; `frontend` is never optional
      }

      expect(phase.task.toLowerCase()).toMatch(/say so in one line/);
    }
  });

  /*
   * CONTROL — the exemption above is narrow: `frontend` is excluded because it is MANDATORY, not
   * because nobody checked it. Asserted positively so deleting the rule fails here too.
   */
  it('the frontend phase is mandatory, never a no-op', () => {
    const frontend = CREATION_PHASES.find((p) => p.id === 'frontend')!;

    expect(frontend.task).toMatch(/NOT optional/i);
    expect(frontend.task.toLowerCase()).not.toMatch(/say so in one line/);
  });

  it('the game phase is told NOT to touch the landing page or chrome', () => {
    const game = CREATION_PHASES.find((p) => p.id === 'game')!;
    expect(game.task).toMatch(/do NOT touch the landing page/i);
  });

  /*
   * The mirror of the rule above, and the one that had to change when the order flipped. While the
   * game ran first, `frontend` was told "the game code is already written: do not rewrite it"; now
   * the game has NOT been written when this phase runs, so the fence has to point the other way or
   * the front-end step quietly becomes the monolithic turn the phases exist to prevent.
   */
  it('the front-end phase is told NOT to write gameplay code', () => {
    const frontend = CREATION_PHASES.find((p) => p.id === 'frontend')!;
    expect(frontend.task).toMatch(/do NOT write gameplay code/i);
  });

  /*
   * The front end runs before any gameplay exists, so the play contract is wired against the class
   * §4.4b scaffolded at creation. Without this the step has no correct class name to navigate to and
   * the single sanctioned response is to invent one.
   */
  it('the front-end phase points at the scaffolded GameMode rather than an invented name', () => {
    const frontend = CREATION_PHASES.find((p) => p.id === 'frontend')!;
    expect(frontend.task).toMatch(/scaffolded into `src\/scripts\/`/i);
    expect(frontend.task).toMatch(/never invent one/i);
  });

  it('the art phase forbids inventing an asset path', () => {
    const art = CREATION_PHASES.find((p) => p.id === 'art')!;
    expect(art.task).toMatch(/never a path you expect it to return/i);
  });
});

describe('parseCreationPhaseId — resolves DOWN', () => {
  /* Every DECLARED id, derived — a new phase the parser refuses is a plan that silently loses a step. */
  it.each(CREATION_PHASES.map((p) => p.id))('accepts %s', (id) => {
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
    expect(currentCreationPhase(newCreationPlan())?.id).toBe('frontend');
    expect(currentCreationPhase({ ...newCreationPlan(['game']), next: 1 })).toBeNull();
    expect(currentCreationPhase(undefined)).toBeNull();
  });
});

describe('creationPhaseMessage — the VISIBLE line', () => {
  const plan = newCreationPlan();

  it('names the step and what it is', () => {
    expect(creationPhaseMessage(plan, 0)).toBe('Step 1 — front end.');
    expect(creationPhaseMessage(plan, 2)).toBe('Step 3 — game code.');
  });

  it("defaults to the plan's own next phase", () => {
    expect(creationPhaseMessage({ ...plan, next: 1 })).toBe('Step 2 — art work.');
  });

  /**
   * 🔴 NO "of N" (owner, 2026-08-14): *"no need `of 3` part"*, and every row reads the same way.
   *
   * The total belongs to the card, which draws every row. It is also the half that can be WRONG: the
   * denominator is the plan's own length, and a resumed 3-phase plan is still valid and still runs, so
   * two messages in one transcript could honestly disagree about how long the build is.
   */
  it('carries the ordinal only — never a total', () => {
    const short = newCreationPlan(['frontend', 'art', 'game']);

    for (const p of [plan, short]) {
      for (let n = 0; n < p.phases.length; n++) {
        expect(creationPhaseMessage(p, n)).not.toMatch(/\bof\b/);
      }
    }

    /* CONTROL — the two plans agree about step 2 precisely BECAUSE the total is absent. */
    expect(creationPhaseMessage(plan, 1)).toBe(creationPhaseMessage(short, 1));
  });

  /*
   * 🔴 THE TASK MOVED TO THE SYSTEM TAIL (2026-08-14, `creationPhaseNote`).
   *
   * This message goes into the conversation, and the conversation is UNCACHED — every byte is re-sent
   * at full input rate on every later turn, forever. A four-phase build would weld ~5KB of scaffolding
   * into the transcript to say something each turn needs once. It is also text the USER reads.
   *
   * The length bound is the assertion: it is what fails if someone moves the task back in here.
   */
  it('is one short line — the task is NOT in the message', () => {
    for (let n = 0; n < plan.phases.length; n++) {
      const message = creationPhaseMessage(plan, n);

      expect(message.length).toBeLessThan(60);
      expect(message).not.toContain('bt-landing skill');
    }
  });

  /*
   * ⚠️ The marker used to ride here, because `carriesCreationBrief` was the only way the server knew a
   * phase was a first build turn. It is derived from the project ROW now (`projectOwesBuild`), which is
   * true for every phase until the last one lands — so the marker is redundant, and leaving it would
   * put a machine sentence in front of the user for no reason.
   */
  it('carries no creation marker — the row is the signal now', () => {
    expect(creationPhaseMessage(plan, 0)).not.toContain(CREATION_BRIEF_MARKER);
  });
});

describe('creationPhaseNote — what the step owes', () => {
  /**
   * 🔴 THE FRONT END IS NOT OPTIONAL ON A FIRST BUILD (owner, 2026-08-14).
   *
   * *"FIRST BUILD MUST redesign the landing pages and chrome as a part of the first initial build."*
   *
   * This task used to end with a skip clause — "if the request was a single narrow change that did not
   * call for a redesign, leave the landing page and the chrome alone". A plan only ever runs on a first
   * build, so the page it offered to leave alone is always the STOCK STARTER, and a real prompt from a
   * real failed run ("create an empty project for a mario kart racer, I will plan the game later")
   * reads exactly like the narrow request it described.
   */
  it('never offers to skip the landing page or the chrome', () => {
    const note = creationPhaseNote('frontend') ?? '';

    expect(note).toMatch(/NOT optional/i);
    expect(note).not.toMatch(/leave the landing/i);
    expect(note).not.toMatch(/did not call for a redesign/i);
  });

  /**
   * CONTROL — the no-op clauses that ARE legitimate must survive. "The user asked for the front end
   * only" and "this design needs no bespoke art" are real outcomes, not guesses at intent, and
   * deleting them would make every narrow first build write a game nobody asked for.
   */
  it('CONTROL — game and art may still legitimately do nothing', () => {
    expect(creationPhaseNote('game')).toMatch(/say so in one line/i);
    expect(creationPhaseNote('game-systems')).toMatch(/say so in one line/i);
    expect(creationPhaseNote('art')).toMatch(/say so in one line/i);
  });

  it('carries that phase task and no other', () => {
    const note = creationPhaseNote('frontend') ?? '';

    expect(note).toContain('bt-landing skill');
    expect(note).not.toContain('PLAYABLE CORE');
  });

  /*
   * The game step owns the WHOLE game again — GameMode, scene, controls, rules, scoring, SPEC.md.
   * Pinned because it was briefly narrowed to a core-only step, and a task that still deferred the
   * rules to a step that no longer runs would ship a game with no scoring and no win condition,
   * reported as a completed build.
   */
  it('the game step owes the whole game, deferring nothing to a retired step', () => {
    const note = creationPhaseNote('game') ?? '';

    expect(note).toMatch(/Write the GAME/);
    expect(note).toContain('SPEC.md');
    expect(note).not.toMatch(/NEXT step/i);
    expect(note).not.toMatch(/PLAYABLE CORE/);
  });

  it('tells a phase not to rewrite what is already correct', () => {
    expect(creationPhaseNote('art')).toMatch(/Do NOT rewrite files that are already correct/i);
  });

  it('says the project already exists, so a phase never re-creates it', () => {
    expect(creationPhaseNote('game')).toMatch(/already exists/i);
  });

  /*
   * `null` is "not a phase turn" and must produce NO note — the proxy pushes whatever this returns, so
   * a non-null default would put creation instructions on ordinary edits.
   */
  it('returns null when there is no phase', () => {
    expect(creationPhaseNote(null)).toBeNull();
  });
});

describe('describeCreationPlan', () => {
  it('marks done / current / pending in order', () => {
    const plan = newCreationPlan(['frontend', 'art', 'game']);
    const view = describeCreationPlan({ ...plan, next: 1, done: [record('frontend')] });
    expect(view.rows.map((r) => r.state)).toEqual(['done', 'current', 'pending']);
    expect(view.complete).toBe(false);
  });

  /* Same wording as the phase message, for the same reason — see `creationPhaseMessage`. */
  it('reports the ordinal only, so the card and the message agree', () => {
    const view = describeCreationPlan({ ...newCreationPlan(), next: 1 });
    expect(view.step).toBe('Step 2');
    expect(view.step).not.toMatch(/\bof\b/);
  });

  /* Every phase gets a row — the card exists because the user could not see step 1 or the last step. */
  it('draws a row for every phase, including the one running and the ones still to come', () => {
    const plan = newCreationPlan();
    const view = describeCreationPlan({ ...plan, next: 1 });
    expect(view.rows.map((r) => r.id)).toEqual(plan.phases);
  });

  it("carries each completed phase's own outcome", () => {
    const view = describeCreationPlan({ ...newCreationPlan(), next: 1, done: [record('frontend', 'rescued')] });
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
    const plan = newCreationPlan();
    const outcome = describeCreationPlanOutcome({ ...plan, next: 1, done: [record('frontend')] });
    expect(outcome.state).toBe('incomplete');

    /*
     * Derived. A literal here is the count that goes stale the next time a phase is added or split —
     * and it would go stale claiming the build is SHORTER than it is, i.e. under-reporting how much
     * work is outstanding in the one message whose job is to say what is left.
     */
    expect(outcome.detail).toContain(`${plan.phases.length - 1} of ${plan.phases.length} steps`);
    expect(outcome.detail).toContain('art work');
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

/**
 * 🔴 WHICH PHASES OWE FILES (live-caught 2026-08-14, `gen_mst3kiyp_71fdy6`).
 *
 * `owesFiles` turns "a first build turn that wrote nothing" into a FAILED, refunded generation. That
 * is right for a monolithic creation and too broad for a phase that is told in its own task that
 * writing nothing is the correct answer. Measured: `verify` ran with no compile errors, spent eleven
 * steps hunting a defect that did not exist, correctly wrote nothing, and ended a successful build
 * with an error message.
 */
describe('phaseOwesFiles', () => {
  it('the front end always owes files — it is the mandatory step', () => {
    expect(phaseOwesFiles('frontend')).toBe(true);
  });

  it('a phase that may legitimately do nothing does not owe files', () => {
    expect(phaseOwesFiles('art')).toBe(false);
    expect(phaseOwesFiles('game')).toBe(false);
    expect(phaseOwesFiles('game-systems')).toBe(false);
    expect(phaseOwesFiles('verify')).toBe(false);
  });

  /*
   * The pairing that keeps this honest: a phase excused from writing files must be a phase whose own
   * task told it so. Otherwise `owesFiles: false` is just the §4.6 refund switched off for a step —
   * silently, since the symptom is a build that bills in full and delivers nothing.
   */
  it('every phase excused from writing files says so in its own task', () => {
    for (const phase of CREATION_PHASES) {
      if (phase.owesFiles || phase.id === 'verify') {
        continue; // `verify` is only scheduled when there is a real compile error to answer
      }

      expect(phase.task.toLowerCase()).toMatch(/say so in one line/);
    }
  });

  /**
   * 🔴 THE SAFETY DIRECTION. No phase means a monolithic creation — a project made before phases, or
   * the unregistered-project path — and those still owe files, so the §4.6 no-files refund is
   * untouched for every flow that is not a phase. A `false` here would silently disable the guard
   * that stops a build billing in full and delivering an empty project.
   */
  it('NO phase still owes files, so the §4.6 guard is untouched off the phase path', () => {
    expect(phaseOwesFiles(null)).toBe(true);
  });

  /**
   * Every phase in the table answers, so a new one cannot be added without deciding. `owesFiles` is
   * required on `CreationPhase`, so this is really a check that nobody typed `undefined` past it.
   */
  it('every declared phase states an answer', () => {
    for (const phase of CREATION_PHASES) {
      expect(typeof phase.owesFiles).toBe('boolean');
    }
  });
});

/**
 * 🔴 `verify` IS NOT SCHEDULED BY DEFAULT (same run).
 *
 * Its task is a repair prompt — "The project failed to compile. Fix the errors reported below" — and
 * running it unconditionally at the end of a healthy build tells the model to fix a failure that did
 * not happen. `decideAutoRepair` covers real compile errors, carries the actual compiler output, is
 * capped at two attempts, and is re-armed the moment the plan completes.
 */
describe('the default plan', () => {
  it('schedules the three building phases, in order', () => {
    expect(DEFAULT_CREATION_PHASES).toEqual(['frontend', 'art', 'game']);
  });

  /**
   * 🔴 THE COUNT IS A DECISION, NOT AN ACCIDENT (owner, live 2026-08-14): *"can we just keep that
   * little stage thing 3 modes… JUST MAKE SURE IT FINISHES — that is the whole point."*
   *
   * Every phase boundary is a bound AND a failure point, and the split added the second without
   * needing the first. Asserted as a ceiling so a fourth step has to be a deliberate act with this
   * sentence read first.
   */
  it('is THREE steps — a fourth is a failure point, not a bound', () => {
    expect(DEFAULT_CREATION_PHASES.length).toBe(3);
  });

  it('does NOT schedule verify — self-healing owns compile errors', () => {
    expect(DEFAULT_CREATION_PHASES).not.toContain('verify');
  });

  /* CONTROL — `verify` is still DECLARED, so a stored plan naming it resolves rather than throwing. */
  it('CONTROL — verify is still a real phase, just not a default one', () => {
    expect(CREATION_PHASES.some((p) => p.id === 'verify')).toBe(true);
    expect(() => phaseById('verify')).not.toThrow();
  });
});

/**
 * 🔴 A STORED PLAN CARRYING A RETIRED PHASE SELF-HEALS (owner-reported 2026-08-14).
 *
 * *"It says step 3 of 4, what happened to step 4 of 4?"* — step 4 was `verify`, the phase that failed
 * and was then removed from the default plan. Removing it fixed NEW builds and did nothing for the
 * ones already on disk: the phase LIST lives on the project row, so every in-flight build kept a
 * 4-phase plan pointing at a step new builds no longer have.
 */
describe('retired phases are dropped on the way in', () => {
  const stored = {
    v: CREATION_PLAN_VERSION,
    phases: ['frontend', 'art', 'game', 'verify'],
    next: 3,
    done: [
      { id: 'frontend', generationId: 'g1', at: 'x', state: 'rescued' },
      { id: 'art', generationId: 'g2', at: 'x', state: 'rescued' },
      { id: 'game', generationId: 'g3', at: 'x', state: 'rescued' },
    ],
  };

  it('drops verify from a plan stored before it was retired', () => {
    expect(parseCreationPlan(stored)!.phases).toEqual(['frontend', 'art', 'game']);
  });

  /**
   * The self-heal. `next` was 3 — pointing at `verify` — and clamps to the new length, so the build
   * reads as COMPLETE, which it is: all three building phases landed. Without this the project sits
   * parked forever on a step that cannot succeed.
   */
  it('the stranded build reads as complete instead of parked on a dead step', () => {
    expect(isCreationPlanComplete(parseCreationPlan(stored))).toBe(true);
  });

  /* The record of what ran is evidence and survives untouched — including the retired phase's own. */
  it('keeps the done records', () => {
    expect(parseCreationPlan(stored)!.done.map((d) => d.id)).toEqual(['frontend', 'art', 'game']);
  });

  /**
   * CONTROL — a plan of ONLY retired phases has nothing left, which `parseCreationPlan` reports as
   * "no plan" rather than an empty one. Without this the block passes for a parser that returns a
   * zero-phase plan, and `currentCreationPhase` would index off the end of it.
   */
  it('CONTROL — a plan with nothing but retired phases is no plan at all', () => {
    expect(parseCreationPlan({ v: CREATION_PLAN_VERSION, phases: ['verify'], next: 0, done: [] })).toBeUndefined();
  });

  /* CONTROL — an ordinary plan is untouched, so this filter cannot be silently eating live phases. */
  it('CONTROL — a current plan passes through whole', () => {
    expect(parseCreationPlan(newCreationPlan())!.phases).toEqual([...DEFAULT_CREATION_PHASES]);
  });

  /**
   * 🔴 A PLAN STORED BEFORE THE GAME SPLIT KEEPS ITS OWN SHAPE, AND THAT IS THE POINT.
   *
   * The phase LIST lives on the project row, so a build parked mid-plan resumes with the steps it
   * started with — three, ending at `game` — rather than silently growing a fourth step it never
   * planned for. That is what makes a stranded project recoverable: the plan is a record of what this
   * build agreed to do, not a pointer at whatever the current default happens to be.
   */
  /**
   * 🔴 THE REVERT SELF-HEALS THE SAME WAY (owner, live 2026-08-14).
   *
   * The game split was live for about an hour and is reverted — it bought no bound (the front end and
   * art steps had already removed the two fixed-size bodies of work, so what was left FIT) and cost a
   * turn plus one more place a build can stop. Plans written in that hour carry a four-phase list,
   * including one mid-build, so `game-systems` is RETIRED rather than deleted and those collapse back
   * to three steps on the next read.
   */
  it('a plan written during the split collapses back to the three steps', () => {
    const midSplit = {
      v: CREATION_PLAN_VERSION,
      phases: ['frontend', 'art', 'game', 'game-systems'],
      next: 2,
      done: [record('frontend'), record('art')],
    };

    const parsed = parseCreationPlan(midSplit)!;

    expect(parsed.phases).toEqual(['frontend', 'art', 'game']);
    expect(currentCreationPhase(parsed)?.id).toBe('game');
  });

  /** And one that had already run the extra step reads as COMPLETE, not parked on a dead phase. */
  it('a plan that finished the retired step is complete, not stranded', () => {
    const parsed = parseCreationPlan({
      v: CREATION_PLAN_VERSION,
      phases: ['frontend', 'art', 'game', 'game-systems'],
      next: 4,
      done: [record('frontend'), record('art'), record('game'), record('game-systems')],
    })!;

    expect(isCreationPlanComplete(parsed)).toBe(true);
  });

  /**
   * CONTROL — retiring an id must not UN-DECLARE it. `plan.done` keeps the record of what actually
   * ran, and `phaseById` has to resolve one to render it; erasing that erases evidence a later change
   * is not entitled to erase.
   */
  it('CONTROL — a retired phase still resolves, so the record of it running survives', () => {
    expect(() => phaseById('game-systems')).not.toThrow();
    expect(
      parseCreationPlan({
        v: CREATION_PLAN_VERSION,
        phases: ['frontend', 'art', 'game', 'game-systems'],
        next: 4,
        done: [record('game-systems')],
      })!.done.map((d) => d.id),
    ).toEqual(['game-systems']);
  });
});
