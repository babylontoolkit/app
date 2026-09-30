// @vitest-environment jsdom
/**
 * The shared Local scenes section (D22, D52). It must work with NO bridge: no helper → no scene list,
 * the "No bridge needed" caption, and a free-text Import that still runs. It must never silently
 * overwrite (D22) — the user confirms first, and cancelling makes no second call.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock('~/lib/local-scenes/import', () => ({
  importLocalScene: vi.fn(),
  FILES_EXIST_PREFIX: 'These files already exist',
}));
vi.mock('~/lib/local-scenes/devserver', () => ({ checkDevServer: vi.fn() }));

const { importLocalScene } = await import('~/lib/local-scenes/import');
const { checkDevServer } = await import('~/lib/local-scenes/devserver');
const { toast } = await import('react-toastify');
const { LocalScenesSection } = await import('./LocalScenesSection');

const importMock = vi.mocked(importLocalScene);
const checkMock = vi.mocked(checkDevServer);

const okResult = {
  ok: true,
  written: ['public/scenes/Level01/Level01.gltf'],
  skipped: [],
  message: 'Imported 1 file(s).',
};
const existsResult = {
  ok: false,
  written: [],
  skipped: [],
  message:
    'These files already exist: public/scenes/Level01/Level01.gltf — confirm with the user, then import again with overwrite.',
};

beforeEach(() => {
  localStorage.clear();
  importMock.mockReset();
  checkMock.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('LocalScenesSection', () => {
  it('without a helper: no scene rows, the "No bridge needed" caption, and free-text Import works', async () => {
    importMock.mockResolvedValue(okResult);
    render(<LocalScenesSection projectId="prj_1" />);

    expect(screen.queryByText('Import to project')).toBeNull();
    expect(screen.getByText(/No bridge needed\./)).toBeTruthy();
    expect(screen.getByText('http://localhost:8888/scenes/Level01.gltf')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Scene URL'), { target: { value: 'http://localhost:8888/scenes/A.glb' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() =>
      expect(importMock).toHaveBeenCalledWith({ url: 'http://localhost:8888/scenes/A.glb', overwrite: false }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Imported 1 file(s).'));
  });

  it('with helper scenes: one Import to project row per scene, using <origin>/scenes/<scene>', async () => {
    importMock.mockResolvedValue(okResult);
    render(
      <LocalScenesSection
        projectId="prj_1"
        helperDevServer={{ origin: 'http://localhost:9999', scenes: ['Level01.gltf'] }}
      />,
    );

    const rows = screen.getAllByRole('button', { name: 'Import to project' });
    expect(rows).toHaveLength(1);
    expect(screen.queryByText(/No bridge needed\./)).toBeNull();

    fireEvent.click(rows[0]);
    await waitFor(() =>
      expect(importMock).toHaveBeenCalledWith({ url: 'http://localhost:9999/scenes/Level01.gltf', overwrite: false }),
    );
  });

  it('asks before overwriting; confirming imports again with overwrite:true', async () => {
    importMock.mockResolvedValueOnce(existsResult).mockResolvedValueOnce(okResult);
    render(<LocalScenesSection projectId="prj_1" helperDevServer={{ scenes: ['Level01.gltf'] }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Import to project' }));
    await screen.findByText('Replace the existing files in public/scenes/Level01/?');

    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));

    await waitFor(() => expect(importMock).toHaveBeenCalledTimes(2));
    expect(importMock.mock.calls[1][0]).toEqual({ url: 'http://localhost:8888/scenes/Level01.gltf', overwrite: true });
  });

  it('cancelling the overwrite confirmation makes no second call', async () => {
    importMock.mockResolvedValueOnce(existsResult);
    render(<LocalScenesSection projectId="prj_1" helperDevServer={{ scenes: ['Level01.gltf'] }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Import to project' }));
    await screen.findByText('Replace the existing files in public/scenes/Level01/?');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByText('Replace the existing files in public/scenes/Level01/?')).toBeNull());
    expect(importMock).toHaveBeenCalledTimes(1);
  });

  it('Save writes bt_local_scene_server:<projectId>, and the saved origin is the next initial value', () => {
    render(<LocalScenesSection projectId="prj_1" />);

    fireEvent.change(screen.getByLabelText('Dev server address'), { target: { value: 'http://localhost:7777/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(localStorage.getItem('bt_local_scene_server:prj_1')).toBe('http://localhost:7777');
    expect(toast.success).toHaveBeenCalledWith('Saved');

    cleanup();
    render(<LocalScenesSection projectId="prj_1" />);
    expect((screen.getByLabelText('Dev server address') as HTMLInputElement).value).toBe('http://localhost:7777');
  });

  it('Check shows the running line, or the explainer title for a failure', async () => {
    checkMock.mockResolvedValueOnce('running').mockResolvedValueOnce('old-exporter');
    render(<LocalScenesSection projectId="prj_1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('The scene server is running and this site can read from it.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('Your Unity exporter is too old for this')).toBeTruthy();
  });
});

describe('LocalScenesSection imports nothing from the bridge store (D52)', () => {
  const importsBridgeStore = (source: string) => /from\s+['"]~\/lib\/stores\/unity-bridge['"]/.test(source);

  it('the component source does not import ~/lib/stores/unity-bridge', () => {
    const source = readFileSync(resolve(__dirname, 'LocalScenesSection.tsx'), 'utf8');
    expect(importsBridgeStore(source)).toBe(false);
  });

  it('control: the scanner detects such an import', () => {
    expect(importsBridgeStore("import { bridgeStatusStore } from '~/lib/stores/unity-bridge';")).toBe(true);
  });
});
