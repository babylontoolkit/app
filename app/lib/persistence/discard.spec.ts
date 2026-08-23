/**
 * "Put this project back to where it is saved." (§4.13a, §4.12.)
 *
 * The first operation in this product whose entire purpose is destruction, so the tests are about
 * the ways it can destroy MORE than the user asked for: running with no saved version to go back to,
 * running while something else owns the tree, running when there was nothing to discard — and, the
 * one that costs a file nobody can get back, treating a repo's file map as the whole truth and
 * deleting the `.env`.
 *
 * That last one is tested against the REAL `planRestore`, with `protectNothing` as the control,
 * because `protect: 'repo'` is otherwise just a string that happens to be spelled correctly.
 */
import { describe, expect, it } from 'vitest';
import { decideDiscard, type DiscardFacts } from './discard';
import { planRestore, protectForRepoRestore, protectNothing } from './restore-plan';
import { selectMountSource } from './mount-source';

/** A linked project on `main` holding checkpoints that were never pushed. */
const DISCARDABLE: DiscardFacts = {
  linked: true,
  currentBranch: 'main',
  unsavedWork: true,
};

describe('there has to be something to go back to', () => {
  /**
   * 🔴 An unlinked project has no saved version — the browser is the only copy that exists
   * (§4.5.4b). The one interpretation available to a best-effort implementation is therefore
   * emptying the project, which is the single most destructive thing this codebase could do,
   * arrived at by treating a missing precondition as a default.
   */
  it('refuses when the project is not linked, and names the missing repository', () => {
    const plan = decideDiscard({ ...DISCARDABLE, linked: false });

    expect(plan.action).toBe('refuse');
    expect(plan.action).not.toBe('proceed');
    expect(plan.reason).toMatch(/repositor/i);
    expect(plan.reason).toMatch(/commit/i);
  });

  /**
   * A "successful" discard that replaced the tree with a byte-identical copy still restarts the dev
   * server and reinstalls dependencies — the user watches 30 seconds of work happen and cannot tell
   * whether anything was lost.
   */
  it('is a no-op when there is nothing to discard, and names the branch', () => {
    const plan = decideDiscard({ ...DISCARDABLE, unsavedWork: false });

    expect(plan.action).toBe('noop');
    expect(plan.reason).toContain('main');
  });

  /**
   * ⚠️ THE FALLBACK STRING IS ASSERTED, NOT ITS TRUTHINESS.
   *
   * This test read `expect(plan.reason).toBeTruthy()`, which passes with the `?? 'its branch'`
   * deleted: the template then renders "There is nothing to discard — this project matches
   * undefined." — a truthy sentence, shown to a user, naming a branch called `undefined`. A test
   * named after a fallback whose input cannot reach it is not a weak test, it is no test.
   */
  it('falls back to a generic phrase when the branch is not known', () => {
    const plan = decideDiscard({ linked: true, unsavedWork: false });

    expect(plan.action).toBe('noop');
    expect(plan.reason).toContain('its branch');
    expect(plan.reason).not.toContain('undefined');
  });

  it('falls back to a generic phrase in the confirmation too', () => {
    const plan = decideDiscard({ linked: true, unsavedWork: true });

    expect(plan.action).toBe('proceed');
    expect(plan.reason).toContain('the linked branch');
    expect(plan.reason).not.toContain('undefined');
  });
});

describe('the happy path', () => {
  it('proceeds with a strict checkpoint first and the repo protection', () => {
    const plan = decideDiscard(DISCARDABLE);

    expect(plan).toEqual({
      action: 'proceed',
      checkpointFirst: true,
      protect: 'repo',
      reason: expect.stringContaining('main'),
    });
  });

  /** The confirmation has to promise the undo, because that is the only reason this is safe to click. */
  it('tells the user their current files are checkpointed first', () => {
    const plan = decideDiscard(DISCARDABLE);

    expect(plan.reason).toMatch(/checkpoint|undo/i);
  });
});

/**
 * 🔴 THE CONTROL THAT MAKES `protect: 'repo'` LOAD-BEARING.
 *
 * `isSecretPath` kept the whole `.env` family out of every push, so a map fetched FROM a repo never
 * contains one — its absence says "never sent", not "deleted". Both halves are asserted here against
 * the real `planRestore`: the protection saves the file, and the OTHER protection would delete it.
 * Without the second half this test passes for a `planRestore` that deletes nothing at all.
 */
describe('the protection the plan selects', () => {
  const STORE = '/home/project/';
  const current = [`${STORE}.env`, `${STORE}src/main.ts`, `${STORE}src/scratch.ts`];

  // Exactly what a repo tree returns: repo-relative, no secrets, and missing the uncommitted file.
  const incoming = ['src/main.ts'];

  it('keeps the .env, while protectNothing would delete it', () => {
    expect(decideDiscard(DISCARDABLE)).toMatchObject({ protect: 'repo' });

    const repoProtected = planRestore({ current, incoming, protect: protectForRepoRestore });

    expect(repoProtected.toDelete).not.toContain(`${STORE}.env`);

    // The discard still does its job: the file the repo does not have is the one that goes.
    expect(repoProtected.toDelete).toEqual([`${STORE}src/scratch.ts`]);

    /*
     * 🔴 The control. `protectNothing` is correct for a LOCAL checkpoint (which really is the whole
     * truth) and catastrophic here — it destroys the user's API keys, the one class of file on disk
     * with no other copy anywhere, and not the thing they asked to discard.
     */
    const unprotected = planRestore({ current, incoming, protect: protectNothing });

    expect(unprotected.toDelete).toContain(`${STORE}.env`);
    expect(unprotected.toDelete).not.toEqual(repoProtected.toDelete);
  });
});

describe('platform refusals, and the order they come in', () => {
  it('refuses while a generation is in flight', () => {
    const plan = decideDiscard({ ...DISCARDABLE, generationInFlight: true });

    expect(plan.action).toBe('refuse');
    expect(plan.reason).toMatch(/building/i);
  });

  it.each(['saving', 'retrying'] as const)('refuses while the save queue is %s', (saveStatus) => {
    const plan = decideDiscard({ ...DISCARDABLE, saveStatus });

    expect(plan.action).toBe('refuse');
    expect(plan.reason).toMatch(/committed/i);
  });

  /** Controls: `failed` must not strand the user, and an absent status is the ordinary case. */
  it.each(['idle', 'failed', undefined] as const)('does NOT refuse when the save queue is %s', (saveStatus) => {
    const plan = decideDiscard({ ...DISCARDABLE, saveStatus });

    expect(plan.action).toBe('proceed');
  });

  /**
   * 🔴 ORDER, pinned as the implementation states it: platform state before preconditions.
   *
   * An unlinked project mid-generation must be told about the generation — that is the transient,
   * actionable fact — and a refusal is a refusal either way, so the only thing at stake is whether
   * the sentence sends the user somewhere useful. Pinning it stops the two rules being reordered
   * into a message that blames the wrong thing.
   */
  it('reports the in-flight generation rather than the missing link', () => {
    const plan = decideDiscard({ ...DISCARDABLE, linked: false, generationInFlight: true });

    expect(plan.action).toBe('refuse');
    expect(plan.reason).toMatch(/building/i);
    expect(plan.reason).not.toMatch(/repositor/i);
  });

  it('reports the save queue rather than the missing link', () => {
    const plan = decideDiscard({ ...DISCARDABLE, linked: false, saveStatus: 'saving' });

    expect(plan.action).toBe('refuse');
    expect(plan.reason).toMatch(/committed/i);
  });
});

/**
 * 🔴 OPEN QUESTION 1, DECIDED: the strict before-checkpoint is UNCONDITIONAL.
 *
 * "Unconditional" is a property of every path, not of one example, so it is asserted over a sweep
 * rather than a case. The tempting saving — skip the checkpoint when there is "nothing to lose" —
 * reintroduces the judgement this module exists to remove: `unsavedWork` is a seq comparison, not a
 * diff, so it is false for an editor change made in the last second, for a file the watcher has not
 * reported, and for anything the agent wrote whose checkpoint has not landed.
 */
describe('there is no path to a proceed without a checkpoint', () => {
  const LINKED = [true, false];
  const UNSAVED = [true, false];
  const IN_FLIGHT = [true, false, undefined];
  const SAVE_STATUS = ['idle', 'saving', 'retrying', 'failed', undefined] as const;
  const BRANCHES = ['main', 'feature/x', undefined];

  it('over every combination of facts', () => {
    let proceeds = 0;
    let others = 0;

    for (const linked of LINKED) {
      for (const unsavedWork of UNSAVED) {
        for (const generationInFlight of IN_FLIGHT) {
          for (const saveStatus of SAVE_STATUS) {
            for (const currentBranch of BRANCHES) {
              const plan = decideDiscard({ linked, unsavedWork, generationInFlight, saveStatus, currentBranch });

              if (plan.action === 'proceed') {
                proceeds++;
                expect(plan.checkpointFirst).toBe(true);
                expect(plan.protect).toBe('repo');
              } else {
                others++;

                // Every non-proceed still has to say something; a silent refusal is a broken button.
                expect(plan.reason).toBeTruthy();
              }

              /*
               * ⚠️ AND WHATEVER IT SAYS, IT NEVER SAYS `undefined`.
               *
               * `toBeTruthy()` alone is blind to a dropped `??` fallback — the sentence still
               * renders, still passes, and shows the user a branch named `undefined`. The sweep
               * includes a row with no `currentBranch` for exactly this reason, so the assertion has
               * to be one the interpolation can fail.
               */
              expect(plan.reason).not.toContain('undefined');
            }
          }
        }
      }
    }

    // Controls: the sweep must actually reach both sides, or it asserts nothing.
    expect(proceeds).toBeGreaterThan(0);
    expect(others).toBeGreaterThan(0);
  });
});

/**
 * 🔴 WHAT A FINISHED DISCARD MUST LEAVE BEHIND, against the REAL `selectMountSource`.
 *
 * A discard ends with the tree byte-identical to the branch head it was read from, so the project's
 * facts must describe a project that has nothing unsaved. Getting the bookkeeping wrong throws
 * nothing at discard time — the damage shows up afterwards, as a chip reporting unsaved work on a
 * tree the user just reset, which is the one message guaranteed to make them press the destructive
 * button a second time.
 *
 * This is plan finding 3 in test form. `refreshSavedCopiesSoon` — the obvious helper to reach for
 * here — is the TOP-UP mechanism: it writes a `'Unsaved changes'` checkpoint and ends with
 * `unsavedWork.set(true)`. Calling it to discharge a discard produces exactly the facts the control
 * below pins as wrong, and nothing else in the codebase would have noticed.
 *
 * It drives the real function rather than restating its rules, for `branch-switch.spec.ts`'s reason:
 * the property is "these two modules agree", and a hand-written expectation is a copy of this file's
 * belief about the other one.
 */
describe('the facts a completed discard leaves behind', () => {
  const HEAD = 'c0ffee1';

  it('read as settled, and the same facts with the seq left behind do NOT', () => {
    /*
     * `markSynced` levelled the two seqs, and the pointer already named this branch (the server does
     * not move it on a discard — the client is the party that decides the reset landed).
     */
    expect(
      selectMountSource({
        linked: true,
        lastSyncedCommitSha: HEAD,
        remoteHead: HEAD,
        localSeq: 7,
        syncedSeq: 7,
      }),
    ).toEqual({ source: 'local', unsavedWork: false });

    /*
     * 🔴 THE CONTROL. The same discard, discharged through the top-up path: a new checkpoint was
     * written (`localSeq` advanced) and `syncedSeq` was left where it was. Same files on disk, and
     * the project now reports work that exists nowhere else — on a tree that is byte-identical to
     * the branch. Without this half, the assertion above passes for a discard that updates nothing.
     */
    expect(
      selectMountSource({
        linked: true,
        lastSyncedCommitSha: HEAD,
        remoteHead: HEAD,
        localSeq: 8,
        syncedSeq: 7,
      }),
    ).toEqual({ source: 'local', unsavedWork: true });
  });
});
