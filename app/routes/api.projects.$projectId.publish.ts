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
import { maxPublishBodyBytes, publishBodyFloorBytes, publishBuild, unpublish } from '~/lib/.server/share/publish';
import { shareUrl } from '~/lib/.server/share/serve';
import { getMonitor, FUNNEL_EVENTS } from '~/lib/.server/monitoring';
import { buildRemixSeed } from '~/lib/.server/share/remix-seed';
import { SeedTooLargeError, putRemixSeed } from '~/lib/.server/share/seed-store';
import { getProjectStore } from '~/lib/.server/projects/store';
import { createScopedLogger } from '~/utils/logger';
import type { AppLoadContext } from '@remix-run/cloudflare';
import type { SerializedFileMap } from '~/lib/binary/binary-files';

const logger = createScopedLogger('share.publish.route');

/**
 * Whether the published game can be remixed, and if not, why (§4.8).
 *
 * Surfaced to the client deliberately. Depositing the seed is best-effort by design — the user is owed
 * their share link whatever happens here — but "best-effort" had been implemented as a `catch` that
 * logged to a server file, so an oversized project produced a green success, a working share link, and
 * a game that could never be remixed. Nobody found out until a stranger clicked Remix and got an empty
 * editor. A publish may still succeed without a seed; it may not do so QUIETLY.
 */
export type RemixSeedOutcome = { remixable: true } | { remixable: false; remixBlockedReason: string };

/**
 * Store the source a remix will be cloned from (§4.8).
 *
 * Never throws: publishing succeeded before this ran. It REPORTS instead — see `RemixSeedOutcome`.
 */
async function depositRemixSeed(
  projectId: string,
  source: SerializedFileMap,
  context: AppLoadContext,
): Promise<RemixSeedOutcome> {
  try {
    const { files, excludedSecrets } = buildRemixSeed(source);

    if (excludedSecrets.length > 0) {
      // Not an error — this is the exclusion doing its job. Worth a line: it is a security boundary.
      logger.info(`Remix seed for ${projectId} withheld ${excludedSecrets.length} secret file(s).`);
    }

    /*
     * Object first, pointer second. If the write fails we have stored nothing and `remixSeedAt` stays
     * unset — the project reads as "no seed", which is true. The reverse order would advertise a seed
     * that does not exist.
     */
    await putRemixSeed(projectId, files, context);
    await getProjectStore(context).update(projectId, { remixSeedAt: new Date().toISOString() });

    return { remixable: true };
  } catch (error) {
    const message = (error as Error).message;
    logger.error(`Could not store the remix seed for ${projectId}: ${message}`);

    /*
     * `SeedTooLargeError` already says the size, the limit and the variable — it is written for whoever
     * has to act on it, so pass it through rather than flattening every cause into one vague sentence.
     */
    return {
      remixable: false,
      remixBlockedReason:
        error instanceof SeedTooLargeError
          ? message
          : 'The source could not be stored, so this game cannot be remixed.',
    };
  }
}

interface PublishBody {
  dist: SerializedFileMap;
  submitToGallery?: boolean;
  title?: string;
  description?: string;

  /**
   * The project's SOURCE, so the game can be remixed (§4.8, §4.5.4b).
   *
   * Optional on the wire and deliberately non-fatal when absent: a publish that cannot be remixed is
   * still a perfectly good publish, and refusing one over it would break sharing to fix remixing.
   * `buildRemixSeed` strips the `.env` family before any of it is stored.
   */
  source?: SerializedFileMap;

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

    /*
     * Cheap early reject: the body carries dist + source, each capped downstream (`publishBuild`,
     * `putRemixSeed`). A declared length past their combined ceiling is refused before we parse it.
     */
    const declaredLength = Number(request.headers.get('content-length') || '0');
    const bodyLimit = maxPublishBodyBytes(context);

    if (declaredLength > bodyLimit) {
      /*
       * An operator can set this below build + seed, in which case it — not the caps they tuned — is
       * what actually refused the publish. Say that here, where it bites: the alternative is a 413
       * naming a limit nobody changed, and an operator hunting the wrong variable.
       */
      const floor = publishBodyFloorBytes(context);

      if (bodyLimit < floor) {
        logger.warn(
          `PUBLISH_BODY_MAX_MB (${Math.round(bodyLimit / 1048576)}MB) is below BUILD_MAX_MB + ` +
            `REMIX_SEED_MAX_MB (${Math.round(floor / 1048576)}MB), so it is the real publish limit.`,
        );
      }

      return json({ error: true, message: 'That build is too large to publish.' }, { status: 413 });
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
     * Deposit the remix seed (§4.8, §4.5.4b).
     *
     * AFTER the upload, deliberately: the share is the thing the user asked for, and a seed that fails
     * to store must not cost them the publish. It is best-effort and says so — a project with no seed
     * remixes as an empty one.
     *
     * The seed is the ONLY reason the platform holds source at all under repo-primary persistence, and
     * it exists only for projects the owner deliberately made public. `unpublish` deletes it again.
     */
    const remix: RemixSeedOutcome = body.source
      ? await depositRemixSeed(project.id, body.source, context)
      : {
          remixable: false,
          remixBlockedReason: 'This game was published without its source, so it cannot be remixed.',
        };

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

    /*
     * 🔴 THE URL IS MINTED HERE, BY THE SERVER, AND HANDED OVER FINISHED (SPEC §2.5 rule 2).
     *
     * The client cannot build it: there is no root loader, `/api/me` carries no origin, and `brand.ts`
     * forbids `process.env` in the brand module because it is client-imported and a read there would
     * inline a build-time value. That is exactly why `ShareDialog` used to string-build
     * `window.location.origin + '/play/' + id` and therefore handed out an app-origin link from a
     * deployed instance — the config it needed was unreachable from where it was standing.
     *
     * This request has just published the build, so it knows the share id, the slug and the configured
     * domain. Sending a string costs nothing and removes the only reason a component would ever
     * construct one again.
     */
    // `remix` rides along: the publish succeeded either way, but the user must SEE it if it cannot be remixed.
    return json({ ...result, ...remix, url: shareUrl(result, context) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
