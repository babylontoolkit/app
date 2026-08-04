/**
 * The public gallery (SPEC §4.8, §5).
 *
 *   GET /api/gallery  → curated grid of admin-APPROVED shared games, newest first.
 *
 * Unauthenticated by design: the gallery is the zero-cost "take a peek" funnel. It returns ONLY
 * `gallery_status = 'approved'` rows — nothing a user submitted becomes visible until an admin approves
 * it (§5, migration 0004's check constraint + the admin route). And it returns only public fields: a
 * title, a blurb, the share id to play/remix. Never the owner, never the project id, never a snapshot.
 */
import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { getProjectStore } from '~/lib/.server/projects/store';
import { listGallery } from '~/lib/.server/share/gallery';
import { errorResponse } from '~/lib/.server/http';

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 48, 1), 96);

    const entries = await listGallery(getProjectStore(context), limit, context);

    return json({ games: entries }, { headers: { 'cache-control': 'public, max-age=60' } });
  } catch (error) {
    return errorResponse(error);
  }
}
