/**
 * Synty asset library admin endpoints (SPEC §4.4d, `_specs/asset-library_plan.md`).
 *
 *   GET  /api/admin/asset-library                → the active manifest + version history
 *   POST /api/admin/asset-library  promote       → validate a candidate manifest, store it, make it live
 *   POST /api/admin/asset-library  rollback      → re-point at a stored version
 *   POST /api/admin/asset-library  unpin         → remove the pointer (generations run without a library)
 *   POST /api/admin/asset-library  fetch-master  → fetch `repo.babylontoolkit.com/assets.json` for the
 *                                                  admin's EYES — never machine-applied
 *
 * The template-pin rules applied to the asset library: promotion is the ONLY way the model's view of
 * the library changes, and `fetch-master` writes nothing — auto-applying whatever the bucket serves
 * would hand anyone who can write that object the model's context. Admin-only for the same reason.
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { createScopedLogger } from '~/utils/logger';
import { requireAdmin } from '~/lib/.server/supabase/auth';
import { getObjectStore } from '~/lib/.server/storage';
import { errorResponse } from '~/lib/.server/http';
import { ASSET_LIBRARY_MASTER_URL, buildAssetLibraryIndex } from '~/lib/.server/assets/library-manifest';
import {
  activeAssetLibraryVersionId,
  ensureAssetLibrary,
  listAssetVersions,
  promoteAssetLibrary,
  readAssetLibrarySettings,
  readAssetPointer,
  rollbackAssetLibrary,
  setAssetLibraryEnabled,
  unpinAssetLibrary,
} from '~/lib/.server/assets/library-store';

const logger = createScopedLogger('api.admin.asset-library');

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    await requireAdmin(request, context);

    const store = getObjectStore(context);
    const [active, pointer, versions, settings] = await Promise.all([
      ensureAssetLibrary(store),
      readAssetPointer(store),
      listAssetVersions(store),
      readAssetLibrarySettings(store),
    ]);

    return json({
      /**
       * The "Use Asset Library" feature switch (Settings → Admin → Features). When false, `active`
       * below is empty EVEN IF a pin exists — that is the gate working, not a missing pin; the UI
       * reads `pointer` to show what is pinned-but-dormant.
       */
      enabled: settings.enabled,

      /** What the prompt is using RIGHT NOW. `versionId: null` = no library pinned, no block emitted. */
      active: {
        versionId: activeAssetLibraryVersionId(),
        packCount: active?.packs.length ?? 0,
        assetCount: active?.packs.reduce((sum, pack) => sum + pack.assets.length, 0) ?? 0,
        baseUrl: active?.baseUrl ?? null,

        /** The exact block the model sees — the admin can read what was just bought. */
        index: buildAssetLibraryIndex(active) ?? null,
      },
      pointer,
      versions: versions.map((v) => ({ ...v, active: v.versionId === pointer?.versionId })),
      masterUrl: ASSET_LIBRARY_MASTER_URL,
      storage: store.backend,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

interface AssetLibraryActionBody {
  action: 'promote' | 'rollback' | 'unpin' | 'fetch-master' | 'set-enabled';

  /** promote: the candidate manifest (untrusted — fully validated before it can reach the prompt). */
  manifest?: unknown;
  note?: string;

  /** rollback */
  versionId?: string;

  /** fetch-master: override the URL (defaults to the repo master). */
  url?: string;

  /** set-enabled: the Use-Asset-Library feature switch. Must be exactly a boolean. */
  enabled?: unknown;
}

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    await requireAdmin(request, context);

    const body = await request.json<AssetLibraryActionBody>();
    const store = getObjectStore(context);

    if (body.action === 'promote') {
      const result = await promoteAssetLibrary(store, body.manifest, { note: body.note });

      if (!result.ok) {
        // 422 with EVERY error — the admin fixing an export needs the whole picture at once.
        return json({ error: true, message: 'The asset manifest was refused.', errors: result.errors }, 422);
      }

      logger.info(`Asset library promoted: ${result.pointer.versionId}`);

      return json({ ok: true, pointer: result.pointer });
    }

    if (body.action === 'rollback') {
      if (!body.versionId) {
        return json({ error: true, message: 'versionId is required to roll back' }, 400);
      }

      const result = await rollbackAssetLibrary(store, body.versionId);

      if (!result.ok) {
        return json({ error: true, message: result.message }, 404);
      }

      return json({ ok: true, pointer: result.pointer });
    }

    if (body.action === 'unpin') {
      await unpinAssetLibrary(store);
      return json({ ok: true });
    }

    if (body.action === 'set-enabled') {
      // Refuse anything but a real boolean — "truthy" from a request body is how a typo enables a feature.
      if (typeof body.enabled !== 'boolean') {
        return json({ error: true, message: 'enabled must be true or false' }, 400);
      }

      const settings = await setAssetLibraryEnabled(store, body.enabled);
      logger.info(`Use Asset Library switched ${settings.enabled ? 'ON' : 'OFF'}`);

      return json({ ok: true, enabled: settings.enabled });
    }

    if (body.action === 'fetch-master') {
      /*
       * For the operator's EYES: fetch the master manifest so they can review + promote it. Only
       * https URLs on the repo host (or the default) — this runs server-side with no user in the
       * loop, and a free-form URL here would be an admin-triggered SSRF.
       */
      const url = body.url?.trim() || ASSET_LIBRARY_MASTER_URL;

      if (!/^https:\/\/([a-z0-9-]+\.)*babylontoolkit\.com\//i.test(url)) {
        return json({ error: true, message: 'Only https://…babylontoolkit.com URLs can be fetched here.' }, 400);
      }

      const response = await fetch(url, { headers: { accept: 'application/json' } });

      if (!response.ok) {
        return json({ error: true, message: `The master manifest fetch failed: HTTP ${response.status}` }, 502);
      }

      const candidate = (await response.json()) as unknown;

      return json({ ok: true, url, candidate });
    }

    return json({ error: true, message: `Unknown action: ${String(body.action)}` }, 400);
  } catch (error) {
    return errorResponse(error);
  }
}
