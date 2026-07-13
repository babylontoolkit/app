/**
 * Restore a checkpoint (SPEC §4.12).
 *
 * GET returns the payload so the client can remount the WebContainer from it. Note the route shape:
 * the snapshot is addressed THROUGH its project, and the ownership check runs on the project — a
 * bare `/api/snapshots/:id` would have let anyone with a snapshot id read the files out of any
 * project on the platform.
 *
 * The double check (`assertSnapshotBelongsTo`) closes the other half: owning project A must not let
 * you read a snapshot belonging to project B by naming it in A's URL.
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireUser } from '~/lib/.server/supabase/auth';
import { assertSnapshotBelongsTo, NotFoundError, requireOwnedProject } from '~/lib/.server/projects/ownership';
import { getProjectStore, getSnapshotStore } from '~/lib/.server/projects/store';
import { errorResponse } from '~/lib/.server/http';

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  try {
    const user = await requireUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);

    const store = getSnapshotStore(context);
    const snapshot = await store.get(params.snapshotId!);

    if (!snapshot) {
      throw new NotFoundError('That checkpoint does not exist.');
    }

    await assertSnapshotBelongsTo(project, snapshot.projectId);

    const files = await store.read(snapshot.id);

    if (!files) {
      throw new NotFoundError('That checkpoint could not be read.');
    }

    return json({ snapshot: { id: snapshot.id, label: snapshot.label, createdAt: snapshot.createdAt }, files });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Mark a checkpoint as current.
 *
 * The client mounts the files (from the GET above) and then calls this. Deliberately does NOT delete
 * anything: history is append-only (§4.12), so the checkpoints taken after this one survive, and the
 * user can always undo their undo. The restore itself gets snapshotted by the client, so the trail
 * reads: … → restore → new checkpoint.
 */
export async function action({ request, params, context }: ActionFunctionArgs) {
  try {
    const user = await requireUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);

    const snapshot = await getSnapshotStore(context).get(params.snapshotId!);

    if (!snapshot) {
      throw new NotFoundError('That checkpoint does not exist.');
    }

    await assertSnapshotBelongsTo(project, snapshot.projectId);
    await getProjectStore(context).update(project.id, { currentSnapshotId: snapshot.id });

    return json({ ok: true, currentSnapshotId: snapshot.id });
  } catch (error) {
    return errorResponse(error);
  }
}
