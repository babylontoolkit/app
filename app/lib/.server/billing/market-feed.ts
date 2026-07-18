/**
 * KIE's public pricing feed — the Admin panel's "what does kie.ai say today" view (SPEC §4.6).
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
