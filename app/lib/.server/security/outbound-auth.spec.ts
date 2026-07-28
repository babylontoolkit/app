/**
 * Every route that reaches OUT on the platform's behalf must refuse an unauthenticated caller BEFORE
 * it spends anything (SPEC §4.5.4, §5).
 *
 * These are inherited bolt.diy plumbing routes — the git CORS proxy, the GitHub/GitLab/Netlify/Vercel/
 * Supabase passthroughs, and the deploy endpoints. They shipped anonymous, and several fall back to a
 * PLATFORM provider token when the caller sends none, so an anonymous request used our token, our
 * quota, and our bandwidth with no way to attribute the spend. The wall is a `denyUnlessVerified` guard
 * at the top of each handler.
 *
 * The test forces the auth layer to "not signed in" and asserts each route answers 401 and NEVER calls
 * `fetch`. If a guard regresses, nothing throws — the route quietly starts spending again — which is
 * exactly the failure this pins. `fetch` is stubbed to throw so a reached outbound is a hard failure,
 * not a silent network call in CI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/.server/supabase/auth', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    requireUser: async () => {
      throw new (actual.UnauthorizedError as new () => Error)();
    },
    requireVerifiedUser: async () => {
      throw new (actual.UnauthorizedError as new () => Error)();
    },
  };
});

import { action as gitProxyAction, loader as gitProxyLoader } from '~/routes/api.git-proxy.$';
import { loader as githubUserLoader, action as githubUserAction } from '~/routes/api.github-user';
import { loader as githubStatsLoader } from '~/routes/api.github-stats';
import { loader as githubBranchesLoader, action as githubBranchesAction } from '~/routes/api.github-branches';
import { action as gitlabBranchesAction } from '~/routes/api.gitlab-branches';
import { action as gitlabProjectsAction } from '~/routes/api.gitlab-projects';
import { loader as netlifyUserLoader, action as netlifyUserAction } from '~/routes/api.netlify-user';
import { loader as vercelUserLoader, action as vercelUserAction } from '~/routes/api.vercel-user';
import { loader as supabaseUserLoader, action as supabaseUserAction } from '~/routes/api.supabase-user';
import { action as netlifyDeployAction } from '~/routes/api.netlify-deploy';
import { loader as vercelDeployLoader, action as vercelDeployAction } from '~/routes/api.vercel-deploy';
import { action as supabaseQueryAction } from '~/routes/api.supabase.query';
import { action as supabaseVariablesAction } from '~/routes/api.supabase.variables';
import { action as supabaseAction } from '~/routes/api.supabase';

/*
 * The five added 2026-07-20. The original sweep looked for routes named after VENDORS and these are
 * named after SUBSYSTEMS, so every one shipped anonymous — `api.system.git-info` most seriously, since
 * it preferred the PLATFORM GitHub token over the caller's own and would list the operator's private
 * repos to a `curl`. `outbound-enumerate.spec.ts` now derives this list from disk so the next one
 * cannot hide the same way.
 */
import { loader as systemGitInfoLoader } from '~/routes/api.system.git-info';
import { loader as systemDiagnosticsLoader } from '~/routes/api.system.diagnostics';
import { loader as githubTemplateLoader } from '~/routes/api.github-template';
import { loader as modelsLoader } from '~/routes/api.models';
import { action as bugReportAction } from '~/routes/api.bug-report';

/*
 * The sandbox routes (2026-07-27). These reach out to CodeSandbox on the PLATFORM api key, and the
 * session route can FORK A VM — an anonymous caller here does not just spend our quota, they leave a
 * machine running that bills by the second. Both must refuse before the provider is touched at all.
 */
import { action as sandboxSessionAction } from '~/routes/api.sandbox.session';
import { loader as sandboxPreviewLoader } from '~/routes/api.sandbox.preview';

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(() => {
    throw new Error('fetch must not be reached for an unauthenticated caller');
  });
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A minimal RouteArgs with a POST (default) or GET request and the given path params. */
const args = (method: string, params: Record<string, string> = {}, url = 'http://localhost/api/x') =>
  ({
    request: new Request(url, {
      method,
      ...(method === 'POST' ? { body: '{}', headers: { 'Content-Type': 'application/json' } } : {}),
    }),
    context: {},
    params,
  }) as any;

type Handler = (a: any) => Promise<Response>;

const cases: Array<{ name: string; call: () => Promise<Response> }> = [
  { name: 'git-proxy loader (GET)', call: () => (gitProxyLoader as Handler)(args('GET', { '*': 'example.com/info' })) },
  {
    name: 'git-proxy action (POST)',
    call: () => (gitProxyAction as Handler)(args('POST', { '*': 'example.com/git' })),
  },
  { name: 'github-user loader', call: () => (githubUserLoader as Handler)(args('GET')) },
  { name: 'github-user action', call: () => (githubUserAction as Handler)(args('POST')) },
  { name: 'github-stats loader', call: () => (githubStatsLoader as Handler)(args('GET')) },
  { name: 'github-branches loader', call: () => (githubBranchesLoader as Handler)(args('GET')) },
  { name: 'github-branches action', call: () => (githubBranchesAction as Handler)(args('POST')) },
  { name: 'gitlab-branches action', call: () => (gitlabBranchesAction as Handler)(args('POST')) },
  { name: 'gitlab-projects action', call: () => (gitlabProjectsAction as Handler)(args('POST')) },
  { name: 'netlify-user loader', call: () => (netlifyUserLoader as Handler)(args('GET')) },
  { name: 'netlify-user action', call: () => (netlifyUserAction as Handler)(args('POST')) },
  { name: 'vercel-user loader', call: () => (vercelUserLoader as Handler)(args('GET')) },
  { name: 'vercel-user action', call: () => (vercelUserAction as Handler)(args('POST')) },
  { name: 'supabase-user loader', call: () => (supabaseUserLoader as Handler)(args('GET')) },
  { name: 'supabase-user action', call: () => (supabaseUserAction as Handler)(args('POST')) },
  { name: 'netlify-deploy action', call: () => (netlifyDeployAction as Handler)(args('POST')) },
  { name: 'vercel-deploy loader', call: () => (vercelDeployLoader as Handler)(args('GET')) },
  { name: 'vercel-deploy action', call: () => (vercelDeployAction as Handler)(args('POST')) },
  { name: 'supabase.query action', call: () => (supabaseQueryAction as Handler)(args('POST')) },
  { name: 'supabase.variables action', call: () => (supabaseVariablesAction as Handler)(args('POST')) },
  { name: 'supabase action', call: () => (supabaseAction as Handler)(args('POST')) },

  /*
   * `system.git-info` only reaches GitHub on an `action=` query — the bare route returns compile-time
   * build constants and stays open — so the URL here is the one that actually spends.
   */
  {
    name: 'system.git-info loader (action=getRepos)',
    call: () =>
      (systemGitInfoLoader as Handler)(args('GET', {}, 'http://localhost/api/system/git-info?action=getRepos')),
  },
  { name: 'system.diagnostics loader', call: () => (systemDiagnosticsLoader as Handler)(args('GET')) },
  {
    name: 'github-template loader',
    call: () =>
      (githubTemplateLoader as Handler)(args('GET', {}, 'http://localhost/api/github-template?repo=owner/repo')),
  },
  { name: 'models loader', call: () => (modelsLoader as Handler)({ ...args('GET'), params: {} }) },
  { name: 'bug-report action', call: () => (bugReportAction as Handler)(args('POST')) },

  /*
   * The session route takes a JSON body naming the project; the preview route is a GET with the
   * project and port in the query. Both are written so the auth wall is the FIRST thing they do —
   * before the "is the provider configured?" check, before the body is even read.
   */
  {
    name: 'sandbox.session action',
    call: () =>
      (sandboxSessionAction as Handler)({
        request: new Request('http://localhost/api/sandbox/session', {
          method: 'POST',
          body: JSON.stringify({ projectId: 'prj_anything' }),
          headers: { 'Content-Type': 'application/json' },
        }),
        context: {},
        params: {},
      }),
  },
  {
    name: 'sandbox.preview loader',
    call: () =>
      (sandboxPreviewLoader as Handler)(
        args('GET', {}, 'http://localhost/api/sandbox/preview?projectId=prj_anything&port=5173'),
      ),
  },
];

describe('outbound routes refuse an unauthenticated caller before spending', () => {
  for (const { name, call } of cases) {
    it(`${name} → 401, no outbound fetch`, async () => {
      const response = await call();

      expect(response.status).toBe(401);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }
});
