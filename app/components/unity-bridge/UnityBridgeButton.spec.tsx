// @vitest-environment jsdom
/**
 * The Unity composer icon (SPEC §4.17, D43, D55).
 *
 * The icon renders in EVERY state — no status yet, unpaired, offline, online, and a disabled bridge —
 * and a click always opens the ONE Unity Bridge dialog (D55).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// `~/lib/persistence` boots the sandbox on import; the atom is created inside the (hoisted) factory.
vi.mock('~/lib/persistence', async () => {
  const { atom } = await import('nanostores');
  return { projectId: atom<string | undefined>(undefined) };
});

const { projectId: projectIdStore } = await import('~/lib/persistence');
const { UnityBridgeButton } = await import('./UnityBridgeButton');
const { bridgeDialogStore, resetUnityBridgeStoresForTests } = await import('~/lib/stores/unity-bridge');
const { streamingState } = await import('~/lib/stores/streaming');

type StatusBody = Record<string, unknown>;

const unpaired: StatusBody = { enabled: true, state: 'unpaired', productionOrigin: null };

const studioMac = (currentProject?: string) => ({
  name: 'Studio Mac',
  online: true,
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
  productionOrigin: null,
  device: studioMac(currentProject),
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

    return new Response(
      JSON.stringify({ code: 'K7QM-2XWD', expiresAt: new Date(Date.now() + 600_000).toISOString() }),
      {
        status: 200,
      },
    );
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
  streamingState.set(false);
  projectIdStore.set('prj_1');
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  resetUnityBridgeStoresForTests();
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

  it('a disabled bridge still renders the icon; a click opens the dialog, which says it is turned off', async () => {
    answerStatusWith({ enabled: false, state: 'unpaired', productionOrigin: null });
    render(<UnityBridgeButton />);

    await waitFor(() => expect(iconButton().querySelector('.i-ph\\:cube-duotone')).not.toBeNull());
    expect(iconButton().getAttribute('title')).toBe('Connect Unity');
    fireEvent.click(iconButton());

    expect(bridgeDialogStore.get()).toBe('bridge');
    expect(await screen.findByText('The Unity Bridge is turned off on this server.')).toBeTruthy();
    expect(screen.queryByText(/--install-service/)).toBeNull();
  });

  it('opens the dialog while the status is still loading (null)', async () => {
    answerStatusWith('pending');
    render(<UnityBridgeButton />);

    await waitFor(() => expect(iconButton().querySelector('.animate-spin')).not.toBeNull());
    fireEvent.click(iconButton());

    expect(bridgeDialogStore.get()).toBe('bridge');
    expect(await screen.findByText('Connect Unity and Blender')).toBeTruthy();
  });

  it('unpaired → "Connect Unity", no success colour; the dialog shows the one install command', async () => {
    answerStatusWith(unpaired);
    render(<UnityBridgeButton />);

    await waitFor(() => expect(iconButton().getAttribute('title')).toBe('Connect Unity'));
    await waitFor(() => expect(iconButton().querySelector('.i-ph\\:cube-duotone')).not.toBeNull());
    expect(bridgeIcon().className).not.toContain('text-bolt-elements-icon-success');
    fireEvent.click(iconButton());

    expect(bridgeDialogStore.get()).toBe('bridge');

    // D59 + D61: the command appears once the App Builder projects folder is filled; it points at its Unity folder.
    fireEvent.change(await screen.findByLabelText('Your App Builder projects folder'), {
      target: { value: '/Users/me/Projects' },
    });
    expect(
      await screen.findByText(
        /^npx @babylonjs-toolkit\/agent bridge --install-service --pair K7QM-2XWD --projects "\/Users\/me\/Projects\/Unity" --server http:\/\/localhost/,
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Pairing code')).toBeNull();
    expect(screen.queryByLabelText('Dev server address')).toBeNull();
  });

  it('offline → "Connect Unity" and no success colour', async () => {
    answerStatusWith({
      enabled: true,
      state: 'offline',
      productionOrigin: null,
      device: { name: 'Studio Mac', online: false },
    });
    render(<UnityBridgeButton />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(iconButton().querySelector('.i-ph\\:cube-duotone')).not.toBeNull());
    expect(iconButton().getAttribute('title')).toBe('Connect Unity');
    expect(bridgeIcon().className).not.toContain('text-bolt-elements-icon-success');
  });

  it('online → success colour and the title "Unity Bridge: <device>"', async () => {
    answerStatusWith(online);
    render(<UnityBridgeButton />);

    // Asserted on the ICON: a colour class on the button loses to IconButton's base colour.
    await waitFor(() => expect(bridgeIcon().className).toContain('text-bolt-elements-icon-success'));
    expect(iconButton().className).not.toContain('text-bolt-elements-icon-success');
    expect(iconButton().getAttribute('title')).toBe('Unity Bridge: Studio Mac');

    fireEvent.click(iconButton());
    expect(bridgeDialogStore.get()).toBe('bridge');
    expect(await screen.findByText('Unity Bridge connected')).toBeTruthy();
  });

  it('online with a current Unity project → the title adds " · <project>"', async () => {
    answerStatusWith(onlineWith('Racer'));
    render(<UnityBridgeButton />);

    await waitFor(() => expect(iconButton().getAttribute('title')).toBe('Unity Bridge: Studio Mac · Racer'));
  });

  it('a project switch clears a pending consent prompt and any open dialog', async () => {
    answerStatusWith(unpaired);
    render(<UnityBridgeButton />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const { bridgeConsentStore } = await import('~/lib/stores/unity-bridge');
    act(() => {
      bridgeConsentStore.set({ generationId: 'g', toolCallId: 't', operation: 'op', target: 'x' });
      bridgeDialogStore.set('bridge');
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
