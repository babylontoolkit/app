/**
 * Add a STORE-CATALOG asset to a project (SPEC §4.9) — the premium gate lives here.
 *
 *   POST /api/projects/:id/assets/catalog  { assetId }  → { ok, item }  |  402 (purchase / not configured)
 *
 * Uploads go through the sibling `assets` route; this one adds a catalog item (hosted scene, prefab, or
 * pack) by id. A FREE item is added straight away. A PREMIUM item requires that the user has bought it
 * (`asset_entitlements`, granted by the Stripe webhook) — the gate is a pure function
 * (`decidePremiumAssetAdd`) so the paywall cannot silently leak or silently block a paying user.
 *
 * Two walls as everywhere: verified user + owned project. The item shape is resolved SERVER-SIDE from
 * the catalog config — the client sends only an id, never a price or a url it could tamper with.
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { errorResponse } from '~/lib/.server/http';
import { findCatalogItem } from '~/lib/.server/assets/catalog';
import { getAssetEntitlementStore } from '~/lib/.server/assets/entitlements';
import { decidePremiumAssetAdd } from '~/lib/.server/assets/premium';
import { isStripeConfigured } from '~/lib/.server/billing/stripe';

export async function action({ request, params, context }: ActionFunctionArgs) {
  try {
    if (request.method !== 'POST') {
      return json({ error: true, message: 'Method not allowed.' }, { status: 405 });
    }

    const user = await requireVerifiedUser(request, context);
    await requireOwnedProject(user, params.projectId!, context);

    const body = await request.json<{ assetId?: string }>();
    const item = body.assetId ? findCatalogItem(body.assetId) : null;

    if (!item) {
      return json({ error: true, message: 'That store asset does not exist.' }, { status: 404 });
    }

    const entitled = item.premium ? await getAssetEntitlementStore(context).has(user.id, item.id) : false;
    const decision = decidePremiumAssetAdd({ item, entitled, stripeConfigured: isStripeConfigured(context) });

    if (!decision.allow) {
      if (decision.reason === 'payments-not-configured') {
        return json(
          { error: true, message: 'Premium purchases are not available on this server yet.', reason: decision.reason },
          { status: 402 },
        );
      }

      return json(
        {
          error: true,
          message: `"${item.title}" is a premium asset. Purchase it to add it to your project.`,
          reason: decision.reason,
          assetId: item.id,
          priceCents: decision.priceCents,
        },
        { status: 402 },
      );
    }

    /*
     * Allowed. The item is returned for the client to use — its scene url / prefab components ride into
     * the generation context as an asset note (§4.9), so the agent scaffolds against the real asset.
     * Placement itself is the agent's job when the user asks; this route is the gate + the reference.
     */
    return json({
      ok: true,
      item: {
        id: item.id,
        title: item.title,
        kind: item.kind,
        url: item.url,
        components: item.components ?? [],
      },
      reason: decision.reason,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
