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
import { decideNudge, describeProjectSaveBadge, describeSaveStatus, shouldWarnBeforeUnload } from './save-status';
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
