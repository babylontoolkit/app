// @vitest-environment jsdom
/**
 * The Unity capture popup (SPEC §4.17, D55) — the user sees what the model was shown, in a popup that
 * replaced the Jobs panel's thumbnail. Never over a pending consent prompt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { UnityCapturePopup } = await import('./UnityCapturePopup');
const { bridgeCaptureStore, bridgeConsentStore, resetUnityBridgeStoresForTests, updateBridgeFromPart } = await import(
  '~/lib/stores/unity-bridge'
);

const image = { base64: 'iVBORw0KGgo=', mimeType: 'image/png' as const };

const capturePart = (jobId = 'brg_cap') => ({
  type: 'bridge-job',
  jobId,
  generationId: 'gen_1',
  status: 'succeeded',
  label: 'unity_capture game',
  image,
});

beforeEach(() => resetUnityBridgeStoresForTests());

afterEach(() => {
  cleanup();
  resetUnityBridgeStoresForTests();
});

describe('UnityCapturePopup', () => {
  it('renders nothing without a capture', () => {
    const { container } = render(<UnityCapturePopup />);

    expect(container.innerHTML).toBe('');
    expect(screen.queryByText('Unity capture')).toBeNull();
  });

  it('opens when a bridge-job part carrying an image arrives, showing the picture', () => {
    render(<UnityCapturePopup />);

    act(() => updateBridgeFromPart(capturePart()));

    expect(screen.getByText('Unity capture')).toBeTruthy();
    expect(screen.getByText('unity_capture game')).toBeTruthy();
    expect(screen.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  it('clicking the picture toggles full size', () => {
    render(<UnityCapturePopup />);
    act(() => updateBridgeFromPart(capturePart()));

    expect(screen.getByRole('img').className).not.toContain('max-w-none');

    fireEvent.click(screen.getByTestId('bridge-capture-image'));
    expect(screen.getByRole('img').className).toContain('max-w-none');

    fireEvent.click(screen.getByTestId('bridge-capture-image'));
    expect(screen.getByRole('img').className).not.toContain('max-w-none');
  });

  it('Close dismisses it, and the replayed part (same bytes) does not re-open it', () => {
    render(<UnityCapturePopup />);
    act(() => updateBridgeFromPart(capturePart()));

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(bridgeCaptureStore.get()).toBeNull();
    expect(screen.queryByText('Unity capture')).toBeNull();

    act(() => updateBridgeFromPart(capturePart()));
    expect(screen.queryByText('Unity capture')).toBeNull();
  });

  it('never opens over a pending consent prompt; it opens once the prompt closes', () => {
    render(<UnityCapturePopup />);

    act(() => {
      updateBridgeFromPart({
        type: 'bridge-consent',
        toolCallId: 'call_1',
        operation: 'unity.cli uninstall 6000.0.0f1',
        target: 'Racer',
        tier: 'consent',
        generationId: 'gen_1',
      });
      updateBridgeFromPart(capturePart());
    });

    expect(bridgeConsentStore.get()).not.toBeNull();
    expect(screen.queryByText('Unity capture')).toBeNull();

    act(() =>
      updateBridgeFromPart({ type: 'bridge-consent', toolCallId: 'call_1', closed: true, generationId: 'gen_1' }),
    );

    expect(screen.getByText('Unity capture')).toBeTruthy();
  });

  it('a part without an image never opens it (control)', () => {
    render(<UnityCapturePopup />);

    act(() =>
      updateBridgeFromPart({
        type: 'bridge-job',
        jobId: 'brg_x',
        generationId: 'gen_1',
        status: 'succeeded',
        label: 'set_transform',
      }),
    );

    expect(screen.queryByText('Unity capture')).toBeNull();
  });
});
