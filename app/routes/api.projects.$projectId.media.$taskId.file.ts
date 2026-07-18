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

    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type':
          upstream.headers.get('content-type') || (task.kind === 'video' ? 'video/mp4' : 'application/octet-stream'),
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
