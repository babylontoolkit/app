/**
 * Every conversation the user has, across every project (SPEC §4.5.6, §4.5.4b) — the sidebar.
 *
 * ## Why this route exists
 *
 * The sidebar rendered `getAll(indexedDb)`: a view of the BROWSER, not of the account. A chat started
 * on a laptop did not exist on a desktop, and clearing site data destroyed the list — while the
 * transcripts themselves sat safely on the server the whole time, with nothing to list them.
 *
 * That was never a decision. Upstream's chat WAS the project and lived in IndexedDB, and the server
 * transcript was added underneath without the sidebar ever learning about it. This is the other half:
 * the platform holds the project record and the conversation, the browser is a local staging area, and
 * the user's CODE lives in their own repo (§4.5.4b).
 *
 * ## Ownership
 *
 * Chats are not addressable on their own — there is no `user_id` on a chat, deliberately (see migration
 * 0008). Ownership is resolved by listing the caller's PROJECTS first and asking only for those. So the
 * blast radius of a bug here is bounded by `listByUser`, which is the one place ownership is decided,
 * rather than by a filter someone might forget on a second query.
 */
import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireUser } from '~/lib/.server/supabase/auth';
import { getProjectStore } from '~/lib/.server/projects/store';
import { listChatsForProjects } from '~/lib/.server/projects/message-store';
import { errorResponse } from '~/lib/.server/http';

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    const user = await requireUser(request, context);

    /*
     * The user's own projects, and only those. This is what makes the chat query safe: it can only ever
     * ask about ids that ownership has already cleared.
     */
    const projects = await getProjectStore(context).listByUser(user.id);
    const chats = await listChatsForProjects(
      projects.map((project) => project.id),
      context,
    );

    /*
     * Project names ride along so the sidebar can say which game a chat belongs to. It is the obvious
     * thing to want once chats from every project share one list, and the client would otherwise have
     * to fetch `/api/projects` and join it by hand.
     */
    const names = new Map(projects.map((project) => [project.id, project.name]));

    return json({
      chats: chats.map((chat) => ({ ...chat, projectName: names.get(chat.projectId) })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
