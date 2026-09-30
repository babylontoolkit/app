// @vitest-environment jsdom
/**
 * THE Unity Bridge dialog (SPEC §4.17, D55) — one screen.
 *
 * Not online → exactly ONE command, `npx @babylonjs-toolkit/agent bridge --install-service --pair <code>`,
 * with `--server <origin>` only off the production origin; the code is minted on open and re-minted before
 * it expires; the dialog polls and switches to the running view when the helper comes online. Online → the
 * helper's status and the per-computer Allow scripts checkbox (D58). Gone for good: the devices list, the
 * jobs, the local-scene inputs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('react-toastify', () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
}));

const { UnityBridgeDialog, installCommand } = await import('./UnityBridgeDialog');
const { bridgeDialogStore, bridgeStatusStore, resetUnityBridgeStoresForTests } = await import(
  '~/lib/stores/unity-bridge'
);

type Status = Record<string, unknown>;

const ORIGIN = () => window.location.origin;

const hello = (overrides: Record<string, unknown> = {}) => ({
  protocol: 2,
  helperVersion: '2.1.0',
  os: 'darwin',
  unityCli: { path: '/u', version: '1.4.0' },
  blender: { path: '/b', version: '5.1.2' },
  projectsDir: 'Unity',
  unityProjects: [{ key: 'k1', name: 'Racer', toolkitVersion: '9.30.0' }],
  currentProject: 'Racer',
  scriptsDisabledLocally: false,
  ...overrides,
});

const unpaired = (productionOrigin: string | null): Status => ({ enabled: true, state: 'unpaired', productionOrigin });
const online = (h = hello()): Status => ({
  enabled: true,
  state: 'online',
  productionOrigin: null,
  device: { id: 'dev_1', name: 'Studio Mac', online: true, hello: h, allowScripts: false },
});
const offline: Status = {
  enabled: true,
  state: 'offline',
  productionOrigin: null,
  device: { id: 'dev_1', name: 'Studio Mac', online: false, allowScripts: false },
};

let serverStatus: Status;
let codes: string[];
let invites: number;
let inviteFailure: string | null;
let toggleFailure: string | null;
let toggles: Array<Record<string, unknown>>;

beforeEach(() => {
  resetUnityBridgeStoresForTests();
  toastSuccess.mockReset();
  codes = ['K7QM-2XWD', 'AB23-CD45', 'EF67-GH89'];
  invites = 0;
  inviteFailure = null;
  toggleFailure = null;
  toggles = [];
  toastError.mockReset();
  serverStatus = unpaired(null);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url) === '/api/bridge/devices' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;

        if (body.action === 'allowScripts') {
          toggles.push(body);

          if (toggleFailure) {
            return new Response(JSON.stringify({ error: true, message: toggleFailure }), { status: 404 });
          }

          const device = serverStatus.device as Record<string, unknown>;
          serverStatus = { ...serverStatus, device: { ...device, allowScripts: body.value } };

          return new Response(JSON.stringify({ device: { id: body.deviceId, allowScripts: body.value } }));
        }

        if (inviteFailure) {
          return new Response(JSON.stringify({ error: true, message: inviteFailure }), { status: 429 });
        }

        const code = codes[Math.min(invites, codes.length - 1)];
        invites++;

        return new Response(JSON.stringify({ code, expiresAt: new Date(Date.now() + 600_000).toISOString() }));
      }

      if (String(url).endsWith('/bridge')) {
        return new Response(JSON.stringify(serverStatus));
      }

      return new Response('{}', { status: 404 });
    }),
  );
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetUnityBridgeStoresForTests();
  vi.unstubAllGlobals();
});

function openWith(status: Status) {
  serverStatus = status;
  bridgeStatusStore.set(status as never);
  bridgeDialogStore.set('bridge');
  render(<UnityBridgeDialog projectId="prj_1" />);
}

const commands = () => screen.queryAllByTestId('bridge-install-command').map((el) => el.textContent ?? '');

describe('installCommand', () => {
  it('omits --server only on the production origin', () => {
    expect(installCommand('K7QM-2XWD', 'https://app.x.com', 'https://app.x.com')).toBe(
      'npx @babylonjs-toolkit/agent bridge --install-service --pair K7QM-2XWD',
    );
    expect(installCommand('K7QM-2XWD', 'http://localhost:5173', 'https://app.x.com')).toBe(
      'npx @babylonjs-toolkit/agent bridge --install-service --pair K7QM-2XWD --server http://localhost:5173',
    );
    expect(installCommand('K7QM-2XWD', 'http://localhost:5173', null)).toContain('--server http://localhost:5173');
  });
});

describe('UnityBridgeDialog — not online', () => {
  it('on the production origin: exactly one command, with the minted code and NO --server', async () => {
    openWith(unpaired(ORIGIN()));

    expect(screen.getByText('Connect Unity and Blender')).toBeTruthy();
    await waitFor(() =>
      expect(commands()).toEqual(['npx @babylonjs-toolkit/agent bridge --install-service --pair K7QM-2XWD']),
    );
    expect(commands()[0]).not.toContain('--server');
    expect(screen.getByText('Run it inside your Unity projects folder, or add --projects <folder>.')).toBeTruthy();
    expect(
      screen.getByText(
        'Run this once in a terminal on the computer that has Unity. It installs a small helper that starts with your computer, so the AI can open, edit and export your Unity projects.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull(); // D58: no Allow scripts before a computer is connected
  });

  it('off production (or production unknown): the command adds --server <this origin>', async () => {
    openWith(unpaired('https://app.example.com'));

    await waitFor(() =>
      expect(commands()).toEqual([
        `npx @babylonjs-toolkit/agent bridge --install-service --pair K7QM-2XWD --server ${ORIGIN()}`,
      ]),
    );
  });

  it('Copy copies exactly the command and toasts "Copied"', async () => {
    openWith(unpaired(null));
    await waitFor(() => expect(commands()[0]).toContain('K7QM-2XWD'));

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Copied'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(commands()[0]);
  });

  it("a failed mint shows the server's message", async () => {
    inviteFailure = 'Too many bridge install codes — try again in a few minutes.';
    openWith(unpaired(null));

    expect(await screen.findByText('Too many bridge install codes — try again in a few minutes.')).toBeTruthy();
    expect(commands()).toEqual([]);
  });

  it('re-mints the code ~30 s before it expires', async () => {
    vi.useFakeTimers();
    openWith(unpaired(ORIGIN()));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(commands()[0]).toContain('--pair K7QM-2XWD');
    expect(invites).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(560_000);
    });
    expect(invites).toBe(1); // not yet: 40 s left

    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    expect(invites).toBe(2);
    expect(commands()[0]).toContain('--pair AB23-CD45');
  });

  it('polls every 3 s and switches to the running view when the helper comes online', async () => {
    vi.useFakeTimers();
    openWith(unpaired(ORIGIN()));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(screen.getByText('Connect Unity and Blender')).toBeTruthy();

    serverStatus = online();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });

    expect(screen.getByText('Unity Bridge connected')).toBeTruthy();
    expect(commands()).toEqual([]);
    expect(toastSuccess).toHaveBeenCalledWith('Unity Bridge connected');
  });

  it('offline: names the computer, then the same one command', async () => {
    openWith(offline);

    expect(screen.getByTestId('bridge-offline-line').textContent).toBe(
      '"Studio Mac" is paired but the helper isn\'t running. Start it again with the command below (it also re-installs the service).',
    );
    await waitFor(() => expect(commands()).toHaveLength(1));
    expect(commands()[0]).toContain('--install-service --pair');
    expect(screen.queryByRole('checkbox')).toBeNull(); // D58: the switch lives in the connected view only
  });
});

describe('UnityBridgeDialog — online', () => {
  it('lists Unity CLI / Blender / Babylon Toolkit / Projects folder / Current project / Computer — nothing else', () => {
    openWith(online());

    expect(screen.getByText('Unity Bridge connected')).toBeTruthy();

    const rows = screen.getAllByTestId('bridge-status-row').map((row) => row.textContent);
    expect(rows).toEqual([
      'Unity CLI1.4.0',
      'Blender5.1.2',
      'Babylon Toolkit9.30.0',
      'Projects folderUnity',
      'Current projectRacer',
      'ComputerStudio Mac',
    ]);

    // D55: no devices list, no jobs, no local-scene inputs, no minted code. D58: ONE checkbox, Allow scripts.
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.queryByText(/Your devices|Remove|Jobs|View jobs/)).toBeNull();
    expect(screen.queryByLabelText('Dev server address')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(commands()).toEqual([]);
    expect(invites).toBe(0);
  });

  it('missing Unity CLI / Blender / current project read as such', () => {
    openWith(online(hello({ unityCli: undefined, blender: undefined, currentProject: undefined })));

    const rows = screen.getAllByTestId('bridge-status-row').map((row) => row.textContent);
    expect(rows).toContain('Unity CLInot found');
    expect(rows).toContain('Blendernot found — add --blender <path> to the install command');
    expect(rows).toContain('Babylon Toolkit—');
    expect(rows).toContain('Current projectnone — ask the AI to open or create one');
  });

  it('--no-scripts on the helper shows one muted line and DISABLES the checkbox (control: absent/enabled otherwise)', () => {
    openWith(online(hello({ scriptsDisabledLocally: true })));
    expect(screen.getByText('Scripts are disabled on this computer (--no-scripts).')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: /Allow scripts/ }) as HTMLInputElement).disabled).toBe(true);

    cleanup();
    openWith(online());
    expect(screen.queryByText(/--no-scripts/)).toBeNull();
    expect((screen.getByRole('checkbox', { name: /Allow scripts/ }) as HTMLInputElement).disabled).toBe(false);
  });

  it('Allow scripts (D58): a device switched off shows unticked with its helper text; ticking posts the device action and shows ON', async () => {
    openWith(online());

    const box = screen.getByRole('checkbox', { name: /Allow scripts/ }) as HTMLInputElement;

    expect(box.checked).toBe(false);
    expect(screen.getByText('Lets the AI run C# in Unity and Python in Blender on this computer.')).toBeTruthy();

    fireEvent.click(box);

    await waitFor(() => expect(toggles).toEqual([{ action: 'allowScripts', deviceId: 'dev_1', value: true }]));
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true));
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false));
    expect(toastError).not.toHaveBeenCalled();

    // …and unticking posts false.
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(toggles.at(-1)).toEqual({ action: 'allowScripts', deviceId: 'dev_1', value: false }));
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false));
  });

  it("a refused toggle toasts the server's message and the box goes back", async () => {
    toggleFailure = 'That device does not exist.';
    openWith(online());

    fireEvent.click(screen.getByRole('checkbox', { name: /Allow scripts/ }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('That device does not exist.'));
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false));
  });

  it("warns when the current project's Toolkit is older than the minimum", () => {
    openWith(online(hello({ unityProjects: [{ key: 'k1', name: 'Racer', toolkitVersion: '9.12.0' }] })));

    expect(
      screen.getByText(
        'Babylon Toolkit 9.12.0 is older than 9.25.1 — export commands will be refused until you update it.',
      ),
    ).toBeTruthy();
  });

  it('"Show install command" reveals the one command (for another computer / re-pairing)', async () => {
    openWith(online());

    fireEvent.click(screen.getByRole('button', { name: 'Show install command' }));

    await waitFor(() => expect(commands()).toHaveLength(1));
    expect(commands()[0]).toContain('--install-service --pair K7QM-2XWD');
  });
});

describe('UnityBridgeDialog — disabled', () => {
  it('says it is turned off, and mints nothing', () => {
    openWith({ enabled: false, state: 'unpaired', productionOrigin: null });

    expect(screen.getByText('The Unity Bridge is turned off on this server.')).toBeTruthy();
    expect(commands()).toEqual([]);
    expect(invites).toBe(0);
  });
});
