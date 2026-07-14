/**
 * The fail-closed guard for upstream bolt.diy's LLM routes (SPEC §4.5.4, §5).
 *
 * `/api/chat` and `/api/llmcall` are inherited from upstream. Nothing in this product calls them —
 * the client posts to `/api/agent`, the platform proxy, which is the SINGLE choke point where the
 * session is checked, the credit gate runs, and settlement happens (§4.2).
 *
 * But they are still routes. They still resolve a provider from the request body, still read the
 * provider key out of the server environment, and still stream tokens back. On a deployed instance
 * with `ANTHROPIC_API_KEY` set, an unauthenticated `curl` at either one is an uncapped bill on OUR
 * key, with no session, no gate, no ledger entry, and no way to attribute the spend to anyone. The
 * choke point is only a choke point if there is no way around it.
 *
 * Hide-don't-delete (SPEC §2.1a): the upstream files stay on disk, byte-for-byte usable, so upstream
 * pulls keep merging. They simply refuse to serve unless an operator explicitly turns them back on —
 * and the flag exists for exactly one purpose: bisecting our proxy against upstream's behaviour in
 * local development.
 */
import { envFlag } from '~/lib/.server/env';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('upstream-routes');

/**
 * Refuse to serve an upstream LLM route.
 *
 * **404, not 403.** A 403 would confirm the route exists and is merely switched off, which is a free
 * hint to anyone probing for an unmetered way onto our key. As far as the internet is concerned,
 * these endpoints are not here.
 */
export function upstreamLlmRouteDisabled(context?: unknown, route?: string): Response | null {
  if (envFlag(context, 'UPSTREAM_LLM_ROUTES_ENABLED')) {
    logger.warn(
      `${route ?? 'An upstream LLM route'} is ENABLED (UPSTREAM_LLM_ROUTES_ENABLED). It has no session ` +
        `check, no credit gate and no settlement — never set this in a deployed environment.`,
    );

    return null;
  }

  return new Response('Not Found', { status: 404, statusText: 'Not Found' });
}
