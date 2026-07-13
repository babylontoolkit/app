/**
 * GitHub reads for doc-sync and skills-sync (SPEC §4.3, §4.11).
 *
 * Used at SYNC time only. Generation never touches GitHub — that is a hard rule (§1.3 principle 3).
 *
 * The token is purely a rate-limit optimization: both source repos are public. So an absent,
 * placeholder, or expired token must never break a sync — we warn and retry anonymously rather than
 * failing a build over a credential we did not actually need. (`.env.local` ships with placeholder
 * GitHub tokens; without this, a fresh checkout could not doc-sync at all.)
 */
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('github-sync');

let warnedAboutToken = false;

export async function githubFetch(url: string, accept: string, token?: string): Promise<Response> {
  const request = (auth?: string) =>
    fetch(url, {
      headers: auth ? { accept, authorization: `Bearer ${auth}` } : { accept },
    });

  let response = await request(token);

  /*
   * Any failure while presenting a token is retried anonymously.
   *
   * Not just 401/403: `raw.githubusercontent.com` answers a bad credential with **404**, not 401 —
   * so a narrow status check reads a rejected token as "the doc does not exist" and fails the build
   * with a completely misleading error. If the resource really is missing, the anonymous retry 404s
   * too and we surface that honestly.
   */
  if (token && !response.ok) {
    if (!warnedAboutToken) {
      logger.warn(
        `GitHub rejected the configured token (HTTP ${response.status}). ` +
          'Retrying anonymously — set a valid GITHUB_API_KEY to raise the rate limit.',
      );
      warnedAboutToken = true;
    }

    response = await request(undefined);
  }

  return response;
}

export async function githubJson<T>(url: string, token?: string): Promise<T> {
  const response = await githubFetch(url, 'application/vnd.github+json', token);

  if (!response.ok) {
    throw new Error(`${url} → HTTP ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

/** Fetch a text file. Empty or missing FAILS the caller — we never build from a partial snapshot. */
export async function githubText(url: string, token?: string): Promise<string> {
  const response = await githubFetch(url, 'text/plain', token);

  if (!response.ok) {
    throw new Error(`${url} → HTTP ${response.status} ${response.statusText}`);
  }

  return response.text();
}
