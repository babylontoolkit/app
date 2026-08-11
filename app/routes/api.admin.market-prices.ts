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
import { BAKED_COMET_PRICES } from '~/lib/.server/billing/baked-comet-prices';
import {
  activeMarketPriceVersionId,
  ensureMarketPrices,
  listVersions,
  promoteMarketPrices,
  readPointer,
  rollbackMarketPrices,
  MARKET_PRICE_PROVIDERS,
  type MarketPriceProvider,
} from '~/lib/.server/billing/market-price-store';
import { fetchKieMarketFeed, fetchCometMarketFeed } from '~/lib/.server/billing/market-feed';
import { env } from '~/lib/.server/env';
import { NotConfiguredError } from '~/lib/.server/agent/config';

const logger = createScopedLogger('api.admin.market-prices');

/** The build-time fallback per provider, shown for comparison and as a "reset to baked" source. */
const BAKED_BY_PROVIDER: Record<MarketPriceProvider, typeof BAKED_MARKET_PRICES> = {
  KIE: BAKED_MARKET_PRICES,
  Comet: BAKED_COMET_PRICES,
};

/**
 * Which marketplace a request is about.
 *
 * 🔴 The value arrives in an ADMIN-supplied body and selects which price list a promotion overwrites,
 * so an unrecognised value must never be coerced — writing Comet's rates over KIE's pointer is a
 * silent repricing of every generation. Default `KIE` preserves the pre-2026-08-10 request shape
 * exactly (an older admin bundle sends no provider), and anything else is refused by name.
 */
function requireProvider(value: unknown): MarketPriceProvider {
  if (value === undefined || value === null || value === '') {
    return 'KIE';
  }

  const match = MARKET_PRICE_PROVIDERS.find((name) => name === value);

  if (!match) {
    throw new Response(
      JSON.stringify({
        error: true,
        message: `Unknown price-list provider ${JSON.stringify(value)}. Expected one of: ${MARKET_PRICE_PROVIDERS.join(', ')}.`,
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }

  return match;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    await requireAdmin(request, context);

    const store = getObjectStore(context);
    const url = new URL(request.url);
    const provider = requireProvider(url.searchParams.get('provider') ?? undefined);

    const [active, pointer, versions] = await Promise.all([
      ensureMarketPrices(provider, context),
      readPointer(store, provider),
      listVersions(store, provider),
    ]);

    return json({
      provider,

      /** Every marketplace the panel can switch between — the UI must not hold its own list. */
      providers: MARKET_PRICE_PROVIDERS,

      /** What billing is using RIGHT NOW for this provider. `versionId: null` = the baked fallback. */
      active: { versionId: activeMarketPriceVersionId(provider), list: active },
      pointer,

      // Flagged so the UI renders "active" without re-deriving the rule.
      versions: versions.map((v) => ({ ...v, active: v.versionId === pointer?.versionId })),

      /** The build-time fallback, shown for comparison and as a "reset to baked" source. */
      baked: BAKED_BY_PROVIDER[provider],
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

  /** Which marketplace this action targets. Absent = KIE, the pre-Comet request shape. */
  provider?: string;
}

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    await requireAdmin(request, context);

    const body = await request.json<MarketPricesActionBody>();
    const store = getObjectStore(context);

    const provider = requireProvider(body.provider);

    if (body.action === 'promote') {
      const result = await promoteMarketPrices(store, provider, body.list, { note: body.note });

      if (!result.ok) {
        // 422 with EVERY error — the admin fixing a pasted list needs the whole picture at once.
        return json({ error: true, message: 'The price list was refused.', errors: result.errors }, 422);
      }

      logger.info(`${provider} marketplace prices promoted: ${result.pointer.versionId}`);

      return json({ ok: true, pointer: result.pointer });
    }

    if (body.action === 'rollback') {
      if (!body.versionId) {
        return json({ error: true, message: 'versionId is required to roll back' }, 400);
      }

      const result = await rollbackMarketPrices(store, provider, body.versionId);

      if (!result.ok) {
        return json({ error: true, message: result.message }, 404);
      }

      return json({ ok: true, pointer: result.pointer });
    }

    if (body.action === 'fetch-feed') {
      /*
       * Each vendor publishes a different shape (KIE: an unauthenticated POST pager returning display
       * strings; Comet: one authenticated GET returning numbers plus a per-row ratio), so this is a
       * dispatch rather than a URL swap. Both are for the operator's EYES and neither ever writes.
       */
      if (provider === 'Comet') {
        const apiKey = env(context, 'COMET_API_KEY');

        if (!apiKey) {
          throw new NotConfiguredError(
            'COMET_API_KEY',
            'The Comet model feed is authenticated, so the platform key is required to read it.',
          );
        }

        return json({ ok: true, feed: await fetchCometMarketFeed(apiKey, { filter: body.filter }) });
      }

      return json({ ok: true, feed: await fetchKieMarketFeed({ filter: body.filter }) });
    }

    return json({ error: true, message: `Unknown action: ${String(body.action)}` }, 400);
  } catch (error) {
    return errorResponse(error);
  }
}
