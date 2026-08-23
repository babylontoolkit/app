/**
 * Which branch operations are allowed, and why a refused one was refused (SPEC §4.13).
 *
 * PURE and exhaustively tested, in the same category as `restore-target.ts` and `auto-repair.ts`: the
 * answers here decide whether a remote branch is destroyed and whether a project's link tuple is
 * repointed, and both failure directions are silent. It lives apart from the route so the rules can be
 * driven without a provider, a store, or a session — the reason `sync-logic.ts` exists beside
 * `github.ts`.
 *
 * Every refusal returns **its own sentence**. Two operations refused for different reasons must not
 * read identically, or the user is told what they cannot do without being told what to do instead —
 * `share/build-failure.ts`'s recorded lesson, and the reason `branch-name.ts` names the rule it broke.
 */

/** A refusal carries the sentence the user sees; `ok` carries nothing, because there is nothing to say. */
export type BranchOpDecision = { ok: true } | { ok: false; reason: string };

export interface BranchDeleteFacts {
  /** The branch the caller asked to delete. */
  name: string;

  /** The branch this project is linked to right now (`projects.linked_branch`). */
  currentBranch: string;

  /**
   * The repository's default branch **as the provider reported it**, or `null` when we could not ask.
   *
   * 🔴 **NEVER A GUESSED `main`.** A repository whose trunk is `master` or `develop` would have its
   * real default deletable and its `main` — which may not exist, or may be a feature branch — refused.
   * `null` is honest: we could not ask, so this rule cannot be applied, and the provider's own refusal
   * is what stands between the user and a protected branch.
   */
  defaultBranch: string | null;
}

/**
 * May this branch be deleted?
 *
 * Two refusals, each with its own sentence, because the recoveries are different: the current branch
 * needs you to switch away first, and the default branch cannot be deleted here at all.
 *
 * ⚠️ **The current-branch rule is about the LINK TUPLE, not about politeness.** §4.5.4b makes
 * `provider` + `linked_repo` + `linked_branch` all-or-nothing (migration 0006's
 * `projects_link_complete_check`), so a project whose `linked_branch` names a branch that no longer
 * exists is a COMPLETE tuple pointing at nothing. Every later push, pull and mount then fails against
 * a branch the provider has never heard of, and the symptom the user reports is "my repository is
 * gone" — from an operation they performed deliberately and were told had succeeded.
 *
 * ⚠️ This is advisory, and deliberately not the last line of defence. The provider refuses a protected
 * branch with its own reason, which is authoritative because it is the provider's rule; this exists so
 * the two cases we can name locally are named *well* rather than surfaced as a raw API error.
 */
export function decideBranchDelete(facts: BranchDeleteFacts): BranchOpDecision {
  if (facts.name === facts.currentBranch) {
    return {
      ok: false,
      reason: `This project is on ${facts.name} right now. Switch to another branch first, then delete it.`,
    };
  }

  if (facts.defaultBranch !== null && facts.name === facts.defaultBranch) {
    return {
      ok: false,
      reason: `${facts.name} is the repository's default branch, so it cannot be deleted from here.`,
    };
  }

  return { ok: true };
}

export interface BranchCreateFacts {
  /**
   * The commit this project last agreed with (`projects.last_synced_commit_sha`), if any.
   *
   * ⚠️ `undefined` = never synced. NOT the same as "the branch is empty" — see `liveHead`.
   */
  lastSyncedCommitSha?: string;

  /**
   * The live head of the branch the project is on, or `null` when that branch has no commits.
   *
   * `null` and `undefined` mean different things here for the same reason they do in `mount-source.ts`:
   * `null` is "we asked and there is nothing", `undefined` is "we did not ask". Collapsing them is how
   * a project with a perfectly good head gets told it has nothing to branch from.
   */
  liveHead: string | null;
}

export type BranchCreateBase = { ok: true; fromSha: string } | { ok: false; reason: string };

/**
 * Which commit does a new branch start at?
 *
 * 🔴 **YOU BRANCH OFF WHAT YOU ARE LOOKING AT, never the repository default.** A user pressing "New
 * branch" while working on `feature/hud` means "carry this on somewhere else"; starting them at
 * `main` would silently discard the branch point they could see on screen, and the mistake is only
 * visible later, as a diff full of changes they never made.
 *
 * The order is deliberate: `lastSyncedCommitSha` FIRST, falling back to the live head. The synced sha
 * is the commit this project agreed with, so branching from it produces a branch whose head matches
 * what the user has locally. Falling back to the live head covers a project that has never pushed —
 * and if the two disagree, the project is diverged, which is a state the create path does not resolve
 * and does not need to: the new branch is created at the commit we agreed with, and the user's working
 * files are carried onto it untouched.
 *
 * A refusal (no sha at all) is a linked repository with **zero commits** — Open Question 7, decided:
 * listing and switching work on such a repo, creating does not, because there is nothing to branch
 * from. It names that rather than inventing an empty branch.
 *
 * 🔴 **THE SYNCED SHA WINS EVEN WHEN THE PROJECT IS DIVERGED, which reads as a deviation from the
 * plan's wording and is the deliberate answer.** T6's Details say "`lastSyncedCommitSha` when in
 * sync, otherwise the live head", which admits a reading where a DIVERGED project branches from the
 * remote's newer commit. It must not. `fastForwardPush` replaces the tree wholesale, so a branch
 * created at a head this project has never held, then pushed with the browser's files, deletes
 * whatever a teammate added in the commits we never saw — silently, on a branch the user believes is
 * simply "their work, somewhere else". Branching at the commit we agreed with produces a branch that
 * matches what the user can see, and their first push to it is an honest fast-forward.
 *
 * The parenthetical the plan gives for this rule — "you branch off what you are looking at, never the
 * repository default" — is satisfied by exactly this behaviour. Carried to SPEC §10 in T21 so the
 * requirement's looser wording does not outlive the decision.
 */
export function decideBranchCreateBase(facts: BranchCreateFacts): BranchCreateBase {
  const fromSha = facts.lastSyncedCommitSha ?? facts.liveHead ?? undefined;

  if (!fromSha) {
    return {
      ok: false,
      reason:
        'This repository has no commits yet, so there is nothing to branch from. Commit your changes first, then create a branch.',
    };
  }

  return { ok: true, fromSha };
}
