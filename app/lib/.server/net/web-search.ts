/**
 * Web search for the agent's research tool (SPEC §4.2) — turn a query into ranked public results.
 *
 * No API key required: the default provider scrapes DuckDuckGo's HTML endpoint. It is deliberately
 * behind a small `SearchProvider` seam (like the codebase's other provider seams) so a keyed provider
 * (Brave, Tavily, …) can be dropped in later WITHOUT touching the tool or the agent — the only reason
 * to do so is robustness: a scrape can be rate-limited or blocked when a lot of requests share one
 * server IP, and the HTML shape is the vendor's to change.
 *
 * The search request targets a FIXED public host (the query is only a parameter), so it is not the
 * caller-controlled-URL SSRF shape — the result URLs are handed back to the model as strings, and it
 * reads them through `web_fetch`, which IS SSRF-guarded (`net/fetch-url.ts`). `webSearch` never throws:
 * it returns a discriminated result so the tool maps failure to a recoverable message.
 */
import { extractTextContent } from '~/lib/.server/net/fetch-url';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('web-search');

const SEARCH_TIMEOUT_MS = 10_000;
export const DEFAULT_SEARCH_LIMIT = 6;
export const MAX_SEARCH_LIMIT = 10;

const SEARCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Content-Type': 'application/x-www-form-urlencoded',
};

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  readonly name: string;

  /**
   * Does a search on this provider cost the platform money? SerpApi/Brave charge per query (→ the user
   * is billed the flat `search` rate); DuckDuckGo/SearXNG have no per-query cost (→ never billed). The
   * billing decision keys off this, so a free fallback never charges the user.
   */
  readonly billable: boolean;

  search(query: string, limit: number): Promise<SearchResult[]>;
}

/**
 * Turn a DuckDuckGo HTML `result__a` href into a real target URL.
 *
 * DDG wraps most results in a redirector: `//duckduckgo.com/l/?uddg=<encoded target>&rut=...`. Pull the
 * `uddg` param out and decode it. A bare `//host/…` becomes `https://host/…`; an absolute URL is used
 * as-is. Anything else (an internal DDG link, an ad) returns null and is dropped.
 */
export function resolveDuckDuckGoHref(href: string): string | null {
  if (!href) {
    return null;
  }

  let raw = href;

  if (raw.startsWith('//')) {
    raw = 'https:' + raw;
  }

  try {
    const parsed = new URL(raw);
    const uddg = parsed.searchParams.get('uddg');

    if (uddg) {
      return uddg; // already decoded by URLSearchParams
    }

    if (parsed.hostname.endsWith('duckduckgo.com')) {
      return null; // an internal/redirect link with no target — not a real result
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

/** Parse DuckDuckGo's HTML SERP into results. Pure — no network — so it is unit-testable on a fixture. */
export function parseDuckDuckGoHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Each result's link: <a ... class="result__a" href="...">Title</a>
  const linkRe = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

  // Each result's snippet: <a ... class="result__snippet" ...>Snippet</a>
  const snippetRe = /<a\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  const snippets: string[] = [];
  let sm: RegExpExecArray | null;

  while ((sm = snippetRe.exec(html)) !== null) {
    snippets.push(extractTextContent(sm[1]));
  }

  let lm: RegExpExecArray | null;
  let index = 0;

  while ((lm = linkRe.exec(html)) !== null && results.length < limit) {
    const url = resolveDuckDuckGoHref(lm[1]);
    const title = extractTextContent(lm[2]);

    if (url && title) {
      results.push({ title, url, snippet: snippets[index] ?? '' });
    }

    index++;
  }

  return results;
}

/**
 * DuckDuckGo HTML scrape — NO key, but best-effort: DDG challenges/rate-limits server-side scrapes, so
 * it returns results from some IPs and a results-less landing page from others. It is the default only
 * because it needs no configuration; a keyed/self-hosted provider below is what makes search reliable.
 */
const duckDuckGoProvider: SearchProvider = {
  name: 'duckduckgo',
  billable: false, // no per-query cost — the free scrape never bills the user
  async search(query, limit) {
    const response = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: SEARCH_HEADERS,
      body: new URLSearchParams({ q: query }).toString(),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`search backend returned ${response.status}`);
    }

    const results = parseDuckDuckGoHtml(await response.text(), limit);

    if (results.length === 0) {
      // Distinguish "genuinely nothing" from "we were challenged" — the latter is the common failure.
      throw new Error('the free search backend returned no parseable results (it may be rate-limiting this server)');
    }

    return results;
  },
};

/**
 * SerpApi — reliable Google results via one JSON call. Has a free starter tier (upgradeable). Needs
 * `SERPAPI_API_KEY`. The key rides as a query param (that is SerpApi's contract); this is a server-only
 * module and the URL is never logged, so the key does not leak.
 */
function serpApiProvider(apiKey: string): SearchProvider {
  return {
    name: 'serpapi',
    billable: true, // paid per query → the user is billed the flat search rate
    async search(query, limit) {
      const url = new URL('https://serpapi.com/search.json');
      url.searchParams.set('engine', 'google');
      url.searchParams.set('q', query);
      url.searchParams.set('num', String(limit));
      url.searchParams.set('api_key', apiKey);

      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`SerpApi returned ${response.status}`);
      }

      const data = (await response.json()) as {
        error?: string;
        organic_results?: Array<{ title?: string; link?: string; snippet?: string }>;
      };

      if (data.error) {
        throw new Error(`SerpApi: ${data.error}`);
      }

      return (data.organic_results ?? [])
        .slice(0, limit)
        .filter((r): r is { title: string; link: string; snippet?: string } => Boolean(r.link && r.title))
        .map((r) => ({
          title: extractTextContent(r.title),
          url: r.link,
          snippet: extractTextContent(r.snippet ?? ''),
        }));
    },
  };
}

/** Brave Search API — reliable, paid (no free tier). Alternative to SerpApi. Needs `BRAVE_SEARCH_API_KEY`. */
function braveProvider(apiKey: string): SearchProvider {
  return {
    name: 'brave',
    billable: true, // paid per query → the user is billed the flat search rate
    async search(query, limit) {
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(limit));

      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`Brave search returned ${response.status}`);
      }

      const data = (await response.json()) as {
        web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
      };

      return (data.web?.results ?? [])
        .slice(0, limit)
        .filter((r): r is { title: string; url: string; description?: string } => Boolean(r.url && r.title))
        .map((r) => ({
          title: extractTextContent(r.title),
          url: r.url,
          snippet: extractTextContent(r.description ?? ''),
        }));
    },
  };
}

/** SearXNG JSON — for a self-hosted or trusted instance (`SEARXNG_URL`). No per-query cost. */
function searxngProvider(baseUrl: string): SearchProvider {
  return {
    name: 'searxng',
    billable: false, // self-hosted / no per-query cost → never bills the user
    async search(query, limit) {
      const url = new URL('/search', baseUrl);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');

      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': SEARCH_HEADERS['User-Agent'] },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`SearXNG returned ${response.status}`);
      }

      const data = (await response.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };

      return (data.results ?? [])
        .slice(0, limit)
        .filter((r): r is { title: string; url: string; content?: string } => Boolean(r.url && r.title))
        .map((r) => ({ title: extractTextContent(r.title), url: r.url, snippet: extractTextContent(r.content ?? '') }));
    },
  };
}

/**
 * Select the search backend from config — the seam where reliability is bought. Precedence:
 * SerpApi → Brave → SearXNG → the no-key DuckDuckGo scrape (best-effort). An explicit keyed/instance
 * provider always wins over the scrape. Reads `process.env` directly (server-only module) — in
 * production this is SSM → container env.
 */
export function getSearchProvider(env: Record<string, string | undefined> = process.env): SearchProvider {
  const serpapi = env.SERPAPI_API_KEY?.trim();

  if (serpapi) {
    return serpApiProvider(serpapi);
  }

  const brave = env.BRAVE_SEARCH_API_KEY?.trim();

  if (brave) {
    return braveProvider(brave);
  }

  const searxng = env.SEARXNG_URL?.trim();

  if (searxng) {
    return searxngProvider(searxng);
  }

  return duckDuckGoProvider;
}

export type SearchOutcome =
  | { ok: true; provider: string; billable: boolean; results: SearchResult[] }
  | { ok: false; error: string };

/** Run a web search. Never throws — a backend hiccup comes back as `{ ok: false }`. */
export async function webSearch(query: string, limit = DEFAULT_SEARCH_LIMIT): Promise<SearchOutcome> {
  const q = (query ?? '').trim();

  if (!q) {
    return { ok: false, error: 'Empty search query.' };
  }

  const provider = getSearchProvider();
  const capped = Math.max(1, Math.min(limit || DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT));

  try {
    const results = await provider.search(q, capped);
    logger.info(`webSearch(${q}) via ${provider.name} → ${results.length} results`);

    return { ok: true, provider: provider.name, billable: provider.billable, results };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return { ok: false, error: 'Search timed out.' };
    }

    logger.error(`webSearch(${q}) failed: ${error instanceof Error ? error.message : String(error)}`);

    return { ok: false, error: error instanceof Error ? error.message : 'Search failed.' };
  }
}
