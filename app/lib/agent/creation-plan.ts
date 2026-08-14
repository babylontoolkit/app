/**
 * 🔴 CREATION IS A PLAN OF PHASES, NOT ONE TURN (2026-08-08, `_specs/phased-creation_plan.md`).
 *
 * ## The failure this exists to make impossible
 *
 * One model turn was asked to write the game, a complete landing-page and chrome redesign, and two
 * design docs. Measured on `gen_mskc4r0y` (opus-5, Anthropic direct):
 *
 *   - 14 files / 90,288 chars of artifact in ONE response
 *   - hit the provider ceiling — `maxTokens: 64_000`, `stop_reason: max_tokens`
 *   - **14 `<boltAction>` opens, 4 closes** — formatting discipline decays across an 11-minute reply
 *   - nine files welded into one 93,856-byte `KartTrack.ts`; the game never reached disk
 *   - 688,305 ms on a single step; 1,162 credits; settled `completed`; "🎮 Your game is ready"
 *
 * The response does not fit. Not marginally — structurally: the artifact alone is 50–62k output
 * tokens plus 20k+ of reasoning, against a 64,000 ceiling. Character split of that run: game code
 * 45%, landing + chrome 33%, docs 7%. Split into phases, no phase needs more than a third of the
 * ceiling, and the two failures above stop being reachable rather than becoming less likely.
 *
 * **This is not a prompt problem and cannot be fixed by one.** The cached prefix was already cut 4×
 * (77,699 → 38,591 tokens) and is **2.6% of that bill**; output is 66%.
 *
 * ## Why the phase list is a CONSTANT
 *
 * The phases for "build a game from a brief" are always the same, so a model turn that emits them
 * would be an extra turn and an extra failure mode to produce a fixed list — and variance is the
 * disease here, not the cure. `phases` is data only so a plan can be replayed, capped and clamped on
 * the way back in from a browser; it is never authored by a model and never derived from user text.
 *
 * ⚠️ **Never add a router here.** Deciding which phases apply by reading the request would be the
 * fourth keyword classifier in this codebase (skills, docs, genre, landing) and the first one over
 * the MODEL's own output, which is worse. Where a step can legitimately be a no-op its own task says
 * so and asks for one line; those turns cost a few hundred output tokens against a warm prefix.
 * Measure that before optimising it, and if it is material the answer is a cheaper task wording,
 * never a route.
 *
 * 🔴 **`frontend` IS NOT ONE OF THOSE STEPS (owner, 2026-08-14).** *"FIRST BUILD MUST redesign the
 * landing pages and chrome as a part of the first initial build. then continue on building whatever
 * the prompt asked for."* Its task carried a skip clause — *"if the request was a single narrow
 * change that did not call for a redesign, leave the landing page and the chrome alone"* — written
 * when phases were imagined as running for ordinary edits too. They do not: a plan only ever exists
 * on a FIRST BUILD (`projectOwesBuild`), so on every turn that task can reach, the page it is being
 * given permission to leave alone is the STOCK STARTER. The clause was an invitation to skip the one
 * step the owner says is mandatory, and *"create an empty project for a mario kart racer, I will plan
 * the game later"* — a real prompt from a real failed run — reads exactly like the narrow request it
 * described. `game` and `art` keep their no-op clauses, because "the user asked for the front end
 * only" and "this design needs no bespoke art" are genuine outcomes rather than guesses at intent.
 *
 * ## PURE, and shared by client and server
 *
 * Sited beside `turn-outcome.ts` for its reason: the server decides and the client renders, so a
 * single definition is the only thing that stops the two disagreeing about what a phase IS or
 * whether a build is over — the two-writers drift this codebase keeps rediscovering.
 */
import type { TurnOutcomeState } from './turn-outcome';

export type CreationPhaseId = 'game' | 'frontend' | 'art' | 'verify';

export interface CreationPhase {
  id: CreationPhaseId;

  /** Card row: "Game code". Sentence case, no verb — it names a thing, not an activity. */
  label: string;

  /** Liveness panel: "Writing your game code". Present tense, addressed to the user. */
  activeLabel: string;

  /**
   * May this phase call the media tools?
   *
   * TRUE for exactly one phase. Creation used to have media off entirely
   * (`CREATION_ALLOWS_MEDIA = false`) because a run once spent every step it had on images and
   * shipped no game — a real fix for a real bug, which left the model designing a page that needs
   * six images and then writing a shopping list it could not act on. Phases resolve it properly:
   * art is its own step, so it cannot starve the build no matter how many images it renders.
   */
  allowsMedia: boolean;

  /**
   * What this step owes, appended to the phase message.
   *
   * Each task ends by telling the model to write nothing if the user's request did not call for this
   * work. That sentence is what makes a narrow request cheap WITHOUT a classifier.
   */
  task: string;
}

/**
 * 🔴 ORDERED FRONT END FIRST, GAME LAST — reversed by owner decision, 2026-08-08.
 *
 * The original order was `game → frontend → art`, argued as "what survives a failure": fail after
 * the game and you have a playable project with a stock page, where the reverse buys a pretty page
 * in front of no game. That reasoning treated a cut-off run as a terminal state. It is not one — a
 * plan RESUMES, and a single-turn build is one prompt from finished whichever way round it went.
 *
 * What actually decides the order is which body of work is BOUNDED. The front end is a known
 * quantity: one page and three chrome files, much the same size whatever the game is (33% of the
 * monolithic run's characters). The game is open-ended — 45% on that same run, and it scales with
 * the request in a way nothing can predict before the turn starts. Whatever runs LAST is what a
 * length-truncated response mangles, so the fixed cost goes first, where it is certain to fit, and
 * the unbounded work takes the room that is left.
 *
 * `verify` stays last because it is the repair pass. `art` stays adjacent to `frontend` because it
 * renders the list `frontend` wrote into `DESIGN.md` and wires the returned paths into the files
 * `frontend` just created — separating that pair would be a real regression.
 *
 * ⚠️ The same rule is stated to the model in the baked prompt's "BUILD ORDER" section
 * (`prompt/sections/20-hard-constraints.md`), which covers a build that runs as a single turn (an
 * older project, or the unregistered-project fallback). The two must never disagree about which way
 * round a build goes.
 *
 * ⚠️ **This comment said "the LIVE path while this plan is inert" until 2026-08-14, and it was true.**
 * The whole phase system shipped on 2026-08-08 with no client caller — `creationPhaseMessage` was
 * referenced by nothing outside its own spec — so it was built, tested, green and unreachable, while
 * every creation kept running as the monolithic turn documented at the top of this file. The runner
 * (`~/lib/chat/creation-plan-runner`) is that caller. A feature whose own source comment says it is
 * inert is not a note for later; it is a bug report nobody filed.
 */
export const CREATION_PHASES: readonly CreationPhase[] = [
  {
    id: 'frontend',
    label: 'Front end',
    activeLabel: 'Designing your front end',
    allowsMedia: false,
    task:
      'Design the complete frontend shell FIRST, following the **bt-landing skill** (pre-loaded in ' +
      'your Skills) EXACTLY, using the project facts in the brief above as its Step-0 inputs.\n\n' +
      'That is the landing page (`src/pages/Home.tsx` + `Home.css`, rewritten completely, ' +
      'full-page-width per the Layout law) AND the game chrome in `src/chrome/**` (preloader, ' +
      'splash, overlay — redesigned to the same theme, never derived from the default splash, ' +
      'lightweight, wiring preserved). If the bt-landing skill is absent from your Skills, follow ' +
      'the same rules from the system prompt\'s "Layout law" and "Chrome rewrites" sections.\n\n' +
      'Wire the play contract now: a registered GameMode was scaffolded into `src/scripts/` when the ' +
      'project was created, so read its real class name off that file and navigate to it — never ' +
      'invent one. Do NOT write gameplay code in this step; the game is a later step, and what this ' +
      'design promises is what it will have to deliver.\n\n' +
      'Then write `DESIGN.md`, and in it name the two or three pieces of art this design would ' +
      'benefit from — the next step renders exactly that list, so be specific about subject, ' +
      'aspect ratio and whether each needs a transparent background.\n\n' +
      '🔴 THIS STEP IS NOT OPTIONAL. This is a brand-new project whose landing page and chrome are ' +
      'the STOCK STARTER — generic, unthemed, and carrying none of this game. Redesign both, every ' +
      'time, whatever the request says. A request for "just an empty project", or for the front end ' +
      'only, or for one specific feature, still gets the full landing-page and chrome redesign: it is ' +
      'the shell every later step builds inside, and there is nothing here yet to leave alone.',
  },
  {
    id: 'art',
    label: 'Art',
    activeLabel: 'Generating your artwork',
    allowsMedia: true,
    task:
      'Render the art this design calls for. Read the list you wrote in `DESIGN.md` and generate ' +
      'those images, ONE per call, at the point in the design where each is needed.\n\n' +
      'Then wire the returned `/assets/generated/…` paths into the files the previous step wrote. ' +
      'Those paths are the one exception to never inventing an asset path — use exactly what the ' +
      'tool returned, never a path you expect it to return.\n\n' +
      'If the design needs no bespoke art, generate nothing and say so in one line.',
  },
  {
    id: 'game',
    label: 'Game code',
    activeLabel: 'Writing your game code',
    allowsMedia: false,
    task:
      'Write the GAME. This step owes the playable project and nothing else — do NOT touch the ' +
      'landing page or the game chrome, which were designed in the earlier steps and are already ' +
      'correct.\n\n' +
      'Build what the request asks for in `src/scripts/**`: the GameMode named above plus whatever ' +
      'Script Components, systems and helpers it needs. Keep the play contract exactly as described, ' +
      'and deliver what the front end promises — its modes, tracks, pickups and scoring are the ' +
      'specification for this step. Then write `SPEC.md` — a short statement of what this game is ' +
      'and how it plays.\n\n' +
      'If the request was a single narrow change that does not call for game code, do only what was ' +
      'asked and say so in one line.',
  },
  {
    id: 'verify',
    label: 'Verify',
    activeLabel: 'Checking your project builds',
    allowsMedia: false,
    task:
      'The project failed to compile. Fix the errors reported below and change nothing else.\n\n' +
      'Repair the smallest thing that makes it build: do not redesign, do not rewrite working files, ' +
      'and do not start over. Every file already written is correct unless an error names it.',
  },
];

export const DEFAULT_CREATION_PHASES: readonly CreationPhaseId[] = CREATION_PHASES.map((p) => p.id);

/**
 * Bumped only when the stored shape changes incompatibly. An unrecognised version is treated as NO
 * plan, which degrades a project to the pre-phase single turn — the safe direction, because the
 * alternative is running a plan whose meaning this build does not know.
 */
export const CREATION_PLAN_VERSION = 1;

/**
 * A ceiling on a value that arrives in a browser body. Not a product limit — a bound on what a
 * malformed or hostile payload can make the runner do.
 */
export const MAX_CREATION_PHASES = 8;

export interface CreationPhaseRecord {
  id: CreationPhaseId;

  /** The generation that ran it — the join to `generations` and therefore to what it cost. */
  generationId: string;

  /** ISO timestamp. Stamped by the caller; this module never reads a clock (it must stay pure). */
  at: string;

  /** That turn's own verdict, so a rescued phase is still visible after its alert is dismissed. */
  state: TurnOutcomeState;
}

export interface CreationPlan {
  v: number;

  /** Ordered. `next` indexes into this, so it is the plan. */
  phases: CreationPhaseId[];

  /** Index of the next phase to RUN. `=== phases.length` means the plan is complete. */
  next: number;

  done: CreationPhaseRecord[];
}

export function phaseById(id: CreationPhaseId): CreationPhase {
  const phase = CREATION_PHASES.find((p) => p.id === id);

  if (!phase) {
    throw new Error(`Unknown creation phase: ${id}`);
  }

  return phase;
}

/**
 * Resolve a phase id from an untrusted value.
 *
 * 🔴 **Resolves DOWN — an unrecognised id is `null`, never a default.** This value arrives in a
 * BROWSER BODY and selects a toolset (the art phase can spend credits on renders), so the same rule
 * as `parseUserEffort`: inventing a more capable phase than the caller named is the expensive
 * direction and it throws nothing.
 */
export function parseCreationPhaseId(value: unknown): CreationPhaseId | null {
  if (typeof value !== 'string') {
    return null;
  }

  return CREATION_PHASES.some((p) => p.id === value) ? (value as CreationPhaseId) : null;
}

/** Does this phase get the media tools? Unknown/absent phases never do. */
export function phaseAllowsMedia(phase: CreationPhaseId | null): boolean {
  return phase ? phaseById(phase).allowsMedia : false;
}

/**
 * Validate a plan sent by the browser.
 *
 * 🔴 **Malformed returns `undefined` = "no plan", which is NOT the same as clearing the handoff.**
 * The brief's rule ("anything malformed clears, because a corrupt handoff is exactly a project that
 * should stop offering to build itself") is right for a brief and catastrophic for a plan: clearing
 * on a corrupt plan strands a half-built project with no way to resume. A dropped plan falls back to
 * the pre-phase single turn, which is survivable; a dropped brief is not.
 */
export function parseCreationPlan(value: unknown): CreationPlan | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const { v, phases, next, done } = value as Partial<CreationPlan>;

  if (v !== CREATION_PLAN_VERSION || !Array.isArray(phases)) {
    return undefined;
  }

  const parsedPhases = phases
    .slice(0, MAX_CREATION_PHASES)
    .map(parseCreationPhaseId)
    .filter((p): p is CreationPhaseId => p !== null);

  if (parsedPhases.length === 0) {
    return undefined;
  }

  /*
   * Clamped to the phase list rather than trusted. A `next` past the end silently reports a plan as
   * complete; a negative one re-runs a finished phase and pays for it.
   */
  const parsedNext =
    typeof next === 'number' && Number.isFinite(next)
      ? Math.min(Math.max(Math.trunc(next), 0), parsedPhases.length)
      : 0;

  const parsedDone: CreationPhaseRecord[] = (Array.isArray(done) ? done : [])
    .slice(0, MAX_CREATION_PHASES)
    .flatMap((entry) => {
      const record = entry as Partial<CreationPhaseRecord>;
      const id = parseCreationPhaseId(record?.id);

      if (!id) {
        return [];
      }

      return [
        {
          id,
          generationId: typeof record.generationId === 'string' ? record.generationId : '',
          at: typeof record.at === 'string' ? record.at : '',
          state: isTurnOutcomeState(record.state) ? record.state : 'finished',
        },
      ];
    });

  return { v: CREATION_PLAN_VERSION, phases: parsedPhases, next: parsedNext, done: parsedDone };
}

function isTurnOutcomeState(value: unknown): value is TurnOutcomeState {
  return value === 'finished' || value === 'rescued' || value === 'incomplete';
}

/**
 * Fold an incoming plan onto the stored one.
 *
 * 🔴 **`next` only ever moves FORWARD.** A full replace lets two tabs, or an out-of-order retry,
 * move the counter backwards and re-run a phase that already ran — paying for it twice and
 * overwriting files that were correct. This is the ledger's `seq` lesson applied to a counter that
 * decides what gets rebuilt: a read-then-write is a race, so the merge is the write.
 *
 * `done` is likewise unioned rather than replaced, keyed on the phase id, because the record of a
 * completed phase is evidence and a stale client must not be able to erase it.
 */
export function mergeCreationPlan(existing: CreationPlan | undefined, incoming: CreationPlan | undefined) {
  if (!incoming) {
    return existing;
  }

  if (!existing) {
    return incoming;
  }

  const done = [...existing.done];

  for (const record of incoming.done) {
    if (!done.some((d) => d.id === record.id)) {
      done.push(record);
    }
  }

  return {
    v: CREATION_PLAN_VERSION,
    phases: incoming.phases,
    next: Math.max(existing.next, incoming.next),
    done,
  } satisfies CreationPlan;
}

export function newCreationPlan(phases: readonly CreationPhaseId[] = DEFAULT_CREATION_PHASES): CreationPlan {
  return { v: CREATION_PLAN_VERSION, phases: [...phases], next: 0, done: [] };
}

/** Record a finished phase and move to the next. Never moves backwards, never past the end. */
export function advanceCreationPlan(plan: CreationPlan, record: CreationPhaseRecord): CreationPlan {
  return {
    v: CREATION_PLAN_VERSION,
    phases: plan.phases,
    next: Math.min(plan.next + 1, plan.phases.length),
    done: plan.done.some((d) => d.id === record.id) ? plan.done : [...plan.done, record],
  };
}

export function isCreationPlanComplete(plan: CreationPlan | undefined | null): boolean {
  return !plan || plan.next >= plan.phases.length;
}

/**
 * 🔴 DOES THIS PROJECT STILL OWE A BUILD? — the SERVER's definition of a first build turn (2026-08-14).
 *
 * ## The failure this exists for
 *
 * `carriesCreationBrief` was the only answer to "is this a first build turn?", and it sniffs the last
 * user message for `CREATION_BRIEF_MARKER`. The hidden brief was retired on 2026-08-08 (`dc58da2`) —
 * deliberately, the guidance moved into the baked prompt — and the CLIENT derivation was updated to
 * match. The SERVER's was not, so the flag has been **permanently false ever since**, and with it all
 * ten protections it drives. Measured on `gen_msswm3qx_u4u2bt`: a creation ran 416s across 9 tool
 * rounds with the ORDINARY tool policy and no skills preloaded, emitted 82 characters and zero files,
 * and settled `completed` for 117 credits — because `owesFiles` is `isFirstBuildTurn && !discussNote`,
 * so the §4.6 no-files refund could not fire. `statusKind: "edit"` on a brand-new project is the
 * fingerprint.
 *
 * Nothing threw, and the whole suite stayed green: every spec asserts *"with the marker present, X
 * happens"*, with the flag both true and false, mutation-verified. **None asserted the marker is ever
 * present on a real build.** Same shape as the cache warmer's `not KIE` guard — a test can only assert
 * the behaviour someone wrote down; it cannot notice that the behaviour stopped being reachable.
 *
 * ## Why the ROW and not the message
 *
 * This flag now gates a REFUND, so it may never be a value the browser can assert. The project row is
 * the one authority the client cannot forge: `creation_handoff` is written by an ownership-checked
 * PATCH whose plan counter is monotonic (`mergeCreationPlan`), and its PRESENCE has meant "created,
 * never built" since migration 0016. The agent route already loads the project for its ownership
 * check, so reading this costs nothing.
 *
 * ⚠️ **The "no plan" case is the OPPOSITE of `isCreationPlanComplete`'s, and that is not an
 * inconsistency.** For a PLAN, absent means "there is nothing left to run" — correct, it is asked
 * about a plan that may never have existed. For a PROJECT, a handoff with no plan is a project that
 * was created and whose build has not started yet: the most owed a build can possibly be. Reusing the
 * plan predicate here would return `false` for exactly the turn this function exists to identify, and
 * it would do it silently.
 */
export function projectOwesBuild(handoff: { plan?: CreationPlan; userPrompt?: string } | null | undefined): boolean {
  /*
   * Cleared. Under migration 0016 that meant "the first build turn was sent"; since phases it means
   * "the last phase completed" (`CreationHandoff.plan`). Either way the build is over, and every later
   * turn is an ordinary edit.
   */
  if (!handoff) {
    return false;
  }

  // Created, never built — see the ⚠️ above.
  if (!handoff.plan) {
    return true;
  }

  return !isCreationPlanComplete(handoff.plan);
}

/** The phase that runs next, or `null` when the plan is complete. */
export function currentCreationPhase(plan: CreationPlan | undefined | null): CreationPhase | null {
  if (!plan || isCreationPlanComplete(plan)) {
    return null;
  }

  return phaseById(plan.phases[plan.next]);
}

/**
 * The VISIBLE text of a phase turn — one short line, and deliberately nothing else.
 *
 * 🔴 **The TASK is not in here; it rides in the system tail** (`creationPhaseNote`). Three reasons,
 * and the first two are rules this repo already enforces elsewhere:
 *
 *   1. **The history is UNCACHED and permanent.** Every byte of a user message is re-sent at full
 *      input rate on every later turn, forever. A four-phase build would weld ~5KB of instructions
 *      into the transcript to say something the model only needs on the turn it applies to.
 *   2. **The user's own message stays the user's own.** The hidden machine-written brief was retired
 *      by owner decision on 2026-08-08 and `new-project-mode-wiring.spec.tsx` pins its absence. An
 *      earlier draft of phases appended the task to the user's words instead — visible, so not
 *      literally the thing that was removed, but the same idea wearing a better hat. The rule stands.
 *   3. **Phase 1 needs no message at all.** It rides the words the user actually typed, with only
 *      `creationPhase` in the request body, so the first build turn is byte-identical to what it was.
 *
 * ⚠️ It no longer carries `CREATION_BRIEF_MARKER`, and that is safe ONLY because the server stopped
 * depending on it: `isFirstBuildTurn` is derived from the project ROW now (`projectOwesBuild`), which
 * is true for every phase until the last one lands. Restoring a marker check as the sole signal is
 * how this went dead for six days — see that function's header.
 */
export function creationPhaseMessage(plan: CreationPlan, index: number = plan.next): string {
  const phase = phaseById(plan.phases[index]);

  return `Step ${index + 1} of ${plan.phases.length} — ${phase.label.toLowerCase()}.`;
}

/**
 * What this step owes, as a SYSTEM note for the turn it applies to (§4.4e).
 *
 * ## Placement
 *
 * Appended in the VOLATILE TAIL, after the last cache breakpoint — the same rule as `discussNote` and
 * the media protocol note, and for the same reason: it changes on every phase, so anywhere earlier
 * would re-write the file-context entry at the 2× cache-WRITE rate four times per build. In the tail
 * it costs one uncached read of ~300 tokens and invalidates nothing.
 *
 * ## Why a note and not a message
 *
 * It is instructions for THIS turn, not a thing the user said. Putting it in the conversation would
 * pay for it on every subsequent turn forever (the history is uncached), and would leave four blocks
 * of scaffolding sitting in a transcript the user reads.
 */
export function creationPhaseNote(phase: CreationPhaseId | null): string | null {
  if (!phase) {
    return null;
  }

  const { label, task } = phaseById(phase);

  return (
    `# This step of the build: ${label}\n\n` +
    `The project already exists and is installed — do not re-create it.\n\n` +
    `${task}\n\n` +
    'Do NOT rewrite files that are already correct — emit only what this step owes.'
  );
}

export interface CreationPlanView {
  /** One row per phase, in order, for the card. */
  rows: Array<{
    id: CreationPhaseId;
    label: string;
    state: 'done' | 'current' | 'pending';
    outcome?: TurnOutcomeState;
  }>;

  /** `Step 2 of 4`, or null when complete. */
  step: string | null;

  complete: boolean;
}

export function describeCreationPlan(plan: CreationPlan): CreationPlanView {
  const complete = isCreationPlanComplete(plan);

  return {
    rows: plan.phases.map((id, n) => ({
      id,
      label: phaseById(id).label,
      state: n < plan.next ? 'done' : n === plan.next ? 'current' : 'pending',
      outcome: plan.done.find((d) => d.id === id)?.state,
    })),
    step: complete ? null : `Step ${plan.next + 1} of ${plan.phases.length}`,
    complete,
  };
}

export interface CreationPlanOutcome {
  state: TurnOutcomeState;
  headline: string;
  detail: string;
}

/**
 * 🔴 THE PLAN-LEVEL VERDICT — because the per-TURN one is about to go quiet.
 *
 * `describeTurnOutcome` is defined against the shape of the monolithic failure: `truncatedByLength`,
 * `completionPassWroteFiles`, `forcedContinuation`. Under phases all three approach zero, which is
 * the goal — and it is EXACTLY the `wastedOutput` mistake, where a metric defined as "sum of
 * all-but-last step outputs" reported zero waste on the most expensive generation in the product, in
 * good faith, forever, the moment the fix made a creation one step.
 *
 * A creation that completed two phases and stopped on the third is a broken project made entirely of
 * healthy turns. Nothing that answers per turn can see that. This does.
 *
 * ⚠️ The rates must be WATCHED too (`finish_reason === 'length'`, the completeness pass firing,
 * scoped to creation phases). A detector that stops firing has to be observed stopping.
 */
export function describeCreationPlanOutcome(plan: CreationPlan): CreationPlanOutcome {
  const remaining = plan.phases.length - plan.next;

  if (remaining > 0) {
    const phase = phaseById(plan.phases[plan.next]);

    return {
      state: 'incomplete',
      headline: 'Your build has not finished',
      detail:
        `${remaining} of ${plan.phases.length} steps are still to run, starting with ` +
        `${phase.label.toLowerCase()}. Nothing is lost — everything already built is on disk, and ` +
        'continuing picks up from exactly there.',
    };
  }

  /*
   * Complete, but a phase needed an automatic second pass to get there. Reported for the same reason
   * the per-turn verdict reports it: an automatic transition on a paid path is something the user
   * hears about when their outcome differed from what they asked for.
   */
  if (plan.done.some((d) => d.state !== 'finished')) {
    return {
      state: 'rescued',
      headline: 'Your project is ready — one step needed a second pass',
      detail:
        'Every step completed, but at least one had to be automatically continued to finish. The ' +
        'project is complete; it cost more than a clean run, and is worth a look over.',
    };
  }

  return { state: 'finished', headline: '', detail: '' };
}
