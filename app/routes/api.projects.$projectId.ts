/**
 * One project — read, rename, delete (SPEC §4.5.3, §4.5.5).
 *
 * Every method here goes through `requireOwnedProject`. That is not boilerplate: `projectId` comes
 * straight out of the URL, so it is a value the caller chooses.
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { getProjectStore } from '~/lib/.server/projects/store';
import { toWireProject } from '~/lib/.server/projects/wire';
import { deleteMessages } from '~/lib/.server/projects/message-store';
import { deleteRemixSeed } from '~/lib/.server/share/seed-store';
import { deleteWorkingCopy } from '~/lib/.server/projects/working-copy';
import { errorResponse } from '~/lib/.server/http';

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  try {
    const user = await requireUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);

    return json({ project: toWireProject(project) });
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
       * Bytes first, row second — every time.
       *
       * The project id is the ONLY handle on this user's bytes: the seed and the conversation are both
       * stored at keys derived from it. Delete the row first and a failure here strands them with
       * nothing left that can name them — invisible, un-deletable, and (for the chat) still ours after
       * the user pressed Delete believing it gone. Losing bytes whose project survives is recoverable;
       * the reverse is not.
       *
       * 🔴 The MESSAGES delete is not tidiness. It did not exist: `DELETE /api/projects/:id` removed
       * the row and left `messages/{projectId}.json` behind forever, because the key was private to the
       * messages route and nothing else could address it. "Delete my project" left the conversation on
       * our servers.
       *
       * Both are unconditional: deleting an absent object is a no-op, and asking a hint first
       * (`remixSeedAt`) leaves the bytes behind on any disagreement between hint and storage.
       */
      await deleteRemixSeed(project.id, context);
      await deleteMessages(project.id, context);

      /*
       * The working copy (§4.5.4c) — the platform's recovery buffer for this project's files. Same
       * unconditional rule as the two above: bytes must never outlive the record that named them, and
       * it holds the user's whole game, so leaving it behind is the worst version of that orphan.
       */
      await deleteWorkingCopy(project.id, context);
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

    return json({ project: toWireProject(updated) });
  } catch (error) {
    return errorResponse(error);
  }
}
