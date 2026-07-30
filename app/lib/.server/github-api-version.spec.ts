/**
 * The GitHub REST API version pin reaches the WIRE, on every door the platform owns.
 *
 * 🔴 This is a dated cliff, not a style preference. A request that sends no `X-GitHub-Api-Version`
 * gets `2022-11-28` — deprecated 2026-03-10, **410 Gone** after 2028-03-10 — so an unpinned door does
 * not degrade, it stops. And it stops on a date, all at once, across Save (§4.5.4b), doc-sync (§4.3),
 * skills-sync (§4.11) and template fetch (§4.4).
 *
 * Every assertion here reads the header off the actual request rather than off a config object,
 * because the way to get this wrong is invisible in review: `@octokit/core`'s constructor builds its
 * default headers from a fixed list and IGNORES an arbitrary `headers` option, so
 * `new Octokit({ headers: { 'x-github-api-version': … } })` type-checks, reads as correct, and sends
 * nothing. Asserting on the wire is the only assertion that can tell the two apart.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GITHUB_API_VERSION, GITHUB_API_VERSION_HEADER, withGitHubApiVersion } from './github-api-version';
import { GitHubProvider } from './git/github';
import { githubJson } from './prompt/github';

/** Case-insensitively read a header off whatever shape the door used (`Headers`, or a plain bag). */
function headerFrom(init: RequestInit | undefined): string | undefined {
  const headers = new Headers((init?.headers ?? {}) as HeadersInit);
  return headers.get(GITHUB_API_VERSION_HEADER) ?? undefined;
}

afterEach(() => vi.unstubAllGlobals());

describe('the pin itself', () => {
  it('is a single dated version, newer than the deprecated default', () => {
    /*
     * `2022-11-28` is the version GitHub serves when NOTHING is sent. Pinning it would remove the
     * warning by re-stating the problem, so the shape is asserted rather than the exact date — the
     * date is expected to move, the "not the sunsetting default" property is not.
     */
    expect(GITHUB_API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(GITHUB_API_VERSION).not.toBe('2022-11-28');
    expect(GITHUB_API_VERSION > '2022-11-28').toBe(true);
  });

  it('adds the header without disturbing the headers it was given', () => {
    expect(withGitHubApiVersion({ accept: 'application/vnd.github+json', authorization: 'Bearer t' })).toEqual({
      accept: 'application/vnd.github+json',
      authorization: 'Bearer t',
      [GITHUB_API_VERSION_HEADER]: GITHUB_API_VERSION,
    });
  });
});

describe('the Save path (Octokit)', () => {
  /**
   * Drive the PRODUCTION construction — `new GitHubProvider(token)`, exactly as `resolve.ts` does —
   * with only the global `fetch` replaced, so the real Octokit, its auth wrapper and the version hook
   * all run. Injecting a client would test the test seam; injecting a *double* would test our mock's
   * opinion of Octokit, and Octokit's own header handling is precisely what is easy to get wrong here.
   */
  async function captureSaveRequest(): Promise<{ url: string; init: RequestInit | undefined }> {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ login: 'octocat' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    await new GitHubProvider('token').getCurrentUser();

    return calls[0];
  }

  it('sends the pinned version', async () => {
    const { url, init } = await captureSaveRequest();

    expect(url).toContain('api.github.com');
    expect(headerFrom(init)).toBe(GITHUB_API_VERSION);
  });

  /**
   * The CONTROL that makes the assertion above mean something. Octokit sets its own default headers
   * (`accept`, `user-agent`, `authorization`) and the pin must be an ADDITION — a hook that replaces
   * the bag instead of spreading it would strip the credential and every call would 401.
   */
  it('does not clobber the headers Octokit sets for itself', async () => {
    const headers = new Headers(((await captureSaveRequest()).init?.headers ?? {}) as HeadersInit);

    expect(headers.get('authorization')).toBe('token token');
    expect(headers.get('accept')).toContain('application/vnd.github');
  });
});

describe('the sync path (doc-sync + skills-sync share one helper)', () => {
  it('sends the pinned version when authenticated', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('{}'));
    vi.stubGlobal('fetch', fetchImpl);

    await githubJson('https://api.github.com/repos/o/r/commits/main', 'token');

    expect(headerFrom(fetchImpl.mock.calls[0][1])).toBe(GITHUB_API_VERSION);
  });

  /**
   * 🔴 The ANONYMOUS RETRY is a separate request, and it is the one that runs in a fresh checkout —
   * `.env.local` ships placeholder GitHub tokens, so `githubFetch` retries without auth on any
   * failure. A pin applied only to the authenticated attempt would leave the common path unversioned.
   */
  it('sends it on the anonymous retry too, not just the authenticated attempt', async () => {
    let call = 0;
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('{}', { status: call++ === 0 ? 401 : 200 }),
    );
    vi.stubGlobal('fetch', fetchImpl);

    await githubJson('https://api.github.com/repos/o/r/commits/main', 'a-rejected-token');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(headerFrom(fetchImpl.mock.calls[1][1])).toBe(GITHUB_API_VERSION);

    // ...and the retry really is anonymous — the pin must not have smuggled the credential back in.
    expect(new Headers((fetchImpl.mock.calls[1][1]?.headers ?? {}) as HeadersInit).get('authorization')).toBeNull();
  });
});

describe('the template path (§4.4 — how every project is created)', () => {
  it('sends the pinned version', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ sha: 'abc', default_branch: 'main' })),
    );
    vi.stubGlobal('fetch', fetchImpl);

    const { resolveTemplateRef } = await import('./templates/fetch');
    await resolveTemplateRef('owner/repo', undefined, undefined);

    expect(fetchImpl.mock.calls.length).toBeGreaterThan(0);
    expect(headerFrom(fetchImpl.mock.calls[0][1])).toBe(GITHUB_API_VERSION);
  });
});
