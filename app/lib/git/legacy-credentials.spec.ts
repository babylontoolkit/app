// @vitest-environment jsdom
/**
 * Reaping the credential cookie the retired browser-side clone left behind (T10, SPEC §4.13, §5).
 *
 * Two subjects, and they fail in opposite directions:
 *
 * 1. `clearLegacyGitCredentialCookies` — the reaper. It must match the `git:` PREFIX rather than a
 *    list of hosts (the self-hosted `git:git.example.com` is the case most likely to hold a long-lived
 *    token, and it is exactly the one a host allow-list forgets), and it must never eat a cookie that
 *    merely LOOKS related — `gitlab_something`, `git_hub`, `bolt_theme`. Both halves are silent: the
 *    first leaves a plaintext PAT readable by every script on the origin, the second deletes state the
 *    product depends on. It must also never throw — it runs at app start, and a browser that refuses
 *    cookie access must not take the application down over a cleanup.
 *
 * 2. A default-deny SOURCE SCAN over the clone path, pinning T10's acceptance clause: no `window.prompt`
 *    remains anywhere on it. Comments are STRIPPED before matching, for the reason `no-client-token.spec.ts`
 *    records — these files DOCUMENT the removed credential path by name, and a gate that fires on the
 *    explanation forces the next person to delete the warning to get green. The scan carries CONTROLS,
 *    per `no-server-storage.spec.ts`: a scanner that silently matches nothing reports a clean bill of
 *    health forever.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Cookies from 'js-cookie';
import { clearLegacyGitCredentialCookies, LEGACY_GIT_COOKIE_PREFIX } from './legacy-credentials';

/** Wipe every cookie jsdom is holding, so one test's fixtures cannot decide another's outcome. */
const wipeCookies = () => {
  for (const name of Object.keys(Cookies.get() ?? {})) {
    Cookies.remove(name);
    Cookies.remove(name, { path: '/' });
  }
};

describe('clearLegacyGitCredentialCookies', () => {
  afterEach(() => {
    wipeCookies();
  });

  it('removes a git:<domain> cookie and reports its name', () => {
    Cookies.set('git:github.com', JSON.stringify({ username: 'someone', password: 'ghp_aRealLookingToken' }));

    expect(Cookies.get('git:github.com')).toBeDefined();

    const removed = clearLegacyGitCredentialCookies();

    expect(removed).toEqual(['git:github.com']);
    expect(Cookies.get('git:github.com')).toBeUndefined();
  });

  /**
   * 🔴 The prefix rule, not a host list. `git:git.example.com` is a self-hosted GitLab/Gitea — the
   * host nobody enumerates, and the one whose PAT is least likely to have been rotated.
   */
  it('removes every host, including a self-hosted one nobody would have enumerated', () => {
    Cookies.set('git:github.com', '{"username":"a","password":"p"}');
    Cookies.set('git:gitlab.com', '{"username":"b","password":"p"}');
    Cookies.set('git:git.example.com', '{"username":"c","password":"p"}');

    const removed = clearLegacyGitCredentialCookies();

    expect(removed.sort()).toEqual(['git:git.example.com', 'git:github.com', 'git:gitlab.com']);

    for (const name of ['git:github.com', 'git:gitlab.com', 'git:git.example.com']) {
      expect(Cookies.get(name)).toBeUndefined();
    }
  });

  /**
   * The control. A sloppy `/git/`-ish match would eat `gitlab_something` and `git_hub`; deleting
   * unrelated state at app start is the loud half of getting this wrong, and `bolt_theme` is real.
   */
  it('leaves every cookie that does not carry the prefix alone', () => {
    Cookies.set('bolt_theme', 'dark');
    Cookies.set('gitlab_something', 'keep-me');
    Cookies.set('git_hub', 'keep-me-too');
    Cookies.set('githubtoken', 'not-ours');
    Cookies.set('git:github.com', '{"username":"a","password":"p"}');

    const removed = clearLegacyGitCredentialCookies();

    expect(removed).toEqual(['git:github.com']);
    expect(Cookies.get('bolt_theme')).toBe('dark');
    expect(Cookies.get('gitlab_something')).toBe('keep-me');
    expect(Cookies.get('git_hub')).toBe('keep-me-too');
    expect(Cookies.get('githubtoken')).toBe('not-ours');
  });

  it('returns [] and does not throw when there are no cookies at all', () => {
    expect(Cookies.get()).toEqual({});
    expect(() => clearLegacyGitCredentialCookies()).not.toThrow();
    expect(clearLegacyGitCredentialCookies()).toEqual([]);
  });

  /**
   * The hardened-browser case the module documents: a profile or a sandboxed iframe where reading
   * cookies throws. The reaper runs from the app-init effect at the root, so a throw here is a blank
   * page for a user whose only crime is a locked-down browser.
   */
  it('returns [] and does not throw when the cookie jar itself refuses to be read', () => {
    const original = Cookies.get;

    Object.defineProperty(Cookies, 'get', {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error('SecurityError: cookies are blocked in this context');
      },
    });

    try {
      expect(() => clearLegacyGitCredentialCookies()).not.toThrow();
      expect(clearLegacyGitCredentialCookies()).toEqual([]);
    } finally {
      Object.defineProperty(Cookies, 'get', { configurable: true, writable: true, value: original });
    }
  });

  it('exports the prefix it matches on, so the root caller and this spec cannot drift', () => {
    expect(LEGACY_GIT_COOKIE_PREFIX).toBe('git:');
  });
});

/**
 * T10 acceptance: "no `window.prompt` remains anywhere on any clone path", and nothing on it writes a
 * `git:` credential cookie ever again. Default-deny over the enumerated doors.
 */
/**
 * 🔴 THE REAPER IS WIRED, WHICH IS A DIFFERENT CLAIM FROM "THE REAPER WORKS".
 *
 * T10's acceptance is *"a pre-existing `git:github.com` cookie is gone after one page load"* — a
 * WIRING claim. Every test above proves the function does its job when called; deleting the one line
 * in `root.tsx` that calls it left the entire 4,507-test suite green, so the cookie would have stayed
 * in every user's browser with nothing anywhere reporting it. That is the same species as the §4.1a
 * lesson: a rule that cannot fail is a rule nobody is keeping.
 *
 * It is asserted at the source, not by rendering the root: `App`'s effect also boots the debug logger
 * and the monitoring client, so a render harness here would be testing the harness. What matters is
 * that the call exists in the one component that runs for every user on every load.
 */
describe('the app root actually runs the reaper', () => {
  it('imports and calls clearLegacyGitCredentialCookies', async () => {
    const source = await fs.readFile(path.resolve(process.cwd(), 'app/root.tsx'), 'utf8');

    // CONTROL: the file was really read, so "it matched" cannot be an artefact of an empty string.
    expect(source.length).toBeGreaterThan(1000);

    expect(source).toMatch(/import\s*\{[^}]*clearLegacyGitCredentialCookies[^}]*\}\s*from\s*['"][^'"]*legacy-cred/);
    expect(source).toMatch(/clearLegacyGitCredentialCookies\s*\(\s*\)/);
  });
});

describe('the clone path asks the user for no credential', () => {
  /* Comment-stripped, per `no-client-token.spec.ts`: these files describe the removed flow BY NAME. */
  const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  const CLONE_PATH = [
    'app/lib/hooks/useGit.ts',
    'app/lib/git/import-repository.ts',
    'app/lib/persistence/projects.ts',
    'app/components/chat/GitCloneButton.tsx',
    'app/components/git/GitUrlImport.client.tsx',
  ];

  const read = async (file: string) => fs.readFile(path.resolve(process.cwd(), file), 'utf8');

  /** Every `.ts`/`.tsx` under a directory, recursively. */
  async function listSourceFiles(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const found: string[] = [];

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        found.push(...(await listSourceFiles(full)));
      } else if (/\.tsx?$/.test(entry.name)) {
        found.push(full);
      }
    }

    return found;
  }

  /** A dialog that asks a human for a secret, and any write of the cookie one used to land in. */
  const FORBIDDEN: Array<[string, RegExp]> = [
    ['a prompt() dialog', /(?<![.\w])prompt\s*\(/],
    ['a confirm() dialog', /(?<![.\w])confirm\s*\(/],
    ['a window.prompt/confirm dialog', /window\s*\.\s*(prompt|confirm)\s*\(/],
    ['a git: credential cookie write', /Cookies\s*\.\s*set\s*\(\s*['"`]git:|\.set\s*\(\s*`git:\$\{/],
  ];

  it.each(CLONE_PATH)('%s contains no credential dialog and writes no git: cookie', async (file) => {
    const source = stripComments(await read(file));

    // The scan must have something to scan — an unreadable/empty file would otherwise pass forever.
    expect(source.trim().length).toBeGreaterThan(200);

    for (const [what, pattern] of FORBIDDEN) {
      expect(source, `${file} still contains ${what}`).not.toMatch(pattern);
    }
  });

  /**
   * CONTROL 1 — the scanner still matches. Without this, a regex that silently matches nothing gives
   * every file above a clean bill of health forever.
   */
  it('the patterns detect the very code they are meant to forbid', () => {
    const fixture = stripComments(`
      const user = prompt('Enter username');
      if (confirm('Save credentials?')) {
        Cookies.set('git:github.com', JSON.stringify({ username: user, password: pat }));
      }
      window.prompt('again');
    `);

    for (const [what, pattern] of FORBIDDEN) {
      expect(fixture, `the ${what} pattern matched nothing`).toMatch(pattern);
    }
  });

  /**
   * CONTROL 2 — the comment-stripping property. `useGit.ts` documents the removed `prompt()`/`confirm()`
   * path in prose on purpose; the gate must read the CODE. If this ever fails, the next person's cheapest
   * route to green is deleting the warning, which is how the flow comes back.
   */
  it('does not fire on a credential dialog that appears only inside a comment', () => {
    const commentedOut = stripComments(`
      /* onAuth used to confirm() and then prompt() for a personal access token. */
      // Cookies.set('git:github.com', pair) wrote it in plaintext.
      const onAuth = () => ({ cancel: true });
    `);

    for (const [, pattern] of FORBIDDEN) {
      expect(commentedOut).not.toMatch(pattern);
    }
  });

  /** CONTROL 3 — the files really were read (a typo'd path would otherwise scan an exception away). */
  it('reads non-empty sources for every file it claims to cover', async () => {
    const sizes = await Promise.all(CLONE_PATH.map(async (file) => (await read(file)).length));

    expect(sizes.every((size) => size > 200)).toBe(true);
    expect(sizes).toHaveLength(5);
  });

  /**
   * 🔴 AND THE SAME QUESTION ASKED OVER THE WHOLE TREE, because `CLONE_PATH` is an enumeration.
   *
   * A list of files is a list of the doors somebody thought of — the exact shape that let a third
   * clone door walk past two versions of the overlay gate (§4.4a). `prompt()` is the one pattern that
   * can be asked globally with a hard zero: this product never asks a human for a secret in a browser
   * dialog, on ANY path, so a new file introducing one fails here without anyone remembering to list
   * it. (`confirm()` cannot be — it legitimately guards destructive actions in the deploy and settings
   * panels — so it stays scoped to the clone path above.)
   *
   * ⚠️ SHIPPED source only. Specs are excluded because a spec's whole job here is to CONTAIN the
   * forbidden pattern — the two controls above are fixtures full of `prompt(` — and because a test
   * NAME may say the word in prose ("neither the user prompt (`1-`) nor…"), which is neither code nor
   * shipped. Excluded by suffix, and the exclusion is narrow enough to state: nothing under `app/`
   * that a user's browser ever executes is exempt.
   */
  it('no shipped file anywhere in app/ opens a prompt() dialog', async () => {
    const files = (await listSourceFiles(path.resolve(process.cwd(), 'app'))).filter(
      (file) => !/\.spec\.tsx?$/.test(file),
    );

    const sources = await Promise.all(
      files.map(async (file) => ({ file, code: stripComments(await fs.readFile(file, 'utf8')) })),
    );

    // CONTROL: the sweep genuinely walked the tree, so "no matches" cannot mean "nothing was read".
    expect(sources.length).toBeGreaterThan(300);

    const offenders = sources
      .filter(({ code }) => /(?<![.\w])prompt\s*\(/.test(code))
      .map(({ file }) => path.relative(process.cwd(), file));

    expect(offenders).toEqual([]);
  });
});
