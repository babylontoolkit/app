// @vitest-environment jsdom
/**
 * THE CLONE BUTTON — THE WIRING (T7).
 *
 * `~/lib/git/import-repository.spec.ts` proves the OPERATION (phases, rollback, settle profile, the
 * hand-off). This file proves the button is wired to it, which is the half no pure test can see — and
 * this repo has already been caught by exactly that gap once (`applyCreationDraft`'s options object was
 * forwarded correctly everywhere except at the one call site, and only a wiring spec found it).
 *
 * 🔴 The specific regression it exists for: **the branch.** Both selectors open a branch picker before
 * calling back and have ALWAYS passed the chosen branch as a second argument — and this handler ignored
 * it for as long as it existed, so picking `develop` cloned `main`. A silent wrong answer, from a UI
 * that had already asked the right question. It was fixed by adding one parameter, which means it can
 * be un-fixed by deleting one argument, in a component the module-level tests do not render.
 *
 * The provider is the same shape of bug pointing at a different wall: a GitLab repository imported as
 * GitHub resolves the wrong token against the wrong host.
 *
 * The selectors are stubbed down to a button that fires `onClone(url, branch)` — the point is what
 * `GitCloneButton` does with the callback, not how a repository list paginates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const seams = vi.hoisted(() => ({
  importRepositoryIntoWorkspace: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('~/lib/git/import-repository', () => ({
  importRepositoryIntoWorkspace: seams.importRepositoryIntoWorkspace,
}));

vi.mock('react-toastify', () => ({ toast: { error: seams.toastError, success: vi.fn() } }));

/*
 * Each selector stub renders ONE button per provider, and the two are distinguishable — so a test that
 * drives the GitLab door and gets `provider: 'github'` fails rather than quietly passing on a shared
 * fixture. `handleBranchSelect` in the real components calls `onClone(url, branch)`; that is the exact
 * contract reproduced here, including the branch being the SECOND argument.
 */
vi.mock('~/components/@settings/tabs/github/components/GitHubRepositorySelector', () => ({
  GitHubRepositorySelector: ({ onClone }: { onClone?: (url: string, branch?: string) => void }) => (
    <button type="button" onClick={() => onClone?.('https://github.com/octocat/Hello-World.git', 'develop')}>
      pick-github-repo
    </button>
  ),
}));

vi.mock('~/components/@settings/tabs/gitlab/components/GitLabRepositorySelector', () => ({
  GitLabRepositorySelector: ({ onClone }: { onClone?: (url: string, branch?: string) => void }) => (
    <button type="button" onClick={() => onClone?.('https://gitlab.com/group/sub/thing.git', 'trunk')}>
      pick-gitlab-repo
    </button>
  ),
}));

import GitCloneButton from './GitCloneButton';

/** The identity that matters — the component must hand THIS through, not a wrapper of its own. */
const importChat = vi.fn(async () => Promise.resolve());

/** Open the dialog, choose a provider, and let its selector fire `onClone`. */
async function driveClone(provider: 'github' | 'gitlab') {
  render(<GitCloneButton importChat={importChat} />);

  fireEvent.click(screen.getByTitle('Clone a repo'));
  fireEvent.click(screen.getByText(provider === 'github' ? 'GitHub' : 'GitLab'));
  fireEvent.click(screen.getByText(`pick-${provider}-repo`));

  // Let the handler's awaits flush before anything is asserted.
  await vi.waitFor(() => expect(seams.importRepositoryIntoWorkspace).toHaveBeenCalled());

  return seams.importRepositoryIntoWorkspace.mock.calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  seams.importRepositoryIntoWorkspace.mockResolvedValue({ ok: true });
});

afterEach(cleanup);

describe('GitCloneButton is wired to the one import path', () => {
  /**
   * The regression this file exists for. `branch` is a plain second argument, so deleting it compiles,
   * lints, and passes every module-level test — the failure is a repository cloned at the wrong commit,
   * reported by nothing.
   */
  it('forwards the BRANCH the selector chose, not a guess', async () => {
    const call = await driveClone('github');

    expect(call).toMatchObject({ repo: 'https://github.com/octocat/Hello-World.git', branch: 'develop' });
  });

  /**
   * The provider the user picked, captured before the dialog resets.
   *
   * GitLab is the interesting direction: `github` is the default everywhere in this codebase, so a
   * dropped provider looks correct on the GitHub path and resolves the wrong token on the GitLab one.
   * Driving both is what makes the assertion capable of failing.
   */
  it.each([
    ['github', 'https://github.com/octocat/Hello-World.git', 'develop'],
    ['gitlab', 'https://gitlab.com/group/sub/thing.git', 'trunk'],
  ] as const)('forwards provider=%s with its own repo and branch', async (provider, repo, branch) => {
    const call = await driveClone(provider);

    expect(call).toMatchObject({ provider, repo, branch });
  });

  /** The single choke point: the component hands its `importChat` through rather than navigating itself. */
  it('passes importChat through to the shared module', async () => {
    const call = await driveClone('github');

    expect(call.importChat).toBe(importChat);
  });

  /**
   * A failure is reported in the SERVER's words.
   *
   * The control is the message itself: a fixed string would satisfy "a toast appeared", which is the
   * assertion the old `Failed to import repository` would also have passed while telling the user
   * nothing they could act on.
   */
  it('reports the server’s own refusal, not a fixed sentence', async () => {
    seams.importRepositoryIntoWorkspace.mockResolvedValue({
      ok: false,
      message: 'That repository stores 12 file(s) in Git-LFS, which is not supported yet.',
    });

    await driveClone('github');

    await vi.waitFor(() => expect(seams.toastError).toHaveBeenCalled());
    expect(seams.toastError).toHaveBeenCalledWith(expect.stringContaining('Git-LFS'));
  });

  it('says nothing on success — the workspace is the feedback', async () => {
    await driveClone('github');

    await vi.waitFor(() => expect(seams.importRepositoryIntoWorkspace).toHaveBeenCalled());
    expect(seams.toastError).not.toHaveBeenCalled();
  });

  /**
   * No credential UI on this door, at all.
   *
   * The flow this replaced asked for a username and a personal access token with `window.prompt` and
   * wrote the result to a plaintext `git:<domain>` cookie. Neither can come back through this
   * component without failing here.
   */
  it('never prompts for a credential and never writes a git cookie', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    await driveClone('github');

    expect(prompt).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(document.cookie).not.toMatch(/git:/);

    prompt.mockRestore();
    confirm.mockRestore();
  });
});
