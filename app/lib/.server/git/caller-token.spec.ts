/**
 * The caller's platform git token, and the ORDER the read routes resolve token sources in.
 *
 * Two things are pinned here, and they fail in opposite ways:
 *
 *   • **Forgetting the stored OAuth token** is the defect this fixed: a user completes OAuth, the
 *     server holds their token, and the picker answers `401 GitHub token not found` — so a working
 *     connect button appears to do nothing. Loud to the user, invisible in code.
 *   • **Reaching for the OPERATOR's token** is the opposite mistake and is silent: the route answers
 *     happily, with somebody else's repositories. That is `api.system.git-info` (`spec/spend-holes.md`),
 *     which listed the operator's private repos to anyone who asked. So the source must be the
 *     caller's own, and the operator env must stay strictly last.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireUser = vi.fn();
const storedAccessToken = vi.fn();

vi.mock('~/lib/.server/supabase/auth', () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock('./resolve', () => ({ storedAccessToken: (...a: unknown[]) => storedAccessToken(...a) }));

const { callerOAuthToken } = await import('./caller-token');

const request = new Request('http://localhost/api/github-stats');

beforeEach(() => {
  requireUser.mockReset();
  storedAccessToken.mockReset();
});

describe('callerOAuthToken', () => {
  it('returns the token stored for THIS caller', async () => {
    requireUser.mockResolvedValue({ id: 'user-1' });
    storedAccessToken.mockResolvedValue('gho_stored');

    await expect(callerOAuthToken(request, {}, 'github')).resolves.toBe('gho_stored');

    // The user id must come from the session, never from a caller-supplied value.
    expect(storedAccessToken).toHaveBeenCalledWith({}, 'user-1', 'github');
  });

  it('defaults to github, and passes gitlab through when asked', async () => {
    requireUser.mockResolvedValue({ id: 'user-1' });
    storedAccessToken.mockResolvedValue('t');

    await callerOAuthToken(request, {});
    expect(storedAccessToken).toHaveBeenLastCalledWith({}, 'user-1', 'github');

    await callerOAuthToken(request, {}, 'gitlab');
    expect(storedAccessToken).toHaveBeenLastCalledWith({}, 'user-1', 'gitlab');
  });

  it('is null — never a throw — when the user has not connected', async () => {
    requireUser.mockResolvedValue({ id: 'user-1' });
    storedAccessToken.mockResolvedValue(null);

    await expect(callerOAuthToken(request, {}, 'github')).resolves.toBeNull();
  });

  it.each([
    ['no session', () => requireUser.mockRejectedValue(new Error('unauthorized'))],
    ['the token store throwing', () => storedAccessToken.mockRejectedValue(new Error('db down'))],
  ])('survives %s without throwing', async (_label, arrange) => {
    /*
     * Callers use this inside a `||` chain of token sources. An exception there turns "you have not
     * connected" into a 500 on a route that still had other options to try.
     */
    requireUser.mockResolvedValue({ id: 'user-1' });
    storedAccessToken.mockResolvedValue('t');
    arrange();

    await expect(callerOAuthToken(request, {}, 'github')).resolves.toBeNull();
  });
});

/**
 * The precedence itself, read out of the routes' source.
 *
 * A behavioural test would need three token sources, a Supabase session and a live GitHub — so what
 * is actually checkable, and what actually regresses, is the ORDER of the `||` chain. It is asserted
 * by position because that is the whole property: swapping two lines here changes whose repositories
 * a user sees, and nothing else in the suite would notice.
 */
describe('token precedence in the inherited read routes', () => {
  const ROUTES = ['app/routes/api.github-stats.ts', 'app/routes/api.github-user.ts'];

  it.each(ROUTES)('%s: EVERY chain is caller cookie → caller OAuth → operator env', async (path) => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

    /*
     * 🔴 Per CHAIN, not per file. The first draft used `indexOf` over the whole source and would
     * have passed with `api.github-user`'s GET loader left unfixed — it has two `const githubToken =`
     * chains (identity, and repos/branches) and only the second had been done. One index cannot see
     * a second chain, and the store's connection call happens to use the one that was missed.
     */
    const chains = source.split(/const githubToken =/).slice(1);

    expect(chains.length, `${path} must declare at least one token chain`).toBeGreaterThan(0);

    chains.forEach((chain, i) => {
      const body = chain.split(';')[0];

      const cookie = body.indexOf('apiKeys.GITHUB_API_KEY');
      const oauth = body.indexOf('callerOAuthToken(request, context)');
      const env = body.indexOf('process.env.GITHUB_TOKEN');

      expect(cookie, `chain ${i}: the caller cookie source must still be present`).toBeGreaterThan(-1);
      expect(oauth, `chain ${i}: the caller OAuth source must be present — this is the fix`).toBeGreaterThan(-1);
      expect(env, `chain ${i}: the operator env fallback is kept by SPEC §2.3`).toBeGreaterThan(-1);

      expect(oauth, `chain ${i}: an explicit BYOK cookie is the user’s own choice and wins`).toBeGreaterThan(cookie);
      expect(oauth, `chain ${i}: the operator’s token must never outrank the caller’s own`).toBeLessThan(env);
    });
  });

  it('the GitLab route prefers the body token and falls back to the caller’s own', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('app/routes/api.gitlab-projects.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

    expect(source).toContain("callerOAuthToken(request, context, 'gitlab')");
    expect(source, 'the body token must come first in the chain').toMatch(
      /bodyToken\s*\|\|\s*\(await callerOAuthToken/,
    );
  });
});
