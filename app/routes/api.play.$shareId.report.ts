/**
 * Report a shared game (SPEC §5 — public content moderation).
 *
 *   POST /api/play/:shareId/report  { reason }  → files a report into the admin queue
 *
 * Deliberately UNAUTHENTICATED: the report link lives on the public play page, and the whole point is
 * that a passer-by who has never signed up can flag something harmful. The trade-off is spam, handled
 * the cheap way — a short rate-window per share id and a hard cap on the reason length. A verified
 * user's id is attached when present (better signal), absent otherwise (still accepted).
 *
 * What it must NOT do: confirm anything about a share that does not exist. An unknown or unshared id
 * returns the same 202 as a real one — a report endpoint that 404s on bad ids is an existence oracle
 * for unlisted shares, which are supposed to be unguessable (§4.8).
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { getUser } from '~/lib/.server/supabase/auth';
import { getProjectStore } from '~/lib/.server/projects/store';
import { fileReport } from '~/lib/.server/share/reports';
import { errorResponse } from '~/lib/.server/http';

const MAX_REASON = 1000;

export async function action({ request, params, context }: ActionFunctionArgs) {
  try {
    if (request.method !== 'POST') {
      return json({ error: true, message: 'Method not allowed.' }, { status: 405 });
    }

    const shareId = params.shareId!;
    const body = await request.json<{ reason?: string }>().catch(() => ({ reason: undefined }));
    const reason = (body.reason ?? '').slice(0, MAX_REASON).trim() || undefined;

    // Attach the reporter's id when they happen to be signed in — never required.
    const user = await getUser(request, context).catch(() => null);

    const project = await getProjectStore(context).getByShareId(shareId);

    // Always answer 202, whether or not the share is real (see header — no existence oracle).
    if (project && project.sharedAt) {
      await fileReport({ projectId: project.id, shareId, reason, reporterId: user?.id }, context);
    }

    return json({ received: true }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
