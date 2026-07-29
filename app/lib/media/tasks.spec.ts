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
  workbenchStore: { createFile: vi.fn(async () => true), refreshPreviews: vi.fn() },
}));

import { toast } from 'react-toastify';
import { workbenchStore } from '~/lib/stores/workbench';
import { mediaRenderStore, trackMediaTask } from './tasks';

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

    /*
     * The render is INVISIBLE without this. The model writes `<img src="/assets/generated/…">` in the
     * same turn it commissions the art, so the preview already 404'd that URL ~30s before these bytes
     * existed — and nothing re-requests a failed `<img>`, because writing into `public/` invalidates
     * no module and therefore fires no HMR. Verified live: a fresh tab rendered every generated image
     * while the workbench preview beside it showed broken icons. Latched with the delivery, so it
     * runs exactly once per task rather than once per replayed stream chunk.
     */
    expect(workbenchStore.refreshPreviews).toHaveBeenCalledTimes(1);
  });

  it('latches failures too — one refund toast, not one per stream chunk', async () => {
    mockRoutes('failed');

    const task = handle();

    await trackMediaTask(task);
    await trackMediaTask(task);

    expect(toast.error).toHaveBeenCalledTimes(1);

    /* A control: nothing landed in the project, so there is nothing for the preview to re-request. */
    expect(workbenchStore.refreshPreviews).not.toHaveBeenCalled();
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

/**
 * `mediaRenderStore` — the in-flight render count behind "Generating 2 images…" (2026-07-28).
 *
 * A render is commissioned in milliseconds and takes 20–60s at KIE, so it routinely outlives the whole
 * generation: the server heartbeat has stopped, the message is finished, and the product looks like it is
 * "spinning for nothing" while it is in fact rendering the art the user asked for.
 *
 * 🔴 The dangerous direction is a count that goes UP and never comes back down — a permanent
 * "Generating 1 image…" is a worse lie than no line at all, and it throws nothing. So every terminal path
 * is pinned: success, failure, timeout, and a throw escaping the loop. Each test carries the count
 * observed MID-FLIGHT, which is the control: "ends at zero" passes trivially for a store nothing ever
 * increments.
 */
describe('mediaRenderStore — in-flight render counts', () => {
  beforeEach(() => {
    mediaRenderStore.set({ images: 0, videos: 0 });
  });

  /** Captures the store the moment the poll route is hit — i.e. while the task is genuinely in flight. */
  function mockRoutesCapturing(status: 'succeeded' | 'failed') {
    const seen: Array<{ images: number; videos: number }> = [];

    (globalThis.fetch as unknown as FetchMock) = vi.fn(async (url: string) => {
      if (String(url).endsWith('/file')) {
        return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as Response;
      }

      seen.push(mediaRenderStore.get());

      return { ok: true, json: async () => ({ task: { status } }) } as Response;
    });

    return seen;
  }

  it('counts up while rendering and back DOWN on success', async () => {
    const seen = mockRoutesCapturing('succeeded');

    await trackMediaTask(handle('image'));

    expect(seen[0]).toEqual({ images: 1, videos: 0 }); // CONTROL: it really went up
    expect(mediaRenderStore.get()).toEqual({ images: 0, videos: 0 });
  });

  it('counts images and videos separately', async () => {
    const seen = mockRoutesCapturing('succeeded');

    const video = handle('video');
    const image = handle('image');

    // Two in flight at once — the poller for the first is parked in `fetch` when the second starts.
    await Promise.all([trackMediaTask(video), trackMediaTask(image)]);

    expect(seen.some((s) => s.videos === 1)).toBe(true);
    expect(seen.some((s) => s.images >= 1)).toBe(true);
    expect(mediaRenderStore.get()).toEqual({ images: 0, videos: 0 });
  });

  it('comes back down on a FAILED render', async () => {
    const seen = mockRoutesCapturing('failed');

    await trackMediaTask(handle('video'));

    expect(seen[0]).toEqual({ images: 0, videos: 1 });
    expect(mediaRenderStore.get()).toEqual({ images: 0, videos: 0 });
    expect(toast.error).toHaveBeenCalled();
  });

  it('comes back down when the poll deadline passes (the timeout path)', async () => {
    /*
     * `MAX_POLL_MS` is 20 minutes and the sleeps are real; the cheapest faithful way to reach the timeout
     * is to move the clock past the deadline the loop just computed, so the `while` never runs a poll.
     */
    const t0 = Date.now();
    let calls = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => (calls++ === 0 ? t0 : t0 + 21 * 60 * 1000));

    (globalThis.fetch as unknown as FetchMock) = vi.fn(async () => {
      throw new Error('should never poll — the deadline had already passed');
    });

    await trackMediaTask(handle('image'));

    nowSpy.mockRestore();

    expect(toast.warning).toHaveBeenCalled();
    expect(mediaRenderStore.get()).toEqual({ images: 0, videos: 0 });
  });

  it('comes back down when the loop THROWS — the finally, not the happy path, is what releases it', async () => {
    /*
     * `pollOnce` and `deliverBytes` both swallow their own errors, so the one thing that can escape the
     * try is the failure toast itself. Contrived on purpose: what is being pinned is that the decrement
     * lives in the SAME `finally` that already releases `tracking`, rather than on any success path.
     */
    const seen = mockRoutesCapturing('failed');
    (toast.error as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('toaster unmounted');
    });

    await expect(trackMediaTask(handle('image'))).rejects.toThrow('toaster unmounted');

    expect(seen[0]).toEqual({ images: 1, videos: 0 });
    expect(mediaRenderStore.get()).toEqual({ images: 0, videos: 0 });
  });
});
