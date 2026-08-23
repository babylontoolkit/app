/**
 * Every link this product builds into a git provider's website, pinned (§4.13a).
 *
 * ## Why this file exists at all
 *
 * A URL is the one kind of output that fails ENTIRELY OUTSIDE this codebase. A wrong path shape does
 * not throw, does not log, and does not fail a build — it opens the provider's own 404 in a new tab,
 * which reads to the user as our button being broken (`spec/fail-loud.md`'s "a refusal that names no
 * cause" wearing a menu item's clothes). Nothing in the app can notice, so the tests have to.
 *
 * Three properties carry that weight, and each is a different KIND of assertion:
 *
 *   1. **The two providers differ in path shape** (`/tree/` vs `/-/tree/`), which is the entire reason
 *      the module is a function and not a template literal. Asserted as two literals AND as an
 *      inequality — a helper that silently used one shape for both would satisfy either literal test
 *      on its own provider and only the inequality catches "they collapsed into one".
 *   2. **Branch names legally contain `/`** — `feature/boost-pads` is the most common shape there is.
 *      Asserted by ROUND-TRIP (`new URL` → decode → compare to the original), which is stronger than
 *      pinning a literal: a literal pins today's spelling, a round-trip pins the PROPERTY that the
 *      provider can recover the branch we meant.
 *   3. **`canOpenPullRequest` is a capability answer, not a guess.** Every test here has a control,
 *      because "always false" passes every negative case in this section and hides the button forever.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_ORIGIN,
  branchTreeUrl,
  canOpenPullRequest,
  commitUrl,
  newPullRequestUrl,
  repoUrl,
  type GitProviderId,
} from './provider-urls';

const REPO = 'MackeyK24/kart-racer';

/** The two branch shapes that break naive concatenation, and one that does not (the control). */
const SLASHED = 'feature/boost-pads';
const UNICODE = 'feature/café-🏎';
const PLAIN = 'main';

/**
 * Decode the ref out of a produced URL the way a provider's router would: parse it (which proves it
 * is a legal URL at all), take the path, and decode the segment.
 *
 * ⚠️ Reading `url.pathname` rather than the raw string is deliberate — `new URL` normalises a path,
 * so anything that survives to here is what the provider actually receives.
 */
function refFromTreeUrl(href: string): string {
  const url = new URL(href);
  const segments = url.pathname.split('/');

  return decodeURIComponent(segments[segments.length - 1]);
}

describe('PROVIDER_ORIGIN', () => {
  it('names both providers and nothing else', () => {
    expect(PROVIDER_ORIGIN).toEqual({ github: 'https://github.com', gitlab: 'https://gitlab.com' });
  });
});

describe('repoUrl', () => {
  it('builds the repository page for both providers', () => {
    expect(repoUrl('github', REPO)).toBe('https://github.com/MackeyK24/kart-racer');
    expect(repoUrl('gitlab', REPO)).toBe('https://gitlab.com/MackeyK24/kart-racer');
  });

  /*
   * `repo` is `owner/name`, so its slash is STRUCTURE and must survive raw. This is the one place in
   * the module where encoding would be the bug — the mirror image of every branch rule below.
   */
  it('leaves the owner/name separator raw', () => {
    expect(repoUrl('github', REPO)).toContain('/MackeyK24/kart-racer');
    expect(repoUrl('github', REPO)).not.toContain('%2F');
  });
});

describe('branchTreeUrl', () => {
  /*
   * 🔴 The difference IS the module. GitLab routes every repository-scoped page under `/-/`; GitHub
   * does not. One shape used for both providers is a 404 on whichever one lost, silently.
   */
  it('uses /tree/ on GitHub and /-/tree/ on GitLab', () => {
    expect(branchTreeUrl('github', REPO, PLAIN)).toBe('https://github.com/MackeyK24/kart-racer/tree/main');
    expect(branchTreeUrl('gitlab', REPO, PLAIN)).toBe('https://gitlab.com/MackeyK24/kart-racer/-/tree/main');
  });

  it('never produces the same path shape for both providers', () => {
    const github = new URL(branchTreeUrl('github', REPO, PLAIN)).pathname;
    const gitlab = new URL(branchTreeUrl('gitlab', REPO, PLAIN)).pathname;

    expect(gitlab).not.toBe(github);
    expect(gitlab).toContain('/-/tree/');
    expect(github).not.toContain('/-/');
  });

  /*
   * 🔴 A branch name containing `/` is the single most common shape a real project has. Left raw it
   * reads as two path segments and the provider answers "branch not found" — a broken link that looks
   * like a missing branch, which is why it survives review.
   */
  it.each<GitProviderId>(['github', 'gitlab'])('encodes a slashed branch name and round-trips it (%s)', (provider) => {
    const href = branchTreeUrl(provider, REPO, SLASHED);

    expect(href).toContain('feature%2Fboost-pads');
    expect(href).not.toContain('/feature/boost-pads');
    expect(refFromTreeUrl(href)).toBe(SLASHED);
  });

  it.each<GitProviderId>(['github', 'gitlab'])('encodes a unicode branch name and round-trips it (%s)', (provider) => {
    const href = branchTreeUrl(provider, REPO, UNICODE);

    /* Nothing outside the ASCII URL alphabet may reach the wire. */
    expect(href).toMatch(/^[\x21-\x7e]+$/);
    expect(href).not.toContain('café');
    expect(refFromTreeUrl(href)).toBe(UNICODE);
  });

  /* CONTROL: an ordinary branch is NOT mangled — an "encode everything" bug would pass the two above. */
  it('leaves an ordinary branch name readable', () => {
    expect(branchTreeUrl('github', REPO, PLAIN)).toMatch(/\/tree\/main$/);
  });
});

describe('commitUrl', () => {
  const SHA = '7206ed8712ab34cd';

  it('uses /commit/ on GitHub and /-/commit/ on GitLab', () => {
    expect(commitUrl('github', REPO, SHA)).toBe(`https://github.com/MackeyK24/kart-racer/commit/${SHA}`);
    expect(commitUrl('gitlab', REPO, SHA)).toBe(`https://gitlab.com/MackeyK24/kart-racer/-/commit/${SHA}`);
  });

  it('never produces the same path shape for both providers', () => {
    expect(commitUrl('gitlab', REPO, SHA)).not.toBe(commitUrl('github', REPO, SHA));
  });
});

describe('newPullRequestUrl', () => {
  /*
   * GitHub compares two refs IN THE PATH; GitLab takes the source branch as a QUERY PARAMETER with a
   * bracketed Rails-style name. Neither form is derivable from the other — the reason this is a
   * function rather than one template with a swapped origin.
   */
  it('builds a GitHub compare with the expand flag', () => {
    expect(newPullRequestUrl('github', REPO, 'boost-pads', 'main')).toBe(
      'https://github.com/MackeyK24/kart-racer/compare/main...boost-pads?expand=1',
    );
  });

  it('encodes BOTH refs, including a slashed default branch', () => {
    const href = newPullRequestUrl('github', REPO, SLASHED, 'release/2026');
    const url = new URL(href);
    const [base, head] = url.pathname.split('/compare/')[1].split('...');

    expect(decodeURIComponent(base)).toBe('release/2026');
    expect(decodeURIComponent(head)).toBe(SLASHED);
    expect(url.searchParams.get('expand')).toBe('1');

    /* The `...` separator is structure and must not be swallowed by the encoding of either side. */
    expect(href).toContain('release%2F2026...feature%2Fboost-pads');
  });

  it('builds a GitLab merge-request form with the source branch pre-filled', () => {
    const url = new URL(newPullRequestUrl('gitlab', REPO, 'boost-pads', 'main'));

    expect(url.origin + url.pathname).toBe('https://gitlab.com/MackeyK24/kart-racer/-/merge_requests/new');

    /*
     * 🔴 Asserted through `searchParams`, not against our own spelling of the query string: this is
     * the parse a browser and GitLab both perform, so it proves the parameter NAME survives whatever
     * we did to the brackets — which pinning the literal cannot.
     */
    expect(url.searchParams.get('merge_request[source_branch]')).toBe('boost-pads');
  });

  it.each<[GitProviderId, string]>([
    ['github', SLASHED],
    ['gitlab', SLASHED],
    ['github', UNICODE],
    ['gitlab', UNICODE],
  ])('round-trips a %s change-request branch (%s)', (provider, branch) => {
    const url = new URL(newPullRequestUrl(provider, REPO, branch, 'main'));

    const recovered =
      provider === 'gitlab'
        ? url.searchParams.get('merge_request[source_branch]')
        : decodeURIComponent(url.pathname.split('...')[1]);

    expect(recovered).toBe(branch);
  });

  /*
   * ⚠️ HONEST NOTE ON WHAT THIS ONE IS AND IS NOT.
   *
   * `%5B`/`%5D` is what the module emits, and it is the correct RFC 3986 spelling for a query — but
   * raw `[`/`]` also works: `new URL` does NOT normalise them, and `searchParams.get()` finds the
   * parameter either way (verified). So the round-trip test above cannot see the difference, and this
   * assertion is the only one that can. It is therefore a CONSISTENCY pin on the module's declared
   * contract ("the brackets must survive encoding"), not a correctness pin — recorded as such so a
   * future reader does not mistake it for evidence that raw brackets are broken.
   */
  it('percent-encodes the bracketed parameter name', () => {
    expect(newPullRequestUrl('gitlab', REPO, 'boost-pads', 'main')).toContain(
      '?merge_request%5Bsource_branch%5D=boost-pads',
    );
  });
});

describe('canOpenPullRequest', () => {
  /*
   * 🔴 Offered only when it can WORK. Both refusals below open an EMPTY compare on the provider's own
   * site — a page that looks like our feature failed rather than like a request that made no sense.
   */
  it('refuses on the default branch — there is nothing to compare against', () => {
    expect(canOpenPullRequest({ branch: 'main', defaultBranch: 'main', lastSyncedCommitSha: 'abc123' })).toBe(false);
  });

  it('refuses a branch that has never been pushed — the provider has no such ref', () => {
    expect(canOpenPullRequest({ branch: 'boost-pads', defaultBranch: 'main', lastSyncedCommitSha: undefined })).toBe(
      false,
    );
  });

  it('refuses when there is no branch at all', () => {
    expect(canOpenPullRequest({ branch: undefined, defaultBranch: 'main', lastSyncedCommitSha: 'abc123' })).toBe(false);
  });

  /*
   * 🔴 THE CONTROL. Without it every assertion in this describe passes for a function that returns
   * `false` unconditionally — i.e. for a button that has silently ceased to exist.
   */
  it('offers a pushed non-default branch', () => {
    expect(canOpenPullRequest({ branch: 'boost-pads', defaultBranch: 'main', lastSyncedCommitSha: 'abc123' })).toBe(
      true,
    );
  });

  /*
   * 🔴 `defaultBranch: undefined` means WE COULD NOT ASK, and it disables THAT RULE ONLY — it never
   * becomes a guessed `'main'`. The distinction is `mount-source.ts`'s `null`-vs-`undefined` one: a
   * guess here hides the button on a real feature branch of a `master`-trunked repository, and offers
   * it on the trunk of a `main`-trunked one. Both are wrong, and neither throws.
   */
  it('does not guess "main" when the default branch is unknown', () => {
    expect(canOpenPullRequest({ branch: 'main', defaultBranch: undefined, lastSyncedCommitSha: 'abc123' })).toBe(true);
  });

  it('still requires a push when the default branch is unknown', () => {
    expect(canOpenPullRequest({ branch: 'main', defaultBranch: undefined, lastSyncedCommitSha: undefined })).toBe(
      false,
    );
  });
});

/**
 * ## The source scan
 *
 * The module is only worth having if the chip actually uses it. A second `PROVIDER_ORIGIN` in a
 * component is not a duplicate constant, it is a second definition of where the user's code lives —
 * the `isSecretPath` "one rule, one place" lesson, and the failure is a broken link nothing logs.
 *
 * ⚠️ **Scoped to `app/components/header/` on purpose — the whole directory, and no wider.** A
 * repo-wide scan for these origins is pure noise: ~31 files legitimately name `https://github.com` /
 * `https://gitlab.com` as API bases, OAuth endpoints, clone URLs and documentation links
 * (`.server/git/oauth.ts`, `gitlabApiService.ts`, the connection panels, `StarterTemplates.tsx`, …).
 * A scan whose failures are mostly false is a scan someone silences with an allow-list entry, which
 * is worse than no scan.
 *
 * But the header directory contains ZERO legitimate provider origins, so covering all of it costs
 * nothing and buys the thing a chip-only scan cannot: §4.13a T19 adds SIBLING components under
 * `header/branch/`, and the defect this guard exists for — a second definition of where the user's
 * code lives — is likelier in a new file than in the one that was just cleaned. A guard fitted to the
 * file somebody already fixed is the `outbound-auth` sweep's mistake, where routes named after
 * vendors were guarded and routes named after subsystems shipped anonymous for a year behind 21
 * green assertions.
 */
/** Every file under a directory, recursively. Small and local — no dependency for six lines. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

/**
 * 🔴 AN UNKNOWN DEFAULT BRANCH IS NOT `main`.
 *
 * `canOpenPullRequest` deliberately keeps the action OFFERED when the default branch could not be
 * read — "we could not ask" disables that rule rather than inventing an answer. A caller that then
 * wrote `defaultBranch ?? 'main'` into the URL would put the guess back one layer down, and on a
 * `master`-trunked repository the user would land on the empty compare page the predicate exists to
 * prevent. The predicate and the URL builder have to refuse the guess together or neither refusal
 * means anything.
 *
 * GitHub's one-ref form compares against the repository's OWN default, so the honest answer is to let
 * the provider supply it.
 */
describe('the change-request URL never guesses a default branch', () => {
  it('omits the base ref entirely when the default is unknown', () => {
    const url = newPullRequestUrl('github', 'octocat/kart', 'feature/boost-pads');

    expect(url).toBe('https://github.com/octocat/kart/compare/feature%2Fboost-pads?expand=1');
    expect(url).not.toContain('main');
    expect(url).not.toContain('...');
  });

  /* CONTROL: a KNOWN default is still used, so "omit it" is not the whole rule. */
  it('CONTROL — uses the default when we actually know it', () => {
    expect(newPullRequestUrl('github', 'octocat/kart', 'feature/boost-pads', 'master')).toBe(
      'https://github.com/octocat/kart/compare/master...feature%2Fboost-pads?expand=1',
    );
  });

  /* GitLab never carried a base ref, so its URL must be unchanged either way. */
  it('GitLab is unaffected — it defaults the target itself', () => {
    expect(newPullRequestUrl('gitlab', 'octocat/kart', 'feature/boost-pads')).toBe(
      newPullRequestUrl('gitlab', 'octocat/kart', 'feature/boost-pads', 'master'),
    );
  });
});

describe('GitStatusChip builds no URL of its own', () => {
  const RAW = readFileSync(join(process.cwd(), 'app/components/header/GitStatusChip.client.tsx'), 'utf8');

  /*
   * Comments are documentation, not behaviour — and here that is load-bearing in BOTH directions: the
   * file's own comments explain the move by naming `PROVIDER_ORIGIN` and the old concatenation. An
   * unstripped scan would fail on the explanation of the fix.
   */
  const CHIP = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /*
   * CONTROLS — a scanner that silently matches nothing reports a clean bill of health forever. One
   * proves the stripped source is still real code, the other proves a miss is a real miss.
   */
  it('the scanner reads real code (control)', () => {
    expect(CHIP).toContain('TOOLBAR_MENU_ITEM');
    expect(CHIP).toContain('DropdownMenu.Root');
    expect(CHIP).not.toContain('ThisSymbolDoesNotExistAnywhere');
  });

  it('the comment strip removed the prose that names the old constant (control)', () => {
    expect(RAW).toContain('PROVIDER_ORIGIN');
    expect(CHIP).not.toContain('PROVIDER_ORIGIN');
  });

  it('holds no provider origin literal', () => {
    expect(CHIP).not.toContain('https://github.com');
    expect(CHIP).not.toContain('https://gitlab.com');
  });

  /**
   * ...and neither does anything else in the header, INCLUDING files that do not exist yet.
   *
   * The directory is walked rather than listed, so a component added by T19 is covered on the day it
   * lands rather than on the day someone remembers to add it here.
   */
  it('no file in the header directory holds one either', () => {
    const dir = join(process.cwd(), 'app/components/header');
    const files = walk(dir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.spec.tsx') && !f.endsWith('.spec.ts'));

    // The CONTROL: a walk that finds nothing asserts nothing, forever.
    expect(files.length).toBeGreaterThan(3);

    const offenders = files.filter((file) => {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

      return code.includes('https://github.com') || code.includes('https://gitlab.com');
    });

    expect(offenders.map((f) => f.replace(process.cwd() + '/', ''))).toEqual([]);
  });

  it('imports its links from the one module', () => {
    expect(CHIP).toContain("from '~/lib/git/provider-urls'");
    expect(CHIP).toContain('branchTreeUrl');
    expect(CHIP).toContain('repoUrl');
  });

  /* Branch-aware: opening the repository root shows whichever branch the provider defaults to. */
  it('opens the branch the user is looking at', () => {
    expect(CHIP).toContain('branchTreeUrl(providerToUse, repo.repo!, repo.branch)');
  });
});
