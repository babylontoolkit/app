/**
 * Publish / unpublish a project (SPEC §4.8, §5).
 *
 *   POST   /api/projects/:id/publish   { dist, submitToGallery?, title?, description? }  → { shareId }
 *   DELETE /api/projects/:id/publish                                                      → { ok }
 *
 * The build (`npm run build`) runs in the user's WebContainer — the server NEVER executes user code
 * (§5). The client streams us the resulting `dist/` as a byte-faithful `SerializedFileMap`; this route
 * runs the publishing checklist one more time on those exact bytes and, if nothing is blocking, uploads
 * them and mints the public id.
 *
 * Two walls, as everywhere: `requireVerifiedUser` then `requireOwnedProject`. Publishing needs a
 * VERIFIED user specifically — an unverified account is the free-abuse vector (§5), and a public URL
 * is the most abusable thing here.
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { errorResponse } from '~/lib/.server/http';
import { runPublishingChecklist } from '~/lib/.server/share/checklist';
import { publishBuild, unpublish } from '~/lib/.server/share/publish';
import { getMonitor, FUNNEL_EVENTS } from '~/lib/.server/monitoring';
import type { SerializedFileMap } from '~/lib/binary/binary-files';

interface PublishBody {
  dist: SerializedFileMap;
  submitToGallery?: boolean;
  title?: string;
  description?: string;

  /** Set true to publish despite non-blocking warnings (debug overlays etc). Blocking findings still refuse. */
  acknowledgeWarnings?: boolean;
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  try {
    const user = await requireVerifiedUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);

    if (request.method === 'DELETE') {
      await unpublish(project, context);
      return json({ ok: true });
    }

    if (request.method !== 'POST') {
      return json({ error: true, message: 'Method not allowed.' }, { status: 405 });
    }

    const body = await request.json<PublishBody>();

    if (!body?.dist || typeof body.dist !== 'object') {
      return json({ error: true, message: 'Publishing needs a built project (dist).' }, { status: 400 });
    }

    const checklist = runPublishingChecklist(body.dist);

    // A blocking finding (a secret) is a refusal, never a warning the user can wave past.
    if (!checklist.ok) {
      return json(
        { error: true, message: 'This game cannot be shared yet.', findings: checklist.findings },
        { status: 422 },
      );
    }

    const warnings = checklist.findings.filter((f) => f.level === 'warning');

    // Warnings are the user's call — but they must SEE them once before we proceed.
    if (warnings.length > 0 && !body.acknowledgeWarnings) {
      return json({ error: true, needsAcknowledgement: true, findings: warnings }, { status: 409 });
    }

    const result = await publishBuild(
      {
        project,
        dist: body.dist,
        title: body.title,
        description: body.description,
        submitToGallery: body.submitToGallery,
        soloLaunch: checklist.soloLaunchRequired,
      },
      context,
    );

    /*
     * Funnel (§5A). SHARE_PUBLISHED fires on every publish; FIRST_PLAYABLE only when this project had
     * no `shareId` before — i.e. its first public, playable URL. The two are distinct funnel stages, so
     * the "first playable → share" progression is measurable rather than collapsed into one event.
     */
    const monitor = getMonitor(context);

    if (!project.shareId) {
      monitor.track(FUNNEL_EVENTS.FIRST_PLAYABLE, { userId: user.id, projectId: project.id });
    }

    monitor.track(FUNNEL_EVENTS.SHARE_PUBLISHED, {
      userId: user.id,
      projectId: project.id,
      gallery: Boolean(body.submitToGallery),
    });

    return json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
