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
import { toast } from 'react-toastify';
import { workbenchStore } from '~/lib/stores/workbench';
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
    tracking.delete(handle.taskId);
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
