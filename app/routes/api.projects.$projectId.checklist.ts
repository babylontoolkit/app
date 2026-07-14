/**
 * Pre-share Publishing Checklist preview (SPEC §4.8).
 *
 *   POST /api/projects/:id/checklist  { files }  → { ok, findings, soloLaunchRequired }
 *
 * Run BEFORE the build, on the project source, so the user sees "you have a secret in here" while they
 * can still fix it — rather than after spending the time to `npm run build`. It is advisory: the real
 * gate is in `/publish`, which re-runs the same pure `runPublishingChecklist` on the actual built
 * bytes. This route never uploads anything and never mutates the project.
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { runPublishingChecklist } from '~/lib/.server/share/checklist';
import { errorResponse } from '~/lib/.server/http';
import type { SerializedFileMap } from '~/lib/binary/binary-files';

export async function action({ request, params, context }: ActionFunctionArgs) {
  try {
    const user = await requireVerifiedUser(request, context);
    await requireOwnedProject(user, params.projectId!, context);

    const body = await request.json<{ files: SerializedFileMap }>();

    if (!body?.files || typeof body.files !== 'object') {
      return json({ error: true, message: 'The checklist needs the project files.' }, { status: 400 });
    }

    return json(runPublishingChecklist(body.files));
  } catch (error) {
    return errorResponse(error);
  }
}
