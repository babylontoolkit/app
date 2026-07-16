/**
 * Server-side OAuth for the git providers (SPEC §4.5.4b, §4.13 hardening).
 *
 * ## What this replaces, and why it had to go
 *
 * §4.13 shipped with the per-user token arriving from the BROWSER: `readGitHubToken` took
 * `body.token` — a raw PAT the client read out of `localStorage` and re-sent in the POST body on every
 * single sync — and fell back to the inherited connector cookie. That was tolerable for an optional
 * developer bridge. Under §4.5.4b the token is the key to the ONLY permanent copy of the user's game,
 * and a key that lives in `localStorage` and crosses the wire on every save is not a storage
 * credential, it is a leak with a retry loop.
 *
 * So: the platform runs its own OAuth apps, exchanges the code server-side, and stores the token
 * encrypted, per user, per provider. The browser never sees it and never sends it. §4.13's own note
 * called this "future work"; §4.5.4b makes it a precondition.
 *
 * ## Scopes — minimal, and honestly not as minimal as we would like
 *
 * §4.5.4b asks for "minimal content-only scopes". We get close on GitHub and cannot on GitLab:
 *
 *   - **GitHub `repo`.** Creating and writing a PRIVATE repo needs it. `public_repo` cannot touch
 *     private repos, and OAuth Apps have no finer content-only grant. (A GitHub *App* with
 *     `contents:write` would be genuinely minimal — recorded as the upgrade path, not built here,
 *     because an App needs installation UX that §4.5.4b does not describe.)
 *   - **GitLab `api`.** `write_repository` covers commits but CANNOT create a project, and "Save"
 *     must create the repo. There is no narrower scope that includes project creation. This is a real
 *     over-grant and is written down rather than glossed.
 *
 * ## Token lifetime differs per provider, and the difference is load-bearing
 *
 * GitHub OAuth App tokens do not expire and have no refresh token. GitLab's expire in ~2 hours and
 * MUST be refreshed. A token layer that assumed GitHub's model would silently stop saving GitLab
 * projects two hours in — so `expiresAt`/`refreshToken` are optional in the stored shape, and the
 * refresh path is driven by their presence rather than by the provider id.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '~/lib/.server/env';
import type { GitProviderId } from './provider';
import { GITLAB_DEFAULT_HOST } from './gitlab';

export interface OAuthAppConfig {
  clientId: string;
  clientSecret: string;

  /** GitLab self-hosted; unused for GitHub. */
  host?: string;
}

/** Where the provider sends the user to approve, and where it posts the code exchange. */
interface ProviderEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
}

export function providerEndpoints(provider: GitProviderId, host?: string): ProviderEndpoints {
  if (provider === 'github') {
    return {
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',

      // The narrowest OAuth App scope that can create and write a PRIVATE repo. See the header.
      scope: 'repo',
    };
  }

  const base = (host ?? GITLAB_DEFAULT_HOST).replace(/\/+$/, '');

  return {
    authorizeUrl: `${base}/oauth/authorize`,
    tokenUrl: `${base}/oauth/token`,

    /*
     * `api` because project CREATION requires it — `write_repository` alone cannot create the repo
     * that Save must create. An over-grant we cannot avoid, stated rather than hidden.
     */
    scope: 'api',
  };
}

/** The OAuth app for a provider, or null when the operator has not configured it (§1.3 principle 0). */
export function getOAuthConfig(context: unknown, provider: GitProviderId): OAuthAppConfig | null {
  const prefix = provider === 'github' ? 'GITHUB' : 'GITLAB';
  const clientId = env(context, `${prefix}_OAUTH_CLIENT_ID`);
  const clientSecret = env(context, `${prefix}_OAUTH_CLIENT_SECRET`);

  if (!clientId || !clientSecret) {
    return null;
  }

  return { clientId, clientSecret, host: provider === 'gitlab' ? env(context, 'GITLAB_HOST') : undefined };
}

export function isProviderConfigured(context: unknown, provider: GitProviderId): boolean {
  return getOAuthConfig(context, provider) !== null;
}

/** Which providers this deployment can offer. Empty = Save cannot work; the UI says "not configured". */
export function configuredProviders(context: unknown): GitProviderId[] {
  return (['github', 'gitlab'] as const).filter((p) => isProviderConfigured(context, p));
}

export function oauthRedirectUri(appUrl: string, provider: GitProviderId): string {
  return `${appUrl.replace(/\/+$/, '')}/api/git/callback/${provider}`;
}

/**
 * The `state` parameter — CSRF protection, and how the callback knows whose token this is.
 *
 * Signed with the platform's own secret and carrying the user id, so the callback never trusts a
 * client-supplied identity: without this, anyone could complete an OAuth dance and have the resulting
 * token filed against ANOTHER user's account, handing themselves that user's repo access. It is
 * verified with `timingSafeEqual` — a `===` on an HMAC is a byte-at-a-time oracle.
 *
 * Bounded by `issuedAt`: a state is single-use in practice because a stale one is refused, so a
 * captured authorize URL cannot be replayed a day later.
 */
export interface OAuthState {
  userId: string;
  provider: GitProviderId;

  /** Where to send the user once the token is stored (an in-app path — never an absolute URL). */
  returnTo: string;
  issuedAt: number;
  nonce: string;
}

const STATE_TTL_MS = 10 * 60 * 1000;

function stateSecret(context: unknown): string {
  /*
   * Reuse the platform's Supabase service-role key as the signing secret when a dedicated one is not
   * set: it is already a server-only high-entropy secret, and requiring operators to invent another
   * variable to make Save work is how deployments end up with an empty-string signing key.
   */
  return (
    env(context, 'GIT_OAUTH_STATE_SECRET') ?? env(context, 'SUPABASE_SERVICE_ROLE_KEY') ?? 'local-dev-state-secret'
  );
}

export function signState(context: unknown, state: OAuthState): string {
  const payload = Buffer.from(JSON.stringify(state), 'utf-8').toString('base64url');
  const signature = createHmac('sha256', stateSecret(context)).update(payload).digest('base64url');

  return `${payload}.${signature}`;
}

export type StateResult =
  | { ok: true; state: OAuthState }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' };

export function verifyState(context: unknown, raw: string, now = Date.now()): StateResult {
  const [payload, signature] = raw.split('.');

  if (!payload || !signature) {
    return { ok: false, reason: 'malformed' };
  }

  const expected = createHmac('sha256', stateSecret(context)).update(payload).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);

  // Length check first: timingSafeEqual THROWS on a length mismatch rather than returning false.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad-signature' };
  }

  let state: OAuthState;

  try {
    state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (!state?.userId || !state?.provider || typeof state.issuedAt !== 'number') {
    return { ok: false, reason: 'malformed' };
  }

  if (now - state.issuedAt > STATE_TTL_MS || now < state.issuedAt - 60_000) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, state };
}

/**
 * Where to send the user to approve access.
 *
 * `returnTo` is sanitised to a same-site PATH before it is signed — an open redirect here would be
 * handed a signed, trusted-looking URL by us.
 */
export function buildAuthorizeUrl(input: {
  context: unknown;
  provider: GitProviderId;
  config: OAuthAppConfig;
  appUrl: string;
  state: OAuthState;
}): string {
  const { authorizeUrl, scope } = providerEndpoints(input.provider, input.config.host);
  const url = new URL(authorizeUrl);

  url.searchParams.set('client_id', input.config.clientId);
  url.searchParams.set('redirect_uri', oauthRedirectUri(input.appUrl, input.provider));
  url.searchParams.set('scope', scope);
  url.searchParams.set(
    'state',
    signState(input.context, { ...input.state, returnTo: safeReturnTo(input.state.returnTo) }),
  );

  if (input.provider === 'gitlab') {
    // GitLab requires an explicit response_type; GitHub defaults to `code`.
    url.searchParams.set('response_type', 'code');
  }

  return url.toString();
}

/** Only a same-site path may be returned to. Anything else becomes the dashboard. */
export function safeReturnTo(returnTo: string | undefined): string {
  if (!returnTo || !returnTo.startsWith('/') || returnTo.startsWith('//')) {
    return '/';
  }

  return returnTo;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;

  /** Epoch ms. Absent for GitHub OAuth App tokens, which do not expire. */
  expiresAt?: number;
}

/** Exchange the callback `code` for a token, or refresh an expiring one. */
export async function exchangeCode(input: {
  provider: GitProviderId;
  config: OAuthAppConfig;
  appUrl: string;
  code: string;
  fetchImpl?: typeof fetch;
}): Promise<TokenResponse> {
  return tokenRequest(input.provider, input.config, input.fetchImpl, {
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    code: input.code,
    grant_type: 'authorization_code',
    redirect_uri: oauthRedirectUri(input.appUrl, input.provider),
  });
}

export async function refreshToken(input: {
  provider: GitProviderId;
  config: OAuthAppConfig;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<TokenResponse> {
  return tokenRequest(input.provider, input.config, input.fetchImpl, {
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    refresh_token: input.refreshToken,
    grant_type: 'refresh_token',
  });
}

async function tokenRequest(
  provider: GitProviderId,
  config: OAuthAppConfig,
  fetchImpl: typeof fetch | undefined,
  body: Record<string, string>,
): Promise<TokenResponse> {
  const { tokenUrl } = providerEndpoints(provider, config.host);
  const doFetch = fetchImpl ?? fetch;

  const response = await doFetch(tokenUrl, {
    method: 'POST',

    // GitHub returns form-encoded unless asked for JSON; GitLab is JSON always.
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || payload.error || !payload.access_token) {
    /*
     * Never echo the payload: a failed exchange body can contain the code, and on some providers the
     * client_secret is reflected back in the error. The operator gets the provider's error CODE only.
     */
    throw new Error(`${provider} OAuth exchange failed (${response.status}): ${payload.error ?? 'no access_token'}`);
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: payload.expires_in ? Date.now() + payload.expires_in * 1000 : undefined,
  };
}
