// @vitest-environment jsdom
/**
 * The consent prompt (SPEC §4.17, D16) — unchanged by D55, which kept it as one of the two popups.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { UnityBridgeConsentDialog } = await import('./UnityBridgeConsentDialog');
const { bridgeConsentStore, resetUnityBridgeStoresForTests, updateBridgeFromPart } = await import(
  '~/lib/stores/unity-bridge'
);

let fetchMock: ReturnType<typeof vi.fn>;

const posted = () =>
  fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) }));

beforeEach(() => {
  resetUnityBridgeStoresForTests();
  fetchMock = vi.fn(async () => new Response('{"ok":true}'));
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
      operation: 'unity.cli uninstall 6000.0.0f1',
      target: 'Racer',
      tier: 'consent',
      generationId: 'gen_9',
    });

  it('shows the operation, and Allow once posts approved:true', async () => {
    raise();
    render(<UnityBridgeConsentDialog />);

    expect(screen.getByText('Allow this Unity operation?')).toBeTruthy();
    expect(screen.getByText('unity.cli uninstall 6000.0.0f1')).toBeTruthy();
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

  it('sits above every other bridge dialog (important z-index — the shared Dialog is z-[9999])', () => {
    raise();
    render(<UnityBridgeConsentDialog />);

    expect(screen.getByRole('dialog').className).toContain('!z-[10000]');
  });

  it('closes when the server ends the wait (closed part for the same call)', async () => {
    raise();
    render(<UnityBridgeConsentDialog />);
    expect(screen.getByText('Allow this Unity operation?')).toBeTruthy();

    updateBridgeFromPart({ type: 'bridge-consent', toolCallId: 'call_9', closed: true, generationId: 'gen_9' });

    await waitFor(() => expect(screen.queryByText('Allow this Unity operation?')).toBeNull());
    expect(posted()).toEqual([]);
  });

  it('Deny posts approved:false', async () => {
    raise();
    render(<UnityBridgeConsentDialog />);

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));

    await waitFor(() => expect(posted()[0]?.body.result).toEqual({ approved: false }));
  });
});
