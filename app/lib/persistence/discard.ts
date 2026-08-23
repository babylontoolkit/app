/**
 * "Put this project back to where it is saved." (§4.13a, §4.12.)
 *
 * The first operation in this product whose ENTIRE PURPOSE is destruction, which changes what its
 * checkpoint is for: everywhere else a before-checkpoint is a courtesy against a step going wrong,
 * and here it is the only copy of what the user is deliberately throwing away. That makes it the
 * feature's safety contract rather than a nicety, and it is why the checkpoint is STRICT (a lax
 * serialize silently omits an unreadable binary, and this map is the only route back).
 *
 * Pure and exhaustively tested for `restore-target.ts`'s reason — it decides that the user's files
 * are replaced, and it is the one door where that is the point.
 */

export interface DiscardFacts {
  /** The project has a complete link tuple. Without one there is nothing to reset *to*. */
  linked: boolean;

  /** The branch the project is on. Named in the confirmation so the user knows where they land. */
  currentBranch?: string;

  /** This browser holds checkpoints made since the last push — i.e. there is something to discard. */
  unsavedWork: boolean;

  /** A generation is in flight for this project (server-authoritative — `isProjectClaimed`). */
  generationInFlight?: boolean;

  /** What the save queue is doing. See `branch-switch.ts` — the `SaveQueue` has no cancel. */
  saveStatus?: 'idle' | 'saving' | 'retrying' | 'failed';
}

/**
 * What a discard does, or why it cannot.
 *
 * `noop` — nothing to discard. Saying so is better than taking a checkpoint of nothing and restoring it.
 */
export type DiscardPlan =
  | { action: 'noop'; reason: string }
  | { action: 'refuse'; reason: string }
  | {
      action: 'proceed';

      /**
       * 🔴 ALWAYS `true`. Open Question 1, decided: the strict before-checkpoint is unconditional.
       *
       * The tempting saving — skip it when there is "nothing to lose" — reintroduces the judgement
       * this whole module exists to remove. `unsavedWork` is a seq comparison, not a diff: it is
       * false for an editor change made in the last second, for a file the watcher has not reported,
       * and for anything the agent wrote whose checkpoint has not landed. The regret window is
       * identical either way, and a checkpoint costs one local write.
       */
      checkpointFirst: true;

      /**
       * 🔴 `protectForRepoRestore`, never `protectNothing`.
       *
       * The incoming map came from a REPO, and a repo has no `.env` — `isSecretPath` kept the whole
       * family out of every push. So their absence from the tree says "never sent", not "deleted",
       * and `protectNothing` here would delete the user's API keys: the one class of file on disk
       * with no other copy anywhere, and not the thing they asked to discard.
       */
      protect: 'repo';

      /** Text for the confirmation, naming the branch the project resets to. */
      reason: string;
    };

export function decideDiscard(facts: DiscardFacts): DiscardPlan {
  if (facts.generationInFlight) {
    return {
      action: 'refuse',
      reason: 'This project is building right now. Wait for it to finish, then discard your changes.',
    };
  }

  if (facts.saveStatus === 'saving' || facts.saveStatus === 'retrying') {
    return {
      action: 'refuse',
      reason: 'Your changes are still being committed. Wait for that to finish before discarding.',
    };
  }

  /*
   * 🔴 UNLINKED IS A REFUSAL THAT NAMES THE MISSING LINK, never a degraded "delete everything".
   *
   * Discard means "go back to the saved version", and an unlinked project has no saved version — the
   * browser is the only copy that exists (§4.5.4b). The one interpretation available to a
   * best-effort implementation is therefore emptying the project, which is the single most
   * destructive thing this codebase could do, arrived at by treating a missing precondition as a
   * default. The sentence points at the action that would make discard meaningful.
   */
  if (!facts.linked) {
    return {
      action: 'refuse',
      reason:
        'This project is not saved to a repository yet, so there is no saved version to go back to. Commit it first.',
    };
  }

  /*
   * Nothing to discard. Reported rather than performed: a "successful" discard that replaced the tree
   * with a byte-identical copy still restarts the dev server and reinstalls dependencies, so the user
   * would watch 30 seconds of work happen and be unable to tell whether anything was lost.
   */
  if (!facts.unsavedWork) {
    return {
      action: 'noop',
      reason: `There is nothing to discard — this project matches ${facts.currentBranch ?? 'its branch'}.`,
    };
  }

  return {
    action: 'proceed',
    checkpointFirst: true,
    protect: 'repo',
    reason: `This replaces every file with the version committed to ${facts.currentBranch ?? 'the linked branch'}. Your current files are saved to a checkpoint first, so you can undo it.`,
  };
}
