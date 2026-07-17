/**
 * Projects — list and create (SPEC §4.5.5).
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireUser } from '~/lib/.server/supabase/auth';
import { getProjectStore } from '~/lib/.server/projects/store';
import { countChats } from '~/lib/.server/projects/message-store';
import { errorResponse } from '~/lib/.server/http';
import { getMonitor, FUNNEL_EVENTS } from '~/lib/.server/monitoring';

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    const user = await requireUser(request, context);

    // Scoped to the caller. There is no "list all projects" — not even for admins, on this route.
    const projects = await getProjectStore(context).listByUser(user.id);

    /*
     * `chatCount` rides along so the dashboard can say how many conversations a project has (§4.5.6).
     *
     * A project with none is a real, deliberate state — deleting a chat never deletes the game, because
     * for an UNLINKED project the browser holds its only copy (§4.5.4b). Without a count on the card
     * that state is indistinguishable from an orphan, which is exactly how it was reported.
     *
     * Counted from the SERVER, not from the browser's local chats: the dashboard's whole job is to be
     * right on a device that has never opened the project.
     *
     * One prefix listing per project (`countChats` reads no bodies), in parallel. If a count fails, the
     * project still lists — a card is not worth losing someone's project list over.
     */
    const withCounts = await Promise.all(
      projects.map(async (project) => ({
        ...project,
        chatCount: await countChats(project.id, context).catch(() => undefined),
      })),
    );

    return json({ projects: withCounts });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    /*
     * Remix sends every non-GET method here, so an unguarded `DELETE /api/projects` would fall into
     * the CREATE branch, fail on the missing body, and surface as a 500 — an alarming way to say
     * "that endpoint doesn't exist". Deleting a project is done through `/api/projects/:id`.
     */
    if (request.method !== 'POST') {
      return json(
        { error: true, message: `Cannot ${request.method} /api/projects.`, statusCode: 405, isRetryable: false },
        { status: 405, headers: { Allow: 'GET, POST' } },
      );
    }

    const user = await requireUser(request, context);
    const body = await request.json<{ name?: string; templateId?: string }>();

    const project = await getProjectStore(context).create({
      /*
       * `userId` comes from the SESSION, never from the body. This is the line that makes ownership
       * mean anything: a client-supplied owner would let anyone create a project in someone else's
       * account and then legitimately "own" it.
       */
      userId: user.id,

      name: (body.name || 'Untitled Game').slice(0, 120),
      templateId: body.templateId || 'blank-canvas',
    });

    // Funnel: a new project exists (§5A). "First playable" and "share" come later in the same story.
    getMonitor(context).track(FUNNEL_EVENTS.PROJECT_CREATED, {
      userId: user.id,
      templateId: project.templateId,
    });

    return json({ project }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
