/**
 * Which branches may be deleted, and why not. (§4.13a.)
 *
 * ⚠️ **The one operation in this feature with NO UNDO.** A checkpoint is a snapshot of FILES; it
 * cannot restore a remote ref. Everything else here — a switch, a discard, even a bad create — is
 * recoverable from something the platform holds. This is not, which is why the refusals are the
 * feature rather than an obstacle to it, and why they name their own rule instead of saying
 * "cannot delete that branch".
 *
 * Pure and mirrored server-side (`app/lib/.server/git/branch-ops.ts` owns the authoritative copy for
 * the route). This one exists so the MENU can dim and explain before a round trip — it never grants
 * anything the server has not also checked.
 */

export type BranchDeletePlan = { ok: true } | { ok: false; reason: string };

/**
 * 🔴 BRANCH DELETION IS OFF (owner, 2026-08-22). *"I don't want them doing that for now — they can
 * always open on GitHub and delete the branch there."*
 *
 * ⚠️ **Deliberately NOT folded into `decideBranchDelete`.** That function answers "*which* branch may
 * be deleted" — the current-branch and default-branch protections, the one operation in this feature
 * with no undo. This answers "is the feature available at all". Two different questions, and the
 * first draft of this switch merged them: every test of those protections then asserted the
 * feature-off sentence instead, so flipping the flag back on would restore an unguarded delete with
 * nothing left pinning the guards. A capability switch must not eat the coverage of the rules it
 * suspends.
 *
 * One writer, invoked at every wall — the `denyUnlessVerified` shape. Re-enable by flipping this to
 * `true`; nothing is stubbed, deleted or flagged off, and both decision functions are untouched.
 */
export const BRANCH_DELETE_ENABLED = false;

/**
 * Why the platform is refusing, and where the user CAN still do it.
 *
 * Names the alternative, because a refusal that names no route forward reads as a broken button
 * (`share/build-failure.ts`'s recorded lesson).
 */
export const BRANCH_DELETE_DISABLED_REASON =
  'Deleting branches is turned off here for now. You can delete a branch from your repository on ' +
  'GitHub or GitLab.';

/**
 * The gate every branch-delete wall calls FIRST.
 *
 * 🔴 It is a REFUSAL, not merely a hidden menu row. Hiding alone leaves `op: 'delete-branch'` live on
 * a route reachable by anyone with a session and a project id — a wall that exists only in a
 * component is not a wall (SPEC §5, and the `withSecurity` `requireAuth` lesson).
 */
export function branchDeleteAvailability(): BranchDeletePlan {
  return BRANCH_DELETE_ENABLED ? { ok: true } : { ok: false, reason: BRANCH_DELETE_DISABLED_REASON };
}

export interface BranchDeleteFacts {
  /** The branch the user picked. */
  name: string;

  /** The branch this project is currently on. */
  currentBranch: string;

  /**
   * The repository's default branch, READ from the provider.
   *
   * 🔴 `undefined` = we could not ask, which DISABLES this rule rather than inventing one. Guessing
   * `main` would leave a `master`-trunked repository's real default deletable while refusing a branch
   * that does not exist — a refusal that names the wrong branch and a permission that should not have
   * been granted, from a single assumption. The provider's own refusal still stands behind this.
   */
  defaultBranch?: string;
}

export function decideBranchDelete(facts: BranchDeleteFacts): BranchDeletePlan {
  if (!facts.name) {
    return { ok: false, reason: 'Choose a branch to delete.' };
  }

  /*
   * The project's own branch. Deleting it leaves a COMPLETE link tuple pointing at nothing, which is
   * worse than an incomplete one: §4.5.4b's constraint is satisfied, so the project reads as healthy
   * and linked, and every later push, pull and mount fails against a ref that is gone — which reads
   * to the user as "my repository was deleted".
   */
  if (facts.name === facts.currentBranch) {
    return {
      ok: false,
      reason: `${facts.name} is the branch this project is on. Switch to another branch first, then delete it.`,
    };
  }

  /*
   * The repository's trunk. A DISTINCT sentence from the one above, deliberately: they are different
   * mistakes with different fixes, and one message covering both would tell a user to "switch first"
   * when switching is not what makes the default branch undeletable.
   */
  if (facts.defaultBranch && facts.name === facts.defaultBranch) {
    return {
      ok: false,
      reason: `${facts.name} is this repository's default branch, so it cannot be deleted here.`,
    };
  }

  return { ok: true };
}
