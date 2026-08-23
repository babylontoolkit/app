/**
 * Branch-name validation (SPEC §4.13, `spec/fail-loud.md`).
 *
 * The property under test is NOT "does it refuse" — it is "does it say WHICH RULE was broken". A
 * validator that returns `ok: false` for every bad shape passes any test written against `ok` alone
 * while being exactly the failure `build-failure.ts` records: a refusal that names no cause is read as
 * the button being broken, so the user files a bug against the feature instead of fixing their typo.
 *
 * So every refusal case below asserts its OWN sentence, and the highest-value assertion in the file is
 * the distinctness one — collapsing all the reasons to a single string is a one-line edit that reads
 * like a tidy-up, and only a set-level assertion notices it.
 *
 * ⚠️ ORDER IS PART OF THE BEHAVIOUR (`validateBranchName`'s own comment says so): the function returns
 * the FIRST broken rule, so each fixture here breaks EXACTLY ONE rule. A fixture that trips two rules
 * pins the order rather than the sentence, and would keep passing after the rule it names was deleted.
 */
import { describe, expect, it } from 'vitest';
import { MAX_BRANCH_NAME, validateBranchName } from './branch-name';

/** Narrowing helper — a refusal's `reason` is only on the `ok: false` arm. */
function reasonFor(name: string): string {
  const result = validateBranchName(name);

  if (result.ok) {
    throw new Error(`expected ${JSON.stringify(name)} to be REFUSED, but it was accepted`);
  }

  return result.reason;
}

/**
 * Every refused shape, one rule each.
 *
 * This table drives both the per-rule sentence assertions and the distinctness assertion, so a rule
 * added to the implementation without a row here is a rule with no sentence test — and one added here
 * with a fixture that breaks a second rule shows up immediately as a duplicated reason.
 */
const REFUSALS: ReadonlyArray<{ what: string; name: string; says: RegExp }> = [
  { what: 'an empty name', name: '', says: /^Enter a branch name\.$/ },
  { what: 'a name past the length cap', name: 'a'.repeat(MAX_BRANCH_NAME + 1), says: /cannot be longer than 255/ },
  { what: 'a space', name: 'my branch', says: /cannot contain spaces/ },

  /*
   * Written as a \u escape, NEVER as a literal control character: a literal one is INVISIBLE in the
   * source, so a later edit can delete it and nothing looks different — the exact trap
   * `build-failure.ts` records for its ANSI strip, and the reason the implementation tests by code
   * point rather than with a regex literal.
   */
  { what: 'a control character', name: 'feature\u0001x', says: /cannot contain control characters/ },

  { what: 'a tilde', name: 'feature~1', says: /cannot contain ~ — git reserves it/ },
  { what: 'a caret', name: 'feature^1', says: /cannot contain \^ — git reserves it/ },
  { what: 'a colon', name: 'feature:boost', says: /cannot contain : — git reserves it/ },
  { what: 'a question mark', name: 'feature?', says: /cannot contain \? — git reserves it/ },
  { what: 'an asterisk', name: 'feature*', says: /cannot contain \* — git reserves it/ },
  { what: 'an open bracket', name: 'feature[1]', says: /cannot contain \[ — git reserves it/ },
  { what: 'a backslash', name: 'feature\\boost', says: /cannot contain \\ — git reserves it/ },

  { what: 'reflog syntax', name: 'main@{1}', says: /cannot contain @\{ — git reads it as reflog syntax/ },
  { what: 'a bare @', name: '@', says: /cannot be named @ on its own/ },
  { what: 'a commit range', name: 'feature..fix', says: /cannot contain \.\. — git reads it as a commit range/ },
  { what: 'a leading hyphen', name: '-x', says: /cannot start with a hyphen/ },
  { what: 'the refs/ prefix', name: 'refs/heads/x', says: /Leave off the refs\/ prefix/ },
  { what: 'a leading slash', name: '/x', says: /cannot start or end with a slash/ },
  { what: 'an empty section', name: 'a//b', says: /cannot contain an empty section between slashes/ },
  { what: 'a .lock suffix', name: 'x.lock', says: /cannot end with \.lock/ },
];

describe('validateBranchName — every refusal names the rule that was broken', () => {
  for (const { what, name, says } of REFUSALS) {
    it(`refuses ${what} and says so`, () => {
      expect(reasonFor(name)).toMatch(says);
    });
  }

  /*
   * A trailing slash shares the leading-slash sentence BY DESIGN (one rule, two ends), so it lives
   * outside the table — the table's rows must stay one-reason-each for the distinctness assertion.
   */
  it('refuses a trailing slash with the same edge-slash sentence', () => {
    expect(reasonFor('x/')).toMatch(/cannot start or end with a slash/);
  });

  /*
   * 🔴 THE ASSERTION THE WHOLE FILE EXISTS FOR. Collapsing every `reason:` to one string ("Invalid
   * branch name.") is a plausible-looking simplification that silently restores the guess-what-you-did
   * failure. The per-rule tests above each catch that particular edit — but a future rule added with a
   * copy-pasted sibling's sentence trips ONLY this one.
   */
  it('gives every rule a DISTINCT sentence — no two refusals read the same', () => {
    const reasons = REFUSALS.map(({ name }) => reasonFor(name));

    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it('never returns an empty or placeholder reason', () => {
    for (const { name } of REFUSALS) {
      const reason = reasonFor(name);

      expect(reason.length).toBeGreaterThan(10);
      expect(reason).not.toMatch(/^invalid/i);
    }
  });
});

/**
 * The controls.
 *
 * Without these the whole suite passes for a validator that refuses EVERYTHING — the cheap way to make
 * a validation spec go green while making the feature unusable. `/` and `.` are both legal in a ref
 * name and both look suspicious next to the rules above, so they are the two most likely to be
 * over-refused by a future tightening.
 */
describe('validateBranchName — legal names are ACCEPTED (controls)', () => {
  it('accepts a namespaced name containing a slash', () => {
    expect(validateBranchName('feature/boost-pads')).toEqual({ ok: true });
  });

  it('accepts dots that are not a commit range', () => {
    expect(validateBranchName('v1.2.x')).toEqual({ ok: true });
  });

  it('accepts ordinary names', () => {
    for (const name of ['main', 'master', 'fix-lap-timer', 'release/1.0', 'user/mackey/wip', '2026-08-21']) {
      expect(validateBranchName(name), name).toEqual({ ok: true });
    }
  });
});

/**
 * The cap, asserted in BOTH directions.
 *
 * A name AT the cap is legal — the implementation's comment says the check is `>` and not `>=`, and
 * this is the test it points at. Only asserting the refusal ABOVE the cap passes for `>=`, which
 * refuses a name the filesystem can hold, for a reason the user cannot act on (they are told 255 is
 * the limit while a 255-character name is rejected).
 */
describe('validateBranchName — the length boundary', () => {
  it('accepts a name of EXACTLY MAX_BRANCH_NAME characters', () => {
    expect(validateBranchName('a'.repeat(MAX_BRANCH_NAME))).toEqual({ ok: true });
  });

  it('refuses one character past the cap and names both numbers', () => {
    const reason = reasonFor('a'.repeat(MAX_BRANCH_NAME + 1));

    expect(reason).toContain(String(MAX_BRANCH_NAME));
    expect(reason).toContain(String(MAX_BRANCH_NAME + 1));
  });
});

/**
 * `.lock` is refused PER SEGMENT, not only at the end of the whole name.
 *
 * Git forbids the suffix on any path component, so `hotfix.lock/urgent` is illegal even though the
 * name does not end in `.lock`. A whole-name `endsWith` check accepts it here and fails at the
 * provider — precisely the outcome this module exists to prevent (a round trip that refuses with
 * somebody else's sentence, or a branch that is simply never created).
 */
describe('validateBranchName — .lock is a per-segment rule', () => {
  it('refuses .lock on a MIDDLE segment, not just the last one', () => {
    expect(reasonFor('hotfix.lock/urgent')).toMatch(/cannot end with \.lock/);
  });

  it('still refuses .lock on the last segment', () => {
    expect(reasonFor('feature/x.lock')).toMatch(/cannot end with \.lock/);
  });

  it('accepts a segment that merely CONTAINS lock', () => {
    expect(validateBranchName('feature/locksmith')).toEqual({ ok: true });
    expect(validateBranchName('feature/lockfile-work')).toEqual({ ok: true });
  });
});

/**
 * Order-dependency, pinned deliberately.
 *
 * A tab breaks two rules (it is whitespace AND a control character) and the user sees only the first
 * sentence. Whitespace wins on purpose — "cannot contain spaces" is a fix the user can make, where
 * "cannot contain control characters" sends them looking for something invisible. Reordering the
 * checks silently changes which advice a real typo gets, so it is asserted rather than left to luck.
 */
describe('validateBranchName — which sentence a multi-rule name gets', () => {
  it('reports whitespace, not control characters, for a tab', () => {
    expect(reasonFor('my\tbranch')).toMatch(/cannot contain spaces/);
  });

  it('reports the length cap before anything the long name also breaks', () => {
    expect(reasonFor(`refs/${'a'.repeat(MAX_BRANCH_NAME)}`)).toMatch(/cannot be longer than/);
  });
});
