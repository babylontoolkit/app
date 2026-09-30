// @vitest-environment jsdom
/**
 * The Status panel, the Consent dialog and the Jobs panel (SPEC §4.17, D16, D52), plus the client half
 * of `import_local_scene` (D22).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// The real importer reaches the workbench store, which boots a sandbox on import.
vi.mock('~/lib/stores/workbench', () => ({
  workbenchStore: { refreshPreviews: vi.fn(), files: { get: () => ({}) }, createFile: vi.fn(async () => true) },
}));

const { UnityBridgeConsentDialog } = await import('./UnityBridgeConsentDialog');
const { UnityBridgeStatusPanel } = await import('./UnityBridgeStatusPanel');
const { UnityBridgeJobsPanel } = await import('./UnityBridgeJobsPanel');
const {
  bridgeConsentStore,
  bridgeDialogStore,
  bridgeLiveJobsStore,
  bridgeStatusStore,
  resetUnityBridgeStoresForTests,
  updateBridgeFromPart,
} = await import('~/lib/stores/unity-bridge');

let fetchMock: ReturnType<typeof vi.fn>;

const posted = () =>
  fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) }));

const device = (toolkitVersion: string, allowScripts = false) => ({
  id: 'dev_1',
  name: 'Studio Mac',
  os: 'darwin',
  online: true,
  allowScripts,
  hello: {
    protocol: 2,
    helperVersion: '2.0.0',
    os: 'darwin' as const,
    projectsDir: 'Unity',
    unityProjects: [
      { key: 'k1', name: 'Racer', toolkitVersion, unityVersion: '6000.1.0f1' },
      { key: 'k2', name: 'Kart', toolkitVersion: '9.30.0' },
    ],
    currentProject: 'Racer',
    scriptsDisabledLocally: false,
  },
});

const status = (toolkitVersion: string, jobs: unknown[] = [], allowScripts = false) => ({
  enabled: true,
  state: 'online' as const,
  device: device(toolkitVersion, allowScripts),
  devices: [device(toolkitVersion, allowScripts)],
  jobs: jobs as never,
});

beforeEach(() => {
  resetUnityBridgeStoresForTests();
  fetchMock = vi.fn(async (url: string) =>
    String(url).endsWith('/bridge')
      ? new Response(JSON.stringify(status('9.25.1')), { status: 200 })
      : new Response('{"ok":true}'),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  resetUnityBridgeStoresForTests();
  vi.unstubAllGlobals();
});

describe('UnityBridgeConsentDialog', () => {
  const raise = () =>
    updateBridgeFromPart({
      type: 'bridge-consent',
      toolCallId: 'call_9',
      operation: 'unity.cli license return',
      target: 'Racer',
      tier: 'consent',
      generationId: 'gen_9',
    });

  it('shows the operation, and Allow once posts approved:true', async () => {
    raise();
    render(<UnityBridgeConsentDialog />);

    expect(screen.getByText('Allow this Unity operation?')).toBeTruthy();
    expect(screen.getByText('unity.cli license return')).toBeTruthy();
    expect(screen.queryByText(/remember/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));

    await waitFor(() =>
      expect(posted()).toEqual([
        {
          url: '/api/agent/tool-result',
          body: { generationId: 'gen_9', toolCallId: 'consent:call_9', result: { approved: true } },
        },
      ]),
    );
    expect(bridgeConsentStore.get()).toBeNull();
  });

  it('Deny posts approved:false', async () => {
    raise();
    render(<UnityBridgeConsentDialog />);

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));

    await waitFor(() => expect(posted()[0]?.body.result).toEqual({ approved: false }));
  });
});

describe('UnityBridgeStatusPanel', () => {
  it('warns when the Toolkit is older than the minimum', () => {
    bridgeStatusStore.set(status('9.12.0'));
    bridgeDialogStore.set('status');
    render(<UnityBridgeStatusPanel projectId="prj_1" />);

    expect(
      screen.getByText(
        'Babylon Toolkit 9.12.0 is older than 9.25.1 — export commands will be refused until you update it.',
      ),
    ).toBeTruthy();

    // D52: the shared Local scenes section is here too.
    expect(screen.getByLabelText('Dev server address')).toBeTruthy();
  });

  it('does not warn at the minimum (control)', () => {
    bridgeStatusStore.set(status('9.25.1'));
    bridgeDialogStore.set('status');
    render(<UnityBridgeStatusPanel projectId="prj_1" />);

    expect(screen.queryByText(/is older than/)).toBeNull();
  });

  it('the scripts checkbox posts allowScripts WITH the device id (D54 — per device)', async () => {
    bridgeStatusStore.set(status('9.25.1'));
    bridgeDialogStore.set('status');
    render(<UnityBridgeStatusPanel projectId="prj_1" />);

    fireEvent.click(screen.getByRole('checkbox'));

    await waitFor(() =>
      expect(posted()).toContainEqual({
        url: '/api/projects/prj_1/bridge',
        body: { action: 'allowScripts', deviceId: 'dev_1', value: true },
      }),
    );
  });

  it("the checkbox reflects the DEVICE's switch", () => {
    bridgeStatusStore.set(status('9.25.1', [], true));
    bridgeDialogStore.set('status');
    render(<UnityBridgeStatusPanel projectId="prj_1" />);

    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  });

  it('lists the projects folder and its Unity projects read-only, marking the current one; no Unlink', () => {
    bridgeStatusStore.set(status('9.25.1'));
    bridgeDialogStore.set('status');
    render(<UnityBridgeStatusPanel projectId="prj_1" />);

    expect(screen.getByText('Unity', { selector: '.font-mono' })).toBeTruthy();

    const list = screen.getByRole('list', { name: 'Unity projects' });
    expect(list.textContent).toContain('Racer');
    expect(list.textContent).toContain('Kart');
    expect(screen.getAllByTestId('current-project')).toHaveLength(1);
    expect(screen.getByTestId('current-project').parentElement?.textContent).toContain('Racer');

    expect(screen.queryByRole('button', { name: 'Unlink' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Link / })).toBeNull();
    expect(screen.getByRole('button', { name: 'View jobs' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Manage devices' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });
});

describe('UnityBridgeJobsPanel', () => {
  it('a cancelled job shows its status and no credits; live rows come first and dedupe by id', () => {
    bridgeStatusStore.set(
      status('9.25.1', [
        {
          id: 'brg_old',
          operation: 'Export Racer',
          status: 'cancelled',
          createdAt: '2026-09-29T00:00:00Z',
        },
        { id: 'brg_live', operation: 'Stale copy', status: 'queued', createdAt: '2026-09-29T00:00:00Z' },
      ]),
    );
    bridgeLiveJobsStore.set({
      brg_live: { generationId: 'gen_1', status: 'running', label: 'Export level', lines: ['50%'] },
    });
    bridgeDialogStore.set('jobs');
    render(<UnityBridgeJobsPanel projectId="prj_1" />);

    const rows = screen.getAllByTestId('bridge-job-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Export level');
    expect(rows[0].textContent).toContain('50%');
    expect(rows[0].textContent).toContain('running');
    expect(rows[1].textContent).toContain('Export Racer');
    expect(rows[1].textContent).toContain('cancelled');

    // D53: bridge operations are not billed separately — no row speaks of credits or refunds.
    for (const row of rows) {
      expect(row.textContent).not.toMatch(/credit|refund/i);
    }
    expect(screen.queryByText('Stale copy')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1);
  });
});

const actual = await import('~/lib/local-scenes/import');

describe('handleLocalSceneCall (the import_local_scene client half)', () => {
  it('imports and posts {message, ok}', async () => {
    const importScene = vi.fn(async () => ({ ok: true, written: ['a'], skipped: [], message: 'Imported 1 file(s).' }));
    const post = vi.fn(async () => undefined);

    await actual.handleLocalSceneCall(
      { generationId: 'gen_1', toolCallId: 'call_1', url: 'http://localhost:8888/scenes/A.gltf', overwrite: false },
      { importScene, post },
    );

    expect(importScene).toHaveBeenCalledWith({ url: 'http://localhost:8888/scenes/A.gltf', overwrite: false });
    expect(post).toHaveBeenCalledWith({
      generationId: 'gen_1',
      toolCallId: 'call_1',
      result: { message: 'Imported 1 file(s).', ok: true },
    });
  });

  it('posts error when the import throws', async () => {
    const post = vi.fn(async () => undefined);

    await actual.handleLocalSceneCall(
      { generationId: 'gen_1', toolCallId: 'call_2', url: 'http://localhost:8888/scenes/A.gltf', overwrite: true },
      {
        importScene: vi.fn(async () => {
          throw new Error('boom');
        }),
        post,
      },
    );

    expect(post).toHaveBeenCalledWith({ generationId: 'gen_1', toolCallId: 'call_2', error: 'boom' });
  });
});
