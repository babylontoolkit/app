// @vitest-environment jsdom
/**
 * The Unity composer icon + Connect dialog (SPEC §4.17, D43, D52).
 *
 * The property that matters most: the Local scenes section is reachable in EVERY state — no status
 * yet, unpaired, and a disabled bridge — because local scenes never wait on the bridge (D52).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// `~/lib/persistence` boots the sandbox on import; the atom is created inside the (hoisted) factory.
vi.mock('~/lib/persistence', async () => {
  const { atom } = await import('nanostores');
  return { projectId: atom<string | undefined>(undefined) };
});

// The real importer reaches the workbench store (a sandbox boot) — not what this file is about.
vi.mock('~/lib/local-scenes/import', () => ({
  importLocalScene: vi.fn(),
  FILES_EXIST_PREFIX: 'These files already exist',
}));

const { projectId: projectIdStore } = await import('~/lib/persistence');
const { UnityBridgeButton, resetUnityBridgeButtonForTests } = await import('./UnityBridgeButton');
const { bridgeDialogStore, resetUnityBridgeStoresForTests } = await import('~/lib/stores/unity-bridge');
const { streamingState } = await import('~/lib/stores/streaming');

type StatusBody = Record<string, unknown>;

const unpaired: StatusBody = { enabled: true, state: 'unpaired', device: null, devices: [], jobs: [] };

const studioMac = (currentProject?: string) => ({
  id: 'dev_1',
  name: 'Studio Mac',
  os: 'darwin',
  online: true,
  allowScripts: false,
  hello: {
    protocol: 2,
    helperVersion: '2.0.0',
    os: 'darwin',
    projectsDir: 'Unity',
    unityProjects: [{ key: 'k1', name: 'Racer' }],
    ...(currentProject ? { currentProject } : {}),
    scriptsDisabledLocally: false,
  },
});

const onlineWith = (currentProject?: string): StatusBody => ({
  enabled: true,
  state: 'online',
  device: studioMac(currentProject),
  devices: [studioMac(currentProject)],
  jobs: [],
});

const online = onlineWith();

let fetchMock: ReturnType<typeof vi.fn>;

function answerStatusWith(body: StatusBody | 'pending') {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/bridge') && (!init || !init.method || init.method === 'GET')) {
      if (body === 'pending') {
        return new Promise<Response>(() => undefined);
      }

      return new Response(JSON.stringify(body), { status: 200 });
    }

    return new Response(JSON.stringify({ ok: true, deviceName: 'Studio Mac' }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
}

function iconButton(): HTMLElement {
  const button = document.querySelector('button[title]');

  if (!button) {
    throw new Error('no icon button');
  }

  return button as HTMLElement;
}

/** The icon inside the button — the element that carries the online colour. */
function bridgeIcon(): HTMLElement {
  const icon = iconButton().querySelector('[data-testid="unity-bridge-icon"]');

  if (!icon) {
    throw new Error('no bridge icon');
  }

  return icon as HTMLElement;
}

beforeEach(() => {
  resetUnityBridgeStoresForTests();
  resetUnityBridgeButtonForTests();
  streamingState.set(false);
  projectIdStore.set('prj_1');
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  resetUnityBridgeStoresForTests();
  resetUnityBridgeButtonForTests();
  projectIdStore.set(undefined);
  vi.unstubAllGlobals();
});

describe('UnityBridgeButton', () => {
  it('renders nothing without a project', () => {
    answerStatusWith(unpaired);
    projectIdStore.set(undefined);

    const { container } = render(<UnityBridgeButton />);

    expect(container.innerHTML).toBe('');
  });

  it('a disabled bridge still renders the icon, and it opens only the Local scenes section', async () => {
    answerStatusWith({ enabled: false, state: 'unpaired', device: null, devices: [], jobs: [] });
    render(<UnityBridgeButton />);

    await waitFor(() => expect(iconButton().getAttribute('title')).toBe('Unity scenes'));
    fireEvent.click(iconButton());

    expect(bridgeDialogStore.get()).toBe('connect');
    expect(await screen.findByLabelText('Dev server address')).toBeTruthy();
    expect(screen.queryByText(/bridge --server/)).toBeNull();
  });

  it('opens Connect while the status is still loading (null)', async () => {
    answerStatusWith('pending');
    render(<UnityBridgeButton />);

    await waitFor(() => expect(iconButton().querySelector('.animate-spin')).not.toBeNull());
    fireEvent.click(iconButton());

    expect(bridgeDialogStore.get()).toBe('connect');
    expect(await screen.findByLabelText('Dev server address')).toBeTruthy();
  });

  it('unpaired → the Connect dialog shows the local scene origin input and the helper command', async () => {
    answerStatusWith(unpaired);
    render(<UnityBridgeButton />);

    await waitFor(() => expect(iconButton().getAttribute('title')).toBe('Connect Unity'));
    await waitFor(() => expect(iconButton().querySelector('.i-ph\\:cube-duotone')).not.toBeNull());
    expect(bridgeIcon().className).not.toContain('text-bolt-elements-icon-success');
    fireEvent.click(iconButton());

    expect(bridgeDialogStore.get()).toBe('connect');
    expect(await screen.findByLabelText('Dev server address')).toBeTruthy();
    expect(screen.getByText(/npx @babylonjs-toolkit\/agent bridge --server http:\/\/localhost/)).toBeTruthy();
  });

  it('online → success colour and the title "Unity Bridge: <device>"', async () => {
    answerStatusWith(online);
    render(<UnityBridgeButton />);

    // Asserted on the ICON: a colour class on the button loses to IconButton's base colour.
    await waitFor(() => expect(bridgeIcon().className).toContain('text-bolt-elements-icon-success'));
    expect(iconButton().className).not.toContain('text-bolt-elements-icon-success');
    expect(iconButton().getAttribute('title')).toBe('Unity Bridge: Studio Mac');

    fireEvent.click(iconButton());
    expect(bridgeDialogStore.get()).toBe('status');
  });

  it('online with a current Unity project → the title adds " · <project>"', async () => {
    answerStatusWith(onlineWith('Racer'));
    render(<UnityBridgeButton />);

    await waitFor(() => expect(iconButton().getAttribute('title')).toBe('Unity Bridge: Studio Mac · Racer'));
  });

  it('the Connect dialog has NO link section (D54) and tells the user to run it in the projects folder', async () => {
    answerStatusWith(online);
    render(<UnityBridgeButton />);

    await waitFor(() => expect(bridgeIcon().className).toContain('text-bolt-elements-icon-success'));
    act(() => bridgeDialogStore.set('connect'));

    expect(await screen.findByText('Your devices')).toBeTruthy();
    expect(screen.getByText('Run it in your Unity projects folder (or add --projects <folder>).')).toBeTruthy();
    expect(screen.queryByText(/Link this project/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Link / })).toBeNull();
  });

  it("Approve posts {action:'approve', code}", async () => {
    answerStatusWith(unpaired);
    render(<UnityBridgeButton />);

    await waitFor(() => expect(iconButton().getAttribute('title')).toBe('Connect Unity'));
    fireEvent.click(iconButton());

    fireEvent.change(await screen.findByLabelText('Pairing code'), { target: { value: 'ABCD-EFGH' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            url === '/api/bridge/devices' &&
            JSON.stringify(JSON.parse(String((init as RequestInit).body))) ===
              JSON.stringify({ action: 'approve', code: 'ABCD-EFGH' }),
        ),
      ).toBe(true),
    );
  });

  it('a project switch clears a pending consent prompt and any open dialog', async () => {
    answerStatusWith(unpaired);
    render(<UnityBridgeButton />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const { bridgeConsentStore } = await import('~/lib/stores/unity-bridge');
    act(() => {
      bridgeConsentStore.set({ generationId: 'g', toolCallId: 't', operation: 'op', target: 'x' });
      bridgeDialogStore.set('connect');
    });
    act(() => projectIdStore.set('prj_2'));

    expect(bridgeConsentStore.get()).toBeNull();
    expect(bridgeDialogStore.get()).toBeNull();
  });

  it('a pending consent prompt closes when the turn stops streaming — nothing is waiting for it', async () => {
    answerStatusWith(unpaired);
    render(<UnityBridgeButton />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const { bridgeConsentStore } = await import('~/lib/stores/unity-bridge');
    act(() => streamingState.set(true));
    act(() => bridgeConsentStore.set({ generationId: 'g', toolCallId: 't', operation: 'op', target: 'x' }));
    expect(bridgeConsentStore.get()).not.toBeNull();

    act(() => streamingState.set(false));

    await waitFor(() => expect(bridgeConsentStore.get()).toBeNull());
  });
});
