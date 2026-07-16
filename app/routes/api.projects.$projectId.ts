/**
 * One project — read, rename, delete (SPEC §4.5.3, §4.5.5).
 *
 * Every method here goes through `requireOwnedProject`. That is not boilerplate: `projectId` comes
 * straight out of the URL, so it is a value the caller chooses.
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { getProjectStore, getSnapshotStore } from '~/lib/.server/projects/store';
import { errorResponse } from '~/lib/.server/http';

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  try {
    const user = await requireUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);

    return json({ project });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  try {
    const user = await requireUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);
    const store = getProjectStore(context);

    if (request.method === 'DELETE') {
      /*
       * Snapshots first. If the project row went first and the snapshot delete then failed, the
       * payload bytes would be orphaned in object storage with nothing left pointing at them — an
       * invisible, unbillable, un-deletable leak. Losing a snapshot whose project survives is
       * recoverable; the reverse is not.
       */
      await getSnapshotStore(context).deleteByProject(project.id);
      await store.delete(project.id);

      return json({ ok: true });
    }

    /*
     * Rename only.
     *
     * `linkedRepo`/`linkedBranch` used to be settable here, one field at a time. Under §4.5.4b that is
     * no longer a pointer to a sync convenience — it is the address of the only permanent copy of the
     * user's game, and it is only meaningful together with a `provider` (migration 0006's
     * `projects_link_complete_check` refuses a half-set). Linking is a real operation with an OAuth
     * token, a repo that must exist, and a push; it lives at `/api/projects/:id/github`. A patch route
     * that could point a project at any string was a way to make a project claim it was saved
     * somewhere it had never written a byte.
     */
    const body = await request.json<{ name?: string }>();

    const updated = await store.update(project.id, {
      ...(body.name !== undefined ? { name: body.name.slice(0, 120) } : {}),
    });

    return json({ project: updated });
  } catch (error) {
    return errorResponse(error);
  }
}
