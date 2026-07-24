/**
 * What we tell the user about where their work lives (SPEC §4.5.4b).
 *
 * Pure, and tested exhaustively, because this is the only thing standing between a user and the belief
 * that their game is safe when it is not. `mount-source.ts` decides which copy is real; this decides
 * what the person is told about it, and the failure modes mirror each other:
 *
 *   - say "saved" when it is not → they close the tab, and the game is gone;
 *   - say "not saved" when it is → they distrust a product that is working, which is cheaper but not
 *     free (they save over and over, and the badge becomes noise they stop reading);
 *   - say nothing → the default belief is "of course it is saved, everything is saved in 2026".
 *
 * The last one is why UNLINKED is amber and loud and LINKED is quiet and grey. The asymmetry is the
 * design: a saved project should feel like nothing, and an unsaved one should feel like something.
 *
 * ## Language
 *
 * §4.5.4b's plain-language rule applies to every string returned from here. No "commit", no "push", no
 * "remote", no "repository HEAD" — the user asked for a game, not a git tutorial. The repo name is
 * shown because it is *theirs* and they may want to find it, not because they need to understand it.
 *
 * ## "Save" became "Sync" (§4.5.4c, 2026-07-22)
 *
 * The old vocabulary was "Save" / "Saved to GitHub", and the unlinked copy said the project "only
 * exists in this browser". That was true when written and is now FALSE: the platform keeps a recovery
 * copy of every project, so durability no longer depends on the user pressing anything.
 *
 * Leaving it would have been the worse kind of stale copy — it conflates two different things under
 * one word, and the conflation is what loses people's work: "Save" sounds like the thing that makes
 * your work safe, so a user who has not pressed it believes they are in danger, and one who HAS
 * pressed it believes they are done. Neither is what the button does. It puts the project in the
 * user's OWN repository, which is about ownership, not safety.
 *
 * So the verb is "Sync", and the unlinked state no longer claims the work is about to be lost — it
 * says where the code lives and offers to move it somewhere the user owns. The tone stays amber
 * because that is still worth doing, not because anything is on fire.
 *
 * ## LINKED ≠ SYNCED (owner decision, 2026-07-23)
 *
 * Auto-push on checkpoint is GONE (`useChatHistory.ts`). Nothing writes to the user's repository
 * unless they ask for it, so the vocabulary has to separate the two facts it used to merge:
 *
 *   - **Linked** — this project has a repository of yours. A permanent fact about the project.
 *   - **Synced** — the code in that repository matches what is in front of you. A fact about *now*,
 *     and one that only the user's own action can make true.
 *
 * The old copy said "Synced to GitHub" the moment a project was linked, which was true only because
 * every checkpoint pushed behind the user's back. With that gone, the same string would be a claim
 * about the repository's contents that nobody had checked — the exact "say saved when it is not"
 * failure this file opens by warning about.
 *
 * ⚠️ The action is deliberately called **"Commit changes"** (owner decision), which is the one piece
 * of git vocabulary allowed to reach the user. It buys precision the plain-language rule cannot: the
 * button writes a specific set of changes to the repository at a moment of the user's choosing, and
 * every softer word for that ("Sync", "Save") is what made people believe it happened by itself. The
 * plain-language rule still binds every other string, and the jargon test still enforces it — see
 * `save-status.spec.ts`, where the exception is scoped to `actionLabel` and nothing else.
 */

import type { SaveState } from './save-queue';
import type { RepoStatus } from './projects';

export interface SaveStatusFacts {
  /** Where the project is saved, as far as we know. `undefined` = we have not looked yet. */
  repo?: RepoStatus;

  /** Whether this browser holds work that exists nowhere else. */
  unsavedWork: boolean;

  /** What the save queue is doing right now. */
  saveState: SaveState;

  /**
   * The account the user chose in the header picker, used ONLY to name the provider before the project
   * is linked. Once linked, `repo.provider` is authoritative and wins. Without this, an unlinked
   * project's reconnect/save copy always said "GitHub" even when the user had picked GitLab, because
   * `repo.provider` is undefined until the first successful save.
   */
  chosenProvider?: 'github' | 'gitlab';
}

/**
 * How loudly to say it.
 *
 * - `danger`  — a save FAILED. The user must act; their only copy is in a tab.
 * - `warning` — browser-only. Nothing is wrong, but nothing is safe either.
 * - `busy`    — in flight.
 * - `neutral` — saved, and there is nothing to think about.
 */
export type SaveTone = 'danger' | 'warning' | 'busy' | 'neutral';

export interface SaveStatusView {
  tone: SaveTone;

  /** The badge text. Short enough for a header; complete enough to be read alone. */
  label: string;

  /** The tooltip / secondary line. May name the repo. */
  detail: string;

  /** What the button does, or `none` when there is nothing useful to press. */
  action: 'save' | 'retry' | 'reconnect' | 'none';

  /** The button's text. Empty when `action` is `none`. */
  actionLabel: string;
}

/** `owner/name` → `name`. The owner is the user; showing it in a header badge is noise. */
function shortRepo(repo?: string): string | undefined {
  return repo?.split('/').pop() || repo;
}

export function describeSaveStatus(facts: SaveStatusFacts): SaveStatusView {
  const { repo, unsavedWork, saveState, chosenProvider } = facts;
  const linked = repo?.linked === true;
  const name = shortRepo(repo?.repo);

  /*
   * A linked project's own provider is the truth. Before it is linked there is no provider yet, so we
   * name the account the user picked in the header (`chosenProvider`); only if neither is known do we
   * fall back to GitHub, the default when a deployment has just one provider configured.
   */
  const provider = repo?.provider ?? chosenProvider ?? 'github';
  const where = provider === 'gitlab' ? 'GitLab' : 'GitHub';

  /*
   * A FAILED save outranks everything, including "not linked yet". It is the only state where the
   * platform tried to protect the user's work and did not manage it — §4.5.4b calls for LOUD, and
   * loud means it wins the badge, not that it queues politely behind a status.
   */
  if (saveState.status === 'failed') {
    return saveState.reconnect
      ? {
          tone: 'danger',
          label: 'Not synced',
          detail: `Your ${where} connection expired. Reconnect to sync your work.`,
          action: 'reconnect',
          actionLabel: `Reconnect ${where}`,
        }
      : {
          tone: 'danger',
          label: 'Not synced',
          detail: saveState.message || 'Your last sync did not work. Your work is still here — try again.',
          action: 'retry',
          actionLabel: 'Try again',
        };
  }

  if (saveState.status === 'saving') {
    return {
      tone: 'busy',
      label: 'Syncing…',
      detail: linked && name ? `Syncing to ${name}.` : `Setting up your ${where} repository.`,
      action: 'none',
      actionLabel: '',
    };
  }

  /*
   * Retrying is `warning`, not `busy`. It is on its way to being fine, but it has already failed once
   * and it may fail for good — dressing that as an ordinary spinner would make the eventual `failed`
   * arrive out of nowhere.
   */
  if (saveState.status === 'retrying') {
    return {
      tone: 'warning',
      label: 'Trying again…',
      detail: saveState.message || 'That sync did not work. Trying again.',
      action: 'none',
      actionLabel: '',
    };
  }

  // Never looked / never linked. The default, and the one that must not be quiet.
  if (!linked) {
    return {
      tone: 'warning',
      label: `Not linked to ${where}`,
      detail:
        `We keep a recovery copy of this project. Link it to your own ${where} account to own the ` +
        'code and keep its history.',
      action: 'save',
      actionLabel: `Link to ${where}`,
    };
  }

  if (unsavedWork) {
    return {
      tone: 'warning',
      label: 'Changes not synced',
      detail: name ? `You have changes that are not in ${name} yet.` : 'You have changes that are not synced yet.',
      action: 'save',
      actionLabel: 'Commit changes',
    };
  }

  /*
   * Linked, with nothing known to be outstanding. Quiet on purpose — and the button stays available
   * rather than disabled: a user who wants to commit on an already-synced project is reassuring
   * themselves, and a disabled button answers that with nothing. Committing again is a no-op push.
   *
   * ⚠️ It says LINKED, not "Synced". Nothing pushes automatically any more, so "synced" would be a
   * claim about the repository's current contents that nothing verified — this state only means we
   * have no *local* changes since the last commit.
   */
  return {
    tone: 'neutral',
    label: `Linked to ${where}`,
    detail: name ? `In your repository, ${name}.` : `In your ${where} account.`,
    action: 'save',
    actionLabel: 'Commit changes',
  };
}

/* ------------------------------------------------------- the dashboard card */

export interface ProjectBadgeView {
  tone: SaveTone;
  label: string;
  detail: string;
}

/**
 * The badge on a project card in the dashboard (§4.5.4b).
 *
 * Deliberately NOT `describeSaveStatus` with made-up facts. It answers a narrower question — *where is
 * this project saved?* — and it must not answer the header's question (*is my current work saved?*),
 * because a dashboard cannot know that: `unsavedWork` lives in this browser's checkpoint state, and a
 * card for a project last edited on another device has no honest answer. Reusing the header's wording
 * here would print "Saved to GitHub" over a project with unpushed work sitting in a tab next door.
 *
 * So: linked says where it lives, unlinked says it lives nowhere. Neither claims the latest change is
 * in it.
 */
export function describeProjectSaveBadge(project: {
  provider?: 'github' | 'gitlab';
  linkedRepo?: string;
}): ProjectBadgeView {
  if (!project.linkedRepo) {
    return {
      tone: 'warning',
      label: 'Not linked to a repository',
      detail: 'This project has a recovery copy but no repository of your own. Open it and link one.',
    };
  }

  const where = project.provider === 'gitlab' ? 'GitLab' : 'GitHub';

  return {
    tone: 'neutral',
    label: project.linkedRepo,
    detail: `In your ${where} account.`,
  };
}

/* ------------------------------------------------------------------- nudges */

export interface NudgeFacts {
  /** Is the project already saved somewhere permanent? A linked project is never nudged. */
  linked: boolean;

  /** How many generations this project has had. The milestone counter — never a clock (§4.5.4b). */
  generationCount: number;

  /** Has the one-time first-save toast already been shown to this user, ever? */
  firstToastShown: boolean;

  /** Has the user dismissed the banner for this project? Dismissal is respected until the next milestone. */
  bannerDismissedAtCount?: number;

  /** `saving.bannerEveryNGenerations`, injected so the rule is testable without importing config. */
  bannerEvery: number;
}

/**
 * - `toast`  — the one-time "your game lives in this tab" moment, after the first creation.
 * - `banner` — the recurring, dismissible reminder.
 * - `none`   — the overwhelmingly common answer, and the one to prefer when unsure.
 */
export type Nudge = 'toast' | 'banner' | 'none';

/**
 * Should we say something about saving right now?
 *
 * Milestone-based by construction: the only input that moves is `generationCount`. There is no clock
 * here and there must never be one — §4.5.4b forbids a timed nudge, and the reason is that a timer
 * fires while the user is mid-sentence describing their game, which is the one moment the platform has
 * nothing useful to add.
 *
 * Nothing this returns can block a generation. It returns a suggestion for a toast or a banner; both
 * are chrome.
 */
export function decideNudge(facts: NudgeFacts): Nudge {
  // Saved is saved. Nothing to nudge about, ever.
  if (facts.linked) {
    return 'none';
  }

  // Nothing has been made yet. There is no work to lose, so a warning about losing work is noise.
  if (facts.generationCount < 1) {
    return 'none';
  }

  /*
   * The first creation. This is the moment the user has something they would miss and no idea it is
   * temporary — the single highest-value thing we ever say about saving.
   */
  if (facts.generationCount === 1 && !facts.firstToastShown) {
    return 'toast';
  }

  const atMilestone = facts.generationCount % facts.bannerEvery === 0;

  if (!atMilestone) {
    return 'none';
  }

  /*
   * A dismissal is honoured for the milestone it was made at, and only that one. Dismissing forever
   * would be a user choosing, once, to never be told their work is at risk; re-asking every generation
   * would be nagging. Re-asking at the NEXT milestone is the honest middle: they have made five more
   * things since they said "not now".
   */
  if (facts.bannerDismissedAtCount === facts.generationCount) {
    return 'none';
  }

  return 'banner';
}

/**
 * The beforeunload guard (§4.5.4b).
 *
 * Only when work would actually be LOST. A browser shows this as a generic "changes you made may not
 * be saved" box the user cannot restyle or read around, so firing it needlessly trains them to click
 * through it, which disarms it for the one time it mattered.
 *
 * ⚠️ **`unsavedWork` STOPPED MEANING "would be lost" (§4.5.4c).** It means "not in the user's own
 * repository", which was the same thing only while the browser held the only copy. Now the platform
 * keeps a recovery copy, so the common state — an unlinked project mid-build — is work that is safe
 * and merely not owned yet. Left alone, this dialog would fire on every such project and cry wolf by
 * design, which is precisely what the paragraph above warns against.
 *
 * So it asks the narrower question it always meant: is there work that no durable copy has? That is
 * true when the recovery copy could not be written (the upload is best-effort and may have failed
 * offline), and false otherwise.
 */
export function shouldWarnBeforeUnload(facts: {
  unsavedWork: boolean;
  generationCount: number;

  /** Did the latest checkpoint reach the server's recovery copy? (§4.5.4c) */
  recoverable: boolean;
}): boolean {
  return facts.unsavedWork && facts.generationCount > 0 && !facts.recoverable;
}
