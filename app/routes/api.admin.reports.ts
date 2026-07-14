/**
 * Abuse-report queue (SPEC §4.10, §5).
 *
 *   GET  /api/admin/reports                       → open reports on shared games
 *   POST /api/admin/reports  { id, action }       → resolve one (unpublish the game, or dismiss)
 *
 * Admin-only. Reports arrive from the public play page (`/api/play/:shareId/report`, anonymous
 * allowed); this is where they are actioned. `unpublish` takes the game down; `dismiss` clears the
 * report. Both mark the report resolved so the queue stays the ACTIONABLE set.
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireAdmin } from '~/lib/.server/supabase/auth';
import { getProjectStore } from '~/lib/.server/projects/store';
import { listOpenReports, resolveReport } from '~/lib/.server/share/reports';
import { unpublish } from '~/lib/.server/share/publish';
import { errorResponse } from '~/lib/.server/http';

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    await requireAdmin(request, context);

    return json({ reports: await listOpenReports(context) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    await requireAdmin(request, context);

    const body = await request.json<{ id: string; projectId?: string; action: 'unpublish' | 'dismiss' }>();

    if (!body.id || (body.action !== 'unpublish' && body.action !== 'dismiss')) {
      return json({ error: true, message: 'Need a report id and action (unpublish|dismiss).' }, { status: 400 });
    }

    if (body.action === 'unpublish' && body.projectId) {
      const project = await getProjectStore(context).get(body.projectId);

      if (project) {
        await unpublish(project, context);
      }
    }

    await resolveReport(body.id, body.action === 'unpublish' ? 'actioned' : 'dismissed', context);

    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
