/**
 * The project's server WORKING COPY — crash recovery (SPEC §4.5.4c).
 *
 *   GET  /api/projects/:id/working  → { copy } | 404
 *   PUT  /api/projects/:id/working  ← { seq, files, messageId? }  → { ok, seq }
 *
 * ## Why this one DOES have a write method, when the seed route deliberately does not
 *
 * `api.projects.$projectId.seed.ts` has no `action` on purpose: a browser saying "store this for me"
 * was the server-side project storage §4.5.4b removed. This route is that write — reintroduced by an
 * explicit owner decision (§4.5.4c) after a completed generation, settled at 427 credits, was lost with
 * the tab that rendered it. The distinction that makes it safe is not the verb, it is the SHAPE:
 *
 *   - **One object per project**, overwritten. There is no history to accumulate and no version to
 *     address, so this cannot become the `snapshots` table that migration 0007 dropped.
 *   - **A key derived from the project id** (`working-copy.ts`), never one the caller names. That is
 *     what makes the two walls sufficient on their own: the deleted snapshot route needed
 *     `assertSnapshotBelongsTo` only because it accepted an id from the client, which is how project
 *     A's owner could read project B's files by naming B's id in A's URL. Re-introduce a caller-supplied
 *     storage id here and that second wall must come back with it.
 *
 * ## Both walls, on every method (§4.5.3)
 *
 * `requireUser` then `requireOwnedProject` — and the latter reports **404, not 403**, for a project the
 * caller does not own, because a 403 confirms the id exists and turns this into an enumeration oracle.
 * "Logged in" is not authorization, and this route reads and overwrites a user's entire game.
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { getWorkingCopy, putWorkingCopy } from '~/lib/.server/projects/working-copy';
import { errorResponse } from '~/lib/.server/http';
import type { SerializedFileMap } from '~/lib/binary/binary-files';

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  try {
    const user = await requireUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);

    const copy = await getWorkingCopy(project.id, context);

    if (!copy) {
      /*
       * Normal, not an error: a project that has never checkpointed has no copy, and neither does one
       * whose stored bytes failed to parse (`getWorkingCopy` returns null rather than handing back
       * something it cannot trust). The client falls back to its other mount sources either way.
       */
      return json({ error: true, message: 'This project has no working copy.' }, { status: 404 });
    }

    return json({ copy });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  try {
    if (request.method !== 'PUT' && request.method !== 'POST') {
      return json({ error: true, message: 'Method not allowed.' }, { status: 405 });
    }

    const user = await requireUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);

    const body = (await request.json()) as { seq?: number; files?: SerializedFileMap; messageId?: string };

    /*
     * `seq` is REQUIRED and must be a real number.
     *
     * Resume compares this copy against the browser's local checkpoint, and a copy that cannot be
     * ordered would either be ignored (pointless) or trusted blindly (dangerous — a stale copy
     * overwriting a newer project). Ordering by the write's own clock is not an option: that is the
     * bug migration 0003 fixed in the ledger and §4.5.4b deviation 3 fixed in local checkpoints.
     * Rejected here rather than defaulted, so a client that forgets fails loudly instead of silently
     * storing something unusable.
     */
    if (typeof body?.seq !== 'number' || !Number.isFinite(body.seq)) {
      return json({ error: true, message: 'A numeric `seq` is required.' }, { status: 400 });
    }

    if (!body.files || typeof body.files !== 'object') {
      return json({ error: true, message: 'A `files` map is required.' }, { status: 400 });
    }

    /*
     * An EMPTY map is refused, and this is a data-loss guard rather than validation pedantry.
     *
     * A client that has not finished mounting reports zero files, and storing that would overwrite a
     * good copy with an empty one — turning the recovery buffer into the cause of the loss. Same bias
     * as `planRestore`'s "an empty incoming map deletes nothing": when in doubt, do nothing.
     */
    if (Object.keys(body.files).length === 0) {
      return json({ error: true, message: 'Refusing to store an empty working copy.' }, { status: 400 });
    }

    await putWorkingCopy(
      project.id,
      {
        projectId: project.id,
        seq: body.seq,
        updatedAt: new Date().toISOString(),

        /*
         * Optional, and only accepted as a string. It answers "does this copy already contain the last
         * paid turn?" — a wrong value there offers to overwrite the user's files, so anything that is
         * not a string is stored as absent (= "cannot say", which asks).
         */
        messageId: typeof body.messageId === 'string' ? body.messageId : undefined,
        files: body.files,
      },
      context,
    );

    return json({ ok: true, seq: body.seq });
  } catch (error) {
    return errorResponse(error);
  }
}
