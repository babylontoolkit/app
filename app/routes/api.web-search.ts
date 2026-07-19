/**
 * "Fetch URL content" — server-side scrape of a user-supplied URL (the chat globe button).
 *
 * This route reaches OUT to the public internet on the platform's behalf, so it is two things that
 * must both hold: authenticated (an anonymous open fetch-proxy is abuse of our bandwidth and IP
 * reputation, the same shape as the Stage-3 unmetered holes) and SSRF-safe (a server that fetches a
 * caller-chosen URL can be aimed at cloud metadata / private services unless it refuses every
 * non-public target — including across redirects and DNS).
 *
 * It does NOT touch the LLM and spends no credits: the fetched text lands in the user's chat input,
 * and is billed only if/when they send it as an ordinary message through `/api/agent`.
 */
import { json } from '@remix-run/cloudflare';
import type { ActionFunctionArgs } from '@remix-run/cloudflare';
import { isAllowedUrl, isPrivateIpAddress } from '~/utils/url';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { errorResponse } from '~/lib/.server/http';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('web-search');

const MAX_CONTENT_LENGTH = 8000;
const MAX_REDIRECTS = 5;
const MAX_FETCH_BYTES = 2_000_000; // refuse to buffer more than ~2MB of a page into memory
const FETCH_TIMEOUT_MS = 10_000;

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

class BlockedUrlError extends Error {
  readonly statusCode = 400;
  readonly name = 'BlockedUrlError';
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : '';
}

function extractMetaDescription(html: string): string {
  const match = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i);

  if (match) {
    return match[1].trim();
  }

  // Try reverse attribute order
  const altMatch = html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i);

  return altMatch ? altMatch[1].trim() : '';
}

function extractTextContent(html: string): string {
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

/**
 * Best-effort DNS-rebinding guard: resolve the hostname and refuse if ANY address is private.
 *
 * `node:dns` is imported dynamically so this module stays loadable in a non-Node runtime; if it (or
 * resolution) is unavailable we do not block — the string-level `isAllowedUrl` check still stands, and
 * a genuine resolution failure is left for `fetch` to surface. A residual TOCTOU remains (the OS may
 * re-resolve at fetch time), which is why this is defense-in-depth, not the only wall.
 */
async function assertResolvesPublic(urlStr: string): Promise<void> {
  const hostname = new URL(urlStr).hostname.replace(/^\[|\]$/g, '');

  let lookup: ((h: string, opts: { all: true }) => Promise<Array<{ address: string }>>) | undefined;

  try {
    ({ lookup } = (await import('node:dns/promises')) as unknown as { lookup: typeof lookup });
  } catch {
    return; // not a Node runtime — rely on the string-level checks
  }

  let results: Array<{ address: string }>;

  try {
    results = await lookup!(hostname, { all: true });
  } catch {
    return; // let fetch report an unresolvable host
  }

  for (const { address } of results) {
    if (isPrivateIpAddress(address)) {
      throw new BlockedUrlError('URL resolves to a private address.');
    }
  }
}

/** Follow redirects by hand so EVERY hop is re-validated against the SSRF rules, not just the first. */
async function fetchGuarded(startUrl: string): Promise<Response> {
  let currentUrl = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedUrl(currentUrl)) {
      throw new BlockedUrlError('URL is not allowed. Only public HTTP/HTTPS URLs are accepted.');
    }

    await assertResolvesPublic(currentUrl);

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

export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    // Authenticated + verified: an anonymous open fetch-proxy is bandwidth/IP-reputation abuse.
    await requireVerifiedUser(request, context);

    const { url } = (await request.json()) as { url?: string };

    if (!url || typeof url !== 'string') {
      return json({ error: 'URL is required' }, { status: 400 });
    }

    if (!isAllowedUrl(url)) {
      return json({ error: 'URL is not allowed. Only public HTTP/HTTPS URLs are accepted.' }, { status: 400 });
    }

    const response = await fetchGuarded(url);

    if (!response.ok) {
      return json({ error: `Failed to fetch URL: ${response.status} ${response.statusText}` }, { status: 502 });
    }

    const contentType = response.headers.get('content-type') || '';

    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      return json({ error: 'URL must point to an HTML or text page' }, { status: 400 });
    }

    const declaredLength = Number(response.headers.get('content-length') || '0');

    if (declaredLength > MAX_FETCH_BYTES) {
      return json({ error: 'Page is too large to fetch.' }, { status: 413 });
    }

    const raw = await response.text();
    const html = raw.length > MAX_FETCH_BYTES ? raw.slice(0, MAX_FETCH_BYTES) : raw;
    const title = extractTitle(html);
    const description = extractMetaDescription(html);
    const content = extractTextContent(html);

    return json({
      success: true,
      data: {
        title,
        description,
        content: content.length > MAX_CONTENT_LENGTH ? content.slice(0, MAX_CONTENT_LENGTH) + '...' : content,
        sourceUrl: url,
      },
    });
  } catch (error) {
    if (error instanceof BlockedUrlError) {
      return json({ error: error.message }, { status: 400 });
    }

    // Auth failures (401/403) come back with their safe messages via the shared helper.
    const status = (error as { statusCode?: number })?.statusCode;

    if (status === 401 || status === 403) {
      return errorResponse(error);
    }

    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return json({ error: 'Request timed out after 10 seconds' }, { status: 504 });
    }

    logger.error(`Web fetch error: ${error instanceof Error ? error.message : String(error)}`);

    return json({ error: error instanceof Error ? error.message : 'Failed to fetch URL' }, { status: 500 });
  }
}
