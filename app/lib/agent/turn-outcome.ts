/**
 * 🔴 A BUILD THAT DID NOT FINISH MUST SAY SO, TO THE USER (2026-08-08, owner-directed).
 *
 * ## The defect
 *
 * Measured on a real creation:
 *
 *   step 5: 655,957ms · 64,000 out · finish=length+forced-continuation
 *   Charged 1175 credits ($3.6450)
 *
 * `length` means the provider stopped at the OUTPUT CEILING — the project was cut off mid-file. The
 * turn ran out of steps, a forced continuation rescued it, and that rescue was itself truncated.
 *
 * **And the user was shown `🎮 Your game is ready — open Preview to play it.`**
 *
 * Every marker existed: `finish_reason` carried `length+forced-continuation`, the Admin panel counts
 * it, monitoring alerts on the rate. All of it machine-visible, none of it user-visible. The owner
 * found out by pasting a server console log into a chat. In their words: *"if it stops for some
 * reason, it needs to be loud about the fact it did not finish project creation."*
 *
 * `spec/fail-loud.md` already required this — the reporting corollary says any automatic transition
 * on a paid path (a rescue, a forced continuation, a retry, a clamp) must leave a machine-visible
 * trace **and a user-visible one whenever the user's outcome differs from what they asked for.** The
 * machine half shipped; the user half did not. "Completed with nothing to show" is not a state, and
 * neither is "completed with half a project".
 *
 * ## The three states
 *
 * PURE and shared by the server (which decides) and the client (which renders), so the two can never
 * disagree about what "finished" means — the two-writers drift this codebase keeps rediscovering.
 *
 *  - `finished`   — nothing intervened. Celebrate.
 *  - `rescued`    — the turn needed an automatic second pass and got there. Say so quietly; the
 *                   project is fine, but the user should know a fallback ran on their bill.
 *  - `incomplete` — we cut it off. `length` on the final stream means the last thing written ends
 *                   mid-token. LOUD, persistent, with an action.
 *
 * ## Never regress
 *
 *  - **`finished` must be the common case.** A warning that fires on healthy builds is one the user
 *    learns to ignore, and then it is worthless on the turn that matters. Every non-`finished` state
 *    here corresponds to a specific automatic intervention that actually happened.
 *  - **`incomplete` outranks everything.** A truncated turn that was ALSO rescued is still truncated;
 *    reporting the rescue instead would describe the treatment and hide the injury.
 *  - **Judge from what WE observed, never from the provider's word alone** (`fail-loud.md` rule 7).
 *    `finishReason` is a claim; `wroteFiles` and the rescue flags are things we watched happen.
 *  - **It rides on `agentMeta`, which is persisted with the message** — so it survives a reload. A
 *    toast is not an acceptable carrier: a warning that vanishes on refresh is not a warning, and
 *    this one has to outlive the moment the user walks away from a broken build.
 */

export type TurnOutcomeState = 'finished' | 'rescued' | 'incomplete';

export interface TurnOutcomeFacts {
  /** This was the expensive first build turn — the only one that owes a whole project. */
  isFirstBuildTurn: boolean;

  /** The provider's stated reason. A CLAIM, corroborated by the flags below — never trusted alone. */
  finishReason: string;

  /** The tool-round cap was hit and a second stream was run to force an answer. */
  forcedContinuation: boolean;

  /** The model announced work it did not do, and was made to do it. */
  unproductiveRescue: boolean;

  /** The completeness pass ran AND wrote files — i.e. the build really was unfinished. */
  completionPassWroteFiles: boolean;

  /** Any file action reached the project at all. */
  wroteFiles: boolean;

  /** The user pressed Stop. Their decision — never a failure (`fail-loud.md` state 4). */
  aborted: boolean;
}

export interface TurnOutcome {
  state: TurnOutcomeState;

  /** One line, plain. Rendered as the alert heading or used to pick the toast. */
  headline: string;

  /** What actually happened and what it means for their project. */
  detail: string;

  /** The message the action button posts, or null when there is nothing to do. */
  action: string | null;
}

/**
 * The exact text the "Finish the build" button sends. Shared so the alert and any other caller post
 * the same thing — and deliberately phrased as an instruction to CONTINUE, never to start over: the
 * files already written are correct and re-emitting them costs a second creation.
 */
export const FINISH_BUILD_MESSAGE =
  'Your previous reply was cut off before the project was finished. Continue from exactly where you ' +
  'stopped: re-emit any file that was left incomplete, then write everything still missing — the ' +
  'landing page, the game chrome, and any remaining game code. Do not rewrite files that are already ' +
  'correct, and do not start over.';

export function describeTurnOutcome(facts: TurnOutcomeFacts): TurnOutcome {
  const finished: TurnOutcome = {
    state: 'finished',
    headline: '',
    detail: '',
    action: null,
  };

  /*
   * A Stop is the user's own decision and is charged for what it consumed (`fail-loud.md` state 4).
   * Telling someone their build "did not finish" after they stopped it is noise.
   */
  if (facts.aborted) {
    return finished;
  }

  /*
   * Scoped to the creation turn. An ordinary edit that ends at the output ceiling is worth reporting
   * too, one day — but the alert's whole value is that it is rare and always means something, and a
   * creation is the turn the user cannot proceed without.
   */
  if (!facts.isFirstBuildTurn) {
    return finished;
  }

  /*
   * 🔴 INCOMPLETE OUTRANKS RESCUED. `length` means the provider stopped at the output ceiling, so the
   * last thing written ends mid-token — usually mid-file. A truncated turn that was also rescued is
   * still truncated, and reporting the rescue would describe the treatment while hiding the injury.
   */
  if (facts.finishReason === 'length') {
    return {
      state: 'incomplete',
      headline: 'This build did not finish',
      detail:
        'The reply hit its maximum length and was cut off, so part of your project was never written ' +
        '— the last file is likely incomplete, and the landing page or game chrome may be missing ' +
        'entirely. Nothing is lost: continue the build and it will pick up where it stopped.',
      action: FINISH_BUILD_MESSAGE,
    };
  }

  /*
   * No files at all on a turn that owed a whole project. `unproductive.ts` refunds and raises an error
   * for the total-silence case, but a turn that produced prose, tool calls and no writes reaches here
   * looking like a success.
   */
  if (!facts.wroteFiles) {
    return {
      state: 'incomplete',
      headline: 'This build did not write any files',
      detail:
        'The turn finished without creating any project files, so your project is still the stock ' +
        'starter template. Continue the build to have it written.',
      action: FINISH_BUILD_MESSAGE,
    };
  }

  /*
   * The completeness pass wrote files — meaning the model HAD stopped early and had to be told to
   * finish. The project is now complete, so this is not an error; but it is an automatic transition on
   * a paid path, and the corollary says the user hears about it when their outcome differed from what
   * they asked for.
   */
  if (facts.completionPassWroteFiles) {
    return {
      state: 'rescued',
      headline: 'Your project is ready — it needed a second pass',
      detail:
        'The first attempt stopped before writing everything, so the build was automatically ' +
        'continued and finished. Worth a look over the landing page and the game chrome.',
      action: null,
    };
  }

  if (facts.forcedContinuation || facts.unproductiveRescue) {
    return {
      state: 'rescued',
      headline: 'Your project is ready — it needed a second pass',
      detail:
        'The build ran out of tool steps and was automatically continued to finish the answer. The ' +
        'project is complete, but it cost more than a clean run.',
      action: null,
    };
  }

  return finished;
}
