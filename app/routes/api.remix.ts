/**
 * Remix / Duplicate (SPEC §4.8) — the growth loop and the self-serve "make a variation" button.
 *
 *   POST /api/remix  { shareId }    → clone a PUBLICLY SHARED game into my account
 *   POST /api/remix  { projectId }  → duplicate one of MY OWN projects (self-remix)
 *
 * Both land in the same clone (`deriveRemix` decides what travels — files yes, ownership/link/share
 * no). The difference is only how the source is resolved and authorised:
 *
 * - `shareId`: any user may remix any shared game — that is the point. The source is fetched by share
 *   id (public), and it must actually be live (`sharedAt` set), or a pulled share could still be cloned.
 * - `projectId`: this is a private project, so the caller must OWN it. `requireOwnedProject` enforces
 *   that and returns 404 (not 403) for anyone else's id, so this route is not an existence oracle.
 *
 * Either way the CALLER must be a verified user — a remix creates a project in their account, and the
 * anti-abuse gate (§5) lives at account verification.
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { getProjectStore, getSnapshotStore } from '~/lib/.server/projects/store';
import { deriveRemix } from '~/lib/.server/share/remix';
import { errorResponse } from '~/lib/.server/http';
import { getMonitor, FUNNEL_EVENTS } from '~/lib/.server/monitoring';
import type { Project } from '~/lib/.server/projects/types';

interface RemixBody {
  shareId?: string;
  projectId?: string;
  name?: string;
}

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    const user = await requireVerifiedUser(request, context);
    const body = await request.json<RemixBody>();

    const projects = getProjectStore(context);
    const snapshots = getSnapshotStore(context);

    let source: Project;
    let isSelfRemix = false;

    if (body.projectId) {
      // Self-remix: must own it.
      source = await requireOwnedProject(user, body.projectId, context);
      isSelfRemix = source.userId === user.id;
    } else if (body.shareId) {
      const shared = await projects.getByShareId(body.shareId);

      if (!shared || !shared.sharedAt) {
        return json({ error: true, message: 'That game is not available to remix.' }, { status: 404 });
      }

      source = shared;
      isSelfRemix = shared.userId === user.id;
    } else {
      return json({ error: true, message: 'A remix needs a shareId or a projectId.' }, { status: 400 });
    }

    /*
     * Clone the CURRENT snapshot's files, if the source has one. A source with no snapshot yet (brand
     * new project) clones as an empty project — still valid, just nothing to copy.
     */
    const sourceSnapshotId = source.currentSnapshotId;
    const files = sourceSnapshotId ? await snapshots.read(sourceSnapshotId) : null;

    const created = await projects.create(deriveRemix(source, { newOwnerId: user.id, name: body.name, isSelfRemix }));

    if (files) {
      const snapshot = await snapshots.create({
        projectId: created.id,
        files,
        label: 'Remixed',
      });
      await projects.update(created.id, { currentSnapshotId: snapshot.id });
    }

    // Growth-loop signal (§5A) — self-remix and shared-game remix are distinguished for the funnel.
    getMonitor(context).track(FUNNEL_EVENTS.REMIX_CREATED, { userId: user.id, self: isSelfRemix });

    return json({ projectId: created.id, name: created.name }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
