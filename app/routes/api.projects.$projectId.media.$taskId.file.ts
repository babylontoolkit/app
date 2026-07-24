/**
 * A finished render's BYTES (SPEC §4.16) — the hop between KIE and the user's project.
 *
 *   GET /api/projects/:id/media/:taskId/file → the image/video bytes, streamed
 *
 * KIE's result URLs expire (~3 days image / ~14 days video), so the bytes must land in the PROJECT —
 * the client fetches them here and writes them into the WebContainer as a `Uint8Array`
 * (binary-first-class, spec/binary-files.md), where they ride the user's repo like any other asset.
 * The server PROXIES and never stores (§4.5.4b: the platform stores no project files) — the body
 * streams straight through without buffering a multi-hundred-MB video.
 *
 * Ownership-checked like every project route; the media record (already ownership-scoped by its
 * derived key) supplies the URL — the client never sends one, so this can only ever fetch a result
 * belonging to this user's own task.
 */
import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { errorResponse } from '~/lib/.server/http';
import { getObjectStore } from '~/lib/.server/storage';
import { getMediaTask } from '~/lib/.server/media/store';
import { downloadResult } from '~/lib/.server/media/kie-client';
import { contentTypeForBytes, extensionMismatch } from '~/lib/media/sniff';
import { getMonitor } from '~/lib/.server/monitoring';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('media-file');

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  try {
    const user = await requireVerifiedUser(request, context);
    await requireOwnedProject(user, params.projectId!, context);

    const task = await getMediaTask(getObjectStore(context), params.projectId!, params.taskId!);

    if (!task) {
      return json({ error: true, message: 'No such media task.' }, { status: 404 });
    }

    if (task.status !== 'succeeded' || !task.resultUrl) {
      return json({ error: true, message: `The render is ${task.status}; there are no bytes yet.` }, { status: 409 });
    }

    const upstream = await downloadResult(task.resultUrl);

    /*
     * 🔴 THE PROVIDER'S WORD IS NOT EVIDENCE (§4.16).
     *
     * KIE's `/ggc/…` backend serves JPEG bytes from a `.png` URL with a `.png` content-type, whatever
     * `output_format` asked for — measured on every render this platform produced between 2026-07-19
     * and 2026-07-23. So the type is taken from the BYTES, and a file whose extension disagrees with
     * its content is reported rather than quietly written into the user's project.
     *
     * Streaming is preserved: only the first chunk is held (long enough to read a magic number), then
     * re-emitted ahead of the rest. A multi-hundred-MB video is never buffered.
     */
    const { head, body } = await peekStream(upstream.body!);
    const sniffed = head.byteLength ? contentTypeForBytes(head) : null;
    const mismatch = head.byteLength ? extensionMismatch(task.destPath, head) : null;

    if (mismatch) {
      const detail = `media task ${task.id}: ${task.destPath} is actually ${mismatch.actual} bytes (${task.model})`;
      logger.warn(detail);
      getMonitor(context).captureMessage(detail, { scope: 'media-format-mismatch' });
    }

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type':
          sniffed ||
          upstream.headers.get('content-type') ||
          (task.kind === 'video' ? 'video/mp4' : 'application/octet-stream'),
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Read the first chunk of a stream, then hand back a stream that still starts with it.
 *
 * The alternative — `await response.arrayBuffer()` — would buffer an entire Kling video in server
 * memory to look at 8 bytes.
 */
async function peekStream(stream: ReadableStream<Uint8Array>): Promise<{ head: Uint8Array; body: ReadableStream }> {
  const reader = stream.getReader();
  const first = await reader.read();
  const head = first.value ?? new Uint8Array();

  const body = new ReadableStream({
    start(controller) {
      if (first.done) {
        controller.close();
        return;
      }

      controller.enqueue(head);
    },
    async pull(controller) {
      const next = await reader.read();

      if (next.done) {
        controller.close();
        return;
      }

      controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return { head, body };
}
