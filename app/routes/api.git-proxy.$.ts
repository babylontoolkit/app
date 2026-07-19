/**
 * CORS proxy for client-side git (isomorphic-git needs a same-origin proxy to reach a git host).
 *
 * Inherited from bolt.diy's cors-proxy, and it shipped as a fully UNAUTHENTICATED open forward-proxy:
 * the target host came straight off the URL path (`/api/git-proxy/<any-host>/<path>`) with no auth,
 * no SSRF guard, no re-validation across redirects. Anyone could stream arbitrary internet content
 * through our server (bandwidth/egress + IP-reputation abuse on OUR bill) or aim it at cloud metadata
 * and private services (SSRF). Closed to match `/api/web-search` (SPEC §4.5.4, §5):
 *
 *  - a VERIFIED session is required — an anonymous open proxy is abuse of our infrastructure;
 *  - EVERY hop (including redirects) is re-validated as a public HTTP/HTTPS target with a DNS guard,
 *    so an allowed host cannot 302 us onto `169.254.169.254` or `10.x`.
 *
 * Bodies still STREAM (never buffered), so a large legitimate clone is fine; auth + the per-hop SSRF
 * check are what bound abuse.
 */
import { json } from '@remix-run/cloudflare';
import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/cloudflare';
import { denyUnlessVerified } from '~/lib/.server/http';
import { assertPublicUrl, BlockedUrlError } from '~/lib/.server/net/ssrf';

// Allowed headers to forward to the target server
const ALLOW_HEADERS = [
  'accept-encoding',
  'accept-language',
  'accept',
  'access-control-allow-origin',
  'authorization',
  'cache-control',
  'connection',
  'content-length',
  'content-type',
  'dnt',
  'pragma',
  'range',
  'referer',
  'user-agent',
  'x-authorization',
  'x-http-method-override',
  'x-requested-with',
];

// Headers to expose from the target server's response
const EXPOSE_HEADERS = [
  'accept-ranges',
  'age',
  'cache-control',
  'content-length',
  'content-language',
  'content-type',
  'date',
  'etag',
  'expires',
  'last-modified',
  'pragma',
  'server',
  'transfer-encoding',
  'vary',
  'x-github-request-id',
  'x-redirected-url',
];

const MAX_REDIRECTS = 5;

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': ALLOW_HEADERS.join(', '),
    'Access-Control-Expose-Headers': EXPOSE_HEADERS.join(', '),
  };
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  return handleProxyRequest(request, params['*'], context);
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  return handleProxyRequest(request, params['*'], context);
}

async function handleProxyRequest(request: Request, path: string | undefined, context: unknown) {
  // CORS preflight carries no credentials and does no work — answer it before the auth wall.
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: { ...corsHeaders(), 'Access-Control-Max-Age': '86400' },
    });
  }

  // A verified session is the floor: this route reaches out on the platform's behalf.
  const denied = await denyUnlessVerified(request, context);

  if (denied) {
    return denied;
  }

  try {
    if (!path) {
      return json({ error: 'Invalid proxy URL format' }, { status: 400 });
    }

    // Extract domain and remaining path
    const parts = path.match(/([^\/]+)\/?(.*)/);

    if (!parts) {
      return json({ error: 'Invalid path format' }, { status: 400 });
    }

    const domain = parts[1];
    const remainingPath = parts[2] || '';

    // Reconstruct the target URL with query parameters
    const url = new URL(request.url);
    const startUrl = `https://${domain}/${remainingPath}${url.search}`;

    // Filter and prepare request headers (only the allow-listed set the git client sent).
    const headers = new Headers();

    for (const header of ALLOW_HEADERS) {
      if (request.headers.has(header)) {
        headers.set(header, request.headers.get(header)!);
      }
    }

    headers.set('Host', domain);

    if (!headers.has('user-agent') || !headers.get('user-agent')?.startsWith('git/')) {
      headers.set('User-Agent', 'git/@isomorphic-git/cors-proxy');
    }

    // Buffer the body once so it can be replayed across redirects (streams are single-use).
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();

    const response = await fetchFollowingRedirects(startUrl, request.method, headers, body);

    // Create response headers with CORS + the exposed subset of the target's headers.
    const responseHeaders = new Headers(corsHeaders());

    for (const header of EXPOSE_HEADERS) {
      // Skip content-length as we'll use the original response's content-length
      if (header === 'content-length') {
        continue;
      }

      if (response.headers.has(header)) {
        responseHeaders.set(header, response.headers.get(header)!);
      }
    }

    if (response.redirected) {
      responseHeaders.set('x-redirected-url', response.url);
    }

    // Stream the target's body straight through — never buffered into memory.
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    if (error instanceof BlockedUrlError) {
      return json({ error: error.message }, { status: 400 });
    }

    return json(
      {
        error: 'Proxy error',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

/**
 * Follow redirects BY HAND so every hop is re-validated as a public target (a `redirect: 'follow'`
 * fetch would chase a 302 to a private IP without our SSRF check ever seeing it).
 */
async function fetchFollowingRedirects(
  startUrl: string,
  method: string,
  headers: Headers,
  body: ArrayBuffer | undefined,
): Promise<Response> {
  let currentUrl = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(currentUrl);

    const hopHeaders = new Headers(headers);
    hopHeaders.set('Host', new URL(currentUrl).host);

    const response = await fetch(currentUrl, {
      method,
      headers: hopHeaders,
      body: body ? body.slice(0) : undefined,
      redirect: 'manual',
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
