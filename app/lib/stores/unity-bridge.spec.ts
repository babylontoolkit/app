import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_MAX_IMAGE_BASE64 } from '~/lib/bridge/protocol';
import {
  answerConsent,
  beginBridgeScan,
  bridgeCaptureStore,
  bridgeConsentStore,
  bridgeDialogStore,
  bridgeLiveJobsStore,
  clearBridgeConsent,
  bridgeStatusStore,
  mintInstallCode,
  refreshBridgeStatus,
  resetUnityBridgeStoresForTests,
  updateBridgeFromPart,
} from './unity-bridge';

const consentPart = {
  type: 'bridge-consent',
  toolCallId: 'call_1',
  operation: 'unity.cli license activate',
  target: 'MyGame',
  tier: 'consent',
  generationId: 'gen_1',
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('unity-bridge store', () => {
  beforeEach(() => {
    resetUnityBridgeStoresForTests();
  });

  afterEach(() => {
    resetUnityBridgeStoresForTests();
    vi.unstubAllGlobals();
  });

  it('sets the consent store once for the same consent part presented twice', () => {
    const listener = vi.fn();
    const unsubscribe = bridgeConsentStore.listen(listener);

    updateBridgeFromPart(consentPart);
    updateBridgeFromPart(consentPart);

    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(bridgeConsentStore.get()).toEqual({
      generationId: 'gen_1',
      toolCallId: 'call_1',
      operation: 'unity.cli license activate',
      target: 'MyGame',
    });
  });

  it('never re-raises an answered consent when the part is replayed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ delivered: true })),
    );
    updateBridgeFromPart(consentPart);
    await answerConsent(false);
    updateBridgeFromPart(consentPart);
    expect(bridgeConsentStore.get()).toBeNull();
  });

  it('answerConsent(true) posts consent:<id> with {approved:true} and clears the store', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ delivered: true }));
    vi.stubGlobal('fetch', fetchMock);
    updateBridgeFromPart(consentPart);

    await answerConsent(true);

    expect(bridgeConsentStore.get()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/agent/tool-result');
    expect(JSON.parse(String(init.body))).toEqual({
      generationId: 'gen_1',
      toolCallId: 'consent:call_1',
      result: { approved: true },
    });
  });

  it('dedupes job lines by count across replayed scans and never moves a status backwards', () => {
    const parts = [
      { type: 'bridge-job', jobId: 'brg_1', status: 'queued', label: 'Export', generationId: 'gen_1' },
      {
        type: 'bridge-job',
        jobId: 'brg_1',
        status: 'running',
        label: 'Export',
        line: 'a',
        generationId: 'gen_1',
      },
      {
        type: 'bridge-job',
        jobId: 'brg_1',
        status: 'running',
        label: 'Export',
        line: 'a',
        generationId: 'gen_1',
      },
    ];

    for (let scan = 0; scan < 3; scan++) {
      beginBridgeScan();
      parts.forEach(updateBridgeFromPart);
    }

    expect(bridgeLiveJobsStore.get().brg_1).toMatchObject({
      status: 'running',
      lines: ['a', 'a'],
      generationId: 'gen_1',
    });

    beginBridgeScan();
    [...parts, { ...parts[0], status: 'succeeded' }].forEach(updateBridgeFromPart);
    beginBridgeScan();
    parts.forEach(updateBridgeFromPart);
    expect(bridgeLiveJobsStore.get().brg_1.status).toBe('succeeded');
  });

  it('refreshBridgeStatus sets null on a 404 (not your project)', async () => {
    bridgeStatusStore.set({ enabled: true, state: 'unpaired', productionOrigin: null });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: true, message: 'Not found' }, 404)),
    );
    await refreshBridgeStatus('prj_x');
    expect(bridgeStatusStore.get()).toBeNull();
  });

  it("mintInstallCode posts {action:'invite'} and returns the code", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ code: 'K7QM-2XWD', expiresAt: '2026-09-29T12:10:00.000Z' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(mintInstallCode()).resolves.toEqual({
      ok: true,
      code: 'K7QM-2XWD',
      expiresAt: '2026-09-29T12:10:00.000Z',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/bridge/devices',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'invite' }) }),
    );
  });

  it("mintInstallCode returns the server's message when minting fails (e.g. the rate limit)", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: true, message: 'Too many bridge install codes.' }, 429)),
    );
    await expect(mintInstallCode()).resolves.toEqual({ ok: false, message: 'Too many bridge install codes.' });
  });

  it('mintInstallCode returns {ok:false} rather than throwing when the network fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    await expect(mintInstallCode()).resolves.toEqual({ ok: false, message: 'offline' });
  });

  it('a closed consent part clears the prompt for THAT call only, and a replay never re-opens it', () => {
    updateBridgeFromPart(consentPart);
    updateBridgeFromPart({ type: 'bridge-consent', toolCallId: 'call_other', closed: true, generationId: 'gen_1' });
    expect(bridgeConsentStore.get()?.toolCallId).toBe('call_1');

    updateBridgeFromPart({ type: 'bridge-consent', toolCallId: 'call_1', closed: true, generationId: 'gen_1' });
    expect(bridgeConsentStore.get()).toBeNull();

    // useChat re-presents the whole data array: the request part comes round again.
    updateBridgeFromPart(consentPart);
    expect(bridgeConsentStore.get()).toBeNull();
  });

  it('clearBridgeConsent (the turn stopped streaming) closes an open prompt and latches it', () => {
    updateBridgeFromPart(consentPart);
    clearBridgeConsent();
    expect(bridgeConsentStore.get()).toBeNull();

    updateBridgeFromPart(consentPart);
    expect(bridgeConsentStore.get()).toBeNull();
  });

  describe('capture images', () => {
    const image = { base64: 'iVBORw0KGgo=', mimeType: 'image/png' };
    const job = (extra: Record<string, unknown> = {}) => ({
      type: 'bridge-job',
      jobId: 'brg_cap',
      generationId: 'gen_1',
      label: 'unity_capture game',
      ...extra,
    });

    it('keeps the latest image per job and opens the capture popup once, when the capture lands (D55)', () => {
      updateBridgeFromPart(job({ status: 'running' }));
      expect(bridgeCaptureStore.get()).toBeNull();

      updateBridgeFromPart(job({ status: 'succeeded', image }));
      expect(bridgeLiveJobsStore.get().brg_cap.image).toEqual(image);
      expect(bridgeCaptureStore.get()).toEqual({ jobId: 'brg_cap', label: 'unity_capture game', image });
      expect(bridgeDialogStore.get()).toBeNull(); // no Jobs panel any more

      // The user closes it; the replayed part (same bytes) must not re-open it.
      bridgeCaptureStore.set(null);
      beginBridgeScan();
      updateBridgeFromPart(job({ status: 'running' }));
      updateBridgeFromPart(job({ status: 'succeeded', image }));
      expect(bridgeCaptureStore.get()).toBeNull();
      expect(bridgeLiveJobsStore.get().brg_cap.image).toEqual(image);
    });

    it('never opens over a pending consent prompt — the capture waits and opens when the prompt closes', () => {
      updateBridgeFromPart(consentPart);
      updateBridgeFromPart(job({ status: 'succeeded', image }));
      expect(bridgeCaptureStore.get()).toBeNull();
      expect(bridgeLiveJobsStore.get().brg_cap.image).toEqual(image);

      updateBridgeFromPart({ type: 'bridge-consent', toolCallId: 'call_1', closed: true, generationId: 'gen_1' });
      expect(bridgeCaptureStore.get()?.jobId).toBe('brg_cap');
    });

    it('a consent prompt arriving over an open capture moves the capture aside, and it returns after', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ delivered: true })),
      );

      updateBridgeFromPart(job({ status: 'succeeded', image }));
      expect(bridgeCaptureStore.get()).not.toBeNull();

      updateBridgeFromPart(consentPart);
      expect(bridgeCaptureStore.get()).toBeNull();
      expect(bridgeConsentStore.get()).not.toBeNull();

      await answerConsent(true);
      expect(bridgeCaptureStore.get()?.jobId).toBe('brg_cap');
    });

    it('drops an image over the cap, or one that is not a PNG', () => {
      updateBridgeFromPart(
        job({ status: 'succeeded', image: { base64: 'A'.repeat(BRIDGE_MAX_IMAGE_BASE64 + 1), mimeType: 'image/png' } }),
      );
      updateBridgeFromPart(
        job({ jobId: 'brg_svg', status: 'succeeded', image: { base64: 'PHN2Zz4=', mimeType: 'image/svg+xml' } }),
      );

      expect(bridgeLiveJobsStore.get().brg_cap.image).toBeUndefined();
      expect(bridgeLiveJobsStore.get().brg_svg.image).toBeUndefined();
      expect(bridgeCaptureStore.get()).toBeNull();
    });
  });
});
