/**
 * Per-project asset uploads (SPEC §4.9, §5).
 *
 *   GET  /api/projects/:id/assets                          → the project's uploaded assets
 *   POST /api/projects/:id/assets  { filename, base64 }    → validate, store, introspect, record
 *   DELETE /api/projects/:id/assets  { assetId }           → remove an asset (bytes + row)
 *
 * Two walls (verified user + owned project). Uploads are validated SERVER-SIDE and never executed
 * (§5): the validator gates type (allow-list), size, per-user quota, and structural soundness before a
 * single byte is stored. For a glTF/GLB the platform runs asset introspection (§4.9) at upload time and
 * stores the component reference on the row, so every later generation can be told what the asset
 * actually contains without re-scanning it.
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { getUserAssetStore, assetKey } from '~/lib/.server/assets/store';
import { validateAssetUpload, DEFAULT_ASSET_LIMITS } from '~/lib/.server/assets/validate';
import { glbToJson, looksLikeGlb } from '~/lib/.server/assets/glb';
import { introspectGltf, renderComponentReference } from '~/lib/.server/assets/introspect';
import { base64ToBytes } from '~/lib/binary/binary-files';
import { contentTypeFor } from '~/lib/.server/share/publish';
import { errorResponse } from '~/lib/.server/http';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.assets');

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  try {
    const user = await requireVerifiedUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);

    const assets = await getUserAssetStore(context).listByProject(project.id);

    return json({
      assets: assets.map((a) => ({
        id: a.id,
        filename: a.filename,
        kind: a.kind,
        byteSize: a.byteSize,
        hasComponents: Boolean(a.introspection),
        createdAt: a.createdAt,
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  try {
    const user = await requireVerifiedUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);
    const store = getUserAssetStore(context);

    if (request.method === 'DELETE') {
      const { assetId } = await request.json<{ assetId: string }>();
      const asset = assetId ? await store.get(assetId) : null;

      // Ownership: the asset must belong to this caller. 404 (not 403) for anyone else's — no oracle.
      if (!asset || asset.userId !== user.id) {
        return json({ error: true, message: 'That asset does not exist.' }, { status: 404 });
      }

      await store.delete(assetId);

      return json({ ok: true });
    }

    const body = await request.json<{ filename: string; base64: string }>();

    if (!body?.filename || !body?.base64) {
      return json({ error: true, message: 'An upload needs a filename and base64 content.' }, { status: 400 });
    }

    const bytes = base64ToBytes(body.base64);
    const currentUserBytes = await store.bytesUsedBy(user.id);

    const validation = validateAssetUpload({ filename: body.filename, bytes, currentUserBytes }, DEFAULT_ASSET_LIMITS);

    if (!validation.ok) {
      return json({ error: true, code: validation.code, message: validation.message }, { status: 422 });
    }

    // Introspect a model at upload time (§4.9), so the component reference is ready for every generation.
    let introspection: string | undefined;

    if (validation.kind === 'model') {
      try {
        const gltf = looksLikeGlb(bytes) ? glbToJson(bytes) : JSON.parse(new TextDecoder().decode(bytes));
        introspection = renderComponentReference(body.filename, introspectGltf(gltf)) ?? undefined;
      } catch (error) {
        // A model we cannot introspect is still a valid upload — it just gets no component reference.
        logger.info(`Could not introspect ${body.filename}: ${(error as Error).message}`);
      }
    }

    // Unique per upload — a timestamp plus randomness so two uploads in the same millisecond never collide.
    const storagePath = assetKey(
      user.id,
      `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      validation.extension,
    );

    const asset = await store.create(
      {
        userId: user.id,
        projectId: project.id,
        filename: body.filename,
        contentType: contentTypeFor(body.filename),
        byteSize: bytes.byteLength,
        storagePath,
        kind: validation.kind,
        introspection,
      },
      bytes,
    );

    return json(
      {
        ok: true,
        asset: { id: asset.id, filename: asset.filename, kind: asset.kind, hasComponents: Boolean(introspection) },
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
