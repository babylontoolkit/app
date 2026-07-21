// @vitest-environment jsdom
/**
 * Unity Project License section of the Unity connect dialog (SPEC §4.18).
 *
 * These tests drive the REAL `UnityLicenseSection` (rendered directly) with the delivery module, toasts
 * and `fetch` mocked. Generation is now a FLAT credit charge per SELECTED tier: the loader returns a
 * `tiers` ladder (price + unlocked), the tier `<select id="unity-license-tier">` chooses which tier the
 * generate POST sends, and the button shows the price — or "Re-generate — free" once the tier is unlocked.
 * The load-bearing properties: link/generate/unlink hit the route with the right action + tier; Generate
 * delivers the license to the web project; the Unity drop is attempted ONLY when connected and its failure
 * NEVER reads as a success (manual instructions instead); linking works with the bridge disconnected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { atom } from 'nanostores';
import type { UnityLicense } from '~/lib/unity/license-delivery';

// The section pulls the bridge machinery transitively; a lightweight stub keeps the import graph cheap.
vi.mock('~/lib/stores/unityBridge', () => ({
  unityConnectionAtom: atom({ status: 'disconnected' }),
  unityToolsAtom: atom([]),
  connectUnity: vi.fn(),
  disconnectUnity: vi.fn(),
  loadPersistedUnityConnection: vi.fn(() => null),
}));

vi.mock('~/lib/persistence', () => ({ projectId: atom(undefined) }));

vi.mock('react-toastify', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('~/lib/unity/license-delivery', () => ({
  WEB_LICENSE_PATH: 'license.json',
  UNITY_LICENSE_PATH: 'Assets/[Config]/license.json',
  writeLicenseToWebProject: vi.fn(async () => true),
  dropLicenseIntoUnity: vi.fn(async () => ({ ok: true, tool: 'create_asset' })),
  downloadLicense: vi.fn(),
}));

import { toast } from 'react-toastify';
import { writeLicenseToWebProject, dropLicenseIntoUnity, downloadLicense } from '~/lib/unity/license-delivery';
import { sessionStore, EMPTY_SESSION } from '~/lib/stores/session';
import { UnityLicenseSection } from './UnityConnection';

const writeMock = writeLicenseToWebProject as unknown as ReturnType<typeof vi.fn>;
const dropMock = dropLicenseIntoUnity as unknown as ReturnType<typeof vi.fn>;
const downloadMock = downloadLicense as unknown as ReturnType<typeof vi.fn>;
const toastSuccess = toast.success as unknown as ReturnType<typeof vi.fn>;
const toastInfo = toast.info as unknown as ReturnType<typeof vi.fn>;

const LICENSE: UnityLicense = {
  licensee: 'Ada Lovelace',
  product: 'babylontoolkit',
  project: 'Kart Racer',
  secret: 's3cr3t',
  trial: false,
  plan: 'SmallBusiness',
  org: '*',
  key: 'AAAA-BBBB-CCCC',
  s1: '',
  s2: '',
  expires: 'never',
};

type Tier = 'Indie' | 'SmallBusiness' | 'PremiumContent';
interface TierOffer {
  tier: Tier;
  label: string;
  credits: number;
  seats: { s1: string; s2: string };
  unlocked: boolean;
}

const DEFAULT_TIERS: TierOffer[] = [
  { tier: 'Indie', label: 'Indie', credits: 500, seats: { s1: 'locked', s2: 'locked' }, unlocked: false },
  { tier: 'SmallBusiness', label: 'Small Business', credits: 1000, seats: { s1: '', s2: '' }, unlocked: false },
  {
    tier: 'PremiumContent',
    label: 'Enterprise Studio',
    credits: 2000,
    seats: { s1: 'unlimited', s2: 'unlimited' },
    unlocked: false,
  },
];

function mk(body: unknown, ok = true) {
  return { ok, json: async () => body } as unknown as Response;
}

interface FetchOpts {
  linkedUnityProjectId?: string | null;
  tiers?: TierOffer[];
  generate?: unknown;
  post?: unknown;
}

/** Route the section's GET (status) and POSTs (link/unlink/generate) to test-supplied bodies. */
function stubFetch(opts: FetchOpts = {}) {
  const status = {
    linkedUnityProjectId: opts.linkedUnityProjectId ?? null,
    tiers: opts.tiers ?? DEFAULT_TIERS,
  };

  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';

    if (method === 'GET') {
      return mk(status);
    }

    const parsed = JSON.parse(String(init?.body ?? '{}')) as { action?: string };

    if (parsed.action === 'generate') {
      return mk(opts.generate ?? { license: LICENSE, tier: 'Indie', credits: 500, alreadyUnlocked: false });
    }

    return mk(opts.post ?? { ok: true });
  });

  global.fetch = fetchMock as unknown as typeof fetch;

  return fetchMock;
}

/** The parsed JSON body of the last POST to the route (asserting on `{ action, ... }`). */
function lastPostBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = [...fetchMock.mock.calls].reverse().find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');

  if (!call) {
    throw new Error('no POST was made');
  }

  return JSON.parse(String((call[1] as RequestInit).body));
}

/** The generate button, whatever price/label it currently shows. */
function generateButton() {
  return screen.getByRole('button', { name: /generate/i });
}

beforeEach(() => {
  vi.clearAllMocks();
  writeMock.mockImplementation(async () => true);
  dropMock.mockImplementation(async () => ({ ok: true, tool: 'create_asset' }));
  sessionStore.set({ ...EMPTY_SESSION, user: { ...EMPTY_SESSION.user, email: 'ada@example.com' } as never });
});

afterEach(() => {
  cleanup();
});

describe('UnityLicenseSection — link', () => {
  it('not-linked state renders the input + Link, and Link POSTs { action: link } with the entered id', async () => {
    const fetchMock = stubFetch({ linkedUnityProjectId: null });

    render(<UnityLicenseSection projectId="p1" isConnected={false} />);

    const input = (await screen.findByPlaceholderText(/5f3c9a1b/i)) as HTMLInputElement;
    const linkBtn = screen.getByRole('button', { name: 'Link' });

    // Disabled until an id is entered.
    expect(linkBtn).toBeDisabled();

    fireEvent.change(input, { target: { value: '  abc123guid  ' } });
    expect(linkBtn).not.toBeDisabled();
    fireEvent.click(linkBtn);

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());

    const body = lastPostBody(fetchMock);
    expect(body).toEqual({ action: 'link', unityProjectId: 'abc123guid' });

    // No delivery function fires on a link.
    expect(writeMock).not.toHaveBeenCalled();
    expect(dropMock).not.toHaveBeenCalled();
  });

  it('links even while the bridge is disconnected (isConnected=false)', async () => {
    const fetchMock = stubFetch({ linkedUnityProjectId: null });

    render(<UnityLicenseSection projectId="p1" isConnected={false} />);

    const input = await screen.findByPlaceholderText(/5f3c9a1b/i);
    fireEvent.change(input, { target: { value: 'guid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));

    await waitFor(() => expect(lastPostBody(fetchMock).action).toBe('link'));
  });
});

describe('UnityLicenseSection — generate', () => {
  it('Generate (disconnected) POSTs { action: generate, tier }, writes the web license, and shows manual instructions WITHOUT dropping into Unity', async () => {
    const fetchMock = stubFetch({ linkedUnityProjectId: 'unity-xyz' });

    render(<UnityLicenseSection projectId="p1" isConnected={false} />);

    // Linked view: the id and the generate/download buttons.
    expect(await screen.findByText('unity-xyz')).toBeTruthy();
    fireEvent.click(generateButton());

    await waitFor(() => expect(writeMock).toHaveBeenCalledTimes(1));

    const body = lastPostBody(fetchMock);
    expect(body.action).toBe('generate');
    expect(body.tier).toBe('Indie'); // the default selection
    expect(writeMock).toHaveBeenCalledWith(LICENSE);

    // Disconnected => no Unity drop, manual instructions shown.
    expect(dropMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/Add the license to Unity manually/i)).toBeTruthy();
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('the tier <select> chooses which tier the generate POST sends', async () => {
    const fetchMock = stubFetch({ linkedUnityProjectId: 'unity-xyz' });

    render(<UnityLicenseSection projectId="p1" isConnected={false} />);

    await screen.findByText('unity-xyz');

    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'SmallBusiness' } });

    fireEvent.click(generateButton());

    await waitFor(() => expect(writeMock).toHaveBeenCalled());
    expect(lastPostBody(fetchMock).tier).toBe('SmallBusiness');
  });

  it('the generate button shows the selected tier price', async () => {
    stubFetch({ linkedUnityProjectId: 'unity-xyz' });

    render(<UnityLicenseSection projectId="p1" isConnected={false} />);

    // Default Indie: 500 credits.
    expect(await screen.findByRole('button', { name: /Generate — 500 credits/i })).toBeTruthy();

    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'PremiumContent' } });

    // 2000 → "2,000" via toLocaleString.
    expect(await screen.findByRole('button', { name: /Generate — 2,000 credits/i })).toBeTruthy();
  });

  it('the button shows "Re-generate — free" when the selected tier is already unlocked', async () => {
    const tiers = DEFAULT_TIERS.map((t) => (t.tier === 'Indie' ? { ...t, unlocked: true } : t));
    stubFetch({ linkedUnityProjectId: 'unity-xyz', tiers });

    render(<UnityLicenseSection projectId="p1" isConnected={false} />);

    expect(await screen.findByRole('button', { name: /Re-generate — free/i })).toBeTruthy();
  });

  it('Generate (connected) drops into Unity; on { ok:false, reason } shows the reason in manual instructions and never a false success', async () => {
    dropMock.mockImplementation(async () => ({ ok: false, reason: 'Unity rejected the write' }));
    stubFetch({ linkedUnityProjectId: 'unity-xyz' });

    render(<UnityLicenseSection projectId="p1" isConnected={true} />);

    await screen.findByText('unity-xyz');
    fireEvent.click(generateButton());

    await waitFor(() => expect(dropMock).toHaveBeenCalledTimes(1));
    expect(dropMock).toHaveBeenCalledWith(LICENSE);

    // The failure surfaces the reason in the manual block and toasts info (not success).
    expect(await screen.findByText(/Automatic drop failed: Unity rejected the write/i)).toBeTruthy();
    expect(screen.getByText(/Add the license to Unity manually/i)).toBeTruthy();
    expect(toastInfo).toHaveBeenCalled();

    // The "dropped into Unity" success toast must not fire.
    expect(toastSuccess.mock.calls.some((c) => /dropped into Unity/i.test(String(c[0])))).toBe(false);
  });

  it('Download is disabled until a license has been generated', async () => {
    stubFetch({ linkedUnityProjectId: 'unity-xyz' });

    render(<UnityLicenseSection projectId="p1" isConnected={false} />);

    const download = await screen.findByRole('button', { name: 'Download' });
    expect(download).toBeDisabled();

    fireEvent.click(generateButton());
    await waitFor(() => expect(download).not.toBeDisabled());

    fireEvent.click(download);
    expect(downloadMock).toHaveBeenCalledWith(LICENSE);
  });
});

describe('UnityLicenseSection — tier explanation', () => {
  const cases: Array<{ value: Tier; match: RegExp }> = [
    { value: 'Indie', match: /Issued to your account email \(ada@example\.com\).*Unity account email must match/i },
    { value: 'SmallBusiness', match: /Two blank, editable seats/i },
    { value: 'PremiumContent', match: /Unlimited seats/i },
  ];

  for (const { value, match } of cases) {
    it(`renders ${value} copy when selected`, async () => {
      stubFetch({ linkedUnityProjectId: 'unity-xyz' });

      render(<UnityLicenseSection projectId="p1" isConnected={false} />);

      const select = await screen.findByRole('combobox');
      fireEvent.change(select, { target: { value } });

      expect(await screen.findByText(match)).toBeTruthy();
    });
  }
});

describe('UnityLicenseSection — unlink', () => {
  it('Unlink POSTs { action: unlink } and calls no delivery function', async () => {
    const fetchMock = stubFetch({ linkedUnityProjectId: 'unity-xyz' });

    render(<UnityLicenseSection projectId="p1" isConnected={false} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(lastPostBody(fetchMock)).toEqual({ action: 'unlink' });

    expect(writeMock).not.toHaveBeenCalled();
    expect(dropMock).not.toHaveBeenCalled();
    expect(downloadMock).not.toHaveBeenCalled();
  });
});
