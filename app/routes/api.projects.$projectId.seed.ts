/**
 * Read this project's remix seed (SPEC §4.8, §4.5.4b).
 *
 *   GET /api/projects/:id/seed  → { files } | 404
 *
 * The seed is the one-time copy of a shared game's source that a remix is cloned from. A clone opens it
 * once, on first mount, and thereafter the project lives where every project lives: in the browser
 * until Save, and in the user's own repo after (§4.5.4b).
 *
 * ## What replaced what
 *
 * This route replaces `/api/projects/:id/snapshots/:snapshotId`, and the shape change is the point.
 * That route took a caller-supplied snapshot id and looked it up, which needed a second wall
 * (`assertSnapshotBelongsTo`) to stop project A's owner reading project B's files by naming B's id in
 * A's URL. Here the key is derived from the project id (`share/seed-store.ts`), so the two walls are
 * the whole of it: prove you own the project, get that project's seed, and there is no second id to
 * abuse.
 *
 * There is deliberately **no write method**. A seed is deposited by publishing (`publish.ts`) or by
 * remixing (`api.remix.ts`) — never by the browser saying "store this for me", which is the server-side
 * project storage §4.5.4b removed.
 */
import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { getRemixSeed } from '~/lib/.server/share/seed-store';
import { errorResponse } from '~/lib/.server/http';

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  try {
    const user = await requireUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);

    const files = await getRemixSeed(project.id, context);

    if (!files) {
      /*
       * Not an error condition — the overwhelming majority of projects have no seed and never will.
       * The client treats this as "nothing to mount", which for a normal project is correct.
       */
      return json({ error: true, message: 'This project has no seed.' }, { status: 404 });
    }

    return json({ files });
  } catch (error) {
    return errorResponse(error);
  }
}
