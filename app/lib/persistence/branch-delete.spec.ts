/**
 * Which branches may be deleted, and why not. (§4.13a.)
 *
 * ⚠️ The one operation in this feature with NO UNDO — a checkpoint is a snapshot of FILES and cannot
 * restore a remote ref — so the refusals ARE the feature. Two things are therefore worth more than
 * the happy path: that the two refusals are two different sentences (they are different mistakes with
 * different fixes), and that a delete can never grow a file-mutating instruction.
 *
 * The distinctness test compares the two reasons to each other rather than matching each against a
 * phrase, because matching phrases is exactly the assertion that stays green when someone collapses
 * both branches into one message that happens to contain both words.
 */
import { describe, expect, it } from 'vitest';
import { decideBranchDelete, type BranchDeleteFacts } from './branch-delete';

const ON_MAIN: BranchDeleteFacts = {
  name: 'feature/hud',
  currentBranch: 'main',
  defaultBranch: 'main',
};

describe('the two branches that cannot be deleted', () => {
  /**
   * Deleting the project's own branch leaves a COMPLETE link tuple pointing at nothing — worse than
   * an incomplete one, because §4.5.4b's constraint is satisfied and the project reads as healthy
   * while every later push, pull and mount fails against a ref that is gone.
   */
  it('refuses the branch the project is on', () => {
    const plan = decideBranchDelete({ ...ON_MAIN, name: 'main', currentBranch: 'main', defaultBranch: 'dev' });

    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.reason).toContain('main');
  });

  it("refuses the repository's default branch", () => {
    const plan = decideBranchDelete({
      ...ON_MAIN,
      name: 'trunk',
      currentBranch: 'feature/hud',
      defaultBranch: 'trunk',
    });

    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.reason).toContain('trunk');
  });

  /**
   * 🔴 TWO DIFFERENT SENTENCES. One message covering both would tell a user to "switch first" when
   * switching is not what makes the default branch undeletable — advice that cannot work, for a rule
   * they were never told about. Comparing the two strings is the only non-vacuous way to assert this.
   */
  it('gives them different reasons', () => {
    /*
     * ⚠️ The SAME branch name on both sides, deliberately. Both sentences interpolate `name`, so two
     * different names make the strings differ even when the template behind them is one shared
     * sentence — i.e. the comparison would pass for exactly the collapse it exists to catch.
     * (Caught by mutation testing: an earlier draft used 'x' and 'main' and went green with both
     * branches returning one message.) Holding the name fixed leaves the template as the only thing
     * that can differ.
     */
    const onThisBranch = decideBranchDelete({ name: 'main', currentBranch: 'main', defaultBranch: 'dev' });
    const isTheDefault = decideBranchDelete({ name: 'main', currentBranch: 'dev', defaultBranch: 'main' });

    expect(onThisBranch.ok).toBe(false);
    expect(isTheDefault.ok).toBe(false);
    expect(onThisBranch.ok === false && onThisBranch.reason).not.toEqual(
      isTheDefault.ok === false && isTheDefault.reason,
    );

    // ...and each still names the rule it is enforcing, not just "no".
    expect(onThisBranch.ok === false && onThisBranch.reason).toMatch(/switch/i);
    expect(isTheDefault.ok === false && isTheDefault.reason).toMatch(/default/i);
  });

  it('refuses when no branch was chosen', () => {
    const plan = decideBranchDelete({ ...ON_MAIN, name: '' });

    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.reason).toMatch(/choose a branch/i);
  });
});

describe('an ordinary branch', () => {
  it('may be deleted', () => {
    expect(decideBranchDelete(ON_MAIN)).toEqual({ ok: true });
  });

  /**
   * 🔴 NEVER A GUESSED `main`. `undefined` means we could not ask the provider, which DISABLES the
   * rule rather than inventing one: guessing would leave a `master`-trunked repository's real default
   * deletable while refusing a branch that does not exist — a refusal naming the wrong branch and a
   * permission that should not have been granted, from a single assumption. The provider's own
   * refusal still stands behind this.
   */
  it('named `main` may be deleted when the default branch could not be read', () => {
    expect(decideBranchDelete({ name: 'main', currentBranch: 'feature/hud' })).toEqual({ ok: true });
  });

  /** The control for the test above: knowing the default is `main` is what makes it undeletable. */
  it('named `main` may NOT be deleted once the default branch is known to be main', () => {
    expect(decideBranchDelete({ name: 'main', currentBranch: 'feature/hud', defaultBranch: 'main' }).ok).toBe(false);
  });
});

/**
 * 🔴 THE CONTROL THAT KEEPS REQUIREMENT 47 TRUE: deleting a branch never touches a file.
 *
 * The plan shape is the enforcement — a delete that cannot express a restore cannot accidentally
 * perform one — so this asserts the shape over a sweep rather than trusting the type, because a
 * `restore` field added in good faith compiles fine and would ship a remote-ref operation that
 * rewrites the working tree with no undo on either half.
 */
describe('a delete plan can never carry a file-mutating instruction', () => {
  const ALLOWED = new Set(['ok', 'reason']);

  it('over every combination of names, current branches and defaults', () => {
    const NAMES = ['', 'main', 'master', 'feature/hud', 'release'];
    const CURRENT = ['main', 'feature/hud', ''];
    const DEFAULTS = ['main', 'master', undefined, ''];

    let allowed = 0;
    let refused = 0;

    for (const name of NAMES) {
      for (const currentBranch of CURRENT) {
        for (const defaultBranch of DEFAULTS) {
          const plan = decideBranchDelete({ name, currentBranch, defaultBranch });

          for (const key of Object.keys(plan)) {
            expect(ALLOWED.has(key)).toBe(true);
          }

          if (plan.ok) {
            allowed++;

            // A success carries nothing else at all — no reason, and nowhere for one to hide.
            expect(Object.keys(plan)).toEqual(['ok']);
          } else {
            refused++;
            expect(typeof plan.reason).toBe('string');
            expect(plan.reason.length).toBeGreaterThan(0);
          }
        }
      }
    }

    // Controls: the sweep reaches both outcomes, or the key assertion is checking nothing.
    expect(allowed).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });
});
