/**
 * Client half of built-in media generation (SPEC §4.16).
 *
 * The server debits and starts the render (agent tool or Media panel); THIS module finishes it:
 * poll the task route until the render lands, fetch the bytes through the server proxy (KIE's URLs
 * expire — the project must hold the real bytes), and write them into the WebContainer as a
 * `Uint8Array` via `workbenchStore.createFile` — the binary-first-class path
 * (spec/binary-files.md), so the asset shows in the file tree, previews, and rides the user's repo
 * on the next save.
 *
 * Fire-and-forget by design: a Kling render takes minutes and must never block a generation or a
 * navigation. Everything here is best-effort UI work — the money is already settled server-side
 * (debit up-front, auto-refund on failure), so a closed tab costs nothing; the task can be polled
 * again from the Media panel's history.
 */
import { atom } from 'nanostores';
import { toast } from 'react-toastify';
import { workbenchStore } from '~/lib/stores/workbench';
import { refreshSavedCopiesSoon } from '~/lib/persistence/refresh-saved-copies';
import { WORK_DIR } from '~/utils/constants';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('media-tasks');

export interface MediaTaskHandle {
  projectId: string;
  taskId: string;
  destPath: string;
  kind: 'image' | 'video';
}

interface MediaTaskStatus {
  status: 'pending' | 'succeeded' | 'failed';
  error?: string;
  credits?: number;
}

/** Tasks this session is already tracking — a re-rendered data part must not spawn a second poller. */
const tracking = new Set<string>();

/**
 * Tasks that reached a TERMINAL state this session — never auto-tracked again.
 *
 * ⚠️ This latch is load-bearing, and `tracking` alone cannot provide it: `tracking` empties in the
 * `finally` when a task finishes, but the chat-data effect that calls us re-runs on EVERY stream
 * chunk, replaying the same `media-task` parts. Without the latch, a delivered image was re-fetched,
 * re-written, and re-toasted once per chunk for the rest of the generation — measured live as ~100
 * success toasts for three images on one creation. Failures latch too (a failed render would re-toast
 * the same way); a poll TIMEOUT does not (the render may still land — re-tracking it is the point).
 */
const completed = new Set<string>();

/** Stop polling after this long; the render may still finish and is recoverable from the panel. */
const MAX_POLL_MS = 20 * 60 * 1000;

export function isTrackingMediaTask(taskId: string): boolean {
  return tracking.has(taskId);
}

/**
 * How many renders are in flight RIGHT NOW, for the live status panel (`StreamingStatus.tsx`).
 *
 * 🔴 **This is a CLIENT fact and it belongs on the client.** The tool call that commissions a render
 * returns in milliseconds — it debits, enqueues at KIE and hands back the destination path (§4.16), so
 * the server-side generation is long finished while the picture is still rendering. The server heartbeat
 * therefore cannot report this and must not try: it would be narrating work it is no longer doing.
 *
 * Derived from `tracking` rather than kept alongside it — one source of truth, updated at the two lines
 * that already own the lifecycle, so a poller can never finish without the count following it down.
 */
export const mediaRenderStore = atom<{ images: number; videos: number }>({ images: 0, videos: 0 });

const inFlightKinds = new Map<string, 'image' | 'video'>();

function republishRenderCounts(): void {
  let images = 0;
  let videos = 0;

  for (const kind of inFlightKinds.values()) {
    if (kind === 'video') {
      videos++;
    } else {
      images++;
    }
  }

  mediaRenderStore.set({ images, videos });
}

/**
 * Poll until terminal, then write the bytes into the project (or surface the failure + refund).
 * Resolves when tracking ends; callers fire-and-forget.
 *
 * `force` re-delivers a task the latch has already retired — the Media panel's explicit Re-save
 * button, a deliberate user click. Stream-driven callers must never pass it.
 */
export async function trackMediaTask(handle: MediaTaskHandle, opts: { force?: boolean } = {}): Promise<void> {
  if (tracking.has(handle.taskId)) {
    return;
  }

  if (completed.has(handle.taskId) && !opts.force) {
    return;
  }

  tracking.add(handle.taskId);
  inFlightKinds.set(handle.taskId, handle.kind);
  republishRenderCounts();

  const intervalMs = handle.kind === 'video' ? 10_000 : 4_000;
  const deadline = Date.now() + MAX_POLL_MS;

  try {
    while (Date.now() < deadline) {
      const task = await pollOnce(handle);

      if (!task) {
        // A flaky poll is not a failed render — wait and ask again.
        await sleep(intervalMs);
        continue;
      }

      if (task.status === 'succeeded') {
        completed.add(handle.taskId);
        await deliverBytes(handle);

        return;
      }

      if (task.status === 'failed') {
        completed.add(handle.taskId);
        toast.error(
          `The ${handle.kind} generation failed${task.error ? `: ${task.error}` : ''}. ` +
            `${task.credits ? 'Your credits were refunded.' : ''}`,
        );

        return;
      }

      await sleep(intervalMs);
    }

    toast.warning(`The ${handle.kind} render is taking unusually long — check the Media panel later.`);
  } finally {
    /*
     * Both sides in the SAME finally that already guaranteed `tracking` is released. A render that
     * fails, times out or throws must drop out of the count exactly as a successful one does — a
     * "generating images" panel that never goes away is a worse lie than no panel at all.
     */
    tracking.delete(handle.taskId);
    inFlightKinds.delete(handle.taskId);
    republishRenderCounts();
  }
}

async function pollOnce(handle: MediaTaskHandle): Promise<MediaTaskStatus | null> {
  try {
    const response = await fetch(`/api/projects/${handle.projectId}/media/${handle.taskId}`);

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { task?: MediaTaskStatus };

    return data.task ?? null;
  } catch {
    return null;
  }
}

async function deliverBytes(handle: MediaTaskHandle): Promise<void> {
  try {
    const response = await fetch(`/api/projects/${handle.projectId}/media/${handle.taskId}/file`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());

    /*
     * Absolute container path — `createFile` relativises against the workdir, mkdir -p's the
     * directory, writes the bytes, and records `isBinary` metadata (never the bytes) in the store.
     */
    const written = await workbenchStore.createFile(`${WORK_DIR}/${handle.destPath}`, bytes);

    if (!written) {
      throw new Error('the file could not be written into the project');
    }

    /*
     * 🔴 THE RENDER IS INVISIBLE UNTIL THE PREVIEW IS TOLD TO ASK AGAIN (§4.16).
     *
     * Async-enqueue means the model gets the destination PATH immediately and writes
     * `<img src="/assets/generated/x.png">` in the same turn it commissions the art. Vite applies
     * that edit over HMR within a second, the browser requests the image — and 404s, because the
     * render has another ~30 seconds to run. When the bytes finally land here, NOTHING re-requests
     * them: writing into `public/` invalidates no module, so HMR does not fire, and a browser never
     * retries an `<img>` that already failed. A CSS `background-image` behaves the same way.
     *
     * So the render succeeded, the code was correct, the bytes were on disk — and the preview showed
     * broken-image icons until the user manually hit Refresh. Which reads, entirely reasonably, as
     * "image generation is broken". Verified live: opening the same URL in a fresh tab rendered every
     * generated image perfectly while the workbench preview beside it showed three broken icons.
     *
     * The remount is cheap and it is the ONLY compensating action the async-enqueue design needs.
     */
    workbenchStore.refreshPreviews();

    /*
     * And the same correction for BOTH SAVED COPIES (§4.5.4c, §4.12).
     *
     * The generation checkpointed ~25s ago, before this render existed, so neither the local checkpoint
     * nor the server working copy holds the asset — only the code that references it. That is not merely
     * a recovery gap: the local checkpoint is restored with `protectNothing` on an ordinary reload, and
     * a `protectNothing` restore DELETES what the incoming map does not have. So the file the user just
     * watched appear was removed on their next refresh — the reported *"they were created and showing,
     * but a refresh LOSES them"*.
     *
     * Coalesced, and post-stream: a burst of renders produces one write, and never during a generation.
     */
    refreshSavedCopiesSoon(`media ${handle.taskId}`);

    toast.success(`Generated ${handle.kind} saved to ${handle.destPath}`);
    logger.info(`Media task ${handle.taskId} delivered ${bytes.byteLength} bytes → ${handle.destPath}`);
  } catch (error) {
    /*
     * The render EXISTS (and was paid for) — only the local write failed. Say so precisely; the
     * Media panel can re-deliver it while the KIE URL is still live.
     */
    logger.error(`Failed to deliver media task ${handle.taskId}: ${(error as Error).message}`);
    toast.error(
      `The ${handle.kind} was generated but could not be saved into the project — retry from the Media panel.`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
