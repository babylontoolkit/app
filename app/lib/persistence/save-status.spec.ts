/**
 * What the user is told about where their work lives (SPEC §4.5.4b).
 *
 * These tests are mostly about ONE claim: the platform must never say "saved" about work that is not
 * saved. Everything else here is comfort; that one is the product promise, and it is the one a
 * refactor can break without breaking anything else — a badge that reads "Saved to GitHub" is exactly
 * as reassuring when it is wrong.
 *
 * So the sweep at the bottom asserts it across EVERY combination rather than the ones I thought of.
 */
import { describe, expect, it } from 'vitest';
import {
  decideNudge,
  describeBranchState,
  describeProjectSaveBadge,
  describeSaveStatus,
  shouldWarnBeforeUnload,
  type BranchStateFacts,
} from './save-status';
import { canOpenPullRequest } from '~/lib/git/provider-urls';
import type { SaveState } from './save-queue';
import type { RepoStatus } from './projects';

const idle: SaveState = { status: 'idle' };
const unlinked: RepoStatus = { linked: false };
const linked: RepoStatus = { linked: true, provider: 'github', repo: 'jane/space-racer', branch: 'main' };

describe('the badge — unlinked', () => {
  /*
   * The copy changed with §4.5.4c and the CLAIM is the point. It used to say the project "only exists
   * in this browser" — true when written, false once the platform kept a recovery copy. It must now
   * describe what syncing is actually for (owning the code) without pretending the work is in danger.
   */
  it('offers to sync, without claiming the work exists nowhere else', () => {
    const view = describeSaveStatus({ repo: unlinked, unsavedWork: true, saveState: idle });

    expect(view.tone).toBe('warning');
    expect(view.label).toBe('Not linked to GitHub');
    expect(view.action).toBe('save');
    expect(view.actionLabel).toBe('Link to GitHub');
    expect(view.detail).not.toMatch(/only exists in this browser/i);
    expect(view.detail).toMatch(/recovery copy/i);
  });

  /** Before the first status fetch lands. The safe default is "not saved", never a hopeful blank. */
  it('assumes NOT saved while the status is still loading', () => {
    const view = describeSaveStatus({ repo: undefined, unsavedWork: false, saveState: idle });

    expect(view.tone).toBe('warning');
    expect(view.action).toBe('save');
  });

  /** An unlinked project with nothing in it is still unlinked — the badge does not get optimistic. */
  it('stays a warning even with no unsaved work', () => {
    expect(describeSaveStatus({ repo: unlinked, unsavedWork: false, saveState: idle }).tone).toBe('warning');
  });
});

describe('the badge — linked', () => {
  it('is quiet when everything is synced', () => {
    const view = describeSaveStatus({ repo: linked, unsavedWork: false, saveState: idle });

    expect(view.tone).toBe('neutral');
    expect(view.label).toBe('Linked to GitHub');
    expect(view.detail).toContain('space-racer');
  });

  it('names GitLab when that is where the project lives', () => {
    const view = describeSaveStatus({
      repo: { ...linked, provider: 'gitlab' },
      unsavedWork: false,
      saveState: idle,
    });

    expect(view.label).toBe('Linked to GitLab');
  });

  it('warns when there is work the repo does not have yet', () => {
    const view = describeSaveStatus({ repo: linked, unsavedWork: true, saveState: idle });

    expect(view.tone).toBe('warning');
    expect(view.label).toBe('Changes not synced');
    expect(view.action).toBe('save');
  });

  /**
   * Pressing Sync on a synced project is someone reassuring themselves. A disabled button answers that
   * with nothing at all; a no-op push answers it with "Synced".
   */
  it('leaves Sync pressable on an already-synced project', () => {
    expect(describeSaveStatus({ repo: linked, unsavedWork: false, saveState: idle }).action).toBe('save');
  });

  it('drops the owner from the badge but keeps the repo name findable', () => {
    const view = describeSaveStatus({ repo: linked, unsavedWork: true, saveState: idle });

    expect(view.detail).toContain('space-racer');
    expect(view.detail).not.toContain('jane/');
  });
});

describe('the badge — in flight', () => {
  it('shows saving', () => {
    const view = describeSaveStatus({ repo: linked, unsavedWork: true, saveState: { status: 'saving' } });

    expect(view.tone).toBe('busy');
    expect(view.action).toBe('none');
    expect(view.actionLabel).toBe('');
  });

  it('tells a first-time saver that the repository is being set up, not that files are uploading', () => {
    const view = describeSaveStatus({ repo: unlinked, unsavedWork: true, saveState: { status: 'saving' } });

    expect(view.detail).toContain('GitHub');
  });

  /**
   * 🔴 Retrying is a WARNING, not a spinner. It has already failed once. Dressing it as ordinary
   * progress means the eventual `failed` arrives out of nowhere, after the user stopped watching.
   */
  it('does not disguise a retry as ordinary progress', () => {
    const view = describeSaveStatus({
      repo: linked,
      unsavedWork: true,
      saveState: { status: 'retrying', attempt: 2, nextAttemptAt: 0, message: 'GitHub is busy.' },
    });

    expect(view.tone).toBe('warning');
    expect(view.tone).not.toBe('busy');
    expect(view.detail).toBe('GitHub is busy.');
  });
});

describe('the badge — failure is loud', () => {
  it('outranks every other state, including a linked, saved-looking project', () => {
    const view = describeSaveStatus({
      repo: linked,

      // Note: `unsavedWork` false — the queue failed before it could be recomputed. The failure wins.
      unsavedWork: false,
      saveState: { status: 'failed', message: 'GitHub is down.' },
    });

    expect(view.tone).toBe('danger');
    expect(view.label).toBe('Not synced');
    expect(view.action).toBe('retry');
  });

  it('offers a reconnect rather than a pointless retry when the connection lapsed', () => {
    const view = describeSaveStatus({
      repo: linked,
      unsavedWork: true,
      saveState: { status: 'failed', message: 'auth', reconnect: true },
    });

    expect(view.action).toBe('reconnect');
    expect(view.actionLabel).toContain('GitHub');
    expect(view.detail).toContain('expired');
  });

  it('says the work is still here, because the user cannot see that it is', () => {
    const view = describeSaveStatus({ repo: linked, unsavedWork: true, saveState: { status: 'failed', message: '' } });

    expect(view.detail).toContain('still here');
  });

  /**
   * The owner reported this: on an UNLINKED project (so `repo.provider` is undefined) with GitLab
   * picked in the header, the reconnect button still said "Reconnect GitHub". The provider must come
   * from the user's choice until the project is linked.
   */
  it('names the chosen provider on a reconnect before the project is linked', () => {
    const view = describeSaveStatus({
      repo: unlinked,
      unsavedWork: true,
      saveState: { status: 'failed', message: 'auth', reconnect: true },
      chosenProvider: 'gitlab',
    });

    expect(view.action).toBe('reconnect');
    expect(view.actionLabel).toBe('Reconnect GitLab');
    expect(view.actionLabel).not.toContain('GitHub');
  });

  /** A linked project's own provider always wins over a stale header pick. */
  it('lets the linked provider override the header pick', () => {
    const view = describeSaveStatus({
      repo: { ...linked, provider: 'github' },
      unsavedWork: true,
      saveState: { status: 'failed', message: 'auth', reconnect: true },
      chosenProvider: 'gitlab',
    });

    expect(view.actionLabel).toBe('Reconnect GitHub');
  });
});

describe('plain language (§4.5.4b)', () => {
  /**
   * Not a git tutorial. Someone who wanted to make a game should never have to learn what a
   * fast-forward is to find out whether their game still exists.
   *
   * ⚠️ **`commit` is the ONE sanctioned exception, and only in `actionLabel`** (owner decision,
   * 2026-07-23). It arrived with the removal of auto-push: the button is now the only thing that
   * writes to the user's repository, and every gentler word for that — "Sync", "Save" — is what made
   * people believe it was happening by itself. The exception is scoped to the button's text on
   * purpose; the STATE the user reads (label, detail) stays in plain language, which is what the
   * split below enforces. Widening this to `label`/`detail` needs the owner, not a passing test edit.
   */
  const jargon = ['push', 'pull', 'remote', 'HEAD', 'fast-forward', 'ref', 'origin', 'SHA'];

  const everyView = () => {
    const views = [];

    for (const repo of [undefined, unlinked, linked]) {
      for (const unsavedWork of [true, false]) {
        for (const saveState of [
          idle,
          { status: 'saving' } as SaveState,
          { status: 'retrying', attempt: 1, nextAttemptAt: 0, message: 'Could not save — trying again.' } as SaveState,
          { status: 'failed', message: 'Could not save your work.' } as SaveState,
          { status: 'failed', message: 'auth', reconnect: true } as SaveState,
        ]) {
          views.push(describeSaveStatus({ repo, unsavedWork, saveState }));
        }
      }
    }

    return views;
  };

  it('never uses git jargon in anything the user reads', () => {
    for (const view of everyView()) {
      for (const word of jargon) {
        expect(`${view.label} ${view.detail} ${view.actionLabel}`.toLowerCase()).not.toContain(word.toLowerCase());
      }
    }
  });

  it('keeps "commit" out of the STATE, however the button is labelled', () => {
    /*
     * The scoped half of the exception above. "Commit changes" is an instruction the user chose to
     * follow; "you have 3 uncommitted commits" is a git tutorial nobody asked for. If a label or a
     * detail sentence ever starts saying commit, this fails — which is the conversation to have with
     * the owner, not a line to delete.
     */
    for (const view of everyView()) {
      expect(`${view.label} ${view.detail}`.toLowerCase()).not.toContain('commit');
    }
  });

  it('always has something to say', () => {
    for (const view of everyView()) {
      expect(view.label.length).toBeGreaterThan(0);
      expect(view.detail.length).toBeGreaterThan(0);
    }
  });

  it('labels every button it offers', () => {
    for (const view of everyView()) {
      expect(view.action === 'none' ? view.actionLabel === '' : view.actionLabel.length > 0).toBe(true);
    }
  });
});

/**
 * 🔴 THE ONE THAT MATTERS.
 *
 * Exhaustive rather than illustrative: "saved" must be unreachable unless the project is linked AND has
 * no unsaved work AND nothing failed. Any future state added to `SaveState` that lands in the neutral
 * branch by accident fails here.
 */
describe('the platform never claims work is saved when it is not', () => {
  it('shows a neutral/saved badge ONLY when the work is genuinely in the repo', () => {
    for (const repo of [undefined, unlinked, linked, { ...linked, provider: 'gitlab' as const }]) {
      for (const unsavedWork of [true, false]) {
        for (const saveState of [
          idle,
          { status: 'saving' } as SaveState,
          { status: 'retrying', attempt: 1, nextAttemptAt: 0, message: 'x' } as SaveState,
          { status: 'failed', message: 'x' } as SaveState,
          { status: 'failed', message: 'x', reconnect: true } as SaveState,
        ]) {
          const view = describeSaveStatus({ repo, unsavedWork, saveState });
          const claimsSaved = view.tone === 'neutral' || /^saved/i.test(view.label);

          if (claimsSaved) {
            expect(repo?.linked, JSON.stringify({ repo, unsavedWork, saveState })).toBe(true);
            expect(unsavedWork, JSON.stringify({ repo, unsavedWork, saveState })).toBe(false);
            expect(saveState.status, JSON.stringify({ repo, unsavedWork, saveState })).toBe('idle');
          }
        }
      }
    }
  });

  /** The inverse: the true-and-safe combination must actually reach the quiet badge. */
  it('does reach the saved badge when everything really is fine', () => {
    expect(describeSaveStatus({ repo: linked, unsavedWork: false, saveState: idle }).tone).toBe('neutral');
  });
});

describe('the dashboard card badge', () => {
  /**
   * 🔴 The regression this replaced: the card rendered a repo chip only when `linkedRepo` was set, so
   * a browser-only project — the one state worth warning about — was the one state the dashboard said
   * nothing about at all. Silence reads as "fine".
   */
  it('warns on a browser-only project rather than saying nothing', () => {
    const badge = describeProjectSaveBadge({});

    expect(badge.tone).toBe('warning');
    expect(badge.label).toBe('Not linked to a repository');
  });

  it('names the repo on a saved project, quietly', () => {
    const badge = describeProjectSaveBadge({ provider: 'github', linkedRepo: 'jane/space-racer' });

    expect(badge.tone).toBe('neutral');
    expect(badge.label).toBe('jane/space-racer');
    expect(badge.detail).toContain('GitHub');
  });

  it('names GitLab when that is where it lives', () => {
    expect(describeProjectSaveBadge({ provider: 'gitlab', linkedRepo: 'jane/x' }).detail).toContain('GitLab');
  });

  /**
   * A dashboard cannot know whether the LATEST work is saved — `unsavedWork` lives in one browser's
   * checkpoint state, and a card for a project last edited elsewhere has no honest answer. So the card
   * must never make the header's claim.
   */
  it('does not claim the latest changes are saved — only where the project lives', () => {
    expect(describeProjectSaveBadge({ provider: 'github', linkedRepo: 'jane/x' }).label).not.toMatch(/saved/i);
  });

  it('never uses git jargon', () => {
    for (const project of [{}, { provider: 'github' as const, linkedRepo: 'jane/x' }]) {
      const badge = describeProjectSaveBadge(project);

      for (const word of ['commit', 'push', 'remote', 'HEAD', 'origin']) {
        expect(`${badge.label} ${badge.detail}`.toLowerCase()).not.toContain(word.toLowerCase());
      }
    }
  });
});

/* ------------------------------------------------------------------- nudges */

const nudge = (over: Partial<Parameters<typeof decideNudge>[0]>) =>
  decideNudge({ linked: false, generationCount: 0, firstToastShown: false, bannerEvery: 5, ...over });

describe('nudges are milestone-based', () => {
  it('says nothing before the user has made anything', () => {
    expect(nudge({ generationCount: 0 })).toBe('none');
  });

  it('speaks once after the first creation — the moment there is something to lose', () => {
    expect(nudge({ generationCount: 1 })).toBe('toast');
  });

  it('never repeats the one-time toast', () => {
    expect(nudge({ generationCount: 1, firstToastShown: true })).toBe('none');
  });

  it('never nudges a saved project', () => {
    expect(nudge({ linked: true, generationCount: 5 })).toBe('none');
    expect(nudge({ linked: true, generationCount: 1 })).toBe('none');
  });

  it('shows the banner at each milestone', () => {
    expect(nudge({ generationCount: 5, firstToastShown: true })).toBe('banner');
    expect(nudge({ generationCount: 10, firstToastShown: true })).toBe('banner');
  });

  it('stays quiet between milestones', () => {
    for (const generationCount of [2, 3, 4, 6, 7, 8, 9, 11]) {
      expect(nudge({ generationCount, firstToastShown: true })).toBe('none');
    }
  });

  it('honours the operator’s cadence rather than a hardcoded 5', () => {
    expect(nudge({ generationCount: 3, firstToastShown: true, bannerEvery: 3 })).toBe('banner');
    expect(nudge({ generationCount: 5, firstToastShown: true, bannerEvery: 3 })).toBe('none');
  });

  /**
   * "Not now" means not now, not never. Honouring it forever would be a user deciding once, in a hurry,
   * to never be warned that their work is at risk.
   */
  it('respects a dismissal at the milestone it was made at', () => {
    expect(nudge({ generationCount: 5, firstToastShown: true, bannerDismissedAtCount: 5 })).toBe('none');
  });

  it('asks again at the NEXT milestone — five more things have happened since', () => {
    expect(nudge({ generationCount: 10, firstToastShown: true, bannerDismissedAtCount: 5 })).toBe('banner');
  });

  /**
   * 🔴 T17 (2026-07-28). A creation checkpoints after its first machine-written message, so
   * `generationCount` reaches 1 while the build is still applying — and the "not saved" toast fired
   * over a half-built project. Mid-work, every nudge waits.
   */
  it('says NOTHING while a generation is still applying, even at a toast-worthy moment', () => {
    expect(nudge({ generationCount: 1, applying: true })).toBe('none');
    expect(nudge({ generationCount: 5, firstToastShown: true, applying: true })).toBe('none');
  });

  it('nudges as before once applying is false', () => {
    expect(nudge({ generationCount: 1, applying: false })).toBe('toast');
    expect(nudge({ generationCount: 5, firstToastShown: true, applying: false })).toBe('banner');
  });
});

describe('the beforeunload warning', () => {
  it('fires when closing the tab would actually lose work', () => {
    expect(shouldWarnBeforeUnload({ unsavedWork: true, generationCount: 3, recoverable: false })).toBe(true);
  });

  /*
   * 🔴 §4.5.4c. `unsavedWork` stopped meaning "would be lost" — it means "not in your own repository",
   * which is the ordinary state of every project mid-build now that the platform keeps a recovery
   * copy. Warning there would fire the unstyleable browser dialog on almost every close, which is the
   * cry-wolf failure the test below exists to prevent, arrived at from the other direction.
   */
  it('does NOT fire when the work reached the recovery copy', () => {
    expect(shouldWarnBeforeUnload({ unsavedWork: true, generationCount: 3, recoverable: true })).toBe(false);
  });

  /**
   * 🔴 A browser's unload prompt cannot be styled or explained. Firing it when nothing is at stake
   * trains the user to click straight through it — which disarms it for the one time it mattered.
   */
  it('does NOT fire on a saved project', () => {
    expect(shouldWarnBeforeUnload({ unsavedWork: false, generationCount: 3, recoverable: false })).toBe(false);
  });

  it('does not fire on an empty project the user just opened and closed', () => {
    expect(shouldWarnBeforeUnload({ unsavedWork: true, generationCount: 0, recoverable: false })).toBe(false);
  });
});

/* ------------------------------------------------------- the branch group (§4.13a, T19) */

/**
 * What the Branch menu says, and what it will not let you press.
 *
 * The same reason `describeSaveStatus` is tested this hard, one group over: these strings are the ONLY
 * thing that distinguishes a control that is unavailable for a reason from one that is broken, and the
 * two destructive warnings are the last thing a user reads before an operation they cannot take back.
 *
 * ⚠️ The fixture branch name is deliberately NEUTRAL. The jargon sweep below is a cartesian product
 * over these facts, so a fixture called `origin-fix` or `pull-fixes` would make the sweep fail on the
 * FIXTURE and read as a defect in the copy. `feature/boost-pads` contains no banned word.
 */
const BRANCH = 'feature/boost-pads';

const branchFacts = (over: Partial<BranchStateFacts> = {}): BranchStateFacts => ({
  linked: true,
  branch: BRANCH,
  provider: 'github',
  ...over,
});

describe('the branch group — unavailable, and why', () => {
  /**
   * 🔴 EXPLAINED AND UNAVAILABLE, never dead items (T19). A greyed row with no reason is
   * indistinguishable from a broken one, and here the fix is a single action away — so the sentence
   * has to name it, and name the place the branches would live.
   */
  it('tells an unlinked project what to do about it, and names the provider', () => {
    const view = describeBranchState({ linked: false, provider: 'github' });

    expect(view.unavailableReason).toBeDefined();
    expect(view.unavailableReason).toContain('GitHub');
    expect(view.unavailableReason).toMatch(/save this project/i);
    expect(view.canOpenChangeRequest).toBe(false);
  });

  it('names GitLab when that is where the project would live', () => {
    expect(describeBranchState({ linked: false, provider: 'gitlab' }).unavailableReason).toContain('GitLab');
  });

  /**
   * The CONTROL. Without it the assertion above passes for a function that returns an explanation
   * unconditionally — which would render the whole group unavailable for every project, forever.
   */
  it('has nothing to explain once the project is linked', () => {
    expect(describeBranchState(branchFacts()).unavailableReason).toBeUndefined();
  });
});

describe('the submenu trigger IS the current-branch row (requirement 75)', () => {
  /*
   * The branch name is readable by opening ONE menu, and it is deliberately not in the chip's label:
   * the header row is right-aligned, so a control that grows with unbounded user-chosen text shoves
   * everything left (measured 16px → 486px), and truncating `feature/boost-…` is ambiguous between
   * exactly the branches a user is most likely to confuse.
   */
  it('names the branch when the status has loaded', () => {
    expect(describeBranchState(branchFacts()).triggerLabel).toBe(`Branch: ${BRANCH}`);
  });

  /** Before the status lands there is no branch to name, and inventing one would be a claim. */
  it('says plain "Branch" while the branch is unknown', () => {
    expect(describeBranchState(branchFacts({ branch: undefined })).triggerLabel).toBe('Branch');
  });

  /**
   * An unlinked project has no branch even if a stale `repoStatus` still carries one — the trigger
   * must not read `Branch: main` above a submenu that says the project is not saved anywhere.
   */
  it('says plain "Branch" for an unlinked project, whatever the facts still carry', () => {
    expect(describeBranchState({ linked: false, branch: 'main' }).triggerLabel).toBe('Branch');
  });
});

describe('"Open a pull request" is offered only when it would work', () => {
  /*
   * Both refusals produce an EMPTY compare page on the provider's own site, which reads as our button
   * being broken rather than as the state it reflects.
   */
  it('is not offered on the default branch — there is nothing to compare against', () => {
    const view = describeBranchState(branchFacts({ branch: 'main', defaultBranch: 'main', lastSyncedCommitSha: 'a1' }));

    expect(view.canOpenChangeRequest).toBe(false);
  });

  it('is not offered before the branch has ever been pushed — the provider has no ref for it', () => {
    expect(describeBranchState(branchFacts({ lastSyncedCommitSha: undefined })).canOpenChangeRequest).toBe(false);
  });

  it('is not offered when we do not know which branch we are on', () => {
    expect(
      describeBranchState(branchFacts({ branch: undefined, lastSyncedCommitSha: 'a1' })).canOpenChangeRequest,
    ).toBe(false);
  });

  /** The CONTROL. Without it every assertion above passes for a constant `false`. */
  it('IS offered on a pushed branch that is not the default', () => {
    expect(
      describeBranchState(branchFacts({ defaultBranch: 'main', lastSyncedCommitSha: 'a1' })).canOpenChangeRequest,
    ).toBe(true);
  });

  /**
   * 🔴 NEVER GUESS `main`. An unknown default DISABLES the default-branch rule rather than inventing
   * one: a `master`-trunked repository would otherwise have its real trunk treated as an ordinary
   * branch while a branch literally named `main` was refused — a wrong answer in both directions from
   * a single assumption. The provider's own compare page is the backstop.
   */
  it('offers it for a branch named "main" when the real default was never read', () => {
    expect(
      describeBranchState(branchFacts({ branch: 'main', defaultBranch: undefined, lastSyncedCommitSha: 'a1' }))
        .canOpenChangeRequest,
    ).toBe(true);
  });
});

/**
 * 🔴 The two destructive sentences, and the difference between them.
 *
 * Discard is recoverable (a checkpoint is taken first) and Delete is not (a checkpoint is a snapshot of
 * FILES and cannot restore a remote ref). A dialog that implies the usual safety net where there is
 * none is worse than no dialog — so the copy must not converge on one reassuring paragraph.
 */
describe('the destructive warnings', () => {
  it('discard names the branch it resets to, and says the change can be undone', () => {
    const view = describeBranchState(branchFacts());

    expect(view.discardWarning).toContain(BRANCH);
    expect(view.discardWarning).toMatch(/undo|recover/i);
  });

  it('delete says plainly that the platform cannot bring the branch back', () => {
    const view = describeBranchState(branchFacts());

    expect(view.deleteWarning).toMatch(/cannot bring it back|cannot be recovered|gone/i);
    expect(view.deleteWarning).not.toMatch(/undo/i);
  });

  /**
   * They must not be the same sentence. Copy drifts towards one shared "are you sure?" paragraph, and
   * the moment it does, the one operation with no undo starts promising the safety net of the one that
   * has it.
   */
  it('says two DIFFERENT things — the safety net is not the same on both', () => {
    const view = describeBranchState(branchFacts());

    expect(view.discardWarning).not.toBe(view.deleteWarning);
  });
});

/**
 * 🔴 THE DELIBERATE DUPLICATE, PINNED.
 *
 * `canOfferChangeRequest` (private, here) and `canOpenPullRequest` (exported, `~/lib/git/provider-urls`)
 * implement one predicate twice ON PURPOSE — this module is client-safe COPY and that one is
 * client-safe LINK BUILDING, and making either import the other drags one concern into the other's
 * bundle for three lines. The implementation says so in a comment; a comment cannot fail.
 *
 * What drift costs: the menu offers a pull request the URL builder then aims at an empty compare
 * page, or the URL exists and the item that would open it is hidden. Both are silent.
 */
describe('the two copies of "can a pull request be opened?" agree', () => {
  it.each([
    ['pushed, non-default', { branch: BRANCH, defaultBranch: 'main', lastSyncedCommitSha: 'a1' }],
    ['pushed, IS the default', { branch: 'main', defaultBranch: 'main', lastSyncedCommitSha: 'a1' }],
    ['never pushed', { branch: BRANCH, defaultBranch: 'main' }],
    ['no branch known', { defaultBranch: 'main', lastSyncedCommitSha: 'a1' }],
    ['default unknown, branch named main', { branch: 'main', lastSyncedCommitSha: 'a1' }],
    ['default unknown, ordinary branch', { branch: BRANCH, lastSyncedCommitSha: 'a1' }],
    ['nothing known at all', {}],
    ['branch equals default, never pushed', { branch: 'main', defaultBranch: 'main' }],
  ] satisfies Array<[string, Partial<BranchStateFacts>]>)('%s', (_label, facts) => {
    expect(describeBranchState({ linked: true, ...facts }).canOpenChangeRequest).toBe(canOpenPullRequest(facts));
  });

  /**
   * The CONTROL for the agreement table: it would pass for two functions that both return `false`
   * always. At least one row must be TRUE and at least one FALSE, on both sides.
   */
  it('the table actually exercises both answers', () => {
    const pushedNonDefault = { branch: BRANCH, defaultBranch: 'main', lastSyncedCommitSha: 'a1' };
    const onDefault = { branch: 'main', defaultBranch: 'main', lastSyncedCommitSha: 'a1' };

    expect(canOpenPullRequest(pushedNonDefault)).toBe(true);
    expect(canOpenPullRequest(onDefault)).toBe(false);
    expect(describeBranchState({ linked: true, ...pushedNonDefault }).canOpenChangeRequest).toBe(true);
    expect(describeBranchState({ linked: true, ...onDefault }).canOpenChangeRequest).toBe(false);
  });
});

/**
 * The plain-language sweep, extended to the branch group.
 *
 * ⚠️ **"branch" is ALLOW-LISTED, deliberately, and the scope is exactly this group.** It is not jargon
 * here — it is the noun the feature is about, it appears on the provider's own UI, and a user who has
 * asked to switch branches has already chosen to know the word. Everything else the sweep bans stays
 * banned: `push`, `pull`, `remote`, `HEAD`, `fast-forward`, `ref`, `origin`, `SHA`.
 *
 * ⚠️ This used to end "…that is why the menu item says 'Open a change request' and not 'Open a pull
 * request'". It says **"Open a pull request"** since 2026-08-22 (owner). Nothing here changed and
 * nothing here is weakened: this sweep runs over `describeBranchState`'s OUTPUT, and every string it
 * returns is still jargon-free. The menu item is a JSX label, which this sweep has never reached —
 * the "Pull from GitHub…" row has sat outside it the whole time. A rule's rationale must not claim
 * credit for a string it does not govern; that is how a sweep gets believed to be wider than it is.
 *
 * ⚠️ It is a cartesian product, so the FIXTURE matters: a branch name containing a banned word would
 * fail here and read as a defect in the copy rather than in the fixture. See `BRANCH` above.
 */
describe('plain language in the branch group (§4.5.4b)', () => {
  const branchJargon = ['push', 'pull', 'remote', 'HEAD', 'fast-forward', 'origin', 'SHA'];

  const everyBranchView = () => {
    const views: Array<ReturnType<typeof describeBranchState>> = [];

    for (const linked of [true, false]) {
      for (const branch of [undefined, BRANCH, 'main']) {
        for (const defaultBranch of [undefined, 'main']) {
          for (const provider of ['github', 'gitlab'] as const) {
            for (const lastSyncedCommitSha of [undefined, 'a1b2c3']) {
              views.push(describeBranchState({ linked, branch, defaultBranch, provider, lastSyncedCommitSha }));
            }
          }
        }
      }
    }

    return views;
  };

  it('never uses git jargon in anything the user reads', () => {
    for (const view of everyBranchView()) {
      const text = `${view.triggerLabel} ${view.unavailableReason ?? ''} ${view.discardWarning} ${view.deleteWarning}`;

      for (const word of branchJargon) {
        expect(text.toLowerCase(), `${word} in: ${text}`).not.toContain(word.toLowerCase());
      }
    }
  });

  /**
   * `ref` is checked separately because it is a SUBSTRING of ordinary English ("refresh", "prefer").
   * Banning it wholesale would be a tripwire on the copy rather than on the jargon, so it is matched
   * as a whole word — which is the thing that would actually reach a user ("the ref is gone").
   */
  it('never says "ref" as a word', () => {
    for (const view of everyBranchView()) {
      const text = `${view.triggerLabel} ${view.unavailableReason ?? ''} ${view.discardWarning} ${view.deleteWarning}`;

      expect(text).not.toMatch(/\brefs?\b/i);
    }
  });

  /** The sweep is only worth anything if the strings it reads are non-empty where they are used. */
  it('always has a trigger label, and always explains an unavailable group', () => {
    for (const view of everyBranchView()) {
      expect(view.triggerLabel.length).toBeGreaterThan(0);

      if (view.unavailableReason !== undefined) {
        expect(view.unavailableReason.length).toBeGreaterThan(0);
      }
    }
  });

  /** A CONTROL for the sweep itself: it must be capable of failing. */
  it('the sweep can fail — a banned word in the same shape of string is caught', () => {
    const poisoned = `Branch: ${BRANCH} — pull from origin`;

    expect(branchJargon.some((word) => poisoned.toLowerCase().includes(word.toLowerCase()))).toBe(true);
  });
});
