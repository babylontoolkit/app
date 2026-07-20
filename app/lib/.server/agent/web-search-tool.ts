/**
 * `web_search` — the model's server-side research tool (SPEC §4.2).
 *
 * Pairs with `web_fetch`: `web_search(query)` returns a ranked list of public results (title, URL,
 * snippet); the model then calls `web_fetch(url)` on the most relevant ones to read them and synthesize
 * an answer. No API key required — see `net/web-search.ts` for the provider seam.
 *
 * BILLING (§4.6): a paid backend (SerpApi/Brave) costs the platform per query, so each SUCCESSFUL
 * billable search debits a FLAT credit toll (the Marketplace price list's `search` rate, migration 0010
 * reason `'search'`) — debited AFTER the vendor returned, so a failed or free (DuckDuckGo/SearXNG) search
 * never bills. The debit is best-effort and NEVER throws into the tool: the vendor was already paid, and
 * `'search'` may go negative, so failing to record it must not break the research answer.
 *
 * A thin, NON-THROWING wrapper: a bad query or a backend hiccup is a recoverable tool_result string,
 * never a thrown error that kills the paid generation (the `tools.ts` lesson — validate in `execute`).
 */
import { tool } from 'ai';
import { z } from 'zod';
import { createScopedLogger } from '~/utils/logger';
import { webSearch, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from '~/lib/.server/net/web-search';
import { getLedger } from '~/lib/.server/billing/ledger';
import { activeMarketPrices, ensureMarketPrices } from '~/lib/.server/billing/market-price-store';
import { searchCreditsFor } from '~/lib/.server/billing/market-prices';
import { BAKED_MARKET_PRICES } from '~/lib/.server/billing/baked-market-prices';

const logger = createScopedLogger('web-search-tool');

/** Who to bill for a paid search. Absent → the tool still works, it just does not bill (tests, BYOK-less callers). */
export interface SearchBillingContext {
  userId: string;
  context?: unknown;
}

/** Debit the flat search toll for a billable search. Best-effort, non-throwing. Returns credits charged. */
async function debitSearch(query: string, billing: SearchBillingContext): Promise<number> {
  try {
    await ensureMarketPrices(billing.context);

    const credits = searchCreditsFor(activeMarketPrices(), BAKED_MARKET_PRICES.search!);

    if (credits <= 0) {
      return 0;
    }

    await getLedger(billing.context).append({
      userId: billing.userId,
      delta: -credits,
      reason: 'search',
      note: `web_search: ${query.slice(0, 120)}`,
    });

    return credits;
  } catch (error) {
    // The vendor was already paid; 'search' may go negative — so a failed debit must not break research.
    logger.warn(`web_search debit failed (${(error as Error).message}) — proceeding without charge.`);
    return 0;
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

        const outcome = await webSearch(query, limit ?? DEFAULT_SEARCH_LIMIT);

        if (!outcome.ok) {
          logger.warn(`web_search(${query}) failed: ${outcome.error}`);
          return `Web search failed: ${outcome.error}. You can try rephrasing the query, or ask the user to paste a relevant URL.`;
        }

        // Bill AFTER a successful billable search — a failed or free-provider search never charges.
        if (outcome.billable && billing?.userId) {
          const credits = await debitSearch(query, billing);

          if (credits > 0) {
            logger.info(`web_search(${query}) billed ${credits} credits (${outcome.provider})`);
          }
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
