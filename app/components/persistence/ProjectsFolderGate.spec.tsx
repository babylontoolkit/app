// @vitest-environment jsdom
/**
 * What the projects-folder panel DRAWS, and that the WORKSPACE DOORS actually wait for it (§4.5.4d).
 *
 * The decision and its copy are pinned in `folder-gate.spec.ts` and the holding behaviour in
 * `workspace-gate.spec.ts`; what only exists here is which buttons a request puts on screen, and the
 * wiring — because a gate that is correct and unmounted, or correct and never awaited, is no gate, and
 * every persistence defect this repo has recorded lived in wiring the unit tests drove around.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FolderGateRequest } from '~/lib/local-project';
import { FolderGatePanel, type FolderGatePanelProps } from './ProjectsFolderGate.client';

const noop = async () => {};

const request = (over: Partial<FolderGateRequest> = {}): FolderGateRequest => ({
  gate: 'choose',
  intent: 'create',
  required: true,
  state: { kind: 'unset' },
  ...over,
});

function draw(over: Partial<FolderGatePanelProps> = {}) {
  const props: FolderGatePanelProps = {
    request: request(),
    onChoose: noop,
    onReconnect: noop,
    onSkip: () => {},
    onCancel: () => {},
    ...over,
  };

  return render(<FolderGatePanel {...props} />);
}

const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), 'utf8');

describe('the projects-folder panel', () => {
  afterEach(cleanup);

  it('choose, required: pick a folder or cancel — and cancel abandons the workspace', () => {
    const onCancel = vi.fn();
    draw({ onCancel });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose a folder on this computer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('choose, not required: Not now is offered instead of Cancel, and opens the workspace anyway', () => {
    const onSkip = vi.fn();
    const onCancel = vi.fn();
    draw({ request: request({ required: false }), onSkip, onCancel });

    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));

    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('reconnect names the folder, and a different folder goes through the same choose action', async () => {
    const onChoose = vi.fn(noop);
    const onReconnect = vi.fn(noop);
    draw({
      request: request({ gate: 'reconnect', state: { kind: 'needs-permission', folderName: 'BTK Projects' } }),
      onChoose,
      onReconnect,
    });

    expect(screen.getByText('Reconnect BTK Projects')).toBeInTheDocument();

    // One action at a time: every button is disabled while one runs, so the second click waits its turn.
    fireEvent.click(screen.getByRole('button', { name: 'Open BTK Projects' }));
    await waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use a different folder…' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Use a different folder…' }));
    await waitFor(() => expect(onChoose).toHaveBeenCalledTimes(1));
  });

  it('checking covers the page with a spinner and NO button', () => {
    const { container } = draw({ request: request({ gate: 'checking', state: { kind: 'unknown' } }) });

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(container.querySelector('.i-svg-spinners\\:90-ring-with-bg')).not.toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByTestId('projects-folder-gate').className).toMatch(/\bz-max\b/);
  });

  it('a failed action stays on the gate and says why', async () => {
    draw({
      onChoose: async () => {
        throw new Error('picker exploded');
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Choose a folder on this computer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('picker exploded');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

/*
 * 🔴 THE GATE BELONGS TO THE WORKSPACE, NOT TO A PAGE (owner, 2026-09-17).
 *
 * It first shipped as a cover over a list of routes, which put it on the app builder's front page —
 * before the user had asked for a project at all. These assertions pin the corrected shape: the panel
 * is mounted once and draws only what a door published, and BOTH doors into a workspace wait for it.
 */
describe('the gate is tied to the workspace', () => {
  const MOUNT = /<Outlet \/>(?:\s|\{\/\*[\s\S]*?\*\/\})*<ProjectsFolderGate \/>\s*<\/Layout>/;

  it('root.tsx mounts the one panel beside the Outlet', () => {
    const root = read('app/root.tsx');

    expect(root).toMatch(
      /import \{ ProjectsFolderGate \} from '.\/components\/persistence\/ProjectsFolderGate.client'/,
    );
    expect(root).toMatch(MOUNT);
  });

  /* CONTROL: the scan can fail — a root without the element does not match. */
  it('CONTROL: the mount pattern does not match a root without the gate', () => {
    expect('<Layout>\n      <Outlet />\n    </Layout>').not.toMatch(MOUNT);
  });

  it('the panel reads a published request and never a route', () => {
    const source = read('app/components/persistence/ProjectsFolderGate.client.tsx').replace(/\/\*[\s\S]*?\*\//g, '');

    expect(source).toContain('folderGateRequest');

    for (const banned of ['useLocation', 'pathname', 'isGatedPath', 'decideFolderGate']) {
      expect(source, `the panel must not decide from ${banned}`).not.toContain(banned);
    }
  });

  it('creation waits for the folder before anything is made, and a cancel makes nothing', () => {
    const source = read('app/components/chat/Chat.client.tsx');

    expect(source).toMatch(/await requireProjectsFolderForWorkspace\('create'\)\) === 'cancelled'/);

    /* Before the project row, the credit debit and the first byte — i.e. before `createProject`. */
    expect(source.indexOf('requireProjectsFolderForWorkspace')).toBeLessThan(source.indexOf('await createProject({'));
  });

  /*
   * 🔴 A cancelled open must THROW. Resolving is what every caller reads as "the mount is done", so it
   * set `ready` and rendered the workspace the user had just declined — measured live, not reasoned.
   */
  it('opening a project waits for the folder too, and a cancel fails the open rather than resolving it', () => {
    const source = read('app/lib/persistence/useChatHistory.ts');

    expect(source).toMatch(/requireProjectsFolderForWorkspace\('open'\)/);
    expect(source, 'a cancelled open must not resolve').toMatch(
      /outcome === 'cancelled'\s*\)?\s*\{\s*throw new ProjectsFolderDeclinedError\(\)/,
    );
    expect(source, 'and must reach the failure surface with a retry').toMatch(
      /error instanceof ProjectsFolderDeclinedError[\s\S]{0,400}reportBootFailure\(\{ message: error.message, retryable: true \}, retry\)/,
    );
  });

  /* CONTROL: these scans read real sources, so a silent miss would be a green report forever. */
  it('CONTROL: the door scans are reading the real files', () => {
    expect(read('app/components/chat/Chat.client.tsx')).toContain('runStartProject');
    expect(read('app/lib/persistence/useChatHistory.ts')).toContain('function mountProjectFiles');
  });
});
