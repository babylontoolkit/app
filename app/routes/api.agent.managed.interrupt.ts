/**
 * Stop a managed turn (`_specs/managed-agents-engine_plan.md` D6, T6).
 *
 *   POST /api/agent/managed/interrupt  { projectId, chatId }  → { interrupted }
 *
 * The Stop button's half of the managed engine. Aborting the request only DETACHES a managed turn (a
 * closed tab must not end a build), so an explicit Stop sends `user.interrupt` to the chat's session
 * here. The interrupted tail's usage is billed by the next settlement's cursor. Two walls — a verified
 * session, then project ownership (404-not-403) — and the chat must belong to that project.
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { interruptManagedTurn } from '~/lib/.server/agent-managed/control';
import { errorResponse } from '~/lib/.server/http';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    if (request.method !== 'POST') {
      return json({ error: true, message: 'Method not allowed.' }, { status: 405 });
    }

    const user = await requireVerifiedUser(request, context);
    const body = await request
      .json<{ projectId?: unknown; chatId?: unknown }>()
      .catch(() => ({}) as Record<string, unknown>);
    const project = await requireOwnedProject(user, typeof body.projectId === 'string' ? body.projectId : '', context);

    return json(await interruptManagedTurn({ projectId: project.id, chatId: body.chatId, context }));
  } catch (error) {
    return errorResponse(error);
  }
}
