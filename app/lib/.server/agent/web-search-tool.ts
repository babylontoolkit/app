/**
 * `web_search` — the model's server-side research tool (SPEC §4.2).
 *
 * Pairs with `web_fetch`: `web_search(query)` returns a ranked list of public results (title, URL,
 * snippet); the model then calls `web_fetch(url)` on the most relevant ones to read them and synthesize
 * an answer. No API key required — see `net/web-search.ts` for the provider seam.
 *
 * BILLING (§4.6): a paid backend (SerpApi/Brave) costs the platform per query, so each billable search
 * debits a FLAT credit toll (the Marketplace price list's `search` rate, migration 0010 reason `'search'`).
 *
 * 🔴 DEBITED BEFORE THE VENDOR CALL (no-unbilled-usage D9). It used to debit AFTER the vendor returned, and a
 * failed debit only logged — so a ledger hiccup meant the vendor was paid and nobody was charged, silently.
 * Now: debit first; a DEFINITE vendor failure refunds the toll; a timeout (the vendor may have served and
 * billed it) keeps it. With billing ENFORCED a debit that cannot land ALERTS and the vendor is NOT called —
 * never spend we cannot bill. Unmetered mode is unchanged: a failed debit warns and the search runs free.
 * A free backend (DuckDuckGo/SearXNG) never bills. Nothing here throws into the tool.
 *
 * A thin, NON-THROWING wrapper: a bad query or a backend hiccup is a recoverable tool_result string,
 * never a thrown error that kills the paid generation (the `tools.ts` lesson — validate in `execute`).
 */
import { tool } from 'ai';
import { z } from 'zod';
import { createScopedLogger } from '~/utils/logger';
import { webSearch, getSearchProvider, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from '~/lib/.server/net/web-search';
import { getLedger } from '~/lib/.server/billing/ledger';
import { getBillingConfig } from '~/lib/.server/billing/rates';
import { getMonitor } from '~/lib/.server/monitoring';
import { ALERT_SIGNALS } from '~/lib/.server/monitoring/events';
import { activeMarketPrices, ensureMarketPrices } from '~/lib/.server/billing/market-price-store';
import { searchCreditsFor } from '~/lib/.server/billing/market-prices';
import { BAKED_MARKET_PRICES } from '~/lib/.server/billing/baked-market-prices';

const logger = createScopedLogger('web-search-tool');

/** Who to bill for a paid search. Absent → the tool still works, it just does not bill (tests, BYOK-less callers). */
export interface SearchBillingContext {
  userId: string;
  context?: unknown;
}

/** The flat toll for one billable search — 0 when the price list says searches are free. */
async function searchToll(billing: SearchBillingContext): Promise<number> {
  await ensureMarketPrices('KIE', billing.context);

  /*
   * ⚠️ Explicitly the KIE list, which is byte-identical to the behaviour before the price store
   * became per-provider — not an oversight.
   *
   * The search toll is a PLATFORM number (a flat credit charge for a web search) that happens to
   * live inside a marketplace price list, so it does not belong to a gateway at all. Anchoring it
   * to the list it has always been read from keeps one answer; letting it follow `LLM_PROVIDER`
   * would make the price of a search change when the operator switched LLM vendors, which is a
   * surprise with no reason behind it. The baked fallback below covers a list that omits it.
   */
  return searchCreditsFor(activeMarketPrices('KIE'), BAKED_MARKET_PRICES.search!);
}

/**
 * Debit the toll BEFORE the vendor call. `{ credits }` on success (0 = nothing owed); `{ refused }` when the
 * debit could not land under ENFORCED billing — the caller must then not call the vendor. Never throws.
 */
async function debitSearch(
  query: string,
  billing: SearchBillingContext,
): Promise<{ credits: number; refused?: undefined } | { refused: string; credits?: undefined }> {
  let credits = 0;

  try {
    credits = await searchToll(billing);

    if (credits <= 0) {
      return { credits: 0 };
    }

    await getLedger(billing.context).append({
      userId: billing.userId,
      delta: -credits,
      reason: 'search',
      note: `web_search: ${query.slice(0, 120)}`,
    });

    return { credits };
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);

    if (!billingEnforced(billing.context)) {
      // Unmetered mode (unchanged): a failed debit never blocks research.
      logger.warn(`web_search debit failed (${message}) — unmetered, proceeding without charge.`);
      return { credits: 0 };
    }

    logger.error(`web_search debit failed (${message}) — the vendor is NOT called (billing enforced).`);
    getMonitor(billing.context).alert(
      ALERT_SIGNALS.LEDGER_INTEGRITY,
      `A web_search toll (${credits} credits) could not be debited, so the paid search was not run: ${message}`,
      { severity: 'warning', scope: 'web-search-debit', userId: billing.userId, tags: { credits } },
    );

    return { refused: message };
  }
}

function billingEnforced(context: unknown): boolean {
  try {
    return getBillingConfig(context).enforced;
  } catch {
    /* A config we cannot read is not permission to spend unbilled. */
    return true;
  }
}

/** Return a prepaid toll after a DEFINITE vendor failure. Never throws; a refund that does not land alerts. */
async function refundSearch(query: string, credits: number, reason: string, billing: SearchBillingContext) {
  try {
    await getLedger(billing.context).append({
      userId: billing.userId,
      delta: credits,
      reason: 'refund',
      note: `web_search refund: ${reason.slice(0, 80)} — ${query.slice(0, 80)}`,
    });
  } catch (error) {
    logger.error(`web_search refund of ${credits} credits did not land: ${(error as Error)?.message}`);
    getMonitor(billing.context).alert(
      ALERT_SIGNALS.LEDGER_INTEGRITY,
      `Refund of a ${credits}-credit web_search toll did NOT land — the user is charged for a failed search: ` +
        `${(error as Error)?.message}`,
      { severity: 'critical', scope: 'web-search-refund', userId: billing.userId, tags: { credits } },
    );
  }
}

export function createWebSearchTool(billing?: SearchBillingContext) {
  return {
    web_search: tool({
      description:
        'Search the public web for a query and get back a ranked list of results (title, URL, and a short ' +
        'snippet). Use it to RESEARCH a topic — e.g. how to do something, docs, forum/board discussions. ' +
        'Then call `web_fetch(url)` on the most relevant results to read the full pages before answering. ' +
        'Returns links + snippets, not full page text.',
      parameters: z.object({
        query: z.string().optional().describe('What to search for, in natural language.'),
        limit: z
          .number()
          .optional()
          .describe(`How many results to return (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}).`),
      }),
      execute: async ({ query, limit }) => {
        if (!query || !query.trim()) {
          return 'web_search needs a "query" — what would you like to search for?';
        }

        /*
         * The backend is resolved ONCE, before the call: whether this search is billable must be known
         * before it runs (the toll is debited first), and the search must run on the backend it was billed
         * for — `webSearch` is handed the same instance rather than re-reading config.
         */
        const provider = getSearchProvider();
        const billed = provider.billable && billing?.userId ? billing : undefined;
        let credits = 0;

        if (billed) {
          const debit = await debitSearch(query, billed);

          if (debit.refused !== undefined) {
            return 'Web search is unavailable right now (the search could not be billed). Continue without it, or ask the user to paste a relevant URL.';
          }

          credits = debit.credits;
        }

        const outcome = await webSearch(query, limit ?? DEFAULT_SEARCH_LIMIT, provider);

        if (!outcome.ok) {
          logger.warn(`web_search(${query}) failed: ${outcome.error}`);

          /* A definite failure refunds the toll; a timeout keeps it (the vendor may have served it). */
          if (billed && credits > 0 && !outcome.maybeCharged) {
            await refundSearch(query, credits, outcome.error, billed);
          }

          return `Web search failed: ${outcome.error}. You can try rephrasing the query, or ask the user to paste a relevant URL.`;
        }

        if (credits > 0) {
          logger.info(`web_search(${query}) billed ${credits} credits (${outcome.provider})`);
        }

        if (outcome.results.length === 0) {
          return `No results found for "${query}". Try a broader or differently-worded query.`;
        }

        const list = outcome.results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
          .join('\n\n');

        return `Search results for "${query}":\n\n${list}\n\nCall web_fetch on the most relevant URLs to read them before answering.`;
      },
    }),
  };
}
