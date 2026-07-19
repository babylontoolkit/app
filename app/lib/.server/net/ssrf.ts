/**
 * Server-side SSRF guard for routes that fetch a caller-influenced URL (`/api/web-search`,
 * `/api/git-proxy`).
 *
 * A server that fetches a URL a caller can influence is an SSRF primitive unless it refuses every
 * non-public target — including across DNS. The string-level classification lives in `~/utils/url`
 * (`isAllowedUrl` / `isPrivateIpAddress`, client-importable, pure). This module adds the one thing
 * that can only run on the server: resolving the hostname and refusing if it lands on a private
 * address (DNS rebinding), plus the shared `BlockedUrlError` both routes throw.
 */
import { isAllowedUrl, isPrivateIpAddress } from '~/utils/url';

/** A refused target. 400 — the caller asked for something we will not fetch. */
export class BlockedUrlError extends Error {
  readonly statusCode = 400;
  readonly name = 'BlockedUrlError';
  readonly isRetryable = false;
}

/**
 * Best-effort DNS-rebinding guard: resolve the hostname and refuse if ANY address is private.
 *
 * `node:dns` is imported dynamically so callers stay loadable in a non-Node runtime; if it (or
 * resolution) is unavailable we do not block — the string-level `isAllowedUrl` check still stands, and
 * a genuine resolution failure is left for `fetch` to surface. A residual TOCTOU remains (the OS may
 * re-resolve at fetch time), which is why this is defense-in-depth, not the only wall.
 */
export async function assertResolvesPublic(urlStr: string): Promise<void> {
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

/**
 * Full pre-fetch check for ONE URL: string-level allow-list THEN a DNS-resolution guard. Throws
 * `BlockedUrlError` if the target is not a public HTTP/HTTPS address. Callers that follow redirects
 * must call this for EVERY hop, not just the first.
 */
export async function assertPublicUrl(urlStr: string): Promise<void> {
  if (!isAllowedUrl(urlStr)) {
    throw new BlockedUrlError('URL is not allowed. Only public HTTP/HTTPS URLs are accepted.');
  }

  await assertResolvesPublic(urlStr);
}
