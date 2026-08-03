// @vitest-environment jsdom
/**
 * `/git?url=` — THE WIRING (T8).
 *
 * `~/lib/git/import-repository.spec.ts` proves the OPERATION; `GitCloneButton.spec.tsx` proves the other
 * door is wired to it. This file is the third one — the route `StarterTemplates` links to — and it is the
 * one that carried three defects of its own, each of which passes every module-level test:
 *
 *   1. **The guard did not match its own effect** (`if (!gitReady && !historyReady)` where the effect
 *      guards on `||`), so an import could start before the chat it is about to be written into exists.
 *      The `&&` form is *weaker*, which is why it looks like the same guard.
 *   2. **A hardcoded branch.** This route is handed a URL and nothing else, and a repository URL says
 *      nothing about whether its trunk is `main` or `master` — `getDefaultBranch` exists precisely
 *      because guessing surfaces as "that template does not exist".
 *   3. **A fixed `toast.error('Failed to import repository')`** followed by `window.location.href = '/'`,
 *      i.e. the only explanation the user got, destroyed a fraction of a second after it appeared.
 *
 * `Chat`/`BaseChat` are stubbed to trivial elements: they drag the entire workbench, the sandbox and the
 * chat history in with them, and none of that is what this file is about.
 */
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const seams = vi.hoisted(() => ({
  importRepositoryIntoWorkspace: vi.fn(),
  toastError: vi.fn(),
  searchParams: new URLSearchParams(),
  historyReady: true,
  importChat: vi.fn(async () => undefined),
}));

vi.mock('~/lib/git/import-repository', () => ({
  importRepositoryIntoWorkspace: seams.importRepositoryIntoWorkspace,
}));

vi.mock('react-toastify', () => ({ toast: { error: seams.toastError, success: vi.fn() } }));

/*
 * `searchParams` is read through a getter so a test can change the query WITHOUT the module reference
 * changing — and a fresh `URLSearchParams` per render so the "exactly once" test is driven by a genuinely
 * new object identity, which is what the effect's dependency array actually watches.
 */
vi.mock('@remix-run/react', () => ({
  useSearchParams: () => [new URLSearchParams(seams.searchParams), vi.fn()],
}));

vi.mock('~/lib/persistence', () => ({
  useChatHistory: () => ({ ready: seams.historyReady, importChat: seams.importChat }),
}));

vi.mock('~/components/chat/Chat.client', () => ({ Chat: () => <div>chat</div> }));
vi.mock('~/components/chat/BaseChat', () => ({ BaseChat: () => <div>base-chat</div> }));

import { GitUrlImport } from './GitUrlImport.client';

const STARTER_TEMPLATE_URL = 'https://github.com/babylontoolkit/AppTemplate.git';

/**
 * Watch `window.location.href = …` without letting jsdom try to navigate.
 *
 * `Location.href` is non-configurable, so the whole `location` object is swapped for a stand-in whose
 * `href` is a spied setter; `restoreNavigation` puts the real one back.
 */
const realLocation = window.location;

function watchNavigation() {
  const setHref = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: {
      ...realLocation,
      get href() {
        return 'http://localhost/git';
      },
      set href(value: string) {
        setHref(value);
      },
    },
  });

  return setHref;
}

function restoreNavigation() {
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: realLocation });
}

beforeEach(() => {
  vi.clearAllMocks();
  seams.importRepositoryIntoWorkspace.mockResolvedValue({ ok: true });
  seams.searchParams = new URLSearchParams({ url: STARTER_TEMPLATE_URL });
  seams.historyReady = true;
});

afterEach(() => {
  cleanup();
  restoreNavigation();
});

describe('GitUrlImport is wired to the one import path', () => {
  /**
   * 🔴 The branch. This door has no picker, so the ONLY correct value is absent — the server resolves the
   * repository's real default. A hardcoded `'main'` here is indistinguishable from correct behaviour on
   * every `main` repository and a flat "not found" on every `master` one.
   */
  it('drives the shared module with the `url` param and NO branch', async () => {
    render(<GitUrlImport />);

    await vi.waitFor(() => expect(seams.importRepositoryIntoWorkspace).toHaveBeenCalled());

    const call = seams.importRepositoryIntoWorkspace.mock.calls[0][0];
    expect(call.repo).toBe(STARTER_TEMPLATE_URL);
    expect(call.branch).toBeUndefined();
  });

  /**
   * A starter template is a link to this route and nothing more (`StarterTemplates.tsx` builds
   * `/git?url=https://github.com/<repo>.git`), so the template flow is only as correct as this call.
   */
  it('carries a StarterTemplates URL through intact', async () => {
    seams.searchParams = new URLSearchParams({ url: 'https://github.com/babylontoolkit/RacingTemplate.git' });
    render(<GitUrlImport />);

    await vi.waitFor(() => expect(seams.importRepositoryIntoWorkspace).toHaveBeenCalled());
    expect(seams.importRepositoryIntoWorkspace.mock.calls[0][0].repo).toBe(
      'https://github.com/babylontoolkit/RacingTemplate.git',
    );
  });

  /**
   * The single choke point. `importChat` is what arms the import tail and binds the chat to the project
   * the files were written into (`{projectId, gitUrl}` is set INSIDE the module) — so the property this
   * component owns is that it forwards the real identity rather than wrapping it in one of its own.
   */
  it('passes the real importChat through, not a wrapper', async () => {
    render(<GitUrlImport />);

    await vi.waitFor(() => expect(seams.importRepositoryIntoWorkspace).toHaveBeenCalled());
    expect(seams.importRepositoryIntoWorkspace.mock.calls[0][0].importChat).toBe(seams.importChat);
  });

  /**
   * The `&&`-vs-`||` bug. The control is the rendered output: "not called" must be because the guard held,
   * not because the component failed to mount and nothing happened at all.
   */
  it('waits for history to be ready, then imports exactly once', async () => {
    seams.historyReady = false;

    const { rerender } = render(<GitUrlImport />);

    expect(screen.getByText('chat')).toBeTruthy(); // control: it really did render
    expect(seams.importRepositoryIntoWorkspace).not.toHaveBeenCalled();

    seams.historyReady = true;
    rerender(<GitUrlImport />);

    await vi.waitFor(() => expect(seams.importRepositoryIntoWorkspace).toHaveBeenCalledTimes(1));
  });

  /**
   * A ref, not state: a `useState` flag is only observable on the NEXT render, which is one render too
   * late — the same double-run class that made a page load mount its project twice. Each rerender hands
   * the effect a NEW `searchParams` object, so its dependency array fires every time.
   */
  it('imports once across re-renders that change the searchParams identity', async () => {
    const { rerender } = render(<GitUrlImport />);

    await vi.waitFor(() => expect(seams.importRepositoryIntoWorkspace).toHaveBeenCalled());

    rerender(<GitUrlImport />);
    rerender(<GitUrlImport />);
    rerender(<GitUrlImport />);

    expect(seams.importRepositoryIntoWorkspace).toHaveBeenCalledTimes(1);
  });

  /**
   * The half a `useState` flag cannot do. StrictMode runs the effect twice within ONE commit, so a flag
   * that is only readable on the next render is still `false` on the second run and the repository is
   * cloned twice — two projects, two VMs, one of them orphaned. A ref is set synchronously.
   */
  it('imports once under StrictMode’s double-invoked effect', async () => {
    render(
      <StrictMode>
        <GitUrlImport />
      </StrictMode>,
    );

    await vi.waitFor(() => expect(seams.importRepositoryIntoWorkspace).toHaveBeenCalled());
    expect(seams.importRepositoryIntoWorkspace).toHaveBeenCalledTimes(1);
  });

  it('redirects home and imports nothing when there is no url', async () => {
    seams.searchParams = new URLSearchParams();

    const setHref = watchNavigation();
    render(<GitUrlImport />);

    await vi.waitFor(() => expect(setHref).toHaveBeenCalledWith('/'));
    expect(seams.importRepositoryIntoWorkspace).not.toHaveBeenCalled();
  });

  /**
   * The server's own sentence. The control is the sentence itself — a fixed string would satisfy "a toast
   * appeared", which is exactly the assertion `Failed to import repository` used to pass while telling
   * the user nothing they could act on.
   */
  it('reports the server’s refusal, not a fixed sentence', async () => {
    seams.importRepositoryIntoWorkspace.mockResolvedValue({
      ok: false,
      message: 'That repository is over the 256MB import limit.',
    });

    render(<GitUrlImport />);

    await vi.waitFor(() => expect(seams.toastError).toHaveBeenCalled());
    expect(seams.toastError).toHaveBeenCalledWith(expect.stringContaining('256MB'));
  });

  /**
   * A failure must LEAVE the user where the explanation is. The old code bounced to `/`, throwing away
   * both the toast and the boot failure surface's retry.
   */
  it('does not bounce home when the import fails', async () => {
    seams.importRepositoryIntoWorkspace.mockResolvedValue({ ok: false, message: 'Connect GitHub and try again.' });

    const setHref = watchNavigation();
    render(<GitUrlImport />);

    await vi.waitFor(() => expect(seams.toastError).toHaveBeenCalled());
    expect(setHref).not.toHaveBeenCalled();
  });

  it('says nothing on success — the workspace is the feedback', async () => {
    render(<GitUrlImport />);

    await vi.waitFor(() => expect(seams.importRepositoryIntoWorkspace).toHaveBeenCalled());
    expect(seams.toastError).not.toHaveBeenCalled();
  });

  /**
   * No credential UI on this door either. The flow this replaced asked for a username and a PAT with
   * `window.prompt` and wrote the result to a plaintext `git:<domain>` cookie.
   */
  it('never prompts for a credential and never writes a git cookie', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<GitUrlImport />);
    await vi.waitFor(() => expect(seams.importRepositoryIntoWorkspace).toHaveBeenCalled());

    expect(prompt).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(document.cookie).not.toMatch(/git:/);

    prompt.mockRestore();
    confirm.mockRestore();
  });
});
