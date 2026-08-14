/**
 * Should the client start the NEXT phase of a creation plan? (§4.4e, `_specs/phased-creation_plan.md`)
 *
 * ## Why this is a pure function
 *
 * It is the second mechanism in the product that starts a generation with **no user action** — the
 * first is `decideAutoRepair`, whose header explains the rule this file inherits: a `run` here spends
 * the user's credits without them asking, so every branch belongs somewhere it can be tested
 * exhaustively rather than buried in a `useEffect` reachable only by driving a browser.
 *
 * The shape deliberately mirrors `decideAutoRepair` — a decider plus an effect that fires `append`
 * when `!isLoading` — because that is the one mechanism in this codebase already proven to start an
 * unattended turn without racing the stream it follows.
 *
 * ## Why it exists at all
 *
 * One turn was asked to write the game, the landing page, the chrome and two design docs. Measured on
 * `gen_mskc4r0y`: 90,288 chars of artifact, the provider's 64,000-token ceiling hit mid-file, **14
 * `<boltAction>` opens against 4 closes**, nine files welded into one, and a settled `completed` with
 * "🎮 Your game is ready" over a project that had never reached disk. The response does not fit — not
 * marginally, structurally. Split into phases, no phase needs more than a third of the ceiling.
 *
 * That was diagnosed on 2026-08-08 and the whole server half shipped the same day. The client half —
 * this file — did not, so the phase list has been inert ever since: `creationPhaseMessage` had no
 * caller, and every creation kept running as the single monolithic turn the phases exist to prevent.
 * Re-measured on `gen_msswm3qx_u4u2bt` (2026-08-14): 416s, 9 tool rounds, 82 characters, zero files.
 *
 * ## The states, and why each is a separate answer
 *
 * `wait` and `pause` look alike from the outside and must never be folded together. `wait` is "not
 * yet, ask me again" — a re-render, an in-flight stream, actions still settling. `pause` is "this plan
 * has STOPPED and a human has to decide", and it is terminal until the user acts. Collapsing them
 * either spins the effect forever on a stopped plan or silently abandons a half-built project with no
 * way back — and a half-built project is the failure mode this whole feature is about.
 */
import type { CreationPlan } from '~/lib/agent/creation-plan';
import { isCreationPlanComplete } from '~/lib/agent/creation-plan';
import type { TurnOutcomeState } from '~/lib/agent/turn-outcome';

/**
 * Why a plan stopped short. Each one is a state a human has to resolve, and each is REPORTED — a plan
 * that stops silently strands a project mid-build, which is worse than never having split the turn.
 */
/*
 * `incomplete` — the server judged the turn unfinished (§4.4e `describeTurnOutcome`); the persistent
 * alert carries it. `error` — the stream failed or the user stopped it; their move next, not ours.
 * `unsettled` — actions never reached a terminal state, so the next phase would read a half-written
 * tree.
 */
export type CreationPauseReason = 'incomplete' | 'error' | 'unsettled';

export type CreationTurnDecision =
  | { kind: 'run'; index: number }
  | { kind: 'pause'; reason: CreationPauseReason }
  | { kind: 'done' }
  | { kind: 'wait' };

export interface CreationTurnInput {
  /**
   * The plan, read from `newProjectModeStore.get()` INSIDE the callback — never from a captured
   * render value.
   *
   * ⚠️ `useStore` **is** a render capture. That is the documented `projectId: undefined` post-mortem
   * (§4.4a): a value read at render time and used in an async callback is the value as it stood when
   * the component last committed, and the plan advances between commits by design.
   */
  plan: CreationPlan | null | undefined;

  /** No project, no plan to run. A creation phase has nowhere to write without one. */
  projectId: string | undefined;

  /** A generation is streaming. Never start a second — the server would refuse it 409 anyway (§4.12). */
  isLoading: boolean;

  /** The last turn errored or was stopped. `sendMessage` truncates the message array on error. */
  hasError: boolean;

  /**
   * The phase index the runner has ARMED, or `null`. Set only after the finished phase's actions have
   * settled and the row has accepted the advance.
   *
   * 🔴 The latch, and the reason this cannot be derived from `plan.next` alone. The effect re-runs on
   * every render; without a one-shot arm it would fire the same phase repeatedly the moment
   * `isLoading` goes false. Same rule as the repair watch, which disarms BEFORE its `append`.
   */
  armedIndex: number | null;

  /** The finished turn's own verdict, from `agentMeta`. `incomplete` stops the plan. */
  lastOutcome: TurnOutcomeState | null;

  /** Already paused. Terminal until the user acts — never re-decide it here. */
  paused: CreationPauseReason | null;
}

export function decideNextCreationTurn(input: CreationTurnInput): CreationTurnDecision {
  const { plan, projectId, isLoading, hasError, armedIndex, lastOutcome, paused } = input;

  /*
   * A pause is a decision that has already been made, and re-deriving it every render is how a paused
   * plan starts running again on its own. The user resumes it explicitly (the card's Continue).
   */
  if (paused) {
    return { kind: 'pause', reason: paused };
  }

  // Nothing to drive. An absent plan is a project created before phases, or one whose build never began.
  if (!plan || !projectId) {
    return { kind: 'wait' };
  }

  if (isCreationPlanComplete(plan)) {
    return { kind: 'done' };
  }

  /*
   * 🔴 A FAILED TURN NEVER AUTO-ADVANCES.
   *
   * The next phase builds on the files the last one wrote, so continuing past an error compounds a
   * broken tree AND bills for it — and the user is the one who can see whether the failure was
   * transient. Checked before the arm so a turn that errored after arming cannot slip through.
   */
  if (hasError) {
    return { kind: 'pause', reason: 'error' };
  }

  /*
   * `incomplete` means the server itself judged the turn unfinished (truncated at the output ceiling,
   * or rescued and still short). The existing persistent alert already carries a "Finish the build"
   * action, so the human has somewhere to go — and running the NEXT phase over an unfinished one is
   * exactly how the monolithic failure used to hide.
   */
  if (lastOutcome === 'incomplete') {
    return { kind: 'pause', reason: 'incomplete' };
  }

  // A stream is running: not an error, not a pause, just not yet.
  if (isLoading) {
    return { kind: 'wait' };
  }

  /*
   * 🔴 THE LATCH, AND IT IS ONE COMPARISON ON PURPOSE.
   *
   * Two things have to be true before a phase may run, and `armedIndex === plan.next` is exactly both:
   *
   *   - **Armed at all.** `null` is never equal to a numeric index, so an unarmed runner waits. The
   *     arm is set only after the finished phase's actions settled AND the row accepted the advance,
   *     which is what stops this effect posting a generation on every render.
   *   - **Armed for the phase the SERVER believes is next.** A stale arm means another tab advanced
   *     the row, or a retry arrived out of order; the row wins, because `mergeCreationPlan` is
   *     monotonic server-side precisely so a client cannot rewind it and re-run a paid phase.
   *
   * ⚠️ A separate `armedIndex === null` guard was written here first and DELETED: it is unreachable
   * behind this comparison, and mutation testing proved it — removing it changed no test's result. A
   * redundant guard is worse than none, because the next reader believes it is the thing doing the
   * work and tests it instead of the comparison that actually is.
   */
  if (armedIndex !== plan.next) {
    return { kind: 'wait' };
  }

  return { kind: 'run', index: plan.next };
}

/**
 * Is a creation plan mid-flight for this project?
 *
 * 🔴 **Auto-repair must be OFF while phases remain** (`_specs/phased-creation_plan.md`, trap 2). A
 * compile error between phases is NORMAL, not a defect: the frontend phase imports art the next phase
 * has not rendered yet, so `src/pages/Home.tsx` legitimately references a file that does not exist for
 * as long as it takes the art phase to run. `decideAutoRepair` fires on any `source: 'preview'` alert
 * inside its window, so without this it would fire between every pair of phases — billing the user to
 * "fix" what the next phase was about to fix, and colliding with it for the in-flight claim (§4.12).
 *
 * ⚠️ **`disarm: false`, never `true`.** The watch has to SURVIVE the gap: the last phase's output is
 * real code with nothing after it to fix a mistake, and that is the turn self-healing exists for. A
 * disarm here would silently trade a spurious repair for no repair at all.
 */
export function creationPlanActive(plan: CreationPlan | null | undefined): boolean {
  return Boolean(plan) && !isCreationPlanComplete(plan);
}
