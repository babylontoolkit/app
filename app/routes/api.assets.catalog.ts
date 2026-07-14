/**
 * The asset store catalog (SPEC §4.9).
 *
 *   GET /api/assets/catalog  → hosted scenes, interactive prefabs, and file packs available to add
 *
 * The catalog is static config (`app/config/assets.json`), not per-user data, so this is a plain read
 * available to any signed-in user. Premium items are marked; the actual purchase/entitlement gate for a
 * premium asset lives at the point of ADD (future — the Stripe one-time flow, §4.9), not here. This
 * endpoint just describes what exists so the assets tab can render the grid.
 */
import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import catalog from '~/config/assets.json';
import { getUser } from '~/lib/.server/supabase/auth';
import { errorResponse } from '~/lib/.server/http';

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    // Signed-in only — the catalog is a product surface, not a public API. Not project-scoped.
    await getUser(request, context);

    return json(
      { scenes: catalog.scenes, prefabs: catalog.prefabs, packs: catalog.packs, version: catalog.version },
      { headers: { 'cache-control': 'public, max-age=300' } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
