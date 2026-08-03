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
import { purgeProject } from '~/lib/.server/projects/purge';
import { errorResponse } from '~/lib/.server/http';

/**
 * How much creation handoff a browser may store on a project (§4.4a, §4.2.8).
 *
 * The brief is machine-written, but it ARRIVES IN A BROWSER BODY and it is later sent to the model on
 * the most expensive turn in the product — so it is caller-supplied text on a paid path, and the cap is
 * the same reasoning as `MAX_INSTRUCTIONS_CHARS`: an unbounded one is an unbounded per-turn bill, and
 * nothing about it would ever throw. Generous enough for the real brief (~4KB with the media section)
 * plus a wizard's compiled selections.
 */
const MAX_HANDOFF_BRIEF_CHARS = 24_000;
const MAX_HANDOFF_PROMPT_CHARS = 8_000;

/**
 * Validate a handoff sent by the browser. `null` CLEARS it — that is how the first build turn ends the
 * mode, so it must be expressible; anything malformed also clears rather than throwing, because a
 * corrupt handoff is exactly a project that should stop offering to build itself.
 */
function parseCreationHandoff(value: unknown) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const { brief, userPrompt } = value as { brief?: unknown; userPrompt?: unknown };

  if (typeof brief !== 'string' || brief.length === 0) {
    return undefined;
  }

  return {
    brief: brief.slice(0, MAX_HANDOFF_BRIEF_CHARS),
    ...(typeof userPrompt === 'string' && userPrompt.length > 0
      ? { userPrompt: userPrompt.slice(0, MAX_HANDOFF_PROMPT_CHARS) }
      : {}),
  };
}

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
       * The whole reaper — published build, seed, conversation, working copy, VM, row, creation refund,
       * in that order and for the reasons written there. It lives in `purge.ts` because account deletion
       * (§4.5.1) reaps every one of a user's projects and must not re-derive the list: two copies of a
       * list this long diverge silently, and the divergence leaves the user's bytes on our servers while
       * the UI reports success.
       */
      await purgeProject(project, { userId: user.id, context });

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
    const body = await request.json<{ name?: string; creationHandoff?: unknown }>();

    const updated = await store.update(project.id, {
      ...(body.name !== undefined ? { name: body.name.slice(0, 120) } : {}),
      ...('creationHandoff' in body ? { creationHandoff: parseCreationHandoff(body.creationHandoff) } : {}),
    });

    return json({ project: toWireProject(updated) });
  } catch (error) {
    return errorResponse(error);
  }
}
