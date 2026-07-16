/**
 * Projects — list and create (SPEC §4.5.5).
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireUser } from '~/lib/.server/supabase/auth';
import { getProjectStore } from '~/lib/.server/projects/store';
import { errorResponse } from '~/lib/.server/http';
import { getMonitor, FUNNEL_EVENTS } from '~/lib/.server/monitoring';

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    const user = await requireUser(request, context);

    // Scoped to the caller. There is no "list all projects" — not even for admins, on this route.
    const projects = await getProjectStore(context).listByUser(user.id);

    return json({ projects });
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
