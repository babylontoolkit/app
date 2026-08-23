/**
 * Which branch operations are allowed, and where a new branch starts (SPEC §4.13, T6).
 *
 * These two functions decide whether a remote branch is **destroyed** and whether a project's link
 * tuple is **repointed**, which puts them in `restore-target.ts`/`auto-repair.ts` territory: both
 * failure directions are silent, and both are only visible later, as work that is not where the user
 * left it. So this file is exhaustive rather than representative.
 *
 * Three properties are asserted that a naive suite would skip, each because its absence is invisible:
 *
 *   - **The two refusals must not read the same.** A test that only checks `ok === false` on both
 *     passes for an implementation that returns one sentence for everything — and the whole reason
 *     these live in a pure module is that the recoveries differ (switch away vs. you cannot, here).
 *     So the sentences are compared to each other, not only matched against a regex.
 *   - **`null` and `undefined` are different questions.** `liveHead: null` is "we asked and the
 *     branch has no commits"; `undefined` is "we did not ask". `mount-source.ts` records what
 *     collapsing those costs. They happen to reach the same ANSWER in the fallback, and the tests
 *     below make that visible rather than leaving a reader to assume it was considered.
 *   - **A delete decision can never mutate a file.** Requirement 47 — asserted on the SHAPE of the
 *     return value, because "it does not touch files" is otherwise a claim in a comment.
 */
import { describe, expect, it } from 'vitest';
import { decideBranchCreateBase, decideBranchDelete } from './branch-ops';

describe('decideBranchDelete', () => {
  it('allows an ordinary branch that is neither current nor default', () => {
    expect(decideBranchDelete({ name: 'feature/hud', currentBranch: 'main', defaultBranch: 'main' })).toEqual({
      ok: true,
    });
  });

  /**
   * 🔴 The current branch is refused because of the LINK TUPLE, not politeness.
   *
   * §4.5.4b makes `provider` + `linked_repo` + `linked_branch` all-or-nothing, so deleting the branch
   * the project is on leaves a COMPLETE tuple pointing at nothing: every later push, pull and mount
   * fails against a branch the provider has never heard of, and the user reports it as "my repository
   * is gone" — from an operation they were told had succeeded.
   */
  it('refuses the branch the project is currently on, and says to switch away first', () => {
    const decision = decideBranchDelete({
      name: 'feature/hud',
      currentBranch: 'feature/hud',
      defaultBranch: 'main',
    });

    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.reason).toMatch(/feature\/hud/);
    expect(decision.ok === false && decision.reason).toMatch(/switch to another branch first/i);
  });

  it("refuses the repository's default branch, and says so", () => {
    const decision = decideBranchDelete({ name: 'main', currentBranch: 'feature/hud', defaultBranch: 'main' });

    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.reason).toMatch(/main/);
    expect(decision.ok === false && decision.reason).toMatch(/default branch/i);
  });

  /**
   * 🔴 THE ACCEPTANCE: **two different sentences**.
   *
   * Asserted by comparing them to each other. A pair of `toMatch` assertions passes for an
   * implementation that returns one generic refusal for both — and the recoveries are genuinely
   * different (switch away, versus you cannot do this here at all), so a user handed the wrong one
   * goes looking for a control that will not help them.
   */
  it('gives the two refusals DIFFERENT sentences', () => {
    const current = decideBranchDelete({ name: 'shared', currentBranch: 'shared', defaultBranch: 'main' });
    const isDefault = decideBranchDelete({ name: 'shared', currentBranch: 'other', defaultBranch: 'shared' });

    expect(current.ok).toBe(false);
    expect(isDefault.ok).toBe(false);

    const a = current.ok === false ? current.reason : '';
    const b = isDefault.ok === false ? isDefault.reason : '';

    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
  });

  /**
   * The current-branch rule wins when a branch is BOTH — the more actionable of the two, since
   * switching away is a thing the user can actually do next.
   */
  it('names the current-branch reason when a branch is both current and default', () => {
    const both = decideBranchDelete({ name: 'main', currentBranch: 'main', defaultBranch: 'main' });
    const onlyDefault = decideBranchDelete({ name: 'main', currentBranch: 'feature', defaultBranch: 'main' });

    expect(both.ok).toBe(false);
    expect(both.ok === false && both.reason).toMatch(/switch to another branch first/i);
    expect(both.ok === false ? both.reason : '').not.toBe(onlyDefault.ok === false ? onlyDefault.reason : '');
  });

  /**
   * 🔴 `defaultBranch: null` is "we could not ask", and it DISABLES that rule rather than guessing.
   *
   * Never a guessed `main`: a repository whose trunk is `master` would have its real default deletable
   * and a `main` that may not even exist refused. The provider's own refusal is what stands behind
   * this, and it is authoritative because it is the provider's rule.
   */
  it('lets a null default disable the default rule — it never guesses main', () => {
    expect(decideBranchDelete({ name: 'main', currentBranch: 'feature/hud', defaultBranch: null })).toEqual({
      ok: true,
    });
    expect(decideBranchDelete({ name: 'master', currentBranch: 'feature/hud', defaultBranch: null })).toEqual({
      ok: true,
    });
  });

  /** The CONTROL for the line above: a null default must not disable the OTHER rule as well. */
  it('still refuses the current branch when the default could not be read', () => {
    const decision = decideBranchDelete({ name: 'feature/hud', currentBranch: 'feature/hud', defaultBranch: null });

    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.reason).toMatch(/switch to another branch first/i);
  });

  /** Ref names are case- and separator-sensitive; a near miss is a DIFFERENT branch, not this one. */
  it.each([
    ['different case', 'Main', 'main', 'main'],
    ['a nested name that merely shares a prefix', 'feature/hud-v2', 'feature/hud', 'main'],
    ['a prefix of the current branch', 'feature', 'feature/hud', 'main'],
  ])('allows %s', (_label, name, currentBranch, defaultBranch) => {
    expect(decideBranchDelete({ name, currentBranch, defaultBranch })).toEqual({ ok: true });
  });

  /**
   * 🔴 REQUIREMENT 47, as a SHAPE assertion: a delete decision can never carry a file instruction.
   *
   * The whole point of this module is that deciding whether a remote ref may be destroyed is a
   * separate question from touching the working tree. An implementation that grew a `restore`,
   * `files` or `protect` field would be doing tree replacement from the delete door, silently, and
   * a `toBe(false)`-shaped test would never notice. So the returned KEYS are pinned.
   *
   * ⚠️ Asserted on the KEYS, never on `JSON.stringify(decision)`. The first draft scanned the
   * serialized decision for `/files|restore|delete|…/` and failed on both refusals — because the
   * refusal PROSE legitimately contains the words "delete it" and "deleted". A scan that reads
   * user-facing sentences as if they were field names is not a shape check; it is a spell checker
   * that fails when the copy is good.
   */
  it.each([
    ['an allowed delete', { name: 'feature/hud', currentBranch: 'main', defaultBranch: 'main' }],
    ['a current-branch refusal', { name: 'main', currentBranch: 'main', defaultBranch: 'main' }],
    ['a default-branch refusal', { name: 'main', currentBranch: 'feature', defaultBranch: 'main' }],
    ['an unaskable default', { name: 'main', currentBranch: 'feature', defaultBranch: null }],
  ])('returns only ok/reason for %s — never a file instruction', (_label, facts) => {
    const decision = decideBranchDelete(facts);
    const keys = Object.keys(decision).sort();

    expect(keys).toEqual(decision.ok ? ['ok'] : ['ok', 'reason']);

    for (const key of keys) {
      expect(key).not.toMatch(/file|restore|protect|write|path|tree/i);
    }
  });
});

describe('decideBranchCreateBase', () => {
  /**
   * 🔴 THE PRECEDENCE. `lastSyncedCommitSha` FIRST — the commit this project agreed with — so the new
   * branch's head matches what the user has locally. Preferring the live head instead would silently
   * branch off somebody else's commit, and the mistake shows up later as a diff full of changes the
   * user never made.
   */
  it('prefers the commit the project agreed with over the live head', () => {
    expect(decideBranchCreateBase({ lastSyncedCommitSha: 'agreed-sha', liveHead: 'moved-on-sha' })).toEqual({
      ok: true,
      fromSha: 'agreed-sha',
    });
  });

  it('falls back to the live head for a project that has never synced', () => {
    expect(decideBranchCreateBase({ liveHead: 'live-sha' })).toEqual({ ok: true, fromSha: 'live-sha' });
  });

  it('takes the agreed sha when the two are the same, which is the ordinary case', () => {
    expect(decideBranchCreateBase({ lastSyncedCommitSha: 'same-sha', liveHead: 'same-sha' })).toEqual({
      ok: true,
      fromSha: 'same-sha',
    });
  });

  /**
   * 🔴 THE REFUSAL: a linked repository with **zero commits** (Open Question 7). There is genuinely
   * nothing to branch from, and inventing an empty branch is the answer that looks like it worked.
   * The sentence names the cause AND the next action — `build-failure.ts`'s rule: a refusal that names
   * nothing is read as the button being broken.
   */
  it('refuses when there is no sha at all, naming the cause and what to do next', () => {
    const decision = decideBranchCreateBase({ liveHead: null });

    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.reason).toMatch(/no commits yet/i);
    expect(decision.ok === false && decision.reason).toMatch(/nothing to branch from/i);
    expect(decision.ok === false && decision.reason).toMatch(/commit your changes first/i);
  });

  /**
   * `null` (we asked, the branch is empty) and `undefined` (we did not ask) reach the same ANSWER
   * here, and that is deliberate rather than accidental: with no synced sha either way there is no
   * commit to start from. The distinction is made VISIBLE — `mount-source.ts` is one directory over,
   * where collapsing exactly these two lets a flaky connection decide a repo is empty.
   */
  it.each([
    ['null — asked, and the branch has no commits', null],
    ['undefined — we did not ask', undefined],
  ])('refuses with no synced sha and liveHead %s', (_label, liveHead) => {
    const decision = decideBranchCreateBase({ liveHead: liveHead as string | null });

    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.reason).toMatch(/no commits yet/i);
  });

  /** The CONTROL for the pair above: a synced sha carries the create even with no readable head. */
  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('still creates from the agreed sha when liveHead is %s', (_label, liveHead) => {
    expect(decideBranchCreateBase({ lastSyncedCommitSha: 'agreed-sha', liveHead: liveHead as string | null })).toEqual({
      ok: true,
      fromSha: 'agreed-sha',
    });
  });

  /**
   * ⚠️ AN EMPTY STRING NEVER BECOMES A BASE SHA — asserted as the property, not as a branch of the
   * fallback.
   *
   * `''` is a value, so `??` keeps it, and the `!fromSha` guard then catches it: the result is a
   * refusal rather than `createRef(sha: '')`, which real GitHub answers with 422 "Object does not
   * exist" — a provider error where the honest answer is a sentence. The refusal names "no commits
   * yet", which is not literally what happened, and that is the accepted cost of a state the store
   * cannot produce (Postgres `NULL` arrives as `undefined`, and `parseCommitSha` validates every sha
   * written by the link op). What must never happen is the OTHER direction, so that is what is
   * asserted: no input produces `{ ok: true, fromSha: '' }`.
   */
  it.each([
    ['an empty synced sha beside a real head', { lastSyncedCommitSha: '', liveHead: 'live-sha' }],
    ['both empty', { lastSyncedCommitSha: '', liveHead: '' }],
    ['an empty live head and nothing synced', { liveHead: '' }],
  ])('never hands an empty sha to createBranch — %s', (_label, facts) => {
    const decision = decideBranchCreateBase(facts as Parameters<typeof decideBranchCreateBase>[0]);

    expect(decision).not.toMatchObject({ ok: true, fromSha: '' });
    expect(decision.ok).toBe(false);
  });

  /** A successful decision carries the sha and nothing else — no branch name, no files. */
  it('returns only ok/fromSha on success', () => {
    const decision = decideBranchCreateBase({ lastSyncedCommitSha: 'agreed-sha', liveHead: null });

    expect(Object.keys(decision).sort()).toEqual(['fromSha', 'ok']);
  });
});
