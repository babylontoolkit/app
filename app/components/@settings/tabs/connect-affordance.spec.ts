/**
 * A "connect" control must be able to CONNECT (SPEC §4.1a, §4.13).
 *
 * Both repository pickers shipped the same dead end: told "Please connect to GitHub first to browse
 * repositories", the user got exactly one button — `Refresh Connection` — wired to
 * `window.location.reload()`. A reload cannot create an OAuth connection, so the page came back with
 * the identical sentence and no explanation. The user presses the only control on screen, nothing
 * happens, and the natural conclusion is that they did something wrong or the button is broken.
 *
 * This is the `build-failure.ts` lesson on a different surface — a refusal that names no route
 * forward reads as the product being broken — and §4.1a's rule about permanently-disabled menu rows
 * ("a dead end, not a roadmap") is the same rule again. `startGitConnect` already existed and was
 * already the single writer used by the git chip and the divergence dialog; these two screens simply
 * never called it.
 *
 * A source scan rather than a render test on purpose: these are the empty states of two components
 * that boot connection hooks and a stats fetcher, so rendering them is most of a browser. What can
 * regress is textual and local — someone reaching for `window.location.reload()` again because it
 * looks like "refresh" — and that is exactly what a scan sees.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/** Comments here DESCRIBE the retired reload, so prose must never satisfy an assertion about it. */
const stripComments = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const SELECTORS = {
  GitHub: {
    path: 'app/components/@settings/tabs/github/components/GitHubRepositorySelector.tsx',
    provider: 'github',
  },
  GitLab: {
    path: 'app/components/@settings/tabs/gitlab/components/GitLabRepositorySelector.tsx',
    provider: 'gitlab',
  },
};

describe('the disconnected state of a repository picker', () => {
  it('scanner control: it reads the files and comment prose is stripped', () => {
    for (const { path } of Object.values(SELECTORS)) {
      const raw = read(path);

      expect(raw, `${path} must exist and be non-trivial`).toContain('RepositorySelector');

      // The doc comments above the fix mention the retired call; the scan must not see them.
      expect(stripComments(raw)).not.toContain('a reload can never make a connection');
    }
  });

  it.each(Object.entries(SELECTORS))('%s offers a control that starts OAuth', (_name, { path, provider }) => {
    const source = stripComments(read(path));

    expect(source, 'the picker must import the single connect writer').toContain('startGitConnect');
    expect(source, `it must connect to ${provider}, not to whichever provider was typed first`).toContain(
      `startGitConnect('${provider}')`,
    );
  });

  it.each(Object.entries(SELECTORS))('%s never offers a reload as the way to connect', (_name, { path }) => {
    /*
     * The specific regression. `window.location.reload()` elsewhere in one of these files would be a
     * different question, but neither has one — so the flat rule is both accurate and the strongest
     * available. If a legitimate reload is ever needed here, narrow this to the empty-state block
     * rather than deleting it.
     */
    expect(stripComments(read(path))).not.toContain('window.location.reload()');
  });

  it.each(Object.entries(SELECTORS))('%s labels the button with the action it performs', (_name, { path }) => {
    const source = stripComments(read(path));

    /*
     * "Refresh Connection" described the implementation (a reload) rather than the outcome, which is
     * how a dead end survives review: the label was honest about the code and useless to the reader.
     */
    expect(source).not.toContain('Refresh Connection');
    expect(source).toMatch(/Connect to Git(Hub|Lab)/);
  });
});
