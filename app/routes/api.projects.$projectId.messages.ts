/**
 * A project's chat history, server-side (SPEC §4.5, §4.5.5).
 *
 * Upstream bolt.diy keeps the conversation in IndexedDB. That makes a project a thing that exists in
 * exactly one browser: it cannot be resumed on another machine, cannot be shared, and dies with the
 * profile. Every Stage 4 feature — share, gallery, remix, GitHub sync — means handing a project to
 * someone (or something) else, so the conversation has to live with the project, not with the tab.
 *
 * Stored in the object store next to the project's snapshots rather than in a `messages` TABLE (which
 * §4.5.5 sketches): the conversation is written as a whole on every turn and read as a whole on
 * resume, is never queried by row, and can be megabytes. That is an object, not a relation. When
 * per-message queries are actually needed (admin search, analytics), the table can be added beside
 * this without changing the route.
 *
 * Ownership is enforced by `requireOwnedProject` — 404, never 403, for someone else's project (§4.5.3).
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { getProjectStore } from '~/lib/.server/projects/store';
import { getObjectStore } from '~/lib/.server/storage';
import { errorResponse } from '~/lib/.server/http';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.project-messages');

/**
 * Guard rail, not a policy. A conversation is text; a few MB is a very long chat. This exists so a
 * runaway client (or a hostile one — this is an authenticated HTTP endpoint, not our React code)
 * cannot push unbounded bytes into our object store on the platform's dime.
 */
const MAX_MESSAGES_BYTES = 25_000_000;

function messagesKey(projectId: string): string {
  return `messages/${projectId}.json`;
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  try {
    const user = await requireUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);

    const bytes = await getObjectStore(context).get(messagesKey(project.id));

    /*
     * A project with no conversation yet is NORMAL — it is every project between "created" and "first
     * message stored". An empty list, not a 404: the caller is asking "what has been said", and the
     * honest answer is "nothing yet".
     */
    if (!bytes) {
      return json({ messages: [] });
    }

    return json({ messages: JSON.parse(new TextDecoder().decode(bytes)) as unknown[] });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  try {
    const user = await requireUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);

    const body = await request.json<{ messages?: unknown[] }>();

    if (!Array.isArray(body.messages)) {
      return json(
        { error: true, message: 'Expected a list of messages.', statusCode: 400, isRetryable: false },
        { status: 400 },
      );
    }

    const bytes = new TextEncoder().encode(JSON.stringify(body.messages));

    if (bytes.length > MAX_MESSAGES_BYTES) {
      return json(
        {
          error: true,
          message: 'This conversation is too large to save. Start a new chat to keep building.',
          statusCode: 413,
          isRetryable: false,
        },
        { status: 413 },
      );
    }

    await getObjectStore(context).put(messagesKey(project.id), bytes, 'application/json');

    // `updatedAt` is what sorts the project list — a chat that moved is a project that moved.
    await getProjectStore(context).update(project.id, {});

    logger.debug(`Saved ${body.messages.length} messages for project ${project.id}`);

    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
