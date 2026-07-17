/**
 * A project's conversations (SPEC §4.5, §4.5.5, §4.5.6).
 *
 * Upstream bolt.diy keeps the conversation in IndexedDB, which makes a project a thing that exists in
 * exactly one browser: it cannot be resumed on another machine, cannot be shared, and dies with the
 * profile. Every Stage 4 feature — share, gallery, remix, GitHub sync — means handing a project to
 * someone (or something) else, so the conversation has to live with the project, not with the tab.
 *
 * This route LISTS; one conversation is read, written and deleted through `messages.$chatId`. Under
 * §4.5.6 a project has many chats ("New chat, same game"), so a list is the only honest answer to
 * "what has been said about this project".
 *
 * Stored in the object store rather than a `messages` TABLE (which §4.5.5 sketches): a conversation is
 * written whole on every turn, read whole on resume, never queried by row, and can be megabytes. That
 * is an object, not a relation. When per-message queries are actually needed (admin search, analytics),
 * the table can be added beside this without changing the route.
 *
 * Ownership is enforced by `requireOwnedProject` — 404, never 403, for someone else's project (§4.5.3).
 */
import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { listChats } from '~/lib/.server/projects/message-store';
import { errorResponse } from '~/lib/.server/http';

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  try {
    const user = await requireUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);

    /*
     * A project with no conversation yet is NORMAL — it is every project between "created" and "first
     * message saved". An empty list, not a 404: the caller is asking "what has been said", and the
     * honest answer is "nothing yet".
     */
    return json({ chats: await listChats(project.id, context) });
  } catch (error) {
    return errorResponse(error);
  }
}
