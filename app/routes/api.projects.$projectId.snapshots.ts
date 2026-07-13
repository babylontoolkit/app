/**
 * Checkpoints — the version history behind Stop/Restore/Retry (SPEC §4.5.5, §4.12).
 *
 * **This is the single most important safety net for a non-developer.** Without it, one bad
 * generation strands someone who cannot read the diff to see what broke. So the rule is: history is
 * only ever APPENDED to, never destroyed. Restoring to checkpoint 3 does not delete checkpoints 4–7;
 * it mounts 3's files and takes a NEW snapshot. You can always get back to where you were, including
 * back to the thing you just restored away from.
 *
 * The payload is a `SerializedFileMap` — the byte-faithful codec from spec/binary-files.md — so a
 * snapshot→restore round-trip preserves PNGs, GLBs and WASM exactly. A snapshot that quietly UTF-8'd
 * the user's textures would be worse than no snapshot at all.
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { getProjectStore, getSnapshotStore } from '~/lib/.server/projects/store';
import type { SnapshotPayload } from '~/lib/.server/projects/types';
import { errorResponse } from '~/lib/.server/http';

/** The version history: metadata only. The payloads are megabytes and the list view needs none of them. */
export async function loader({ request, params, context }: LoaderFunctionArgs) {
  try {
    const user = await requireUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);

    const snapshots = await getSnapshotStore(context).listByProject(project.id);

    return json({
      currentSnapshotId: project.currentSnapshotId ?? null,
      snapshots: snapshots.map((s) => ({
        id: s.id,
        label: s.label,
        messageId: s.messageId,
        createdAt: s.createdAt,
        fileCount: s.fileManifest.length,
        totalBytes: s.fileManifest.reduce((sum, f) => sum + f.size, 0),
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Take a checkpoint. Called after each applied generation, on editor idle, and on manual save. */
export async function action({ request, params, context }: ActionFunctionArgs) {
  try {
    const user = await requireUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);

    const body = await request.json<{ files: SnapshotPayload; messageId?: string; label?: string }>();

    if (!body.files || typeof body.files !== 'object') {
      return json({ error: true, message: 'A snapshot needs files.' }, { status: 400 });
    }

    const snapshot = await getSnapshotStore(context).create({
      projectId: project.id,
      files: body.files,
      messageId: body.messageId,
      label: body.label,
    });

    // The pointer the builder remounts from on resume.
    await getProjectStore(context).update(project.id, { currentSnapshotId: snapshot.id });

    return json(
      {
        snapshot: {
          id: snapshot.id,
          label: snapshot.label,
          messageId: snapshot.messageId,
          createdAt: snapshot.createdAt,
          fileCount: snapshot.fileManifest.length,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
