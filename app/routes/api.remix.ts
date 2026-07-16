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
import type { SerializedFileMap } from '~/lib/binary/binary-files';

interface RemixBody {
  shareId?: string;
  projectId?: string;
  name?: string;

  /**
   * The files to clone, supplied by the caller — SELF-REMIX ONLY (§4.5.4b).
   *
   * Under repo-primary persistence the platform holds no copy of an unshared project, so a Duplicate
   * has nothing on the server to clone from: the only copy is in the user's browser. They own both
   * sides (`requireOwnedProject` above), so their own bytes are the authoritative source and there is
   * nothing to trust: it is their project, being copied into their account.
   *
   * 🔴 IGNORED on the `shareId` path, deliberately. Honouring it there would let any visitor post
   * arbitrary files and have the platform store them against a stranger's shared game — the remix of a
   * public game must come from what the OWNER published (`buildRemixSeed`), never from the requester.
   */
  files?: SerializedFileMap;
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
     * Where the clone's files come from (§4.5.4b).
     *
     * 🔴 This used to read `source.currentSnapshotId` and nothing else, back when the platform kept a
     * server-side snapshot of every project after every generation. It does not any more — so that
     * lookup now returns `undefined` for every ordinary project, and this route quietly produced an
     * EMPTY clone. The comment that used to sit here ("a source with no snapshot yet clones as an
     * empty project — still valid, just nothing to copy") described a rare edge case that had silently
     * become the universal one.
     *
     * The two paths that DO have files, and no others:
     *
     *   - self-remix: the caller's own browser sends them (`body.files`). They own both projects.
     *   - shared remix: the seed the OWNER deposited when they published (`buildRemixSeed`), which is
     *     what `currentSnapshotId` now points at.
     *
     * `body.files` is honoured ONLY for a self-remix. On the shareId path a visitor's files are not
     * the owner's game, and storing them against a stranger's share would be letting the requester
     * dictate what a public remix contains.
     */
    const seeded = source.currentSnapshotId ? await snapshots.read(source.currentSnapshotId) : null;
    const files = (isSelfRemix && body.files) || seeded;

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
