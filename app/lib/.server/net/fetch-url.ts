/**
 * Shared server-side "fetch a public web page and return its readable text" core.
 *
 * ONE implementation, two callers (the "one rule in one place" principle — a second copy is a
 * silent-drift bug on an SSRF-sensitive path):
 *   - `/api/web-search` — the chat's "Fetch URL content" globe button (lands text in the chat input);
 *   - the agent's `web_fetch` tool (`agent/web-fetch-tool.ts`) — lets the MODEL pull a URL mid-generation.
 *
 * Reaching OUT to a caller-influenced URL is an SSRF primitive unless every non-public target is
 * refused — including across redirects and DNS — so every hop goes through `assertPublicUrl`
 * (`net/ssrf.ts`). It also bounds what it will buffer and return, because both callers put the result
 * somewhere that costs money if it is unbounded (the model's context / a chat message).
 *
 * `scrapeUrl` NEVER throws: it returns a discriminated result so both callers map failure trivially
 * (an HTTP status for the route, a recoverable message for the tool). Auth is the CALLER's job, not
 * this module's.
 */
import { isAllowedUrl } from '~/utils/url';
import { assertPublicUrl, BlockedUrlError } from '~/lib/.server/net/ssrf';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('fetch-url');

/** How much extracted text a caller gets back. Bounds the context/chat bill. */
export const MAX_CONTENT_LENGTH = 8000;

const MAX_REDIRECTS = 5;
const MAX_FETCH_BYTES = 2_000_000; // refuse to buffer more than ~2MB of a page into memory
const FETCH_TIMEOUT_MS = 10_000;

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

export function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : '';
}

export function extractMetaDescription(html: string): string {
  const match = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i);

  if (match) {
    return match[1].trim();
  }

  // Try reverse attribute order
  const altMatch = html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i);

  return altMatch ? altMatch[1].trim() : '';
}

export function extractTextContent(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, ' ')
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, ' ')
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Follow redirects by hand so EVERY hop is re-validated against the SSRF rules, not just the first. */
async function fetchGuarded(startUrl: string): Promise<Response> {
  let currentUrl = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(currentUrl);

    const response = await fetch(currentUrl, {
      headers: FETCH_HEADERS,
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');

      if (!location) {
        return response;
      }

      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return response;
  }

  throw new BlockedUrlError('Too many redirects.');
}

export interface ScrapedPage {
  title: string;
  description: string;
  content: string;
  sourceUrl: string;
}

export type ScrapeResult = ({ ok: true } & ScrapedPage) | { ok: false; status: number; error: string };

/**
 * Fetch a public URL and return its readable text, or a mapped failure. Never throws — SSRF refusals,
 * timeouts, non-HTML content, oversize pages, and transport errors all come back as `{ ok: false }`.
 */
export async function scrapeUrl(url: string): Promise<ScrapeResult> {
  if (!url || typeof url !== 'string' || !isAllowedUrl(url)) {
    return { ok: false, status: 400, error: 'URL is not allowed. Only public HTTP/HTTPS URLs are accepted.' };
  }

  try {
    const response = await fetchGuarded(url);

    if (!response.ok) {
      return { ok: false, status: 502, error: `Failed to fetch URL: ${response.status} ${response.statusText}` };
    }

    const contentType = response.headers.get('content-type') || '';

    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      return { ok: false, status: 400, error: 'URL must point to an HTML or text page.' };
    }

    const declaredLength = Number(response.headers.get('content-length') || '0');

    if (declaredLength > MAX_FETCH_BYTES) {
      return { ok: false, status: 413, error: 'Page is too large to fetch.' };
    }

    const raw = await response.text();
    const html = raw.length > MAX_FETCH_BYTES ? raw.slice(0, MAX_FETCH_BYTES) : raw;
    const content = extractTextContent(html);

    return {
      ok: true,
      title: extractTitle(html),
      description: extractMetaDescription(html),
      content: content.length > MAX_CONTENT_LENGTH ? content.slice(0, MAX_CONTENT_LENGTH) + '...' : content,
      sourceUrl: url,
    };
  } catch (error) {
    if (error instanceof BlockedUrlError) {
      return { ok: false, status: 400, error: error.message };
    }

    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return { ok: false, status: 504, error: 'Request timed out after 10 seconds.' };
    }

    logger.error(`Web fetch error: ${error instanceof Error ? error.message : String(error)}`);

    return { ok: false, status: 500, error: error instanceof Error ? error.message : 'Failed to fetch URL.' };
  }
}
