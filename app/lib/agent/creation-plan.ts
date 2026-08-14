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

export type CreationPhaseId = 'game' | 'game-systems' | 'frontend' | 'art' | 'verify';

export interface CreationPhase {
  id: CreationPhaseId;

  /**
   * Card row: "Game mode". Sentence case, no verb — it names a thing, not an activity.
   *
   * Two words, and sharing no word with another scheduled phase (owner, 2026-08-14) — these are read
   * as a LIST, where a one-word row reads as a different kind of thing and two rows sharing a word
   * read as two halves of one step. Pinned in the spec.
   */
  label: string;

  /** Liveness panel: "Writing your game mode". Present tense, addressed to the user. */
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
   * 🔴 MUST this phase write files to count as successful? (live-caught 2026-08-14.)
   *
   * `owesFiles` in the proxy turns "a first build turn that wrote nothing" into a FAILED, refunded
   * generation — the §4.6 guard that stops a build billing in full and delivering an empty project.
   * Under phases that predicate became too broad, because a phase can be told IN ITS OWN TASK that
   * writing nothing is the right answer: `art` ends with *"if the design needs no bespoke art,
   * generate nothing and say so in one line"*, and `game` with the equivalent for a request that asks
   * only for a front end. Obeying the instruction then failed the turn.
   *
   * It is not hypothetical: `verify` ran with no compile errors, correctly wrote nothing, and was
   * failed for it — the user's build ended in an error message over a project that had just built.
   *
   * So the answer is per phase and it is DATA, not a guess: `frontend` is mandatory (owner rule — a
   * first build always redesigns the landing page and chrome), and the rest may legitimately be a
   * one-line "nothing to do here". A monolithic creation with NO phase still owes files, which is
   * what keeps every pre-phase project behaving exactly as it did.
   */
  owesFiles: boolean;

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
 * 🔴 **WHICH IS WHY THE GAME IS TWO STEPS (owner, 2026-08-14).** *"I think we should split the game
 * code phase, so in general it handle your BRIEF better."* Splitting the front end off the monolith
 * left `game` as the only step still carrying an unbounded amount of work — the largest slice of the
 * original run, and the one that grows with the request — so it inherited the failure the phases were
 * built to remove. Measured on `gen_mstgbuqo_pkhkhi`: 34,192 output tokens across a 5.4-minute silent
 * step, then nothing; and on the run that DID complete, 46,963 output tokens and 38,610 characters of
 * artifact from one reply, i.e. comfortably the biggest response in the build even after the split.
 *
 * The seam is the same one that decides the phase order, applied one level down: `game` writes the
 * BOUNDED part — the GameMode, its scene, its camera and its controls, the smallest thing that
 * actually runs — and `game-systems` writes the part that scales with the brief. A truncated response
 * then costs the systems step, on top of a project that already runs, rather than costing the whole
 * game on top of a project that does nothing.
 *
 * ⚠️ It is a fourth turn, so it pays one more warm-prefix read and one more history re-send. That is
 * the standing cost of a phase and it is the trade being made deliberately: input caches, output
 * decodes serially, and the step this splits was the one that could not finish.
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
    owesFiles: true,
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

    /*
     * "Art work", not "Art" (owner, 2026-08-14) — *"make uniform looking"*. Every row names a body of
     * work in two words and NO two of them share a word: **Front end · Art work · Game mode · Core
     * mechanics**. A one-word row read as a different KIND of thing sitting in the same list, and the
     * step line it feeds ("Step 2 — art.") read as a truncation rather than a label.
     */
    label: 'Art work',
    activeLabel: 'Generating your artwork',
    allowsMedia: true,
    owesFiles: false,
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
    label: 'Game mode',
    activeLabel: 'Writing your game mode',
    allowsMedia: false,
    owesFiles: false,
    task:
      'Write the PLAYABLE CORE — the smallest version of this game that actually runs. Do NOT touch ' +
      'the landing page or the game chrome, which were designed in the earlier steps and are already ' +
      'correct.\n\n' +
      'In `src/scripts/**`: the GameMode named above — scene setup, camera, lighting, the player or ' +
      'other controllable entity, its input, and the update loop that makes it move. Keep the play ' +
      'contract exactly as described.\n\n' +
      'When this step ends the project must RUN and respond to the controls, even if it is bare. ' +
      'Scoring, pickups, obstacles, enemies, levels, HUD and win/lose conditions are the NEXT step — ' +
      'leave them out, and do not stub them.\n\n' +
      'If the request was a single narrow change that does not call for game code, do only what was ' +
      'asked and say so in one line.',
  },
  {
    /*
     * The unbounded half. Its task is written to EXTEND rather than revisit: the core it is building
     * on was written one turn ago by the same model with the same brief, so the failure to guard
     * against is not a misunderstanding, it is a rewrite — re-emitting `<Title>Mode.ts` to add a
     * scoring field is the whole-file-for-one-line waste this repo prices in output tokens, and it
     * spends the exact room the split just bought.
     */
    /*
     * 🔴 THE `id` IS THE STORED KEY; THE `label` IS THE DISPLAY NAME, AND THEY ARE ALLOWED TO DIFFER.
     * `game-systems` lives in `projects.creation_handoff` and travels in browser bodies, so renaming
     * it to match the label would make `parseCreationPhaseId` refuse every plan already carrying it —
     * which drops the step, and drops it SILENTLY for any plan whose `game` phase has already run
     * (`withSplitGamePhase` only re-adds it before that point). Rename the label freely; leave the id.
     */
    id: 'game-systems',
    label: 'Core mechanics',
    activeLabel: 'Building your core mechanics',
    allowsMedia: false,
    owesFiles: false,
    task:
      'Build the GAMEPLAY on top of the core that now runs. The GameMode, its scene and its controls ' +
      'already exist and work — read them, extend them, and do not rewrite them. Do NOT touch the ' +
      'landing page or the game chrome either: they were designed in the earlier steps, and this is ' +
      'the last step of the build, so anything you change here is what the user is left with.\n\n' +
      'This step owes everything the request asked for that the core does not have yet: the rules and ' +
      'scoring, the pickups, obstacles, enemies, tracks or levels, the HUD, and the win and lose ' +
      'conditions. Deliver what the front end promises — the modes, tracks, pickups and scoring its ' +
      'design advertises are the specification for this step.\n\n' +
      'Put new behaviour in its own Script Component in `src/scripts/**` rather than growing the ' +
      'GameMode, so this step adds files instead of re-emitting the one the previous step wrote.\n\n' +
      'Then write `SPEC.md` — a short statement of what this game is and how it plays.\n\n' +
      'If the core already delivers everything the request asked for, add nothing beyond `SPEC.md` ' +
      'and say so in one line.',
  },
  {
    id: 'verify',
    label: 'Verify',
    activeLabel: 'Checking your project builds',
    allowsMedia: false,
    owesFiles: false,
    task:
      'The project failed to compile. Fix the errors reported below and change nothing else.\n\n' +
      'Repair the smallest thing that makes it build: do not redesign, do not rewrite working files, ' +
      'and do not start over. Every file already written is correct unless an error names it.',
  },
];

/**
 * 🔴 `verify` IS NOT IN THE DEFAULT PLAN (live-caught 2026-08-14, `gen_mst3kiyp_71fdy6`).
 *
 * This was `CREATION_PHASES.map(p => p.id)` — every declared phase, including `verify`. But `verify`'s
 * task is a REPAIR prompt: *"The project failed to compile. Fix the errors reported below and change
 * nothing else."* Run unconditionally at the end of a healthy build there are no errors to report, so
 * the model is told to fix a failure that did not happen.
 *
 * Measured: it spent ELEVEN steps reading the project hunting for a defect that did not exist, wrote
 * nothing (correctly — there was nothing to fix), and `owesFiles` then turned "wrote nothing" into a
 * FAILED generation. The user's build reached its last step and reported an error over a project that
 * had just been built successfully.
 *
 * ⚠️ **Self-healing already covers this, and better.** `decideAutoRepair` fires on a real Vite compile
 * error inside its window, carries the actual compiler output, and is capped at two attempts — and it
 * is armed again the instant the plan completes, which is exactly why `creationPlanActive` returns
 * `disarm: false` rather than disarming the watch between phases. A repair pass that runs whether or
 * not there is anything to repair is strictly worse than one triggered by the error itself.
 *
 * The phase stays in `CREATION_PHASES` so a stored plan naming it still resolves (and so an operator
 * or a future flow can schedule it deliberately); it is simply not scheduled by default.
 */
export const DEFAULT_CREATION_PHASES: readonly CreationPhaseId[] = ['frontend', 'art', 'game', 'game-systems'];

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

/**
 * 🔴 PHASES THAT MAY NO LONGER BE SCHEDULED (2026-08-14).
 *
 * `verify` is declared — a stored plan naming it must still RESOLVE rather than throw — but it can no
 * longer be RUN. Its task is a repair prompt ("The project failed to compile. Fix the errors reported
 * below") and nothing supplies it errors, so it hunts a defect that does not exist. Removing it from
 * `DEFAULT_CREATION_PHASES` fixed that for new builds and did nothing for the plans already on disk:
 * the phase LIST is stored on the project row, so every in-flight build kept a 4-phase plan pointing
 * at a step that new builds no longer have. Reported as *"it says step 3 of 4, what happened to step
 * 4 of 4?"* — the honest answer being that step 4 was the one that failed.
 *
 * Filtered at the PARSE, so one rule covers both doors: a plan read back from the row and a plan
 * posted by a browser. A stranded plan then self-heals — dropping the trailing phase makes `next`
 * clamp to the new length, i.e. the build reads as COMPLETE, which it is: frontend, art and game all
 * landed.
 */
const RETIRED_PHASES: readonly CreationPhaseId[] = ['verify'];

/**
 * 🔴 A PLAN THAT STILL OWES `game` OWES `game-systems` TOO (2026-08-14).
 *
 * The mirror of `RETIRED_PHASES`, and it exists because splitting a phase CHANGES WHAT AN EXISTING
 * PHASE ID MEANS. Plans on disk name `game`; until today that meant "write the whole game", and from
 * today it means "write the playable core and stop". A stranded 3-phase build resumed against the new
 * task would therefore write a bare core, mark itself COMPLETE, and hand back a game with no scoring,
 * no pickups and no win condition — a worse outcome than the failure it was resuming from, produced
 * by a build that reported success.
 *
 * 🔴 **Only when `game` has NOT already run.** A plan whose `game` phase is in `done` ran it under the
 * task that was live at the time, i.e. it wrote the whole game — appending a step there would bill a
 * turn to add systems to a game that already has them. So the two directions are: a plan that has yet
 * to reach the game gains the partner step (correct, and free — it has not been paid for), and a plan
 * that is past it is left exactly as it is (correct, and the safe direction, because the cost of being
 * wrong is a generation nobody asked for).
 *
 * Sited at the PARSE for the same reason as the retirement: it is the one door a stored plan and a
 * browser-posted plan both pass through, so the client and the server cannot end up disagreeing about
 * how many steps a build has.
 */
function withSplitGamePhase(phases: CreationPhaseId[], done: CreationPhaseRecord[]): CreationPhaseId[] {
  const gameAt = phases.indexOf('game');
  const alreadyRan = done.some((d) => d.id === 'game');

  if (gameAt < 0 || alreadyRan || phases.includes('game-systems')) {
    return phases;
  }

  return [...phases.slice(0, gameAt + 1), 'game-systems', ...phases.slice(gameAt + 1)];
}

/** Does this phase get the media tools? Unknown/absent phases never do. */
export function phaseAllowsMedia(phase: CreationPhaseId | null): boolean {
  return phase ? phaseById(phase).allowsMedia : false;
}

/**
 * Must this phase write files to count as a success? See `CreationPhase.owesFiles`.
 *
 * 🔴 **`null` — no phase at all — is TRUE**, and that direction is the whole safety of this function.
 * A monolithic creation (a project made before phases, or the unregistered-project path) still owes
 * files, so the §4.6 no-files refund is untouched for every flow that is not a phase. Only a phase
 * that explicitly declares it may do nothing is excused, and it is excused because its own task told
 * it so.
 */
export function phaseOwesFiles(phase: CreationPhaseId | null): boolean {
  return phase ? phaseById(phase).owesFiles : true;
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

  const declaredPhases = phases
    .slice(0, MAX_CREATION_PHASES)
    .map(parseCreationPhaseId)
    .filter((p): p is CreationPhaseId => p !== null && !RETIRED_PHASES.includes(p));

  if (declaredPhases.length === 0) {
    return undefined;
  }

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

  /* Needs `parsedDone` — the migration turns on whether `game` has already run. */
  const parsedPhases = withSplitGamePhase(declaredPhases, parsedDone).slice(0, MAX_CREATION_PHASES);

  /*
   * Clamped to the phase list rather than trusted. A `next` past the end silently reports a plan as
   * complete; a negative one re-runs a finished phase and pays for it.
   *
   * Clamped against `parsedPhases` — the list actually being RETURNED — because that is the list
   * `isCreationPlanComplete` and `currentCreationPhase` will index into. ⚠️ Clamping against
   * `declaredPhases` instead happens to produce the same answer for every value a real plan can hold
   * (they differ only above the declared length, which only a corrupt payload reaches), so this is
   * correctness by construction rather than a defended invariant — a test asserting the ordering was
   * written, found to pass with the ordering reversed, and deleted rather than left reporting a
   * property it could not see.
   */
  const parsedNext =
    typeof next === 'number' && Number.isFinite(next)
      ? Math.min(Math.max(Math.trunc(next), 0), parsedPhases.length)
      : 0;

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

  /*
   * 🔴 NO "of N" (owner, 2026-08-14): *"Dont say `Step 2 of 3 - art work` but instead `Step 2 - art
   * work`… no need `of 3` part."*
   *
   * The total belongs to the CARD, which draws every row and can show the shape of the build at a
   * glance. Repeating it on each message spends the one line a phase turn gets restating something
   * already on screen — and it is the half that goes wrong: the denominator is the plan's length,
   * which differs between a resumed plan and a new one (a stored 3-phase plan is still valid and
   * still runs), so two messages in the same transcript could honestly disagree about how many steps
   * a build has. The ordinal cannot.
   */
  return `Step ${index + 1} — ${phase.label.toLowerCase()}.`;
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

  /*
   * 🔴 READ IN BATCHES, THEN WRITE (live-measured 2026-08-14, `gen_mst2b7sd_vi0z91`).
   *
   * This turn has a bounded number of round trips and every tool call spends one. The failing run
   * batched ten reads into its first step — the model parallelises perfectly well when it decides to
   * — and then took FIVE more steps at one read each, discovering files as it went, until there were
   * no steps left to write with. It never emitted a single file.
   *
   * Prose alone does not stop a model (the `protocol-strip` lesson), which is why
   * `CREATION_FILE_READ_ROUNDS` moved with it. This is the half that costs nothing and addresses the
   * actual observed behaviour: the model did not need more information, it needed to ask at once.
   */
  return (
    `# This step of the build: ${label}\n\n` +
    `The project already exists and is installed — do not re-create it.\n\n` +
    `${task}\n\n` +
    'Do NOT rewrite files that are already correct — emit only what this step owes.\n\n' +
    'You have a limited number of tool round trips this step. Request every file you need in ONE ' +
    'parallel batch of `read_file` calls, then write. Do not read one file at a time: each round trip ' +
    'is a step you can no longer write code with, and a step that runs out mid-plan delivers nothing.'
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

  /** `Step 2`, or null when complete. Same wording as the phase message — see `creationPhaseMessage`. */
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
    step: complete ? null : `Step ${plan.next + 1}`,
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
