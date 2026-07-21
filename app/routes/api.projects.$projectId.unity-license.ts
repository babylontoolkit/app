/**
 * Unity Project Licenser — link / unlink / generate / status (SPEC §4.18, §4.5.3).
 *
 *   GET  /api/projects/:id/unity-license                          → { linkedUnityProjectId, tiers }
 *   POST /api/projects/:id/unity-license { action:'link', unityProjectId } → { ok, linkedUnityProjectId }
 *   POST /api/projects/:id/unity-license { action:'unlink' }      → { ok }
 *   POST /api/projects/:id/unity-license { action:'generate', tier } → { license, tier, credits, alreadyUnlocked }
 *
 * Two walls, as everywhere a project is touched: a verified session (`requireVerifiedUser`) AND proof
 * that this user owns THIS project (`requireOwnedProject`, 404-not-403).
 *
 * Generation is a FLAT credit charge per tier (the §4.18 price ladder), charged once per (Unity project,
 * tier) and free to re-generate after — the credit gate IS the Pro Tools entitlement. The tier is a
 * server-validated SELECTION (no longer derived from a Stripe plan); `licensee`/`product`/`project` are
 * server-derived, so a `unityProjectId`/`email`/`tier` a client puts in the body is either ignored or
 * validated, never trusted verbatim.
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { getProjectStore } from '~/lib/.server/projects/store';
import { errorResponse } from '~/lib/.server/http';
import { isValidUnityProjectId, type UnityLicensePlan } from '~/lib/.server/licensing/unity-license';
import {
  describeLicenseTiers,
  generateUnityLicense,
  LicenseRefusedError,
} from '~/lib/.server/licensing/unity-license-service';

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  try {
    const user = await requireVerifiedUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);

    const linkedUnityProjectId = project.linkedUnityProjectId ?? null;

    return json({
      linkedUnityProjectId,
      tiers: await describeLicenseTiers(user.id, linkedUnityProjectId, context),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

interface UnityLicenseBody {
  action?: 'link' | 'unlink' | 'generate';
  unityProjectId?: string;
  tier?: string;
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  try {
    if (request.method !== 'POST') {
      return json({ error: true, message: 'Method not allowed.' }, { status: 405 });
    }

    const user = await requireVerifiedUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);

    const body = await request.json<UnityLicenseBody>().catch(() => ({}) as UnityLicenseBody);
    const store = getProjectStore(context);

    switch (body.action) {
      case 'link': {
        if (!body.unityProjectId || !isValidUnityProjectId(body.unityProjectId)) {
          return json(
            { error: true, message: 'Enter a valid Unity Project ID — the 32-character productGUID from Unity.' },
            { status: 400 },
          );
        }

        const linkedUnityProjectId = body.unityProjectId.trim().toLowerCase();
        await store.update(project.id, { linkedUnityProjectId });

        return json({ ok: true, linkedUnityProjectId });
      }

      case 'unlink': {
        await store.update(project.id, { linkedUnityProjectId: undefined });
        return json({ ok: true, linkedUnityProjectId: null });
      }

      case 'generate': {
        if (!project.linkedUnityProjectId) {
          return json(
            { error: true, message: 'Link a Unity Project ID before generating a license.' },
            { status: 400 },
          );
        }

        try {
          const result = await generateUnityLicense({
            userId: user.id,
            licensee: user.email,
            unityProjectId: project.linkedUnityProjectId,
            projectName: project.name,

            // Validated at runtime by `generateUnityLicense` (isValidLicenseTier → 400 on a bad value).
            tier: body.tier as UnityLicensePlan,
            context,
          });

          return json(result);
        } catch (error) {
          if (error instanceof LicenseRefusedError) {
            return json({ error: true, message: error.message }, { status: error.statusCode });
          }

          throw error;
        }
      }

      default:
        return json({ error: true, message: 'Unknown action.' }, { status: 400 });
    }
  } catch (error) {
    return errorResponse(error);
  }
}
