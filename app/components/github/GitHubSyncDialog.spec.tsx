// @vitest-environment jsdom
/**
 * THE SYNC DIALOG'S PROVIDER — THE WIRING (fixed 2026-08-02).
 *
 * This dialog hardcoded GitHub in four places at once: the `configured` check, the connection check,
 * `startConnect`, and — the expensive one — an inline `call({ op: 'link' })` that sent no `provider` at
 * all, so the route's legacy `github` default stood. Survivable while the dialog had its own button;
 * not survivable once `GitStatusChip` became the only way in, because the chip carries a provider radio
 * group that can say GitLab. A user with both providers connected could link a **GitLab** repo, have
 * `github` written on the row, and then have every later push resolve the wrong token against the wrong
 * host — silently, since the link itself succeeds.
 *
 * 🔴 **GitLab is the only direction that can see any of it.** `github` is the default at every layer
 * beneath this component, so every assertion here that is driven only on GitHub would pass for the
 * broken implementation. That is why the regression tests below drive gitlab and the github ones are
 * present as controls rather than as the point.
 *
 * The other half is that a prop with a DEFAULT makes a missing prop invisible: `GitStatusChip` failing
 * to pass `provider` compiles, lints, renders, and quietly means GitHub. Nothing this file renders can
 * see that, so the chip's call site is pinned by a source scan — with a control proving the scan can
 * fail.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { atom } from 'nanostores';

const seams = vi.hoisted(() => ({
  getProject: vi.fn(),
  linkProjectToRepo: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarn: vi.fn(),
}));

/*
 * `~/lib/persistence` re-exports `useChatHistory`, which boots a sandbox on import. Mocked down to the
 * one atom the dialog's module graph actually needs.
 */
vi.mock('~/lib/persistence', () => ({
  projectId: atom<string | undefined>('prj_1'),
  repoStatus: atom(undefined),
  unsavedWork: atom(false),
  requestSave: vi.fn(),
  startGitConnect: vi.fn(),
}));

vi.mock('~/lib/persistence/projects', () => ({
  getProject: seams.getProject,
  linkProjectToRepo: seams.linkProjectToRepo,
}));

vi.mock('~/lib/persistence/useChatHistory', () => ({ db: undefined }));
vi.mock('~/lib/persistence/local-snapshots', () => ({ createLocalSnapshot: vi.fn() }));
vi.mock('~/lib/stores/workbench', () => ({ workbenchStore: { serializeFiles: vi.fn(), restoreFiles: vi.fn() } }));

vi.mock('react-toastify', () => ({
  toast: { error: seams.toastError, success: seams.toastSuccess, warn: seams.toastWarn },
}));

import { GitHubSyncDialog } from './GitHubSyncButton';

/** The dialog always takes an `onClose`; nothing here drives it. */
const onClose = vi.fn();

/** What `/api/git/connections` answered. Rewritten per test. */
let connections: { configured: string[]; connections: Array<{ provider: string }> };

/** Where `startConnect` sent the browser, captured instead of navigating (jsdom cannot). */
let navigatedTo: string | undefined;

function stubLocation() {
  navigatedTo = undefined;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      pathname: '/chat/abc',
      search: '?x=1',
      set href(value: string) {
        navigatedTo = value;
      },
      get href() {
        return navigatedTo ?? '';
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  connections = { configured: ['github', 'gitlab'], connections: [{ provider: 'github' }, { provider: 'gitlab' }] };

  seams.getProject.mockResolvedValue({ id: 'prj_1', linkedRepo: undefined, linkedBranch: undefined });
  seams.linkProjectToRepo.mockResolvedValue({ ok: true });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('/api/git/connections')) {
        return new Response(JSON.stringify(connections), { headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }),
  );

  stubLocation();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * Render the dialog, wait for its connection probe to settle, and fill in the link form.
 *
 * The link form is only reachable for a CONNECTED user with an UNLINKED project, which is exactly the
 * state the regression lives in — so getting there is part of the test rather than a fixture.
 */
async function openLinkForm(provider?: 'github' | 'gitlab') {
  render(<GitHubSyncDialog projectId="prj_1" provider={provider} onClose={onClose} />);

  return waitFor(() => screen.getByText('Link repository'));
}

async function link(input: { provider?: 'github' | 'gitlab'; repo?: string; branch?: string } = {}) {
  const { fireEvent } = await import('@testing-library/react');
  const button = await openLinkForm(input.provider);

  fireEvent.change(screen.getByPlaceholderText('my-org/my-game'), {
    target: { value: input.repo ?? 'group/my-game' },
  });

  if (input.branch) {
    const branchInput = screen.getByDisplayValue('main');
    fireEvent.change(branchInput, { target: { value: input.branch } });
  }

  fireEvent.click(button);

  await waitFor(() => expect(seams.linkProjectToRepo).toHaveBeenCalled());

  return seams.linkProjectToRepo.mock.calls[0];
}

describe('linking records the provider the user actually chose', () => {
  /**
   * 🔴 THE REGRESSION. It goes through `linkProjectToRepo` — whose signature makes `provider` required —
   * rather than an inline `call({ op: 'link' })` that can omit it and inherit the route's `github`.
   */
  it('links a GitLab repo AS GitLab', async () => {
    const [projectId, body] = await link({ provider: 'gitlab', repo: 'group/my-game', branch: 'trunk' });

    expect(projectId).toBe('prj_1');
    expect(body).toEqual({ repo: 'group/my-game', branch: 'trunk', provider: 'gitlab' });
  });

  /** The control: the default is still GitHub, so nothing linked before this change changes meaning. */
  it('defaults to github when no provider prop is given', async () => {
    const [, body] = await link({ repo: 'octocat/Hello-World' });

    expect(body).toMatchObject({ provider: 'github' });
  });

  /**
   * ⚠️ And it never posts `op: 'link'` itself. A second writer for one fact is how the provider got
   * dropped in the first place — the wrapper is the wall, so reaching past it must fail here.
   */
  it('writes the link through the one wrapper, never a raw POST', async () => {
    await link({ provider: 'gitlab' });

    const bodies = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String((call[1] as RequestInit | undefined)?.body ?? ''))
      .join('|');

    expect(bodies).not.toContain('"op":"link"');
  });
});

describe('the connection check reads the CHOSEN provider', () => {
  /**
   * 🔴 A user connected only to GitHub must NOT read as connected in gitlab mode. The old check asked
   * `c.provider === 'github'` unconditionally, so this state rendered the link form and let the user
   * link a GitLab repo with no GitLab connection at all — failing later, at push time, somewhere else.
   */
  it('does not treat a GitHub-only connection as a GitLab one', async () => {
    connections = { configured: ['github', 'gitlab'], connections: [{ provider: 'github' }] };

    render(<GitHubSyncDialog projectId="prj_1" provider="gitlab" onClose={onClose} />);

    /*
     * `textContent`, not `getByText`: the provider name is an interpolation, so the sentence is split
     * across three text nodes and a node-wise matcher would report "not found" for copy that is on
     * screen — a green test that means nothing.
     */
    await waitFor(() => expect(document.body.textContent).toContain('Connect your GitLab account'));
    expect(screen.queryByText('Link repository')).toBeNull();

    // 🔴 And the copy names the provider the user chose. It said "GitHub" here until 2026-08-02.
    expect(document.body.textContent).not.toContain('GitHub');
  });

  /**
   * 🔴 THE BUG THIS FILE FOUND. The connect BUTTON in this state was still `startConnect('github')`
   * while the reconnect path beside it followed the chosen provider — so a user in GitLab mode with no
   * GitLab connection authorised GitHub, came back exactly as unconnected as before, and was shown the
   * same screen. A loop, with no error anywhere in it.
   */
  it('connects the CHOSEN provider from the not-connected state', async () => {
    const { fireEvent } = await import('@testing-library/react');
    connections = { configured: ['github', 'gitlab'], connections: [] };

    render(<GitHubSyncDialog projectId="prj_1" provider="gitlab" onClose={onClose} />);

    const button = await waitFor(() => screen.getByRole('button', { name: /Connect GitLab/ }));
    fireEvent.click(button);

    expect(navigatedTo).toContain('/api/git/connect/gitlab');
  });

  /** The control for it: the same connection list DOES satisfy the dialog in github mode. */
  it('treats that same connection as connected in github mode', async () => {
    connections = { configured: ['github', 'gitlab'], connections: [{ provider: 'github' }] };

    render(<GitHubSyncDialog projectId="prj_1" provider="github" onClose={onClose} />);

    await waitFor(() => screen.getByText('Link repository'));
  });

  /**
   * `configured` is the OPERATOR's answer, and it is per provider too: a deployment with a GitHub OAuth
   * app and no GitLab one must say "not set up on this server" rather than offer a connect button that
   * dead-ends.
   */
  it('reports a provider the operator has not configured', async () => {
    connections = { configured: ['github'], connections: [] };

    render(<GitHubSyncDialog projectId="prj_1" provider="gitlab" onClose={onClose} />);

    await waitFor(() => screen.getByText(/not set up on this server/i));
  });
});

describe('startConnect targets the chosen provider', () => {
  /**
   * A lapsed GitLab connection sent through GitHub's OAuth flow returns the user to a screen that still
   * says "connect", having authorised the wrong account — the same wrong-host failure one layer up.
   */
  it('sends a lapsed GitLab connection through the GitLab flow', async () => {
    const { fireEvent } = await import('@testing-library/react');
    seams.linkProjectToRepo.mockResolvedValue({ ok: false, reconnect: true, message: 'expired' });

    const button = await openLinkForm('gitlab');
    fireEvent.change(screen.getByPlaceholderText('my-org/my-game'), { target: { value: 'group/my-game' } });
    fireEvent.click(button);

    await waitFor(() => expect(navigatedTo).toBeTruthy());

    expect(navigatedTo).toContain('/api/git/connect/gitlab');
    expect(navigatedTo).not.toContain('/api/git/connect/github');

    // It comes back where it started, rather than dumping the user on the dashboard.
    expect(navigatedTo).toContain(encodeURIComponent('/chat/abc?x=1'));

    // …and the message names the provider the user was actually using.
    expect(seams.toastError).toHaveBeenCalledWith(expect.stringContaining('GitLab'));
  });

  /** The control. Identical drive on github, which is where a hardcoded provider would look correct. */
  it('sends a lapsed GitHub connection through the GitHub flow', async () => {
    const { fireEvent } = await import('@testing-library/react');
    seams.linkProjectToRepo.mockResolvedValue({ ok: false, reconnect: true, message: 'expired' });

    const button = await openLinkForm('github');
    fireEvent.change(screen.getByPlaceholderText('my-org/my-game'), { target: { value: 'octocat/x' } });
    fireEvent.click(button);

    await waitFor(() => expect(navigatedTo).toBeTruthy());

    expect(navigatedTo).toContain('/api/git/connect/github');
  });
});

/**
 * 🔴 THE CALL SITE, which is the half that actually broke.
 *
 * `provider` has a default, so `GitStatusChip` omitting it is a silent GitHub. No render of this dialog
 * can observe that — the component under test is correct either way — so the chip's JSX is pinned at
 * source level, with a CONTROL proving the matcher discriminates rather than matching anything.
 */
describe('GitStatusChip passes its chosen provider down', () => {
  const CHIP = path.join(process.cwd(), 'app/components/header/GitStatusChip.client.tsx');

  /** Comments are stripped: a doc comment describing the fix must not be able to satisfy the scan. */
  const source = () =>
    fs
      .readFileSync(CHIP, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  /** The dialog's own JSX element, whatever else the file contains. */
  const dialogElement = (text: string) => /<GitHubSyncDialog\b[\s\S]*?\/>/.exec(text)?.[0] ?? '';

  it('renders the dialog with provider={providerToUse}', () => {
    const element = dialogElement(source());

    expect(element).toBeTruthy();
    expect(element).toMatch(/provider=\{providerToUse\}/);
  });

  /**
   * The control. The same matcher run over a copy with the prop deleted must FAIL — otherwise the
   * assertion above is a scan that reports a clean bill of health forever.
   */
  it('and the scan notices when it is missing', () => {
    const mutated = source().replace(/\s*provider=\{providerToUse\}/, '');

    expect(dialogElement(mutated)).toBeTruthy();
    expect(dialogElement(mutated)).not.toMatch(/provider=\{providerToUse\}/);
  });
});
