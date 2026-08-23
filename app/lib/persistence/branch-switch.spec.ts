/**
 * Does a branch switch replace the user's files, and may it happen at all? (§4.13a.)
 *
 * `decideBranchSwitch` is in `restore-target.ts`'s category: it decides whether the working tree is
 * destroyed and rebuilt. So these tests are weighted towards the ways it can be wrong SILENTLY —
 * proceeding where it should have asked, restoring where it should have carried work forward, and
 * "switching" to the branch the project is already on (30 seconds of destruction-and-rebuild whose
 * only observable effect is risk).
 *
 * Several tests are written as PAIRS on purpose. A single-sided assertion here passes for a rule that
 * was deleted — "unsaved work asks first" is green for a function that asks about everything, and
 * "a create does not restore" is green for a function that never restores at all — so the contrast is
 * the assertion.
 */
import { describe, expect, it } from 'vitest';
import { decideBranchSwitch, type BranchSwitchFacts } from './branch-switch';
import { selectMountSource } from './mount-source';

/** A healthy project on `main`, everything committed, switching to an existing `feature`. */
const CLEAN: BranchSwitchFacts = {
  currentBranch: 'main',
  targetBranch: 'feature',
  unsavedWork: false,
};

describe('unsaved work is a question, never an overwrite', () => {
  /**
   * 🔴 §4.13's two-button divergence discipline applied to a new door. The platform never picks a
   * winner between two versions of someone's work — and the three answers are BUTTONS, so their
   * order is part of the contract: `commit` first because it is the only one that loses nothing,
   * `discard` separated as the destructive one, `cancel` last.
   */
  it('asks a three-way question, in commit/discard/cancel order, naming both branches', () => {
    const plan = decideBranchSwitch({ ...CLEAN, unsavedWork: true });

    expect(plan.action).toBe('confirm');
    expect(plan).toMatchObject({ choices: ['commit', 'discard', 'cancel'] });

    // Naming both branches is what makes the question answerable: from where, to where.
    expect(plan.action === 'confirm' && plan.reason).toContain('main');
    expect(plan.action === 'confirm' && plan.reason).toContain('feature');
  });

  /**
   * The control for the test above: with nothing to lose there is nothing to ask, and a switch that
   * prompts every time teaches the user to click through the prompt that matters.
   */
  it('proceeds without a prompt when there is nothing unsaved', () => {
    const plan = decideBranchSwitch(CLEAN);

    expect(plan).toEqual({ action: 'proceed', restoresTree: true });
  });

  /**
   * 🔴 A CREATE carries the work forward by construction — no file is touched — so there is nothing
   * to lose and nothing to ask. Prompting here would teach the user that branching is dangerous,
   * which is the opposite of true and pushes them towards the switch that actually is.
   */
  it('does not ask on a create, even with unsaved work', () => {
    const plan = decideBranchSwitch({ ...CLEAN, unsavedWork: true, createFromCurrent: true });

    expect(plan.action).not.toBe('confirm');
    expect(plan).toEqual({ action: 'proceed', restoresTree: false });
  });
});

describe('switching to the branch you are already on', () => {
  /**
   * 🔴 A full restore here rewrites `vite.config.ts`, restarts Vite and reinstalls dependencies to
   * arrive exactly where it started. The `not.toBe('proceed')` half is the point of the test: a
   * no-op that proceeds is indistinguishable from a working switch until you watch the clock.
   */
  it('is a no-op that says so, and is NOT a proceed', () => {
    const plan = decideBranchSwitch({ ...CLEAN, targetBranch: 'main' });

    expect(plan.action).toBe('noop');
    expect(plan.action).not.toBe('proceed');
    expect(plan.action === 'noop' && plan.reason).toContain('main');
  });

  /**
   * ...unless it is a CREATE. `git checkout -b` onto an existing name is a genuine collision, and the
   * server's `name-taken` refusal is the one that should say so — answering "you are already there"
   * would tell the user their branch was created when it was not.
   */
  it('is not a no-op when the user is CREATING a branch with that name', () => {
    const plan = decideBranchSwitch({ ...CLEAN, targetBranch: 'main', createFromCurrent: true });

    expect(plan.action).not.toBe('noop');
  });
});

describe('restoresTree is the half that replaces the user files', () => {
  /**
   * Asserted as a PAIR, because each side alone is vacuous: "a create does not restore" passes for a
   * function that never restores, and "a switch restores" passes for one that always does. The
   * contrast between two otherwise-identical fact sets is the assertion.
   */
  it('is false for create-and-switch and true for switch-to-existing', () => {
    const created = decideBranchSwitch({ ...CLEAN, createFromCurrent: true });
    const switched = decideBranchSwitch({ ...CLEAN, createFromCurrent: false });

    expect(created).toEqual({ action: 'proceed', restoresTree: false });
    expect(switched).toEqual({ action: 'proceed', restoresTree: true });
    expect(created).not.toEqual(switched);
  });
});

describe('a commit-less target has no tree to restore', () => {
  /**
   * `planRestore` refuses an empty incoming map by design, so handing one through would restore
   * nothing and report success — the switch silently not happening while the UI says it did.
   */
  it('refuses when the target branch is known to have no commits', () => {
    const plan = decideBranchSwitch({ ...CLEAN, targetHead: null });

    expect(plan.action).toBe('refuse');
    expect(plan.action === 'refuse' && plan.reason).toContain('feature');
  });

  /**
   * 🔴 THE CONTROL, and the whole reason the field is `string | null | undefined`. `undefined` means
   * "not looked up yet" — the normal case, where the server reads the tree and refuses a commit-less
   * branch itself. Collapsing it with `null` (the `remoteHead` distinction one file over) would make
   * every ordinary switch refuse.
   */
  it('does NOT refuse when the head is simply unknown', () => {
    const plan = decideBranchSwitch({ ...CLEAN, targetHead: undefined });

    expect(plan.action).not.toBe('refuse');
    expect(plan).toEqual({ action: 'proceed', restoresTree: true });
  });

  /** A create has no target tree to read, so the emptiness rule cannot apply to it. */
  it('does not apply the commit-less rule to a create', () => {
    const plan = decideBranchSwitch({ ...CLEAN, targetHead: null, createFromCurrent: true });

    expect(plan.action).not.toBe('refuse');
  });
});

describe('platform refusals, and the order they come in', () => {
  /** §4.12: a generation owns the tree while it runs. */
  it('refuses while a generation is in flight, and says why', () => {
    const plan = decideBranchSwitch({ ...CLEAN, generationInFlight: true });

    expect(plan.action).toBe('refuse');
    expect(plan.action === 'refuse' && plan.reason).toMatch(/building/i);
  });

  /**
   * 🔴 ORDER: platform refusals precede the no-op precede the user question.
   *
   * Put the no-op first and someone can "switch" to their current branch while a generation is
   * writing files and be told everything is fine — true about the files, misleading about the state
   * of the project. Put the confirm first and the user is asked to choose between three things and
   * then refused whichever they picked.
   */
  it('outranks the same-branch no-op', () => {
    const plan = decideBranchSwitch({ ...CLEAN, targetBranch: 'main', generationInFlight: true });

    expect(plan.action).toBe('refuse');
    expect(plan.action).not.toBe('noop');
  });

  it('outranks the unsaved-work question', () => {
    const plan = decideBranchSwitch({ ...CLEAN, unsavedWork: true, generationInFlight: true });

    expect(plan.action).toBe('refuse');
    expect(plan.action).not.toBe('confirm');
  });

  /**
   * The `SaveQueue` has no cancel and no drain: a queued push re-reads the files at push time, so one
   * landing after a switch would commit the NEW branch's tree under the previous turn's summary — a
   * commit nobody wrote, on a branch nobody chose. Waiting is the honest answer.
   */
  it.each(['saving', 'retrying'] as const)('refuses while the save queue is %s', (saveStatus) => {
    const plan = decideBranchSwitch({ ...CLEAN, saveStatus });

    expect(plan.action).toBe('refuse');
    expect(plan.action === 'refuse' && plan.reason).toMatch(/committed/i);
  });

  /**
   * 🔴 THE CONTROLS. `failed` especially: a save that failed is exactly when the user needs to be
   * able to move, and a refusal there strands them on a branch with a broken push.
   */
  it.each(['idle', 'failed', undefined] as const)('does NOT refuse when the save queue is %s', (saveStatus) => {
    const plan = decideBranchSwitch({ ...CLEAN, saveStatus });

    expect(plan.action).not.toBe('refuse');
    expect(plan).toEqual({ action: 'proceed', restoresTree: true });
  });

  /**
   * 🔴 THE SAVE-QUEUE REFUSAL NEEDS ITS OWN ORDERING ASSERTION, and it did not have one.
   *
   * `generationInFlight` was pinned against both the no-op and the confirm; `saveStatus` was pinned
   * against neither, so moving it below the no-op passed the whole suite. The defect that buys is
   * quiet and specific: a user who presses their current branch while a push is in flight is told
   * "you are already on main", the dialog closes, and the push they were not told about lands a
   * commit under the previous turn's summary. Two rules that must hold together need two tests —
   * one of them holding is not evidence about the other.
   */
  it('the save-queue refusal outranks the same-branch no-op', () => {
    const plan = decideBranchSwitch({ ...CLEAN, targetBranch: 'main', saveStatus: 'saving' });

    expect(plan.action).toBe('refuse');
    expect(plan.action).not.toBe('noop');
  });

  it('the save-queue refusal outranks the unsaved-work question', () => {
    const plan = decideBranchSwitch({ ...CLEAN, unsavedWork: true, saveStatus: 'retrying' });

    expect(plan.action).toBe('refuse');
    expect(plan.action).not.toBe('confirm');
  });

  /**
   * 🔴 THE NO-OP OUTRANKS THE QUESTION — the case no fixture reached, because it needs
   * `targetBranch === currentBranch` AND `unsavedWork: true` at once.
   *
   * Below the confirm, pressing the branch you are already on while holding uncommitted work pops
   * "Switching to main replaces every file in the project" for an operation that touches nothing.
   * The user is asked to weigh losing their work against an action with no effect, and the only
   * safe-looking answer (commit first) spends a real push to arrive where they already were.
   */
  it('the same-branch no-op outranks the unsaved-work question', () => {
    const plan = decideBranchSwitch({ ...CLEAN, targetBranch: 'main', unsavedWork: true });

    expect(plan.action).toBe('noop');
    expect(plan.action).not.toBe('confirm');
  });

  /**
   * 🔴 AND THE COMMIT-LESS REFUSAL OUTRANKS IT TOO — verbatim the failure the module's own
   * `⚠️ ORDER MATTERS` comment forbids: "the user is asked to choose between three things and then
   * refused whichever they picked". Every one of the three answers loses here (cancel wastes the
   * question; commit spends a push; discard destroys work) for a switch that was never possible.
   */
  it('the commit-less refusal outranks the unsaved-work question', () => {
    const plan = decideBranchSwitch({ ...CLEAN, unsavedWork: true, targetHead: null });

    expect(plan.action).toBe('refuse');
    expect(plan.action).not.toBe('confirm');
    expect(plan.action === 'refuse' && plan.reason).toMatch(/no commits/i);
  });

  it('refuses when no branch was chosen', () => {
    const plan = decideBranchSwitch({ ...CLEAN, targetBranch: '' });

    expect(plan.action).toBe('refuse');
    expect(plan.action === 'refuse' && plan.reason).toMatch(/choose a branch/i);
  });
});

/**
 * 🔴 THE INTEGRATION TEST, against the REAL `selectMountSource`.
 *
 * A switch is only finished when the project's facts describe a project that is exactly where the
 * repo is. Get the bookkeeping wrong and nothing throws at switch time — the damage appears on the
 * NEXT page load, as a divergence prompt for a project nobody diverged, or as a silent re-fetch of
 * the branch that is already on disk.
 *
 * This is why it drives the real function rather than restating its rules: the property being pinned
 * is "these two modules agree", and a hand-written expectation of `selectMountSource`'s output is a
 * copy of this file's belief about it, which is the thing that drifts.
 */
describe('the facts a completed switch leaves behind', () => {
  const NEW_HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const OLD_HEAD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  it('do not read as diverged, and the same facts without the sha write DO', () => {
    const plan = decideBranchSwitch(CLEAN);
    expect(plan).toEqual({ action: 'proceed', restoresTree: true });

    /*
     * After the switch: the tree came from `feature`'s head, the platform recorded that head as the
     * commit it agrees with, and the seqs were levelled because the restored tree IS the repo's.
     */
    const afterSwitch = selectMountSource({
      linked: true,
      lastSyncedCommitSha: NEW_HEAD,
      remoteHead: NEW_HEAD,
      localSeq: 7,
      syncedSeq: 7,
    });

    expect(afterSwitch.source).not.toBe('diverged');
    expect(afterSwitch).toEqual({ source: 'local', unsavedWork: false });

    /*
     * 🔴 CONTROL 1 — the assertion above is not vacuous. Drop the `lastSyncedCommitSha` write (leave
     * it at the branch we switched AWAY from) and the very next mount decides the repo moved ahead
     * and re-fetches over the tree that is already correct.
     */
    const shaWriteDropped = selectMountSource({
      linked: true,
      lastSyncedCommitSha: OLD_HEAD,
      remoteHead: NEW_HEAD,
      localSeq: 7,
      syncedSeq: 7,
    });

    expect(shaWriteDropped).toEqual({ source: 'repo', reason: 'remote-ahead' });
    expect(shaWriteDropped).not.toEqual(afterSwitch);

    /*
     * 🔴 CONTROL 2 — the same dropped write with the seqs NOT levelled is the worse half: the mount
     * reads a divergence that never happened and puts a two-button choice in front of a user who
     * only changed branches.
     */
    const shaAndSeqDropped = selectMountSource({
      linked: true,
      lastSyncedCommitSha: OLD_HEAD,
      remoteHead: NEW_HEAD,
      localSeq: 8,
      syncedSeq: 7,
    });

    expect(shaAndSeqDropped).toEqual({ source: 'diverged', remoteHead: NEW_HEAD });
  });

  /**
   * A create writes the same complete tuple: the new branch's head is the current head, because the
   * branch was cut from it and no restore happened.
   */
  it('are equally settled after a create-and-switch', () => {
    const plan = decideBranchSwitch({ ...CLEAN, createFromCurrent: true });
    expect(plan).toEqual({ action: 'proceed', restoresTree: false });

    expect(
      selectMountSource({
        linked: true,
        lastSyncedCommitSha: NEW_HEAD,
        remoteHead: NEW_HEAD,
        localSeq: 3,
        syncedSeq: 3,
      }),
    ).toEqual({ source: 'local', unsavedWork: false });
  });
});
