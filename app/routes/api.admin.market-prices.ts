/**
 * Marketplace price list admin endpoints (SPEC §4.6, spec/billing.md).
 *
 *   GET  /api/admin/market-prices              → the active list + version history + baked reference
 *   POST /api/admin/market-prices  promote     → validate a candidate list, store it, make it live
 *   POST /api/admin/market-prices  rollback    → re-point at a stored version
 *   POST /api/admin/market-prices  fetch-feed  → KIE's public pricing feed, for the admin's EYES
 *
 * This is the ONLY way platform prices change without a deploy — the env price vars are retired
 * (`rates.ts` refuses them). Admin-only (session `isAdmin`), like the template pin: an open promote
 * endpoint would let anyone set the platform's cost basis, which prices every user's credits.
 *
 * 🔴 `fetch-feed` NEVER writes anything. It returns KIE's free-text display rows for the operator to
 * compare against the curated list; auto-applying a third party's feed to our billing table would
 * hand KIE's webmaster write access to our margin.
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { createScopedLogger } from '~/utils/logger';
import { requireAdmin } from '~/lib/.server/supabase/auth';
import { getObjectStore } from '~/lib/.server/storage';
import { errorResponse } from '~/lib/.server/http';
import { BAKED_MARKET_PRICES } from '~/lib/.server/billing/baked-market-prices';
import {
  activeMarketPriceVersionId,
  ensureMarketPrices,
  listVersions,
  promoteMarketPrices,
  readPointer,
  rollbackMarketPrices,
} from '~/lib/.server/billing/market-price-store';
import { fetchKieMarketFeed } from '~/lib/.server/billing/market-feed';

const logger = createScopedLogger('api.admin.market-prices');

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    await requireAdmin(request, context);

    const store = getObjectStore(context);
    const [active, pointer, versions] = await Promise.all([
      ensureMarketPrices(context),
      readPointer(store),
      listVersions(store),
    ]);

    return json({
      /** What billing is using RIGHT NOW. `versionId: null` = the baked fallback. */
      active: { versionId: activeMarketPriceVersionId(), list: active },
      pointer,

      // Flagged so the UI renders "active" without re-deriving the rule.
      versions: versions.map((v) => ({ ...v, active: v.versionId === pointer?.versionId })),

      /** The build-time fallback, shown for comparison and as a "reset to baked" source. */
      baked: BAKED_MARKET_PRICES,
      storage: store.backend,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

interface MarketPricesActionBody {
  action: 'promote' | 'rollback' | 'fetch-feed';

  /** promote: the candidate list (untrusted — fully validated before it can price anything). */
  list?: unknown;
  note?: string;

  /** rollback */
  versionId?: string;

  /** fetch-feed: optional server-side model filter. */
  filter?: string;
}

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    await requireAdmin(request, context);

    const body = await request.json<MarketPricesActionBody>();
    const store = getObjectStore(context);

    if (body.action === 'promote') {
      const result = await promoteMarketPrices(store, body.list, { note: body.note });

      if (!result.ok) {
        // 422 with EVERY error — the admin fixing a pasted list needs the whole picture at once.
        return json({ error: true, message: 'The price list was refused.', errors: result.errors }, 422);
      }

      logger.info(`Marketplace prices promoted: ${result.pointer.versionId}`);

      return json({ ok: true, pointer: result.pointer });
    }

    if (body.action === 'rollback') {
      if (!body.versionId) {
        return json({ error: true, message: 'versionId is required to roll back' }, 400);
      }

      const result = await rollbackMarketPrices(store, body.versionId);

      if (!result.ok) {
        return json({ error: true, message: result.message }, 404);
      }

      return json({ ok: true, pointer: result.pointer });
    }

    if (body.action === 'fetch-feed') {
      const feed = await fetchKieMarketFeed({ filter: body.filter });

      return json({ ok: true, feed });
    }

    return json({ error: true, message: `Unknown action: ${String(body.action)}` }, 400);
  } catch (error) {
    return errorResponse(error);
  }
}
