/**
 * OAuth / email-verification landing (SPEC §4.5.1).
 *
 * Supabase redirects here with a `code`; we exchange it for a session and set the cookies. The
 * `Set-Cookie` headers the client produced during the exchange MUST ride on the redirect response —
 * dropping them is the classic "signed in, then immediately signed out" bug.
 *
 * The intended action survives the round trip (§4.5.1): a visitor who clicked Remix or New Project
 * and hit the sign-up gate lands back where they were going, not on a generic dashboard.
 */
import { redirect, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { createScopedLogger } from '~/utils/logger';
import { createRequestClient, isSupabaseConfigured } from '~/lib/.server/supabase/client';

/*
 * The wall against an open redirect, and it is SHARED (`~/lib/auth/safe-redirect`) rather than
 * private to this file. `next` is attacker-controllable — it rides in a URL — and three layers now
 * handle it (the dialog, `/api/auth` when it builds this address, and here). A second copy of the
 * rule is how one of them ends up more permissive than the others, silently.
 */
import { safeRedirect } from '~/lib/auth/safe-redirect';

const logger = createScopedLogger('auth.callback');

export async function loader({ request, context }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = safeRedirect(url.searchParams.get('next'));

  if (!isSupabaseConfigured(context) || !code) {
    return redirect(next);
  }

  const { client, headers } = await createRequestClient(request, context);
  const { error } = await client.auth.exchangeCodeForSession(code);

  if (error) {
    logger.warn(`Auth callback failed: ${error.message}`);
    return redirect('/?auth=failed', { headers });
  }

  // The grant is issued on the first verified session — see `api.me`. Nothing to do here but land.
  return redirect(next, { headers });
}
