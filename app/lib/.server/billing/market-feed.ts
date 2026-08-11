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

/*
 * ------------------------------------------------------------------------------------------------ *
 * Comet's model feed
 * ------------------------------------------------------------------------------------------------
 */

/** Comet publishes its whole catalogue in one authenticated GET — no paging, unlike KIE's POST pager. */
const COMET_FEED_URL = 'https://api.cometapi.com/api/models';

/**
 * One row of Comet's feed, reduced to the fields an operator compares against the promoted list.
 *
 * 🔴 **`input`/`output` are the OFFICIAL VENDOR rates; the CHARGED rate is `input x ratio`.** This
 * shape keeps all three so the panel can show the arithmetic rather than a number whose meaning has
 * to be remembered — reading `input` as the charged rate is the mistake that produced "no discount on
 * Opus 5" on the first pass of this investigation.
 *
 * ⚠️ `ratio` is PER ROW. 273 of 276 rows carry 0.8 and three carry 1.0, so a UI (or a capture) that
 * folds in a constant under-charges exactly the newest and most expensive models.
 */
export interface CometFeedRow {
  id: string;

  /** Comet's own display code, which DISAGREES with `id` on some rows (`grok-4.5` → `grok-4-5`). */
  code: string;
  name: string;
  modelType: string;
  officialInputPerMTok: number | null;
  officialOutputPerMTok: number | null;
  ratio: number | null;

  /** `official x ratio`, computed here so every reader sees the same number. Null when unpriceable. */
  chargedInputPerMTok: number | null;
  chargedOutputPerMTok: number | null;
  contextLength: string | null;
  maxCompletionTokens: string | null;
}

export interface CometFeedResult {
  rows: CometFeedRow[];
  reportedTotal: number;
  fetchedAt: string;
}

function charged(official: number | null | undefined, ratio: number | null | undefined): number | null {
  /*
   * BOTH operands are finite-checked, and the symmetry is the point: checking only `official` let a
   * row with `ratio: NaN` through as `NaN`, which renders as a BLANK CELL — indistinguishable from a
   * free model, on the screen an operator uses to decide what to charge.
   */
  if (typeof official !== 'number' || !Number.isFinite(official)) {
    return null;
  }

  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) {
    return null;
  }

  // Two decimals — 0.3 x 0.8 is 0.24000000000000002 in binary floating point.
  return Math.round(official * ratio * 100) / 100;
}

/**
 * Comet's catalogue, for the ADMIN'S EYES ONLY.
 *
 * 🔴 Never machine-applied, exactly like the KIE variant above: auto-applying a third party's feed to
 * our billing table hands their webmaster write access to our margin. It exists so an operator can
 * SEE that a promoted row has drifted, and then decide.
 *
 * ⚠️ It is also **not a probe**. A row here is evidence of a price, never evidence that the id can be
 * called — `claude-haiku-4-5` is absent from this feed AND 400s on the wire, while `grok-4.5` appears
 * under the display code `grok-4-5`. An id ships only after a request to it returns 200 (FR4).
 */
export async function fetchCometMarketFeed(apiKey: string, options?: { filter?: string }): Promise<CometFeedResult> {
  const response = await fetch(COMET_FEED_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Comet model feed returned HTTP ${response.status}`);
  }

  /*
   * A body of literal `null` parses fine and then throws a bare TypeError on property access — so the
   * shape is checked before it is read, and the failure says what was wrong with it.
   */
  const json = (await response.json()) as { data?: unknown } | null;

  if (!json || typeof json !== 'object' || !Array.isArray(json.data)) {
    throw new Error('Comet model feed returned no data array');
  }

  const records = json.data as Array<Record<string, any>>;

  const filter = options?.filter?.trim().toLowerCase();

  /*
   * ⚠️ The filter matches `id` OR `code`, because this module's own header records that the two
   * DISAGREE on some rows (`grok-4.5` carries `code: "grok-4-5"`). Matching `id` alone meant an
   * operator who typed the code Comet shows in its own UI got zero rows out of 276 — which reads as
   * "Comet does not sell it" rather than "you spelled it their other way", on the panel whose entire
   * job is telling those two states apart.
   */
  const rows: CometFeedRow[] = records
    .filter((r) => !filter || `${r.id ?? ''} ${r.code ?? ''}`.toLowerCase().includes(filter))
    .map((r) => {
      const ratio = typeof r.pricing?.ratio === 'number' ? r.pricing.ratio : null;
      const officialIn = typeof r.pricing?.input === 'number' ? r.pricing.input : null;
      const officialOut = typeof r.pricing?.output === 'number' ? r.pricing.output : null;

      return {
        id: String(r.id ?? ''),
        code: String(r.code ?? ''),
        name: String(r.name ?? ''),
        modelType: String(r.model_type ?? ''),
        officialInputPerMTok: officialIn,
        officialOutputPerMTok: officialOut,
        ratio,
        chargedInputPerMTok: charged(officialIn, ratio),
        chargedOutputPerMTok: charged(officialOut, ratio),
        contextLength: r.context_length == null ? null : String(r.context_length),
        maxCompletionTokens: r.max_completion_tokens == null ? null : String(r.max_completion_tokens),
      };
    });

  return { rows, reportedTotal: records.length, fetchedAt: new Date().toISOString() };
}
