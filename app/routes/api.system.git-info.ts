/**
 * Build/git info, plus an inherited GitHub passthrough (SPEC §5, `spec/spend-holes.md`).
 *
 * The static build-info branch at the bottom reports compile-time constants and reaches nothing — it
 * stays open. The `action=` branch is a different animal: it calls api.github.com, and it shipped
 * ANONYMOUS while preferring the PLATFORM `GITHUB_ACCESS_TOKEN` over the caller's own. A `curl` with no
 * session listed the platform account's private repos, gists, and orgs. That is the same class of leak
 * as the retired `/api/export-api-keys`, and strictly worse than the `api.github-user` fallback that was
 * closed on 2026-07-19 — there the platform token was a fallback; here it had PRECEDENCE.
 *
 * Two walls, matching that fix: a verified session before any outbound call, and the caller's OWN token
 * only — the server env is not consulted, not even as a fallback.
 */
import { json, type LoaderFunction, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { denyUnlessVerified } from '~/lib/.server/http';

interface GitInfo {
  local: {
    commitHash: string;
    branch: string;
    commitTime: string;
    author: string;
    email: string;
    remoteUrl: string;
    repoName: string;
  };
  github?: {
    currentRepo?: {
      fullName: string;
      defaultBranch: string;
      stars: number;
      forks: number;
      openIssues?: number;
    };
  };
  isForked?: boolean;
  timestamp?: string;
}

/*
 * Deliberately carries no `GITHUB_ACCESS_TOKEN` field: this route must not read a platform token, and a
 * type that still advertises one is an invitation to wire the fallback back in.
 */
interface AppContext {
  env?: Record<string, never>;
}

interface GitHubRepo {
  name: string;
  full_name: string;
  html_url: string;
  description: string;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
  languages_url: string;
}

interface GitHubGist {
  id: string;
  html_url: string;
  description: string;
}

// These values will be replaced at build time
declare const __COMMIT_HASH: string;
declare const __GIT_BRANCH: string;
declare const __GIT_COMMIT_TIME: string;
declare const __GIT_AUTHOR: string;
declare const __GIT_EMAIL: string;
declare const __GIT_REMOTE_URL: string;
declare const __GIT_REPO_NAME: string;

/*
 * Remove unused variable to fix linter error
 * declare const __GIT_REPO_URL: string;
 */

export const loader: LoaderFunction = async ({ request, context }: LoaderFunctionArgs & { context: AppContext }) => {
  console.log('Git info API called with URL:', request.url);

  // Handle CORS preflight requests
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');

  console.log('Git info action:', action);

  if (action === 'getUser' || action === 'getRepos' || action === 'getOrgs' || action === 'getActivity') {
    // Wall one: no outbound GitHub call for an anonymous caller.
    const denied = await denyUnlessVerified(request, context);

    if (denied) {
      return denied;
    }

    const cookieToken = request.headers
      .get('Cookie')
      ?.split(';')
      .find((cookie) => cookie.trim().startsWith('githubToken='))
      ?.split('=')[1];

    // Also check for token in Authorization header
    const authHeader = request.headers.get('Authorization');
    const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;

    /*
     * Wall two: the CALLER's token, never the platform's. See the module note — the env fallback here
     * handed an anonymous request the platform account's private repos.
     */
    const token = headerToken || cookieToken;

    console.log('Using GitHub token from:', headerToken ? 'auth header' : cookieToken ? 'cookie' : 'none');

    if (!token) {
      console.error('No GitHub token available');
      return json(
        { error: 'No GitHub token available' },
        {
          status: 401,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          },
        },
      );
    }

    try {
      if (action === 'getUser') {
        const response = await fetch('https://api.github.com/user', {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          console.error('GitHub user API error:', response.status);
          throw new Error(`GitHub API error: ${response.status}`);
        }

        const userData = await response.json();

        return json(
          { user: userData },
          {
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            },
          },
        );
      }

      if (action === 'getRepos') {
        const reposResponse = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            Authorization: `Bearer ${token}`,
          },
        });

        if (!reposResponse.ok) {
          console.error('GitHub repos API error:', reposResponse.status);
          throw new Error(`GitHub API error: ${reposResponse.status}`);
        }

        const repos = (await reposResponse.json()) as GitHubRepo[];

        // Get user's gists
        const gistsResponse = await fetch('https://api.github.com/gists', {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            Authorization: `Bearer ${token}`,
          },
        });

        const gists = gistsResponse.ok ? ((await gistsResponse.json()) as GitHubGist[]) : [];

        // Calculate language statistics
        const languageStats: Record<string, number> = {};
        let totalStars = 0;
        let totalForks = 0;

        for (const repo of repos) {
          totalStars += repo.stargazers_count || 0;
          totalForks += repo.forks_count || 0;

          if (repo.language && repo.language !== 'null') {
            languageStats[repo.language] = (languageStats[repo.language] || 0) + 1;
          }

          /*
           * Optionally fetch languages for each repo for more accurate stats
           * This is commented out to avoid rate limiting
           *
           * if (repo.languages_url) {
           *   try {
           *     const langResponse = await fetch(repo.languages_url, {
           *       headers: {
           *         Accept: 'application/vnd.github.v3+json',
           *         Authorization: `Bearer ${token}`,
           *       },
           *     });
           *
           *     if (langResponse.ok) {
           *       const languages = await langResponse.json();
           *       Object.keys(languages).forEach(lang => {
           *         languageStats[lang] = (languageStats[lang] || 0) + languages[lang];
           *       });
           *     }
           *   } catch (error) {
           *     console.error(`Error fetching languages for ${repo.name}:`, error);
           *   }
           * }
           */
        }

        return json(
          {
            repos,
            stats: {
              totalStars,
              totalForks,
              languages: languageStats,
              totalGists: gists.length,
            },
          },
          {
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            },
          },
        );
      }

      if (action === 'getOrgs') {
        const response = await fetch('https://api.github.com/user/orgs', {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          console.error('GitHub orgs API error:', response.status);
          throw new Error(`GitHub API error: ${response.status}`);
        }

        const orgs = await response.json();

        return json(
          { organizations: orgs },
          {
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            },
          },
        );
      }

      if (action === 'getActivity') {
        const username = request.headers
          .get('Cookie')
          ?.split(';')
          .find((cookie) => cookie.trim().startsWith('githubUsername='))
          ?.split('=')[1];

        if (!username) {
          console.error('GitHub username not found in cookies');
          return json(
            { error: 'GitHub username not found in cookies' },
            {
              status: 400,
              headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
              },
            },
          );
        }

        const response = await fetch(`https://api.github.com/users/${username}/events?per_page=30`, {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          console.error('GitHub activity API error:', response.status);
          throw new Error(`GitHub API error: ${response.status}`);
        }

        const events = await response.json();

        return json(
          { recentActivity: events },
          {
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            },
          },
        );
      }
    } catch (error) {
      console.error('GitHub API error:', error);
      return json(
        { error: error instanceof Error ? error.message : 'Unknown error' },
        {
          status: 500,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          },
        },
      );
    }
  }

  const gitInfo: GitInfo = {
    local: {
      commitHash: typeof __COMMIT_HASH !== 'undefined' ? __COMMIT_HASH : 'development',
      branch: typeof __GIT_BRANCH !== 'undefined' ? __GIT_BRANCH : 'main',
      commitTime: typeof __GIT_COMMIT_TIME !== 'undefined' ? __GIT_COMMIT_TIME : new Date().toISOString(),
      author: typeof __GIT_AUTHOR !== 'undefined' ? __GIT_AUTHOR : 'development',
      email: typeof __GIT_EMAIL !== 'undefined' ? __GIT_EMAIL : 'development@local',
      remoteUrl: typeof __GIT_REMOTE_URL !== 'undefined' ? __GIT_REMOTE_URL : 'local',
      repoName: typeof __GIT_REPO_NAME !== 'undefined' ? __GIT_REPO_NAME : 'app-builder',
    },
    timestamp: new Date().toISOString(),
  };

  return json(gitInfo, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    },
  });
};
