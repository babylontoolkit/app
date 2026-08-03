/**
 * Turning an authenticated USER into a ready-to-use `GitProvider` (SPEC §4.5.4b).
 *
 * This is the only place a stored token becomes a live provider, and therefore the only place that
 * needs to know about refresh. Everything downstream (save, reload, auto-push) asks for a provider and
 * gets one, or gets a typed `auth` failure it must show the user.
 *
 * ## The rule: a lapsed token is LOUD, never a silent no-op
 *
 * §4.5.4b: "a lapsed token must never silently drop saves." So there is no `getProviderOrNull` here.
 * Every failure to produce a provider throws a `GitProviderError{kind:'auth'}` carrying a sentence the
 * user can act on, and the UI turns that into a re-connect prompt. The tempting alternative — return
 * null, let the caller skip the push — is precisely how a user's work stops being saved for a week
 * without anyone noticing.
 */
import { GitProviderError, type GitProvider, type GitProviderId } from './provider';

export type { GitProviderId };
import { GitHubProvider } from './github';
import { GitLabProvider } from './gitlab';
import { getOAuthConfig, refreshToken as refreshOAuthToken } from './oauth';
import { getGitTokenStore, type TokenRecord } from './token-store';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('git.resolve');

/**
 * Refresh this far before actual expiry.
 *
 * A save can take a while (hundreds of blob uploads on a big project), so a token valid for another
 * ten seconds is not a usable token — it would expire mid-push and fail the save half-written. Five
 * minutes is comfortably longer than any single save.
 */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export function buildProvider(provider: GitProviderId, token: string, host?: string): GitProvider {
  return provider === 'github' ? new GitHubProvider(token) : new GitLabProvider(token, { host });
}

const reconnect = (provider: GitProviderId, why: string) =>
  new GitProviderError({
    kind: 'auth',
    message: `${why} Reconnect ${provider === 'github' ? 'GitHub' : 'GitLab'} to keep saving your project.`,
  });

/**
 * The stored token for a user+provider, refreshed if it is close to expiring.
 *
 * GitHub OAuth App tokens carry no `expiresAt` and no refresh token, so they skip this entirely.
 * GitLab's expire in ~2h and must be refreshed — a code path keyed off the RECORD's shape rather than
 * the provider id, so a provider that changes its token policy does not need a new branch here.
 */
async function currentToken(context: unknown, userId: string, provider: GitProviderId): Promise<TokenRecord> {
  const store = getGitTokenStore(context);
  const record = await store.get(userId, provider);

  if (!record) {
    throw reconnect(provider, `Your project is not connected to ${provider === 'github' ? 'GitHub' : 'GitLab'} yet.`);
  }

  const expiresSoon = record.expiresAt !== undefined && record.expiresAt - Date.now() < REFRESH_SKEW_MS;

  if (!expiresSoon) {
    return record;
  }

  if (!record.refreshToken) {
    throw reconnect(provider, 'Your connection has expired.');
  }

  const config = getOAuthConfig(context, provider);

  if (!config) {
    /*
     * The operator removed the OAuth app while users hold live tokens. Not the user's fault, but they
     * still cannot save — so it surfaces rather than pretending the save worked.
     */
    throw reconnect(provider, 'Saving is not configured on this server.');
  }

  try {
    const refreshed = await refreshOAuthToken({ provider, config, refreshToken: record.refreshToken });

    const updated: TokenRecord = {
      ...record,
      accessToken: refreshed.accessToken,

      // A provider that rotates refresh tokens returns a new one; one that does not, keeps the old.
      refreshToken: refreshed.refreshToken ?? record.refreshToken,
      expiresAt: refreshed.expiresAt,
      updatedAt: new Date().toISOString(),
    };

    await store.put(updated);
    logger.info(`Refreshed ${provider} token for user ${userId}.`);

    return updated;
  } catch (error) {
    /*
     * The refresh token itself is dead (the user revoked access at the provider, or it aged out).
     * Delete the record so the UI shows "not connected" rather than a connection that silently cannot
     * save, and make the user re-grant.
     */
    logger.warn(`Refresh failed for ${provider}/${userId}; requiring re-connect.`, error);
    await store.delete(userId, provider);

    throw reconnect(provider, 'Your connection has expired.');
  }
}

/**
 * A live provider for this user, or a typed `auth` error telling them to reconnect.
 *
 * `host` is read from config for GitLab self-hosted; GitHub ignores it.
 */
export async function resolveProvider(context: unknown, userId: string, provider: GitProviderId): Promise<GitProvider> {
  const record = await currentToken(context, userId, provider);
  const config = getOAuthConfig(context, provider);

  return buildProvider(provider, record.accessToken, config?.host);
}

/**
 * The caller's OWN stored OAuth access token, or `null` when they have not connected.
 *
 * 🔴 **This exists because the platform grew TWO GitHub connections and only one of them was real.**
 * §4.5.4b requires that the browser never holds a git token, so `/api/git/connect/:provider` puts an
 * encrypted one in `git_tokens` and nothing client-side ever sees it. But upstream bolt.diy's repo
 * pickers were built on the opposite model — a token in `localStorage` plus a cookie — and their
 * data routes (`api.github-stats`, `api.github-user`) resolved from cookies and operator env only.
 *
 * So a user could complete OAuth successfully, the server could hold a perfectly good token for
 * them, and the picker would still answer `401 GitHub token not found` and show "connect first".
 * Pressing the connect button ran a real OAuth round-trip, GitHub auto-approved it, and the user
 * came back to the identical screen — MEASURED live, and reported (correctly) as "it does NOTHING".
 *
 * Non-throwing on purpose: `currentToken` throws a `reconnect` error for "not connected", which is
 * the right shape for a save (the badge offers a reconnect) and the wrong shape for a read that has
 * two other token sources to try. Absent is `null`, never an exception — the `getBranchHead` rule.
 *
 * ⚠️ It returns the CALLER'S token, resolved from their own user id, and it is deliberately NOT a
 * platform fallback (`spec/spend-holes.md`): a route reaching for an operator-wide token on behalf
 * of whoever asked is how `api.system.git-info` listed the operator's private repos to strangers.
 */
export async function storedAccessToken(
  context: unknown,
  userId: string,
  provider: GitProviderId,
): Promise<string | null> {
  try {
    // `currentToken` also refreshes a token that is about to expire, so this stays valid to use.
    return (await currentToken(context, userId, provider)).accessToken;
  } catch {
    return null;
  }
}

/** Which providers this user has connected — for the UI. Never includes a token (§5). */
export async function listConnections(context: unknown, userId: string) {
  const records = await getGitTokenStore(context).listByUser(userId);

  return records.map((r) => ({ provider: r.provider, providerLogin: r.providerLogin, connectedAt: r.updatedAt }));
}
