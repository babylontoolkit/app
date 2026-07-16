/**
 * The OAuth callback — where a provider token enters the platform (SPEC §4.5.4b, §5).
 *
 * `GET /api/git/callback/:provider?code=...&state=...` → exchange, store encrypted, redirect back.
 *
 * ## Two things this route must never do
 *
 * 1. **Trust the browser about identity.** The user id comes from the signed `state`, not from the
 *    session and not from a query param. Using the session would look equivalent and is not: a victim
 *    who is logged in and lands on an attacker-supplied callback URL would have the ATTACKER's token
 *    filed against their own account — a login-CSRF that quietly redirects the victim's future saves
 *    into a repo the attacker controls. The signature is what makes "this code belongs to this user"
 *    a fact rather than an assumption.
 * 2. **Emit the token.** §5: a route may act on a secret, never return one. This one redirects; it has
 *    no body at all. The `code` is likewise never echoed into an error message — it is a bearer
 *    credential until it is exchanged.
 */
import type { LoaderFunctionArgs } from '@remix-run/cloudflare';
import { redirect } from '@remix-run/cloudflare';
import { env } from '~/lib/.server/env';
import { exchangeCode, getOAuthConfig, safeReturnTo, verifyState } from '~/lib/.server/git/oauth';
import { getGitTokenStore } from '~/lib/.server/git/token-store';
import { buildProvider, type GitProviderId } from '~/lib/.server/git/resolve';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('git.oauth.callback');

function parseProvider(raw: string | undefined): GitProviderId | null {
  return raw === 'github' || raw === 'gitlab' ? raw : null;
}

/** Send the user back to where they were, with a flag the UI turns into a plain-language message. */
function backTo(returnTo: string, status: 'connected' | 'failed', provider: string) {
  const url = new URL(returnTo, 'http://placeholder');
  url.searchParams.set('git', status);
  url.searchParams.set('provider', provider);

  return redirect(`${url.pathname}${url.search}`);
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const provider = parseProvider(params.provider);

  if (!provider) {
    throw new Response('Not found', { status: 404 });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const rawState = url.searchParams.get('state');

  /*
   * The user pressed "Cancel" on the consent screen. Not an error — send them back quietly. The
   * provider reports this as `?error=access_denied` with no code.
   */
  if (!code || !rawState) {
    return backTo('/', 'failed', provider);
  }

  const state = verifyState(context, rawState);

  if (!state.ok) {
    // A forged or stale state. Never proceed, and never say which of the two it was.
    logger.warn(`Rejected ${provider} OAuth callback: state ${state.reason}.`);
    throw new Response('Invalid or expired authorization request. Please try connecting again.', { status: 400 });
  }

  if (state.state.provider !== provider) {
    // The state was minted for a different provider — a signed value replayed onto the wrong route.
    throw new Response('Invalid authorization request.', { status: 400 });
  }

  const config = getOAuthConfig(context, provider);

  if (!config) {
    throw new Response(`Saving to ${provider} is not configured on this server.`, { status: 503 });
  }

  const appUrl = env(context, 'APP_URL') ?? url.origin;
  const returnTo = safeReturnTo(state.state.returnTo);

  try {
    const token = await exchangeCode({ provider, config, appUrl, code });

    /*
     * Ask the provider who this token belongs to, rather than storing an anonymous credential. The
     * login is what the UI shows ("Saving to github.com/ana/my-game"), and a token we cannot even
     * identify the owner of is one we should not keep.
     */
    const { login } = await buildProvider(provider, token.accessToken, config.host).getCurrentUser();

    await getGitTokenStore(context).put({
      userId: state.state.userId,
      provider,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      providerLogin: login,
      updatedAt: new Date().toISOString(),
    });

    logger.info(`Connected ${provider} (${login}) for user ${state.state.userId}.`);

    return backTo(returnTo, 'connected', provider);
  } catch (error) {
    /*
     * Log the failure WITHOUT the code or the response body — an exchange error can echo the code, and
     * some providers reflect the client_secret. The user gets a retry, not a stack trace.
     */
    logger.error(`OAuth exchange failed for ${provider}: ${(error as Error).message}`);

    return backTo(returnTo, 'failed', provider);
  }
}
