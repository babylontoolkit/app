/**
 * Should this branch switch happen, and what does it do to the user's files? (§4.13a.)
 *
 * Pure, exported and exhaustively tested for the reason `restore-target.ts` and `auto-repair.ts` are:
 * **this decides whether the user's working tree is replaced.** Every wrong answer here is silent —
 * nothing throws, the screen just ends up holding a project the user did not ask for — and there is no
 * natural symptom, because a tree that was replaced looks exactly like a tree that was always that way.
 *
 * The rules, and what each one costs when it is wrong:
 *
 *   - 🔴 **Unsaved work makes a switch a THREE-WAY CHOICE** — commit first / discard and switch /
 *     cancel — never a silent overwrite. This is §4.13's two-button divergence discipline applied to
 *     a new door: the platform never picks a winner between two versions of someone's work.
 *   - 🔴 **Switching to the branch you are already on is a NO-OP that says so.** A full restore there
 *     rewrites `vite.config.ts`, restarts Vite and reinstalls dependencies for a tree that is already
 *     correct — 30+ seconds of destruction-and-rebuild whose only observable effect is risk.
 *   - 🔴 **Create-and-switch performs NO restore.** The whole point of branching is that the work in
 *     progress carries onto the new branch; a restore there would discard exactly what the user was
 *     protecting by branching.
 *   - **A generation owns the tree while it runs** (§4.12), and the `SaveQueue` has no cancel — a
 *     queued push re-reads files at push time, so a save landing after a switch would push the NEW
 *     branch's files under the old turn's summary. Both are refusals with a sentence, not waits.
 */

/** What the caller knows before it asks. */
export interface BranchSwitchFacts {
  /** The branch the project is on now. */
  currentBranch: string;

  /** The branch the user picked. For a create-and-switch, the name they typed. */
  targetBranch: string;

  /** True when this is `create-branch` (the branch does not exist yet), false for a switch. */
  createFromCurrent?: boolean;

  /** This browser holds checkpoints made since the last push. */
  unsavedWork: boolean;

  /** A generation is in flight for this project (server-authoritative — `isProjectClaimed`). */
  generationInFlight?: boolean;

  /** What the save queue is doing. `saving`/`retrying` are refusals; see the header. */
  saveStatus?: 'idle' | 'saving' | 'retrying' | 'failed';

  /**
   * The target branch's head, when the caller already knows it. `null` = the branch exists and has
   * no commits — a refusal, never a restore of emptiness (`planRestore` refuses an empty map by
   * design, so handing one through would restore nothing and report success).
   *
   * `undefined` = not looked up yet, which is the normal case: the server reads the tree and refuses
   * a commit-less branch itself. This exists so a caller that DOES know can refuse without a round
   * trip, and it must never be collapsed with `null` — the `remoteHead` distinction one file over.
   */
  targetHead?: string | null;
}

/**
 * Why a switch cannot proceed, or what must be asked first.
 *
 * `noop` — nothing to do. The user is already on this branch and no files are touched.
 */
export type BranchSwitchPlan =
  | { action: 'noop'; reason: string }

  /** Cannot proceed at all right now. `reason` is shown verbatim; it always names a cause. */
  | { action: 'refuse'; reason: string }

  /**
   * Ask first. The three answers are the caller's buttons, in this order — `commit` is FIRST because
   * it is the only one that loses nothing, and `discard` is separated as destructive.
   */
  | { action: 'confirm'; reason: string; choices: ['commit', 'discard', 'cancel'] }

  /**
   * Go. `restoresTree` is the half that decides whether the user's files are replaced:
   * `false` for a create (the work carries onto the new branch), `true` for a switch.
   */
  | { action: 'proceed'; restoresTree: boolean };

export function decideBranchSwitch(facts: BranchSwitchFacts): BranchSwitchPlan {
  /*
   * ⚠️ ORDER MATTERS, and this is the order: refusals that are about the PLATFORM's state come
   * before the no-op, which comes before the question we ask the USER.
   *
   * Putting the no-op first would let someone "switch" to their current branch while a generation is
   * writing files and be told everything is fine — true for the files, and misleading about the state
   * of the project. Putting the confirm before the refusals would ask the user to choose between
   * three things and then refuse whichever they picked.
   */
  if (facts.generationInFlight) {
    return {
      action: 'refuse',
      reason: 'This project is building right now. Wait for it to finish, then switch branches.',
    };
  }

  if (facts.saveStatus === 'saving' || facts.saveStatus === 'retrying') {
    /*
     * The `SaveQueue` has no cancel and no drain: a queued push re-reads the files at push time, so
     * one landing after a switch would commit the NEW branch's tree under the previous turn's
     * summary — a commit nobody wrote, on a branch nobody chose. Waiting is the honest answer;
     * inventing a cancel path into the one sanctioned push writer is not.
     */
    return {
      action: 'refuse',
      reason: 'Your changes are still being committed. Wait for that to finish, then switch branches.',
    };
  }

  if (!facts.targetBranch) {
    return { action: 'refuse', reason: 'Choose a branch to switch to.' };
  }

  /*
   * 🔴 Already here. Not an error and not a switch — a full restore would rewrite every file, restart
   * the dev server and reinstall dependencies to arrive exactly where it started.
   *
   * A CREATE is exempt: `git checkout -b` onto the current name is a genuine collision, and the
   * server's `name-taken` refusal is the one that should say so — answering "you are already there"
   * would tell the user their branch was created when it was not.
   */
  if (!facts.createFromCurrent && facts.targetBranch === facts.currentBranch) {
    return { action: 'noop', reason: `You are already on ${facts.targetBranch}.` };
  }

  /*
   * A branch that exists and has no commits has no tree to restore. Refused with a sentence rather
   * than handed through, because `planRestore` would decline the empty map and the switch would
   * silently not happen while reporting success.
   */
  if (!facts.createFromCurrent && facts.targetHead === null) {
    return {
      action: 'refuse',
      reason: `${facts.targetBranch} has no commits yet, so there is nothing to switch to.`,
    };
  }

  /*
   * 🔴 UNSAVED WORK IS A QUESTION, NEVER AN OVERWRITE — but only for a switch.
   *
   * A CREATE carries the work forward by construction (no file is touched), so there is nothing to
   * lose and nothing to ask: prompting there would teach the user that branching is dangerous, which
   * is the opposite of true and would push them towards the switch that actually is.
   */
  if (facts.unsavedWork && !facts.createFromCurrent) {
    return {
      action: 'confirm',
      reason: `You have changes that are not committed to ${facts.currentBranch}. Switching to ${facts.targetBranch} replaces every file in the project.`,
      choices: ['commit', 'discard', 'cancel'],
    };
  }

  return { action: 'proceed', restoresTree: !facts.createFromCurrent };
}
