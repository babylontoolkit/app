/**
 * Export the user's OWN BYOK keys (Settings → export).
 *
 * ⚠️ THIS ROUTE USED TO HAND THE PLATFORM KEY TO ANYONE WHO ASKED (fixed 2026-07-13, SPEC §4.5.4, §5).
 *
 * Upstream's version walked every provider, read its `apiTokenKey` out of `process.env` /
 * `context.cloudflare.env` / `llmManager.env`, and returned the values as JSON — from an
 * **unauthenticated GET loader**. On a deployed instance that is:
 *
 *     curl https://app.example.com/api/export-api-keys  →  {"Anthropic":"sk-ant-..."}
 *
 * That is worse than an unmetered generation endpoint. An unmetered endpoint bills us while it is
 * reachable; a leaked key keeps working **off-platform, forever**, with no rate limit, no gate, and no
 * way to attribute the spend — and it is exactly the "ALL platform secrets are server-only, never in
 * client bundles, never logged" rule in CLAUDE.md, violated by the server handing them out directly.
 *
 * The legitimate feature is narrow: a Pro/BYOK user exports the keys **they themselves entered**, which
 * live in their own cookie. Echoing a caller their own cookie is not a disclosure. So:
 *
 *   - the server environment is NEVER read here. Not as a fallback, not "only if the cookie is empty".
 *     There is no ordering of precedence that makes returning a platform secret acceptable.
 *   - the caller must be a verified user, so this is not an anonymous probe surface.
 *
 * If you find yourself adding an env lookup back into this file, the thing you actually want is
 * `/api/check-env-key`, which answers "is a key configured?" with a BOOLEAN and never the value.
 */
import type { LoaderFunction } from '@remix-run/cloudflare';
import { getApiKeysFromCookie } from '~/lib/api/cookies';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.export-api-keys');

export const loader: LoaderFunction = async ({ context, request }) => {
  try {
    await requireVerifiedUser(request, context);
  } catch (error: any) {
    return Response.json(
      { error: true, message: error?.message ?? 'Unauthorized' },
      { status: typeof error?.statusCode === 'number' ? error.statusCode : 401 },
    );
  }

  /*
   * The caller's own keys, from the caller's own cookie. Nothing else. In credits mode
   * (`PRO_FEATURES_ENABLED=false`, the shipping default) there is no key-entry UI at all, so this is
   * an empty object — which is the correct answer, not a bug.
   */
  const apiKeys = getApiKeysFromCookie(request.headers.get('Cookie'));

  logger.debug(`Exporting ${Object.keys(apiKeys).length} user-supplied key(s); server env not consulted.`);

  return Response.json(apiKeys);
};
