/**
 * The client media-task poller (§4.16) — pins the TERMINAL LATCH.
 *
 * The chat-data effect replays every `media-task` data part on every stream chunk, so `trackMediaTask`
 * being called N times for one task is the NORMAL case, not an edge. Before the latch, each replay of
 * a finished task re-fetched the bytes, re-wrote the file, and re-toasted — observed live as ~100
 * success toasts for three images on one creation. These tests drive the real module with only the
 * network, the workbench store, and the toaster mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-toastify', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('~/lib/stores/workbench', () => ({
  workbenchStore: { createFile: vi.fn(async () => true) },
}));

import { toast } from 'react-toastify';
import { workbenchStore } from '~/lib/stores/workbench';
import { trackMediaTask } from './tasks';

type FetchMock = ReturnType<typeof vi.fn>;

/** One poll route answering `status`, one file route answering bytes — counted separately. */
function mockRoutes(status: 'succeeded' | 'failed') {
  const fileFetches = { count: 0 };

  (globalThis.fetch as unknown as FetchMock) = vi.fn(async (url: string) => {
    if (String(url).endsWith('/file')) {
      fileFetches.count++;

      return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as Response;
    }

    return { ok: true, json: async () => ({ task: { status } }) } as Response;
  });

  return fileFetches;
}

let n = 0;

/** Unique per test — the latch is module-level state shared across this whole spec file. */
function handle(kind: 'image' | 'video' = 'image') {
  return { projectId: 'p1', taskId: `med_test_${n++}`, destPath: 'public/assets/generated/a.png', kind };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('trackMediaTask — the terminal latch', () => {
  it('delivers a finished task exactly ONCE however many times the stream replays it', async () => {
    const files = mockRoutes('succeeded');
    const task = handle();

    await trackMediaTask(task);
    await trackMediaTask(task);
    await trackMediaTask(task);

    expect(files.count).toBe(1);
    expect(workbenchStore.createFile).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('latches failures too — one refund toast, not one per stream chunk', async () => {
    mockRoutes('failed');

    const task = handle();

    await trackMediaTask(task);
    await trackMediaTask(task);

    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('force re-delivers past the latch — the Media panel Re-save button', async () => {
    const files = mockRoutes('succeeded');
    const task = handle();

    await trackMediaTask(task);
    await trackMediaTask(task); // stream replay: latched
    await trackMediaTask(task, { force: true }); // deliberate click: delivered again

    expect(files.count).toBe(2);
    expect(workbenchStore.createFile).toHaveBeenCalledTimes(2);
  });

  /* The control (§useMessageParser.spec convention): without it, a latch that latches EVERYTHING passes above. */
  it('still delivers a first-time task normally', async () => {
    const files = mockRoutes('succeeded');

    await trackMediaTask(handle('video'));

    expect(files.count).toBe(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
});
