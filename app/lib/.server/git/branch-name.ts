/**
 * Is this a branch name the user can actually have? (SPEC §4.13, `spec/fail-loud.md`)
 *
 * A pure module with no provider, no URL and no I/O, for the reason `repo-name.ts` opens with: this
 * decides what appears in someone else's namespace, from text they typed. The difference is that
 * `deriveRepoName` DERIVES — it is free to fix a bad title silently — while this one REFUSES, because
 * the user chose these exact characters and a branch quietly renamed to something else is worse than
 * one that was not created. So every refusal names **the rule that was broken**, never "invalid name":
 * a user told their name is invalid has to guess which of a dozen ref rules they tripped, and the
 * usual guess is that the feature is broken (`build-failure.ts`'s recorded lesson — a refusal that
 * names no cause is read as the button being broken).
 *
 * ## Scope, honestly
 *
 * These are the rules worth catching BEFORE a round trip, not the whole of `git-check-ref-format`.
 * Git additionally rejects a path component beginning with `.` and a name ending in `.`, and each
 * provider layers its own policy on top (protected-branch patterns, org rules, URL length). Those
 * still refuse —
 * they refuse at the provider, and `toGitHubError` / `_toError` surface the provider's OWN reason,
 * which is the right answer for a rule we do not own. What must never happen is a refusal here
 * wearing a sentence we invented for a rule the provider actually applied.
 *
 * ⚠️ **This module never builds a URL.** A branch name legally contains `/`, so it needs encoding on
 * the way into a provider path — that is the adapter's job (`github.ts` / `gitlab.ts`), and doing it
 * here would produce a name that validates as one string and is created as another.
 */

/**
 * Git itself imposes no limit; the filesystem holding `.git/refs/` does, and 255 is the common
 * single-component ceiling (ext4, APFS, NTFS). A name AT the cap is legal — the check is `>`, not
 * `>=`, and there is a test at exactly this length saying so.
 */
export const MAX_BRANCH_NAME = 255;

/** Characters git reserves in a ref name. `[` and `\` are in here too — this is a list, not a regex class. */
const FORBIDDEN_CHARACTERS = ['~', '^', ':', '?', '*', '[', '\\'];

export type BranchNameCheck = { ok: true } | { ok: false; reason: string };

/**
 * Control characters, tested by CODE POINT rather than with a regex literal.
 *
 * Two reasons, and the second is why it is not `/[\x00-\x1f\x7f]/`. A control character written into
 * a source file is INVISIBLE, so a later edit can delete one and nothing looks different — the exact
 * trap `build-failure.ts` records for its ANSI strip, where the leading escape had to be written as
 * an escape or a tidy-up would silently start eating real Vite output. And a range in a regex reads
 * as one rule while being two; here the boundary (`0x7f`, DEL) is stated where a reader can see it.
 */
function hasControlCharacter(name: string): boolean {
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;

    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }

  return false;
}

/**
 * ⚠️ ORDER IS PART OF THE BEHAVIOUR. A name can break several rules at once (`  refs/x..y `), and the
 * user only ever sees the first sentence — so the checks run most-specific-and-most-actionable first.
 * "Branch names cannot contain spaces" is a fix the user can make; "cannot contain `..`" is true of
 * the same input and less useful. Reordering these silently changes which advice a real typo gets.
 */
export function validateBranchName(name: string): BranchNameCheck {
  if (name.length === 0) {
    return { ok: false, reason: 'Enter a branch name.' };
  }

  if (name.length > MAX_BRANCH_NAME) {
    return {
      ok: false,
      reason: `Branch names cannot be longer than ${MAX_BRANCH_NAME} characters — this one is ${name.length}.`,
    };
  }

  if (/\s/.test(name)) {
    return { ok: false, reason: 'Branch names cannot contain spaces. Use a hyphen or a slash instead.' };
  }

  /*
   * Almost always a paste from somewhere else rather than typing, so the message says what to DO
   * rather than naming a code point the user cannot see on their screen.
   */
  if (hasControlCharacter(name)) {
    return { ok: false, reason: 'Branch names cannot contain control characters — try retyping the name.' };
  }

  const forbidden = FORBIDDEN_CHARACTERS.find((character) => name.includes(character));

  if (forbidden) {
    return { ok: false, reason: `Branch names cannot contain ${forbidden} — git reserves it.` };
  }

  /* Before the bare-`@` rule, because `@{` is reflog syntax and deserves to be named as such. */
  if (name.includes('@{')) {
    return { ok: false, reason: 'Branch names cannot contain @{ — git reads it as reflog syntax.' };
  }

  if (name === '@') {
    return { ok: false, reason: 'A branch cannot be named @ on its own — git reads it as the current branch.' };
  }

  if (name.includes('..')) {
    return { ok: false, reason: 'Branch names cannot contain .. — git reads it as a commit range.' };
  }

  if (name.startsWith('-')) {
    return { ok: false, reason: 'Branch names cannot start with a hyphen — git reads it as a command-line option.' };
  }

  if (name.startsWith('refs/')) {
    return { ok: false, reason: 'Leave off the refs/ prefix — enter just the branch name.' };
  }

  /*
   * The slash rules split into two messages on purpose. An edge slash is nearly always a stray
   * keystroke and says so; an empty section in the middle (`feature//boost`) needs different advice,
   * and collapsing both into one sentence sends half the users looking at the wrong end of the name.
   */
  if (name.startsWith('/') || name.endsWith('/')) {
    return { ok: false, reason: 'Branch names cannot start or end with a slash.' };
  }

  if (name.split('/').some((segment) => segment.length === 0)) {
    return { ok: false, reason: 'Branch names cannot contain an empty section between slashes.' };
  }

  /*
   * PER SEGMENT, not just at the end. Git forbids `.lock` on any component, so `hotfix.lock/urgent`
   * is refused here too — a suffix-only check passes it and fails at the provider, which is the one
   * outcome this module exists to prevent.
   */
  if (name.split('/').some((segment) => segment.endsWith('.lock'))) {
    return { ok: false, reason: 'Branch names cannot end with .lock — git uses that suffix for its own lock files.' };
  }

  return { ok: true };
}
