/**
 * Media task status — the client's poll target (SPEC §4.16).
 *
 *   GET /api/projects/:id/media/:taskId → { task }   — asks KIE once when still pending
 *
 * Polling is client-driven on purpose: a Kling render can take 10+ minutes, and holding a server
 * request (or worse, an LLM generation) open for that is exactly what §4.16's async-enqueue design
 * exists to avoid. Each poll advances the record at most one state; the failure transition refunds
 * exactly once (`pollMediaTask`'s per-task serialisation + the `refunded` latch).
 */
import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { errorResponse } from '~/lib/.server/http';
import { getObjectStore } from '~/lib/.server/storage';
import { mediaBaseUrlFor, requireMediaKey } from '~/lib/.server/agent/config';
import { mediaProviderFor } from '~/lib/.server/media/provider';
import { pollMediaTask } from '~/lib/.server/media/service';

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  try {
    const user = await requireVerifiedUser(request, context);
    await requireOwnedProject(user, params.projectId!, context);

    const task = await pollMediaTask({
      projectId: params.projectId!,
      taskId: params.taskId!,

      /*
       * 🔴 Resolved from the RECORD, not from `MEDIA_PROVIDER`. A poll must reach the gateway that
       * issued the task id — an operator flipping the switch mid-render would otherwise strand every
       * render in flight and eventually refund art that succeeded.
       */
      resolveProvider: (name) => mediaProviderFor(name, requireMediaKey(name, context), mediaBaseUrlFor(name, context)),
      objectStore: getObjectStore(context),
      context,
    });

    if (!task) {
      // 404-not-403 everywhere an id could probe someone else's data (§4.5.3).
      return json({ error: true, message: 'No such media task.' }, { status: 404 });
    }

    return json({ task });
  } catch (error) {
    return errorResponse(error);
  }
}
