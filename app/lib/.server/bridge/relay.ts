/**
 * Unity Bridge relay — the in-memory half of the bridge (SPEC §4.17, D4, D5, D13).
 *
 * The Desktop Agent long-polls `POST /api/bridge/poll`. Workerd forbids writing to a socket from another
 * request, but a promise resolves across requests (`mcp-relay.ts` relies on the same fact), so a poll
 * PARKS here as a waiter and a job enqueued by a generation resolves it.
 *
 * ONE server instance holds all of this (D5): presence, per-device queues, parked polls and job
 * handles. Nothing here is persisted — durable facts (the job rows) are the service's business. A
 * restart loses queued jobs; their pickup timeout marks them cancelled.
 *
 * The one latch: an entry marked `dropped` (cancelled before it started) never accepts another event.
 * A late `started` returns `false` and `onEvent` is never called, so a cancelled job can never be turned
 * back into a running one. (Bridge operations are not billed separately — D53.)
 */
import {
  BRIDGE_JOB_RETENTION_MS,
  BRIDGE_PRESENCE_MS,
  type BridgeCancel,
  type BridgeDispatch,
  type BridgeHello,
  type BridgeJobEvent,
  type BridgePollResponse,
  type BridgeResultPayload,
} from '~/lib/bridge/protocol';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('bridge.relay');

type EntryState = 'queued' | 'dispatched' | 'started' | 'final' | 'refused' | 'dropped';
type FinalValue = BridgeResultPayload | 'refused' | null;

interface Entry {
  dispatch: BridgeDispatch;
  userId: string;
  deviceId: string;
  generationId?: string;
  state: EntryState;
  onEvent: (event: BridgeJobEvent) => void;
  startedWaiters: Array<(v: boolean) => void>;
  finalWaiters: Array<(v: FinalValue) => void>;
  final?: BridgeResultPayload;
}

interface DeviceState {
  lastSeen: number;
  hello?: BridgeHello;
  queue: Entry[];
  cancels: BridgeCancel[];
  waiter?: (r: BridgePollResponse) => void;
}

export interface JobHandle {
  jobId: string;
  waitStarted(timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  waitFinal(timeoutMs: number, signal?: AbortSignal): Promise<BridgeResultPayload | 'refused' | null>; // null = still running
}

const devices = new Map<string, DeviceState>();
const jobs = new Map<string, Entry>();

const empty = (): BridgePollResponse => ({ jobs: [], cancels: [] });

function deviceState(deviceId: string): DeviceState {
  let state = devices.get(deviceId);

  if (!state) {
    state = { lastSeen: 0, queue: [], cancels: [] };
    devices.set(deviceId, state);
  }

  return state;
}

/** Hand everything pending to the helper: queued jobs become `dispatched`, pending cancels are drained. */
function take(state: DeviceState): BridgePollResponse {
  const dispatched = state.queue.splice(0);

  for (const entry of dispatched) {
    entry.state = 'dispatched';
  }

  return { jobs: dispatched.map((entry) => entry.dispatch), cancels: state.cancels.splice(0) };
}

/** A parked poll is released the moment there is something for it. */
function flush(state: DeviceState): void {
  if (state.waiter && (state.queue.length > 0 || state.cancels.length > 0)) {
    const waiter = state.waiter;
    state.waiter = undefined;
    waiter(take(state));
  }
}

function scheduleRemoval(jobId: string): void {
  const timer = setTimeout(() => jobs.delete(jobId), BRIDGE_JOB_RETENTION_MS) as unknown as { unref?: () => void };
  timer.unref?.();
}

function removeFromQueue(entry: Entry): void {
  const state = devices.get(entry.deviceId);

  if (state) {
    state.queue = state.queue.filter((queued) => queued !== entry);
  }
}

/** Resolve every waiter of an entry that will never start (dropped): not started, no final. */
function settleDroppedEntry(entry: Entry): void {
  entry.state = 'dropped';
  removeFromQueue(entry);

  for (const resolve of entry.startedWaiters.splice(0)) {
    resolve(false);
  }

  for (const resolve of entry.finalWaiters.splice(0)) {
    resolve(null);
  }

  scheduleRemoval(entry.dispatch.jobId);
}

function callOnEvent(entry: Entry, event: BridgeJobEvent): void {
  try {
    const result = entry.onEvent(event) as unknown;

    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      (result as Promise<unknown>).catch((error) =>
        logger.error(`onEvent failed for ${event.jobId}: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
  } catch (error) {
    logger.error(`onEvent failed for ${event.jobId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Park a waiter on a list until it is resolved by the relay, the timeout elapses, or the signal aborts.
 * The list entry is removed on timeout/abort so a settled job never calls a dead waiter.
 */
function park<T>(list: Array<(v: T) => void>, fallback: T, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve) => {
    if (signal?.aborted) {
      resolve(fallback);
      return;
    }

    let done = false;

    const finish = (value: T) => {
      if (done) {
        return;
      }

      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);

      const index = list.indexOf(waiter);

      if (index >= 0) {
        list.splice(index, 1);
      }

      resolve(value);
    };
    const waiter = (value: T) => finish(value);
    const onAbort = () => finish(fallback);
    const timer = setTimeout(() => finish(fallback), Math.max(0, timeoutMs));

    list.push(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function handleFor(entry: Entry): JobHandle {
  return {
    jobId: entry.dispatch.jobId,

    waitStarted(timeoutMs, signal) {
      if (entry.state === 'started' || entry.state === 'final' || entry.state === 'refused') {
        return Promise.resolve(true);
      }

      if (entry.state === 'dropped') {
        return Promise.resolve(false);
      }

      return park(entry.startedWaiters, false, timeoutMs, signal);
    },

    waitFinal(timeoutMs, signal) {
      if (entry.state === 'final') {
        return Promise.resolve(entry.final ?? null);
      }

      if (entry.state === 'refused') {
        return Promise.resolve('refused' as const);
      }

      if (entry.state === 'dropped') {
        return Promise.resolve(null);
      }

      return park<FinalValue>(entry.finalWaiters, null, timeoutMs, signal);
    },
  };
}

export function touchDevice(deviceId: string, hello: BridgeHello | undefined, now: number = Date.now()): void {
  const state = deviceState(deviceId);
  state.lastSeen = now;

  if (hello) {
    state.hello = hello;
  }
}

export function isDevicePresent(deviceId: string, now: number = Date.now()): boolean {
  const state = devices.get(deviceId);

  return Boolean(state && state.lastSeen > 0 && now - state.lastSeen < BRIDGE_PRESENCE_MS);
}

/** When the device last polled this instance (epoch ms), or 0 if never — orders present devices (D54). */
export function deviceLastSeen(deviceId: string): number {
  return devices.get(deviceId)?.lastSeen ?? 0;
}

export function deviceHello(deviceId: string): BridgeHello | undefined {
  return devices.get(deviceId)?.hello;
}

export function enqueueBridgeJob(input: {
  deviceId: string;
  userId: string;
  generationId?: string;
  dispatch: BridgeDispatch;
  onEvent: (event: BridgeJobEvent) => void;
}): JobHandle {
  const entry: Entry = {
    dispatch: input.dispatch,
    userId: input.userId,
    deviceId: input.deviceId,
    generationId: input.generationId,
    state: 'queued',
    onEvent: input.onEvent,
    startedWaiters: [],
    finalWaiters: [],
  };

  jobs.set(input.dispatch.jobId, entry);

  const state = deviceState(input.deviceId);
  state.queue.push(entry);
  flush(state);

  return handleFor(entry);
}

/** Ownership by userId: another user's job id is `null`, exactly like an unknown one. */
export function getJobHandle(jobId: string, userId: string): JobHandle | null {
  const entry = jobs.get(jobId);

  return entry && entry.userId === userId ? handleFor(entry) : null;
}

export async function pollBridgeJobs(
  deviceId: string,
  holdMs: number,
  signal?: AbortSignal,
): Promise<BridgePollResponse> {
  touchDevice(deviceId, undefined);

  const state = deviceState(deviceId);

  if (state.queue.length > 0 || state.cancels.length > 0) {
    return take(state);
  }

  // One parked poll per device: a newer poll replaces (and releases) the older one.
  if (state.waiter) {
    const previous = state.waiter;
    state.waiter = undefined;
    previous(empty());
  }

  if (signal?.aborted) {
    return empty();
  }

  return new Promise<BridgePollResponse>((resolve) => {
    let done = false;

    const finish = (response: BridgePollResponse) => {
      if (done) {
        return;
      }

      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);

      if (state.waiter === waiter) {
        state.waiter = undefined;
      }

      resolve(response);
    };
    const waiter = (response: BridgePollResponse) => finish(response);
    const onAbort = () => finish(empty());
    const timer = setTimeout(() => finish(empty()), Math.max(0, holdMs));

    state.waiter = waiter;
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** false if the job is unknown, not this device's, dropped (D13), or already settled. */
export function deliverBridgeEvent(deviceId: string, event: BridgeJobEvent): boolean {
  const entry = jobs.get(event.jobId);

  if (!entry || entry.deviceId !== deviceId) {
    return false;
  }

  if (entry.state === 'dropped' || entry.state === 'final' || entry.state === 'refused') {
    return false;
  }

  switch (event.type) {
    case 'started': {
      if (entry.state === 'queued' || entry.state === 'dispatched') {
        removeFromQueue(entry);
        entry.state = 'started';

        for (const resolve of entry.startedWaiters.splice(0)) {
          resolve(true);
        }
      }

      callOnEvent(entry, event);

      return true;
    }

    case 'progress': {
      callOnEvent(entry, event);
      return true;
    }

    case 'final': {
      removeFromQueue(entry);
      entry.state = 'final';
      entry.final = event.result;

      for (const resolve of entry.startedWaiters.splice(0)) {
        resolve(true);
      }

      for (const resolve of entry.finalWaiters.splice(0)) {
        resolve(event.result);
      }

      callOnEvent(entry, event);
      scheduleRemoval(event.jobId);

      return true;
    }

    case 'refused': {
      removeFromQueue(entry);
      entry.state = 'refused';

      // Picked up but refused before running: the started waiters are released and waitFinal reports the refusal.
      for (const resolve of entry.startedWaiters.splice(0)) {
        resolve(true);
      }

      for (const resolve of entry.finalWaiters.splice(0)) {
        resolve('refused');
      }

      callOnEvent(entry, event);
      scheduleRemoval(event.jobId);

      return true;
    }

    default:
      return false;
  }
}

export function cancelBridgeJob(jobId: string, userId: string): 'dropped' | 'signalled' | 'unknown' {
  const entry = jobs.get(jobId);

  if (!entry || entry.userId !== userId) {
    return 'unknown';
  }

  switch (entry.state) {
    case 'queued': {
      settleDroppedEntry(entry);
      return 'dropped';
    }

    case 'dispatched': {
      // It never started, so it is cancellable — AND the helper holds it, so tell the helper too.
      settleDroppedEntry(entry);

      const state = deviceState(entry.deviceId);
      state.cancels.push({ jobId, cancel: true });
      flush(state);

      return 'dropped';
    }

    case 'started': {
      // The run began: only the cancel signal goes out.
      const state = deviceState(entry.deviceId);
      state.cancels.push({ jobId, cancel: true });
      flush(state);

      return 'signalled';
    }

    default:
      return 'unknown';
  }
}

/** Drops QUEUED jobs of that generation; returns their ids. */
export function cancelGenerationBridgeJobs(generationId: string): string[] {
  const dropped: string[] = [];

  for (const entry of jobs.values()) {
    if (entry.generationId === generationId && entry.state === 'queued') {
      settleDroppedEntry(entry);
      dropped.push(entry.dispatch.jobId);
    }
  }

  return dropped;
}

/**
 * On revoke/logout: marks queued AND dispatched-not-started entries 'dropped'; returns their ids. The
 * device's presence is forgotten and any parked poll is released empty.
 */
export function dropDevice(deviceId: string): string[] {
  const dropped: string[] = [];

  for (const entry of jobs.values()) {
    if (entry.deviceId === deviceId && (entry.state === 'queued' || entry.state === 'dispatched')) {
      settleDroppedEntry(entry);
      dropped.push(entry.dispatch.jobId);
    }
  }

  const state = devices.get(deviceId);

  if (state?.waiter) {
    const waiter = state.waiter;
    state.waiter = undefined;
    waiter(empty());
  }

  devices.delete(deviceId);

  return dropped;
}

export function resetBridgeRelayForTests(): void {
  for (const state of devices.values()) {
    const waiter = state.waiter;
    state.waiter = undefined;
    waiter?.(empty());
  }

  devices.clear();
  jobs.clear();
}
