import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeDispatch, BridgeJobEvent, BridgeResultPayload } from '~/lib/bridge/protocol';
import {
  cancelBridgeJob,
  cancelGenerationBridgeJobs,
  deliverBridgeEvent,
  dropDevice,
  enqueueBridgeJob,
  getJobHandle,
  isDevicePresent,
  pollBridgeJobs,
  resetBridgeRelayForTests,
  touchDevice,
} from './relay';

const dispatch = (jobId: string): BridgeDispatch => ({
  jobId,
  op: { kind: 'unity.command', name: 'set_transform', params: {} },
  allowScripts: false,
  consentGranted: false,
});

function enqueue(jobId: string, opts: { deviceId?: string; generationId?: string } = {}) {
  const onEvent = vi.fn<(event: BridgeJobEvent) => void>();
  const handle = enqueueBridgeJob({
    deviceId: opts.deviceId ?? 'dev_1',
    userId: 'u1',
    generationId: opts.generationId,
    dispatch: dispatch(jobId),
    onEvent,
  });

  return { handle, onEvent };
}

const RESULT: BridgeResultPayload = { ok: true, text: 'done' };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-29T12:00:00.000Z'));
  resetBridgeRelayForTests();
});

afterEach(() => {
  resetBridgeRelayForTests();
  vi.useRealTimers();
});

describe('bridge relay', () => {
  it('a poll with an empty queue parks and resolves when a job is enqueued (same tick after enqueue)', async () => {
    let settled: unknown = null;
    const poll = pollBridgeJobs('dev_1', 25_000).then((r) => (settled = r));

    await Promise.resolve();
    expect(settled).toBeNull();

    enqueue('brg_1');
    await poll;

    expect(settled).toEqual({ jobs: [dispatch('brg_1')], cancels: [] });
  });

  it('the hold elapses → {jobs:[],cancels:[]}', async () => {
    const poll = pollBridgeJobs('dev_1', 25_000);
    await vi.advanceTimersByTimeAsync(25_000);

    expect(await poll).toEqual({ jobs: [], cancels: [] });
  });

  it('an aborted poll resolves empty', async () => {
    const controller = new AbortController();
    const poll = pollBridgeJobs('dev_1', 25_000, controller.signal);
    controller.abort();

    expect(await poll).toEqual({ jobs: [], cancels: [] });
  });

  it('a second poll replaces the first waiter (the first resolves empty)', async () => {
    const first = pollBridgeJobs('dev_1', 25_000);
    const second = pollBridgeJobs('dev_1', 25_000);

    expect(await first).toEqual({ jobs: [], cancels: [] });

    enqueue('brg_1');
    expect((await second).jobs.map((j) => j.jobId)).toEqual(['brg_1']);
  });

  it('a queued job is returned immediately by the next poll, first in first out', async () => {
    enqueue('brg_1');
    enqueue('brg_2');

    expect((await pollBridgeJobs('dev_1', 25_000)).jobs.map((j) => j.jobId)).toEqual(['brg_1', 'brg_2']);
  });

  it('deliverBridgeEvent from a different device → false', async () => {
    const { onEvent } = enqueue('brg_1');
    await pollBridgeJobs('dev_1', 25_000);

    expect(deliverBridgeEvent('dev_2', { jobId: 'brg_1', type: 'started' })).toBe(false);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('started → waitStarted true', async () => {
    const { handle, onEvent } = enqueue('brg_1');
    await pollBridgeJobs('dev_1', 25_000);

    const started = handle.waitStarted(30_000);
    expect(deliverBridgeEvent('dev_1', { jobId: 'brg_1', type: 'started' })).toBe(true);

    expect(await started).toBe(true);
    expect(onEvent).toHaveBeenCalledWith({ jobId: 'brg_1', type: 'started' });
    expect(await handle.waitStarted(1)).toBe(true);
  });

  it('waitStarted times out → false', async () => {
    const { handle } = enqueue('brg_1');
    const started = handle.waitStarted(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await started).toBe(false);
  });

  it('final → waitFinal returns the payload', async () => {
    const { handle } = enqueue('brg_1');
    await pollBridgeJobs('dev_1', 25_000);
    deliverBridgeEvent('dev_1', { jobId: 'brg_1', type: 'started' });

    const final = handle.waitFinal(60_000);
    deliverBridgeEvent('dev_1', { jobId: 'brg_1', type: 'final', result: RESULT });

    expect(await final).toEqual(RESULT);
    expect(await getJobHandle('brg_1', 'u1')!.waitFinal(1)).toEqual(RESULT);
  });

  it('refused → "refused"', async () => {
    const { handle } = enqueue('brg_1');
    await pollBridgeJobs('dev_1', 25_000);

    const final = handle.waitFinal(60_000);
    deliverBridgeEvent('dev_1', { jobId: 'brg_1', type: 'refused', reason: 'scripts are off' });

    expect(await final).toBe('refused');
    expect(await handle.waitStarted(1)).toBe(true);
  });

  it('waitFinal timeout → null', async () => {
    const { handle } = enqueue('brg_1');
    const final = handle.waitFinal(60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await final).toBeNull();
  });

  it('getJobHandle is ownership-checked', () => {
    enqueue('brg_1');

    expect(getJobHandle('brg_1', 'u1')).not.toBeNull();
    expect(getJobHandle('brg_1', 'u2')).toBeNull();
    expect(cancelBridgeJob('brg_1', 'u2')).toBe('unknown');
  });

  it('cancelBridgeJob on queued → "dropped", and the job never dispatches', async () => {
    enqueue('brg_1');

    expect(cancelBridgeJob('brg_1', 'u1')).toBe('dropped');

    const poll = pollBridgeJobs('dev_1', 25_000);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await poll).toEqual({ jobs: [], cancels: [] });
  });

  it('on dispatched (not started) → "dropped", and the next poll carries the cancel', async () => {
    enqueue('brg_1');
    await pollBridgeJobs('dev_1', 25_000);

    expect(cancelBridgeJob('brg_1', 'u1')).toBe('dropped');
    expect(await pollBridgeJobs('dev_1', 25_000)).toEqual({ jobs: [], cancels: [{ jobId: 'brg_1', cancel: true }] });
  });

  it('on started → "signalled", and the next poll carries the cancel', async () => {
    const { handle } = enqueue('brg_1');
    await pollBridgeJobs('dev_1', 25_000);
    deliverBridgeEvent('dev_1', { jobId: 'brg_1', type: 'started' });

    expect(cancelBridgeJob('brg_1', 'u1')).toBe('signalled');
    expect(await pollBridgeJobs('dev_1', 25_000)).toEqual({ jobs: [], cancels: [{ jobId: 'brg_1', cancel: true }] });

    // It began — the helper finishes it, and a final still lands.
    expect(deliverBridgeEvent('dev_1', { jobId: 'brg_1', type: 'final', result: RESULT })).toBe(true);
    expect(await handle.waitFinal(1)).toEqual(RESULT);
  });

  it('a started event for a dropped entry → deliverBridgeEvent returns false and onEvent is not called', async () => {
    const { onEvent } = enqueue('brg_1');
    await pollBridgeJobs('dev_1', 25_000);
    cancelBridgeJob('brg_1', 'u1');

    expect(deliverBridgeEvent('dev_1', { jobId: 'brg_1', type: 'started' })).toBe(false);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('dropDevice returns the ids of queued and dispatched-not-started entries only', async () => {
    enqueue('brg_dispatched');
    enqueue('brg_started');
    await pollBridgeJobs('dev_1', 25_000);
    deliverBridgeEvent('dev_1', { jobId: 'brg_started', type: 'started' });
    enqueue('brg_queued');
    enqueue('brg_other_device', { deviceId: 'dev_2' });

    expect(dropDevice('dev_1').sort()).toEqual(['brg_dispatched', 'brg_queued']);
    expect(deliverBridgeEvent('dev_1', { jobId: 'brg_queued', type: 'started' })).toBe(false);
  });

  it('cancelGenerationBridgeJobs drops only queued jobs of that generation', async () => {
    enqueue('brg_a', { generationId: 'gen_1' });
    await pollBridgeJobs('dev_1', 25_000); // brg_a is now dispatched
    enqueue('brg_b', { generationId: 'gen_1' });
    enqueue('brg_c', { generationId: 'gen_2' });

    expect(cancelGenerationBridgeJobs('gen_1')).toEqual(['brg_b']);
    expect((await pollBridgeJobs('dev_1', 25_000)).jobs.map((j) => j.jobId)).toEqual(['brg_c']);
  });

  it('isDevicePresent is false after 45 s', () => {
    const now = Date.now();
    touchDevice('dev_1', undefined, now);

    expect(isDevicePresent('dev_1', now + 44_999)).toBe(true);
    expect(isDevicePresent('dev_1', now + 45_000)).toBe(false);
    expect(isDevicePresent('dev_never', now)).toBe(false);
  });

  it('a settled job is forgotten after the retention window', async () => {
    enqueue('brg_1');
    await pollBridgeJobs('dev_1', 25_000);
    deliverBridgeEvent('dev_1', { jobId: 'brg_1', type: 'final', result: RESULT });

    await vi.advanceTimersByTimeAsync(600_000);
    expect(getJobHandle('brg_1', 'u1')).toBeNull();
  });
});
