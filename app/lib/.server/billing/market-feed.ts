/**
 * Vendor pricing feeds — the Admin panel's "what does the vendor say today" view (SPEC §4.6): KIE and
 * fal.ai at the end. KIE's public pricing feed first.
 *
 * `POST https://api.kie.ai/client/v1/model-pricing/page` is the same public, unauthenticated endpoint
 * KIE's own /pricing page reads (verified server-reachable 2026-07-18; the kie.ai WEBSITE blocks
 * server fetchers, the API host does not). It returns display rows — free-text model descriptions
 * with typos ("per milion tokens", "0,325") — so it is for the OPERATOR'S EYES in the admin panel,
 * compared against the curated list by a human.
 *
 * 🔴 It is NEVER machine-applied to the active price list. The whole point of the promotion flow is
 * that a price change is a deliberate, reviewed admin action; auto-applying a third party's free-text
 * feed to our billing table would hand KIE's webmaster write access to our margin. Same rule as the
 * template pin: fetching is free, PROMOTING is the decision.
 *
 * Billing never calls this — it reads the promoted list (`market-price-store.ts`). A kie.ai outage
 * costs the admin a comparison view, never a generation.
 */
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('market-feed');

const FEED_URL = 'https://api.kie.ai/client/v1/model-pricing/page';
const PAGE_SIZE = 25;

/** Hard stop well above today's 15 pages — a runaway pager must not hammer a third party. */
const MAX_PAGES = 40;

/** One display row, exactly as KIE returns it. Free text — never parsed into billing. */
export interface KieFeedRow {
  modelDescription: string;
  interfaceType: string;
  provider: string;
  creditPrice: string;
  creditUnit: string;
  usdPrice: string;
  falPrice: string;
  discountRate: number;
}

export interface KieFeedResult {
  rows: KieFeedRow[];

  /** The total KIE reported, so the UI can say "fetched 372 of 372" (or flag a short read). */
  reportedTotal: number;
  fetchedAt: string;
}

export async function fetchKieMarketFeed(options?: { filter?: string }): Promise<KieFeedResult> {
  const rows: KieFeedRow[] = [];
  let reportedTotal = 0;

  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    const response = await fetch(FEED_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pageNum,
        pageSize: PAGE_SIZE,
        modelDescription: options?.filter ?? '',
        interfaceType: '',
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`KIE pricing feed returned HTTP ${response.status}`);
    }

    const json = (await response.json()) as {
      code?: number;
      data?: { records?: KieFeedRow[]; total?: number };
    };

    if (json.code !== 200 || !json.data) {
      throw new Error(`KIE pricing feed returned an error payload (code ${json.code ?? 'missing'})`);
    }

    const records = json.data.records ?? [];
    reportedTotal = json.data.total ?? reportedTotal;
    rows.push(...records);

    if (records.length < PAGE_SIZE) {
      break;
    }
  }

  if (rows.length < reportedTotal) {
    // A short read is surfaced, not silently truncated — the admin is comparing against this.
    logger.warn(`KIE feed short read: fetched ${rows.length} of ${reportedTotal} rows`);
  }

  return { rows, reportedTotal, fetchedAt: new Date().toISOString() };
}

/*
 * ------------------------------------------------------------------------------------------------ *
 * fal.ai's pricing API (media-gateways T2)
 * ------------------------------------------------------------------------------------------------
 */

const FAL_PRICING_URL = 'https://api.fal.ai/v1/models/pricing';

/** fal accepts 1–50 `endpoint_id`s per request. */
export const FAL_PRICING_BATCH = 50;

/**
 * One row of fal's pricing API, as returned. `unit` is fal's own word ("images", "seconds",
 * "1000 characters") — shown, never parsed into billing.
 */
export interface FalFeedRow {
  endpointId: string;
  unitPrice: number | null;
  unit: string;
  currency: string;
}

export interface FalFeedResult {
  rows: FalFeedRow[];

  /** How many ids were asked about — a row short of this is an id fal no longer recognises. */
  reportedTotal: number;
  fetchedAt: string;
}

/**
 * fal's prices for the ids the active fal list carries, for the ADMIN'S EYES ONLY.
 *
 * 🔴 Never machine-applied, exactly like the KIE feed. Two further reasons apply to fal:
 * the prices are ACCOUNT-SPECIFIC (they reflect this key's discounts, so they are not a list price),
 * and the API returns ONE base price per model — resolution, audio and duration multipliers live only
 * in each model's prose, so the variant rows in the list are curated by hand (`baked-fal-prices.ts`).
 *
 * This is not a browse: fal's API answers only for the ids it is asked about,
 * so the caller passes the ids of the active list and they are sent in batches of 50 (fal's limit).
 * `Authorization: Key <key>` — fal's scheme, not `Bearer`.
 */
export async function fetchFalMarketFeed(
  apiKey: string,
  options: { endpointIds: string[]; filter?: string },
): Promise<FalFeedResult> {
  const filter = options.filter?.trim().toLowerCase();
  const ids = [...new Set(options.endpointIds)].filter((id) => !filter || id.toLowerCase().includes(filter));
  const rows: FalFeedRow[] = [];

  for (let i = 0; i < ids.length; i += FAL_PRICING_BATCH) {
    const batch = ids.slice(i, i + FAL_PRICING_BATCH);

    /*
     * Ids are joined with a literal comma (fal's documented form) and each id is encoded on its own:
     * ids contain `/`, which is safe in a query value, and encoding the comma would make fal read the
     * whole batch as ONE id and answer 404 "Endpoint(s) not found".
     */
    const query = batch.map((id) => encodeURIComponent(id)).join(',');
    const response = await fetch(`${FAL_PRICING_URL}?endpoint_id=${query}`, {
      headers: { Authorization: `Key ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`fal pricing API returned HTTP ${response.status}`);
    }

    const json = (await response.json()) as { prices?: unknown } | null;

    if (!json || typeof json !== 'object' || !Array.isArray(json.prices)) {
      throw new Error('fal pricing API returned no prices array');
    }

    for (const r of json.prices as Array<Record<string, unknown>>) {
      rows.push({
        endpointId: String(r.endpoint_id ?? ''),
        unitPrice: typeof r.unit_price === 'number' && Number.isFinite(r.unit_price) ? r.unit_price : null,
        unit: String(r.unit ?? ''),
        currency: String(r.currency ?? ''),
      });
    }
  }

  if (rows.length < ids.length) {
    logger.warn(`fal pricing API short read: ${rows.length} prices for ${ids.length} ids`);
  }

  return { rows, reportedTotal: ids.length, fetchedAt: new Date().toISOString() };
}
