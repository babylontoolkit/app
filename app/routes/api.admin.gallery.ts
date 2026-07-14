/**
 * Gallery curation (SPEC §4.8, §4.10, §5).
 *
 *   GET  /api/admin/gallery                          → projects awaiting curation (pending)
 *   POST /api/admin/gallery  { projectId, decision } → approve | reject a submission
 *
 * Admin-only. **Nothing becomes publicly listed without this route** — a user's `submitToGallery`
 * only ever moves a project to `pending` (migration 0004's check constraint), and only an admin here
 * moves it to `approved`. This is the human gate §5 requires between "a user shared a game" and "the
 * platform is publicly recommending it".
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireAdmin } from '~/lib/.server/supabase/auth';
import { getProjectStore } from '~/lib/.server/projects/store';
import { errorResponse } from '~/lib/.server/http';

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    await requireAdmin(request, context);

    const submissions = await getProjectStore(context).listGallerySubmissions(200);

    // Only the fields curation needs — the admin decides on a title, a blurb, and a link to play.
    return json({
      submissions: submissions.map((p) => ({
        projectId: p.id,
        shareId: p.shareId,
        title: p.shareTitle || p.name,
        description: p.shareDescription,
        sharedAt: p.sharedAt,
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    await requireAdmin(request, context);

    const body = await request.json<{ projectId: string; decision: 'approve' | 'reject' }>();

    if (!body.projectId || (body.decision !== 'approve' && body.decision !== 'reject')) {
      return json({ error: true, message: 'Need a projectId and decision (approve|reject).' }, { status: 400 });
    }

    const galleryStatus = body.decision === 'approve' ? 'approved' : 'rejected';
    await getProjectStore(context).update(body.projectId, { galleryStatus });

    return json({ ok: true, projectId: body.projectId, galleryStatus });
  } catch (error) {
    return errorResponse(error);
  }
}
