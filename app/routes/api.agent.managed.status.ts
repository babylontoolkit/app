/**
 * Is a managed turn still pending for this chat? (`_specs/managed-agents-engine_plan.md` T6)
 *
 *   GET /api/agent/managed/status?projectId=…&chatId=…  → { engine, pending }
 *
 * A reopened chat asks this on mount: `pending: true` means the chat's Managed Agents session is still
 * mid-turn (running, or waiting on a tool result no browser has answered), and the browser re-attaches
 * with a resume turn. Two walls — a verified session, then project ownership (404-not-403) — and the
 * chat must belong to that project (`getManagedTurnStatus`).
 */
import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { getManagedTurnStatus } from '~/lib/.server/agent-managed/control';
import { errorResponse } from '~/lib/.server/http';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    const user = await requireVerifiedUser(request, context);
    const url = new URL(request.url);
    const projectId = url.searchParams.get('projectId') ?? '';
    const project = await requireOwnedProject(user, projectId, context);

    return json(await getManagedTurnStatus({ projectId: project.id, chatId: url.searchParams.get('chatId'), context }));
  } catch (error) {
    return errorResponse(error);
  }
}
