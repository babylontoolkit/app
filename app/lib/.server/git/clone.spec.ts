/**
 * Server-side CLONE — the import path's read primitive (SPEC §4.13, §4.5.4b, §5).
 *
 * ## What is actually at risk here, and why the fakes are wired the way they are
 *
 * Clone is the first caller-influenced fetch target in the product, and it is the one repo operation
 * that may run with NO credential at all. Those two facts pull in opposite directions, and each has a
 * silent failure mode:
 *
 *   - **The anonymous path must really be anonymous.** A public repository cloned by a user who has
 *     never connected an account is a first-class path (`clone.ts` header). If any layer quietly sends
 *     an empty credential, the provider rejects it and the user is shown a *connect* prompt for a
 *     repository that needs no connection — a dead end on the product's own front door. So the GitLab
 *     fake here REFUSES a malformed `Authorization: Bearer ` rather than ignoring headers, in the
 *     `fake-servers.ts` tradition of reproducing the quirk that catches the bug. (It caught one:
 *     `_listTree` built its own request and always sent the header.)
 *   - **A refusal must NAME the limitation.** `share/build-failure.ts` is the same lesson one door
 *     over: told to fix something unnamed, a user concludes the button is broken. So the unsupported
 *     host says which host, and the size cap says the size, the limit AND the env var that moves it.
 *
 * ## Why these tests build providers from real adapters against the fake servers
 *
 * The interesting logic in `cloneRepository` is entirely about what the ADAPTERS answer — a default
 * branch that resolves, a `fetchTree` that returns `null`, a 404 that means "private" to an anonymous
 * reader — so a hand-written stub provider would only assert that we can read our own fixture. The
 * adapter modules are therefore mocked at their CONSTRUCTOR to inject the fake transports, which
 * leaves `resolveProvider`'s real "no stored token → auth" behaviour (the thing the anonymous fallback
 * hangs off) genuinely under test.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeGitHub, createFakeGitLab, FakeRepoStore } from './fake-servers';
import { GitProviderError } from './provider';
import { setGitTokenStore, type GitTokenStore, type TokenRecord } from './token-store';
import {
  BRANCH_WRITE_RATE_LIMIT,
  CLONE_RATE_LIMIT,
  MemoryUserRateLimitStore,
  setUserRateLimitStore,
  TREE_READ_RATE_LIMIT,
  type UserRateLimitStore,
} from '~/lib/.server/security/user-rate-limit';
import { FsProjectStore, setProjectStore } from '~/lib/.server/projects/store';
import { bytesToBase64, type SerializedFileMap } from '~/lib/binary/binary-files';
import { claimProject, _resetClaims } from '~/lib/.server/agent/inflight';
import type { Project, ProjectStore } from '~/lib/.server/projects/types';

/*
 * The SSRF wall is defense-in-depth here (the coordinate reduction is the primary one), and it does a
 * real DNS lookup. Stubbed so the suite never touches the network — but kept as a SPY, because "the
 * origin was checked before anything was fetched" is a property worth asserting rather than assuming.
 */
const assertPublicUrl = vi.fn(async (url: string) => url);

vi.mock('~/lib/.server/net/ssrf', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertPublicUrl: (url: string) => assertPublicUrl(url),
}));

/** The world both adapter mocks read. Rebuilt per test so nothing leaks between them. */
let world: {
  store: FakeRepoStore;
  github: ReturnType<typeof createFakeGitHub>;
  gitlab: ReturnType<typeof createFakeGitLab>;

  /** Repos an ANONYMOUS reader cannot see. GitHub answers 404 for these — never 403 (see below). */
  privateRepos: Set<string>;
};

/**
 * An Octokit that models VISIBILITY, which `fake-servers.ts` deliberately does not.
 *
 * ⚠️ A private repo answers **404, not 403** — GitHub does that on purpose so its API cannot be used
 * to enumerate private repositories, and `clone.ts` is built around the consequence: to an anonymous
 * reader "private" and "typo" are the same observation, so both become one connect prompt.
 */
function githubFor(token: string) {
  const octokit = world.github.octokit as unknown as Record<string, Record<string, (p: never) => unknown>>;
  const visible = (owner: string, repo: string) => token !== '' || !world.privateRepos.has(`${owner}/${repo}`);
  const notFound = () => Object.assign(new Error('Not Found'), { status: 404, response: { headers: {} } });

  const gate =
    <P extends { owner: string; repo: string }>(inner: (p: P) => unknown) =>
    async (params: P) => {
      if (!visible(params.owner, params.repo)) {
        throw notFound();
      }

      return inner(params);
    };

  return {
    ...octokit,
    repos: { ...octokit.repos, get: gate(octokit.repos.get as never) },
    git: { ...octokit.git, getRef: gate(octokit.git.getRef as never) },
  } as never;
}

/**
 * A GitLab `fetch` that REJECTS an empty bearer, exactly as gitlab.com does.
 *
 * The fake would otherwise be nicer than the real thing, and the anonymous clone path would pass in
 * the test while 401-ing in production — which is the failure `fake-servers.ts` opens by warning about.
 */
function gitlabFetch(token: string): typeof fetch {
  return async (input, init) => {
    const auth = new Headers((init?.headers ?? {}) as HeadersInit).get('authorization');

    if (auth !== null && !/^Bearer .+/.test(auth)) {
      return new Response(JSON.stringify({ message: '401 Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(typeof input === 'string' ? input : (input as Request).url);
    const project = decodeURIComponent(url.pathname.replace(/^\/api\/v4\/projects\//, '').split('/')[0]);

    if (token === '' && world.privateRepos.has(project)) {
      return new Response(JSON.stringify({ message: '404 Project Not Found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return world.gitlab.fetchImpl(input, init);
  };
}

vi.mock('./github', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./github')>();

  return {
    ...actual,
    GitHubProvider: class extends actual.GitHubProvider {
      constructor(token: string, octokit?: never) {
        super(token, octokit ?? githubFor(token));
      }
    },
  };
});

vi.mock('./gitlab', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./gitlab')>();

  return {
    ...actual,
    GitLabProvider: class extends actual.GitLabProvider {
      constructor(token: string, options: { host?: string; fetchImpl?: typeof fetch } = {}) {
        super(token, { ...options, fetchImpl: options.fetchImpl ?? gitlabFetch(token) });
      }
    },
  };
});

const USER = { id: 'user-1', email: 'a@example.com', emailVerified: true } as const;

/**
 * The owner's 2026-08-22 branch-delete switch, made drivable.
 *
 * ⚠️ Default `open: false` delegates to the REAL `branchDeleteAvailability`, so the switch itself is
 * asserted against production behaviour rather than against a mock of it. The `delete-branch` suite
 * opens it, which is what keeps the per-branch protections — the current-branch and default-branch
 * refusals, the one operation here with no undo — under test while the feature is off. Suspending a
 * capability must not silently retire the coverage of the rules that make it safe to restore.
 */
const branchDeleteGate = vi.hoisted(() => ({ open: false }));

vi.mock('~/lib/persistence/branch-delete', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/persistence/branch-delete')>();

  return {
    ...actual,
    branchDeleteAvailability: () => (branchDeleteGate.open ? { ok: true } : actual.branchDeleteAvailability()),
  };
});

vi.mock('~/lib/.server/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireVerifiedUser: async () => USER,
  requireUser: async () => USER,
}));

/**
 * 🔴 `ctx({})` is NOT "nothing is configured" (the `oauth.spec.ts` trap, second offence in this dir).
 *
 * `env()` falls back to `process.env` and vitest loads `.env.local`, so a developer who has set
 * `GIT_CLONE_MAX_MB` or a GitLab host would see these tests fail while CI stayed green. Every key the
 * clone path reads — including the ones it reads INDIRECTLY, through `getOAuthConfig` — is cleared.
 */
const CLONE_ENV_KEYS = [
  'GIT_CLONE_MAX_MB',
  'GITHUB_OAUTH_CLIENT_ID',
  'GITHUB_OAUTH_CLIENT_SECRET',
  'GITLAB_OAUTH_CLIENT_ID',
  'GITLAB_OAUTH_CLIENT_SECRET',
  'GITLAB_HOST',
];

const ctx = (vars: Record<string, string> = {}) => ({ cloudflare: { env: vars } });

/** A user who HAS connected the provider. `''` is never a token — that is the anonymous path. */
const connected = (provider: 'github' | 'gitlab' = 'github'): GitTokenStore => {
  const record: TokenRecord = {
    userId: USER.id,
    provider,
    accessToken: 'gho_a_real_stored_token',
    providerLogin: 'testuser',
    updatedAt: new Date().toISOString(),
  };

  return {
    get: async (_userId, p) => (p === provider ? record : null),

    // A clone is a READ. It must never write or clear the user's connection, however it fails.
    put: async () => {
      throw new Error('A clone must never write a token.');
    },
    delete: async () => {
      throw new Error('A clone must never delete a connection.');
    },
    listByUser: async () => [record],
  };
};

/** A user who has connected nothing — `resolveProvider` throws `auth`, and clone must fall back. */
const unconnected: GitTokenStore = {
  get: async () => null,
  put: async () => {
    throw new Error('A clone must never write a token.');
  },
  delete: async () => {
    throw new Error('A clone must never delete a connection.');
  },
  listByUser: async () => [],
};

beforeEach(() => {
  for (const key of CLONE_ENV_KEYS) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  const store = new FakeRepoStore();

  world = {
    store,
    github: createFakeGitHub({ store }),
    gitlab: createFakeGitLab({ store }),
    privateRepos: new Set(),
  };

  assertPublicUrl.mockClear();
  setGitTokenStore(unconnected);
});

afterEach(() => {
  vi.unstubAllEnvs();
  setGitTokenStore(null);
});

/** Register a repo in both fakes and seed its default branch with content. */
function seed(fullName: string, files: Record<string, { content: string; base64?: boolean }>, branch = 'main') {
  world.store.addRepo(fullName, branch);
  world.store.seedBranch(branch, files);
}

const clone = async (
  target: Parameters<typeof import('./clone').cloneRepository>[0]['target'],
  context: unknown = ctx(),
) => {
  const { cloneRepository } = await import('./clone');

  return cloneRepository({ context, userId: USER.id, target });
};

describe('parseCloneTarget — the primary SSRF wall is a COORDINATE, not a URL', () => {
  it.each([
    ['owner/repo', { provider: 'github', owner: 'owner', repo: 'repo', branch: undefined }],
    ['https://github.com/owner/repo', { provider: 'github', owner: 'owner', repo: 'repo', branch: undefined }],
    ['https://github.com/owner/repo.git', { provider: 'github', owner: 'owner', repo: 'repo', branch: undefined }],
    ['git@github.com:owner/repo.git', { provider: 'github', owner: 'owner', repo: 'repo', branch: undefined }],
    ['github.com/owner/repo', { provider: 'github', owner: 'owner', repo: 'repo', branch: undefined }],
    ['https://www.github.com/owner/repo', { provider: 'github', owner: 'owner', repo: 'repo', branch: undefined }],
  ])('reduces %j to a coordinate', async (raw, expected) => {
    const { parseCloneTarget } = await import('./clone');

    expect(parseCloneTarget(raw)).toEqual(expected);
  });

  /**
   * A pasted BROWSE url carries the branch after `/tree/`. Dropping the suffix without reading it
   * clones `owner/repo/tree` — a repository that does not exist — reported as "not found" for a URL
   * the user copied out of their own address bar.
   */
  it('reads the branch out of a GitHub /tree/ browse URL', async () => {
    const { parseCloneTarget } = await import('./clone');

    expect(parseCloneTarget('https://github.com/owner/repo/tree/dev')).toEqual({
      provider: 'github',
      owner: 'owner',
      repo: 'repo',
      branch: 'dev',
    });
  });

  it("reads the branch out of GitLab's /-/tree/ form and keeps the nested group path", async () => {
    const { parseCloneTarget } = await import('./clone');

    expect(parseCloneTarget('https://gitlab.com/group/subgroup/proj/-/tree/release')).toEqual({
      provider: 'gitlab',
      owner: 'group/subgroup',
      repo: 'proj',
      branch: 'release',
    });
  });

  /** GitLab permits nesting; only the LAST segment is the project (`parseRepo`'s rule). */
  it('keeps a nested GitLab group path intact', async () => {
    const { parseCloneTarget } = await import('./clone');

    expect(parseCloneTarget('https://gitlab.com/group/subgroup/proj')).toMatchObject({
      provider: 'gitlab',
      owner: 'group/subgroup',
      repo: 'proj',
    });
  });

  /**
   * The GitLab arm keys off the OPERATOR's configured host, not the string "gitlab" — a deployment
   * pointed at `git.example.com` must be able to import from it.
   */
  it('serves the operator-configured self-hosted GitLab host', async () => {
    const { parseCloneTarget } = await import('./clone');

    expect(
      parseCloneTarget('https://git.acme.internal/team/proj', { gitlabHost: 'https://git.acme.internal' }),
    ).toMatchObject({
      provider: 'gitlab',
      owner: 'team',
      repo: 'proj',
    });
  });

  /** The control for the line above: the SAME host is refused when the operator has not configured it. */
  it('refuses that same host when GitLab is NOT configured for it', async () => {
    const { parseCloneTarget } = await import('./clone');

    expect(() => parseCloneTarget('https://git.acme.internal/team/proj')).toThrow(/git\.acme\.internal/);
  });

  it('takes the provider hint for a bare owner/repo', async () => {
    const { parseCloneTarget } = await import('./clone');

    expect(parseCloneTarget('group/proj', { provider: 'gitlab' })).toMatchObject({ provider: 'gitlab' });
    expect(parseCloneTarget('owner/repo', { provider: 'nonsense' })).toMatchObject({ provider: 'github' });
  });

  /**
   * §5 / FR7 — and the refusal NAMES the host. "We do not support Bitbucket" is a product boundary a
   * user can act on; "import failed" is a bug report filed against whatever changed most recently.
   */
  it.each([
    'https://bitbucket.org/owner/repo',
    'https://evil.example.com/owner/repo',
    'git@bitbucket.org:owner/repo.git',
  ])('refuses %j by name', async (raw) => {
    const clone = await import('./clone');

    let thrown: unknown;

    try {
      clone.parseCloneTarget(raw);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(clone.UnsupportedGitHostError);
    expect((thrown as Error).message).toMatch(/only github and gitlab/i);
    expect((thrown as Error).message).toContain(new URL(raw.replace(/^git@([^:]+):/, 'https://$1/')).hostname);
  });

  /** Neither an IP literal nor a non-http scheme is a route to somewhere — both are refused. */
  it.each(['http://169.254.169.254/latest/meta-data', 'file:///etc/passwd', 'ssh://github.com/owner/repo'])(
    'refuses %j',
    async (raw) => {
      const { parseCloneTarget } = await import('./clone');

      expect(() => parseCloneTarget(raw)).toThrow();
    },
  );

  it.each(['', '   ', 'justaword', 'github.com/owner'])('refuses %j with a shape hint', async (raw) => {
    const { parseCloneTarget } = await import('./clone');

    expect(() => parseCloneTarget(raw)).toThrow(/repository/i);
  });
});

describe('the measurements a refusal is made from', () => {
  it('measures DECODED bytes for binaries, not their base64 length', async () => {
    const { serializedSourceBytes } = await import('./clone');

    const bytes = new Uint8Array(300).fill(7);
    const files: SerializedFileMap = {
      'src/a.ts': { type: 'file', content: 'x'.repeat(100), isBinary: false },
      'public/a.png': { type: 'file', content: bytesToBase64(bytes), isBinary: true },
    };

    expect(serializedSourceBytes(files)).toBe(400);
  });

  it('ignores non-file entries rather than throwing on them', async () => {
    const { serializedSourceBytes } = await import('./clone');

    expect(serializedSourceBytes({ src: { type: 'folder' } } as unknown as SerializedFileMap)).toBe(0);
  });

  /**
   * 🔴 The regression this found: a pointer arrives classified **BINARY**.
   *
   * `classifyFetchedBlob` lets the path veto a text verdict, and LFS exists precisely for `.glb` /
   * `.png` / `.mp4` — so a `!isBinary` check excluded every path a pointer is ever found at. The guard
   * read as present and could not fire. Both shapes are pinned, plus two controls: ordinary prose that
   * merely mentions git-lfs, and a genuine binary asset that must not be decoded into a false positive.
   */
  it('finds a pointer whether it arrives as text or as a binary-classified blob', async () => {
    const { findLfsPointers } = await import('./clone');

    const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12345\n';

    const files: SerializedFileMap = {
      'assets/model.glb': { type: 'file', content: bytesToBase64(new TextEncoder().encode(pointer)), isBinary: true },
      'shaders/water.glsl': { type: 'file', content: pointer, isBinary: false },
      'README.md': { type: 'file', content: 'This project uses git-lfs for large assets.\n', isBinary: false },
      'public/logo.png': { type: 'file', content: bytesToBase64(new Uint8Array(2000).fill(0x89)), isBinary: true },
    };

    expect(findLfsPointers(files).sort()).toEqual(['assets/model.glb', 'shaders/water.glsl']);
  });

  /** ONE secret rule (`~/lib/git/paths.ts`) — a second copy is how `.env.production` shipped once. */
  it('strips the whole .env family on the way IN, and reports what it dropped', async () => {
    const { stripSecrets } = await import('./clone');

    const files: SerializedFileMap = {
      '.env': { type: 'file', content: 'SECRET=1', isBinary: false },
      '.env.production': { type: 'file', content: 'SECRET=2', isBinary: false },
      '.env.example': { type: 'file', content: 'SECRET=', isBinary: false },
      'src/game.ts': { type: 'file', content: 'export const x = 1;', isBinary: false },
    };

    const result = stripSecrets(files);

    expect(Object.keys(result.files).sort()).toEqual(['.env.example', 'src/game.ts']);
    expect(result.removed.sort()).toEqual(['.env', '.env.production']);
  });

  it('takes the limit from config and falls back when it is nonsense', async () => {
    const { maxCloneBytes, DEFAULT_GIT_CLONE_MAX_MB } = await import('./clone');

    expect(maxCloneBytes(ctx({ GIT_CLONE_MAX_MB: '4' }))).toBe(4 * 1024 * 1024);
    expect(maxCloneBytes(ctx({ GIT_CLONE_MAX_MB: 'banana' }))).toBe(DEFAULT_GIT_CLONE_MAX_MB * 1024 * 1024);
    expect(maxCloneBytes(ctx({ GIT_CLONE_MAX_MB: '-1' }))).toBe(DEFAULT_GIT_CLONE_MAX_MB * 1024 * 1024);
    expect(maxCloneBytes(ctx())).toBe(DEFAULT_GIT_CLONE_MAX_MB * 1024 * 1024);
  });

  /**
   * The control for the `stubEnv` block at the top — it makes the trap visible rather than merely
   * avoided. `env()` really does fall back to `process.env`; delete the stubs and this whole file
   * starts failing for exactly the developer who configured `GIT_CLONE_MAX_MB`, with CI green.
   */
  it('reads process.env when the context does not answer — hence the stubs above', async () => {
    const { maxCloneBytes } = await import('./clone');

    vi.stubEnv('GIT_CLONE_MAX_MB', '7');

    expect(maxCloneBytes(ctx())).toBe(7 * 1024 * 1024);
  });
});

describe('cloneRepository', () => {
  it('clones a PUBLIC repo for a user with NO connection at all', async () => {
    seed('octocat/public-game', {
      'src/game.ts': { content: 'export const speed = 10;\n' },
      'README.md': { content: '# game\n' },
    });

    const result = await clone({ provider: 'github', owner: 'octocat', repo: 'public-game' });

    expect(result).toMatchObject({ repo: 'octocat/public-game', branch: 'main', provider: 'github' });
    expect(Object.keys(result.files).sort()).toEqual(['README.md', 'src/game.ts']);
    expect(result.head).toBeTruthy();
  });

  /**
   * The CONTROL for the anonymous path. Same repository, same code, one difference — it is private —
   * and the outcome must flip. Without this the test above passes even if the fallback secretly
   * required a token, because the fake would happily serve either.
   */
  it('refuses that same repo, once private, with a CONNECT prompt rather than a credential prompt', async () => {
    seed('octocat/private-game', { 'src/game.ts': { content: 'secret sauce\n' } });
    world.privateRepos.add('octocat/private-game');

    const error = await clone({ provider: 'github', owner: 'octocat', repo: 'private-game' }).catch((e) => e);

    expect(error).toBeInstanceOf(GitProviderError);
    expect(error).toMatchObject({ kind: 'auth', status: 401 });
    expect(error.message).toMatch(/connect github/i);

    // Never a username/PAT prompt — the credential the user already granted is the only one we use.
    expect(error.message).not.toMatch(/token|password|username/i);
  });

  it('clones a PRIVATE repo for a connected user', async () => {
    seed('octocat/private-game', { 'src/game.ts': { content: 'secret sauce\n' } });
    world.privateRepos.add('octocat/private-game');
    setGitTokenStore(connected('github'));

    const result = await clone({ provider: 'github', owner: 'octocat', repo: 'private-game' });

    expect(Object.keys(result.files)).toEqual(['src/game.ts']);
  });

  /**
   * A CONNECTED user asking for a repository that is not there gets the truth — "not found" — not a
   * connect prompt for an account they already connected.
   */
  it('reports not-found for a connected user, never a connect prompt', async () => {
    setGitTokenStore(connected('github'));

    const error = await clone({ provider: 'github', owner: 'octocat', repo: 'nope' }).catch((e) => e);

    expect(error).toMatchObject({ kind: 'not-found' });
    expect(error.message).toContain('octocat/nope');
  });

  it('resolves the default branch by ASKING, never by guessing "main"', async () => {
    seed('octocat/trunk-is-develop', { 'src/game.ts': { content: 'x\n' } }, 'develop');

    const result = await clone({ provider: 'github', owner: 'octocat', repo: 'trunk-is-develop' });

    expect(result.branch).toBe('develop');
  });

  /**
   * `fetchTree` → `null` means the BRANCH HAS NO COMMITS. It is a distinct, loud failure: `fetchTree`
   * THROWS when it could not ask, so collapsing the two would report an empty repository as a platform
   * outage, or an outage as an empty repository.
   */
  it('treats an empty branch as its own loud failure, not as "could not ask"', async () => {
    world.store.addRepo('octocat/empty', 'main');

    const error = await clone({ provider: 'github', owner: 'octocat', repo: 'empty' }).catch((e) => e);

    expect(error).toMatchObject({ kind: 'not-found' });
    expect(error.message).toMatch(/no commits to import/i);
  });

  it('does not turn a provider OUTAGE into "that repository is private"', async () => {
    seed('octocat/public-game', { 'src/game.ts': { content: 'x\n' } });
    world.github.failWith({ match: '/git/trees/', status: 503 });

    const error = await clone({ provider: 'github', owner: 'octocat', repo: 'public-game' }).catch((e) => e);

    expect(error).toMatchObject({ kind: 'unavailable', retryable: true });
  });

  /**
   * ⚠️ The ORDER is the assertion, and `toHaveBeenCalledWith` alone cannot see it.
   *
   * The first draft of this test asserted only that `assertPublicUrl` was called with the origin — and
   * it passed with the call MOVED to after `fetchTree`, i.e. with the guard running once the request it
   * guards had already gone out. A test whose input cannot reach the rule it names is not a weak test,
   * it is no test (`build-failure.ts`'s vacuous-assertion lesson). So the guard is pinned by observing,
   * from inside the spy, that nothing has been fetched yet.
   */
  it('checks the API ORIGIN before it fetches anything', async () => {
    seed('octocat/public-game', { 'src/game.ts': { content: 'x\n' } });

    let requestsAtCheck = -1;
    assertPublicUrl.mockImplementation(async (url: string) => {
      requestsAtCheck = world.github.requests.length;
      return url;
    });

    await clone({ provider: 'github', owner: 'octocat', repo: 'public-game' });

    expect(assertPublicUrl).toHaveBeenCalledWith('https://api.github.com');

    // Zero requests had been sent when the origin was checked — and the clone really did fetch after.
    expect(requestsAtCheck).toBe(0);
    expect(world.github.requests.length).toBeGreaterThan(0);
  });

  it('never carries a .env into the imported project, and says which files it dropped', async () => {
    seed('octocat/has-secrets', {
      'src/game.ts': { content: 'export const x = 1;\n' },
      '.env': { content: 'STRIPE_SECRET=sk_live_do_not_import_me\n' },
      '.env.production': { content: 'DB_URL=postgres://prod\n' },
      '.env.example': { content: 'STRIPE_SECRET=\n' },
    });

    const result = await clone({ provider: 'github', owner: 'octocat', repo: 'has-secrets' });

    expect(Object.keys(result.files).sort()).toEqual(['.env.example', 'src/game.ts']);
    expect(result.skippedSecrets.sort()).toEqual(['.env', '.env.production']);

    // Belt and braces: the secret VALUE must not be anywhere in what we hand back.
    expect(JSON.stringify(result)).not.toContain('sk_live_do_not_import_me');
  });

  /**
   * LFS is out of scope, and the point is that it fails INFORMATIVELY: the tree hands us 130-byte
   * pointer text in place of every large asset, so importing it silently produces a project that
   * looks complete, mounts cleanly, and cannot run.
   */
  it('reports Git-LFS rather than importing a project of placeholder text', async () => {
    seed('octocat/lfs-game', {
      'src/game.ts': { content: 'export const x = 1;\n' },
      'assets/car.glb': { content: 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 90000000\n' },
    });

    const error = await clone({ provider: 'github', owner: 'octocat', repo: 'lfs-game' }).catch((e) => e);

    expect(error.name).toBe('LfsPointerError');
    expect(error.statusCode).toBe(422);
    expect(error.message).toContain('assets/car.glb');
    expect(error.message).toMatch(/git-lfs/i);
  });

  /** Binaries cross byte-identically — an import is the same read the repo-primary mount uses. */
  it('imports binary files losslessly', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x7f]);

    seed('octocat/binary-game', {
      'public/logo.png': { content: bytesToBase64(bytes), base64: true },
    });

    const result = await clone({ provider: 'github', owner: 'octocat', repo: 'binary-game' });
    const dirent = result.files['public/logo.png'];

    expect(dirent).toMatchObject({ type: 'file', isBinary: true });
    expect(Buffer.from((dirent as { content: string }).content, 'base64').equals(Buffer.from(bytes))).toBe(true);
  });

  describe('the size cap — refused BEFORE the bytes are handed back', () => {
    const CONTENT = 'a'.repeat(1000);
    const MORE = 'b'.repeat(24);
    const TOTAL = 1024;

    const limitOf = (bytes: number) => ctx({ GIT_CLONE_MAX_MB: String(bytes / (1024 * 1024)) });

    beforeEach(() => {
      seed('octocat/big-game', { 'a.txt': { content: CONTENT }, 'b.txt': { content: MORE } });
    });

    /** The control: exactly AT the limit is fine. Without it, a cap of zero would pass the test below. */
    it('allows a repo that is exactly at the limit', async () => {
      const result = await clone({ provider: 'github', owner: 'octocat', repo: 'big-game' }, limitOf(TOTAL));

      expect(Object.keys(result.files).sort()).toEqual(['a.txt', 'b.txt']);
    });

    it('refuses one byte over, naming the size, the limit and the env var that moves it', async () => {
      const error = await clone({ provider: 'github', owner: 'octocat', repo: 'big-game' }, limitOf(TOTAL - 1)).catch(
        (e) => e,
      );

      expect(error.name).toBe('CloneTooLargeError');
      expect(error.statusCode).toBe(413);
      expect(error.message).toContain('GIT_CLONE_MAX_MB');
      expect(error.message).toMatch(/MB/);
    });
  });

  describe('GitLab', () => {
    const GITLAB_CTX = ctx({ GITLAB_OAUTH_CLIENT_ID: 'id', GITLAB_OAUTH_CLIENT_SECRET: 'secret' });

    /**
     * 🔴 The one that found a real bug. `_request` was fixed to omit the header entirely when there is
     * no token, but `_listTree` builds its own request and always sent `Bearer ` — so an anonymous
     * clone got as far as reading the branch head and then 401-ed on the tree, and the user was shown
     * a connect prompt for a PUBLIC repository. Two doors, one rule.
     */
    it('clones a public project anonymously — no empty bearer on ANY request', async () => {
      seed('group/subgroup/public-proj', {
        'src/game.ts': { content: 'export const speed = 10;\n' },
        'README.md': { content: '# hi\n' },
      });

      const result = await clone({ provider: 'gitlab', owner: 'group/subgroup', repo: 'public-proj' }, GITLAB_CTX);

      expect(result).toMatchObject({ provider: 'gitlab', repo: 'group/subgroup/public-proj', branch: 'main' });
      expect(Object.keys(result.files).sort()).toEqual(['README.md', 'src/game.ts']);
    });

    it('sends a connect prompt for a project an anonymous read cannot see', async () => {
      seed('group/private-proj', { 'src/game.ts': { content: 'x\n' } });
      world.privateRepos.add('group/private-proj');

      const error = await clone({ provider: 'gitlab', owner: 'group', repo: 'private-proj' }, GITLAB_CTX).catch(
        (e) => e,
      );

      expect(error).toMatchObject({ kind: 'auth', status: 401 });
      expect(error.message).toMatch(/connect gitlab/i);
    });
  });
});

/**
 * The route (`POST /api/projects/:id/github { op: 'clone' }`).
 *
 * Clone lives as an OP on the project's git route rather than on a route of its own, and that is a
 * security property: by the time it runs the project exists, so BOTH walls apply (verified user AND
 * owned project) instead of the single `requireVerifiedUser` a standalone route would have carried. It
 * also inherits this file's `providerErrorResponse` mapper — without which a `GitProviderError` would
 * flatten to a generic 500 and the client would lose the `reconnect` signal that drives the prompt.
 */
describe('the clone op on the project git route', () => {
  let tmp: string;
  let project: Project;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'git-clone-route-'));

    const projects = new FsProjectStore(tmp);
    project = await projects.create({ userId: USER.id, name: 'Imported game', templateId: 'blank' });
    setProjectStore(projects);

    /*
     * ⚠️ The default limiter store is a MODULE SINGLETON, so without this every clone in this describe
     * shares one 10-per-hour budget and the suite starts failing on whichever test happens to be
     * eleventh — a green file that goes red when someone adds a case, blaming the case.
     */
    setUserRateLimitStore(new MemoryUserRateLimitStore());
  });

  afterEach(async () => {
    setProjectStore(undefined);
    setUserRateLimitStore(undefined);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function post(body: Record<string, unknown>, context: unknown = ctx()) {
    const { action } = await import('~/routes/api.projects.$projectId.github');

    const response = (await action({
      request: new Request('https://app.example.com/api/projects/p/github', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      params: { projectId: project.id },
      context,
    } as never)) as Response;

    return { response, payload: (await response.json()) as Record<string, unknown> };
  }

  it('clones a public repo for an unconnected user', async () => {
    seed('octocat/public-game', { 'src/game.ts': { content: 'export const x = 1;\n' } });

    const { response, payload } = await post({ op: 'clone', repo: 'https://github.com/octocat/public-game' });

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, repo: 'octocat/public-game', branch: 'main', provider: 'github' });
    expect(Object.keys(payload.files as object)).toEqual(['src/game.ts']);
  });

  /** The signal the client needs: 401 + `reconnect` is what raises the connect prompt (never a 500). */
  it('returns 401 { reconnect: true, kind: auth } when an anonymous read cannot see it', async () => {
    seed('octocat/private-game', { 'src/game.ts': { content: 'x\n' } });
    world.privateRepos.add('octocat/private-game');

    const { response, payload } = await post({ op: 'clone', repo: 'octocat/private-game' });

    expect(response.status).toBe(401);
    expect(payload).toMatchObject({ reconnect: true, kind: 'auth' });
    expect(payload.message).toMatch(/connect github/i);
  });

  it('honours an explicit branch over the default', async () => {
    world.store.addRepo('octocat/multi', 'main');
    world.store.seedBranch('main', { 'a.txt': { content: 'trunk\n' } });
    world.store.seedBranch('feature', { 'b.txt': { content: 'branch\n' } });

    const { payload } = await post({ op: 'clone', repo: 'octocat/multi', branch: 'feature' });

    expect(payload).toMatchObject({ ok: true, branch: 'feature' });
    expect(Object.keys(payload.files as object)).toEqual(['b.txt']);
  });

  it('refuses an unsupported host by NAME, and fetches nothing', async () => {
    const { response, payload } = await post({ op: 'clone', repo: 'https://bitbucket.org/owner/repo' });

    expect(response.status).toBe(400);
    expect(payload.message).toContain('bitbucket.org');
    expect(payload.message).toMatch(/only github and gitlab/i);

    // The refusal happens before anything reaches the network — not even the origin check runs.
    expect(assertPublicUrl).not.toHaveBeenCalled();
    expect(world.github.requests).toHaveLength(0);
  });

  it('refuses an empty repo field rather than guessing', async () => {
    const { response, payload } = await post({ op: 'clone' });

    expect(response.status).toBe(400);
    expect(payload.message).toMatch(/repository/i);
  });

  it('refuses an oversize repo with a message naming the limit and its env var', async () => {
    seed('octocat/big-game', { 'a.txt': { content: 'a'.repeat(4096) } });

    const { response, payload } = await post(
      { op: 'clone', repo: 'octocat/big-game' },
      ctx({ GIT_CLONE_MAX_MB: String(1024 / (1024 * 1024)) }),
    );

    expect(response.status).toBe(413);
    expect(payload.message).toContain('GIT_CLONE_MAX_MB');
    expect(payload.message).toMatch(/import limit/i);
  });

  it('reports Git-LFS as its own refusal', async () => {
    seed('octocat/lfs-game', {
      'assets/car.glb': { content: 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 900\n' },
    });

    const { response, payload } = await post({ op: 'clone', repo: 'octocat/lfs-game' });

    expect(response.status).toBe(422);
    expect(payload.message).toContain('assets/car.glb');
  });

  it('never hands a .env back to the browser', async () => {
    seed('octocat/has-secrets', {
      'src/game.ts': { content: 'export const x = 1;\n' },
      '.env': { content: 'STRIPE_SECRET=sk_live_leak\n' },
    });

    const { payload } = await post({ op: 'clone', repo: 'octocat/has-secrets' });

    expect(Object.keys(payload.files as object)).toEqual(['src/game.ts']);
    expect(payload.skippedSecrets).toEqual(['.env']);
    expect(JSON.stringify(payload)).not.toContain('sk_live_leak');
  });

  /**
   * Clone runs BEFORE the linked-repo check — an import is precisely what a project with no repo does,
   * and the repo being cloned is deliberately not the project's own link (there is not one yet).
   */
  it('works on an UNLINKED project, and writes no link of its own', async () => {
    seed('octocat/public-game', { 'src/game.ts': { content: 'x\n' } });

    const { response } = await post({ op: 'clone', repo: 'octocat/public-game' });
    const stored = await new FsProjectStore(tmp).get(project.id);

    expect(response.status).toBe(200);
    expect(stored?.linkedRepo).toBeUndefined();
  });

  /**
   * 🔴 PER-USER RATE LIMITING (§5, §10 item 20) — and the ORDERING is the whole point.
   *
   * One clone pulls up to `GIT_CLONE_MAX_MB` of somebody else's repository through our egress, so the
   * limit has to be counted BEFORE the provider is touched. A limiter that refuses after the fetch is
   * not a limiter, it is a 429 attached to a bill we have already paid — and nothing about the response
   * would reveal the difference, which is why it is asserted observably (zero requests reached the
   * fake, and the origin check never ran) rather than by reading the handler.
   */
  describe('the per-user rate limit', () => {
    /** A store already at its ceiling, so the route's very first call is the refused one. */
    const exhausted: UserRateLimitStore = {
      hit: async (_key, _rule, now) => ({ allowed: false, remaining: 0, resetAt: now + 15 * 60 * 1000 }),
    };

    it('refuses with 429 and reaches the provider ZERO times', async () => {
      seed('octocat/public-game', { 'src/game.ts': { content: 'x\n' } });
      setUserRateLimitStore(exhausted);

      const { response, payload } = await post({ op: 'clone', repo: 'octocat/public-game' });

      expect(response.status).toBe(429);
      expect(payload.message).toMatch(/try again in about/i);
      expect(payload.isRetryable).toBe(true);

      // The assertions that make this about ORDER: no egress was spent on the refusal.
      expect(world.github.requests).toHaveLength(0);
      expect(assertPublicUrl).not.toHaveBeenCalled();
    });

    /**
     * The CONTROL. Same repository, same route, one difference — the budget — and the outcome flips.
     * Without it the test above passes for a route that refuses everything, or fetches nothing ever.
     */
    it('serves the same clone when the budget is not spent', async () => {
      seed('octocat/public-game', { 'src/game.ts': { content: 'x\n' } });

      const { response } = await post({ op: 'clone', repo: 'octocat/public-game' });

      expect(response.status).toBe(200);
      expect(world.github.requests.length).toBeGreaterThan(0);
    });

    /**
     * Counted before `parseCloneTarget`, not merely before the fetch: a caller hammering the route with
     * malformed input is exactly the traffic worth bounding, and a limit that only counts well-formed
     * requests is one an attacker opts out of by sending rubbish.
     */
    it('refuses before it even parses the target', async () => {
      setUserRateLimitStore(exhausted);

      const { response, payload } = await post({ op: 'clone', repo: 'https://bitbucket.org/owner/repo' });

      expect(response.status).toBe(429);
      expect(payload.message).not.toContain('bitbucket.org');
    });

    /** The real budget, driven end to end through the route: ten land, the eleventh does not. */
    it('lets a user import CLONE_RATE_LIMIT.max repos an hour and no more', async () => {
      seed('octocat/public-game', { 'src/game.ts': { content: 'x\n' } });

      for (let i = 0; i < CLONE_RATE_LIMIT.max; i++) {
        expect((await post({ op: 'clone', repo: 'octocat/public-game' })).response.status).toBe(200);
      }

      expect((await post({ op: 'clone', repo: 'octocat/public-game' })).response.status).toBe(429);
    });

    /** Other ops on this route are not clones and must not be charged against the import budget. */
    it('does not count a link against the clone budget', async () => {
      setUserRateLimitStore(exhausted);

      const { response } = await post({ op: 'link', repo: 'octocat/public-game', branch: 'main' });

      expect(response.status).toBe(200);
    });
  });
});

/**
 * 🔴 PULL IS AN INGEST PATH TOO — and it was the unguarded half of the pair (found 2026-08-19).
 *
 * `cloneRepository` refuses an oversize tree and refuses Git-LFS; the route's `pull` did neither. It
 * read the branch and handed the whole thing back:
 *
 *     const pulled = await input.provider.fetchTree(input.ref);
 *     return json({ ok: true, files: pulled.files, head: pulled.head });
 *
 * So the guards were trivially walked around by the ordinary workflow they were written for: save a
 * small project to GitHub, add gigabytes of glTF to the repo from a git client, press Sync. Two
 * failures, and the second is the quieter one:
 *
 *   - **Unbounded size.** A pull runs THROUGH the server — GitHub → this process → one JSON response
 *     → the browser — so the whole tree is held in memory and base64-serialised into a single body.
 *     That is not a per-user problem: one pull of a multi-gigabyte repository is an availability
 *     problem for everyone sharing the process. Downstream it also blows the client working-copy
 *     budget, which turns the crash-recovery copy off (§4.16, `working-copy-size.ts`).
 *   - **LFS arrives silently.** `LfsPointerError` exists because a tree hands back 130 bytes of
 *     pointer text in place of every large asset, producing a project that mounts cleanly, looks
 *     complete and cannot run. Clone bolts that door; pull left it open next to it.
 *
 * The shape is this codebase's recurring one — one half of a pair guarded, the other not, exactly as
 * `recordAgentWrite`/`#recordRestoredFiles` and `prepareMountedProject`/`mountedThisLoad` were. Clone
 * and pull do the same thing (fetch somebody's tree, hand it to the client); only the one with
 * "import" in its name was read as an ingest path.
 *
 * The guard therefore lives in ONE function called by both (`assertFetchedTreeUsable`), never a second
 * copy of the rule — the `isSecretPath` lesson — and it is placed inside the route's `pull` helper,
 * which is the single choke point BOTH `op: 'pull'` and `op: 'resolve' { choice: 'pull-overwrite' }`
 * pass through. A membership list of "the ops that pull" is the `coversWorkspace` mistake: it covers
 * the doors somebody enumerated, and the next one walks past it.
 */
describe('the pull op on the project git route', () => {
  let tmp: string;
  let project: Project;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'git-pull-route-'));

    const projects = new FsProjectStore(tmp);
    project = await projects.create({ userId: USER.id, name: 'Linked game', templateId: 'blank' });

    // A pull needs a complete link tuple (§4.5.4b) — provider, repo and branch move together.
    await projects.update(project.id, {
      provider: 'github',
      linkedRepo: 'octocat/linked-game',
      linkedBranch: 'main',
      lastSyncedCommitSha: 'sha-from-the-last-time-we-agreed',
    });

    setProjectStore(projects);
    setUserRateLimitStore(new MemoryUserRateLimitStore());

    // Pull resolves a provider from a stored token — it is never an anonymous path.
    setGitTokenStore(connected('github'));
  });

  afterEach(async () => {
    setProjectStore(undefined);
    setUserRateLimitStore(undefined);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function post(body: Record<string, unknown>, context: unknown = ctx()) {
    const { action } = await import('~/routes/api.projects.$projectId.github');

    const response = (await action({
      request: new Request('https://app.example.com/api/projects/p/github', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      params: { projectId: project.id },
      context,
    } as never)) as Response;

    return { response, payload: (await response.json()) as Record<string, unknown> };
  }

  const storedProject = () => new FsProjectStore(tmp).get(project.id);

  /**
   * The CONTROL, first. Without it every assertion below passes for a pull that refuses everything —
   * which is the cheerful way a "stop letting big things in" fix goes green while breaking Sync.
   */
  it('pulls an ordinary repository and advances the sync pointer', async () => {
    seed('octocat/linked-game', { 'src/game.ts': { content: 'export const x = 1;\n' } });

    const { response, payload } = await post({ op: 'pull' });

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(Object.keys(payload.files as object)).toEqual(['src/game.ts']);
    expect((await storedProject())?.lastSyncedCommitSha).not.toBe('sha-from-the-last-time-we-agreed');
  });

  it('refuses an oversize pull with a message naming the limit and its env var', async () => {
    seed('octocat/linked-game', { 'assets/level.glb': { content: 'a'.repeat(4096) } });

    const { response, payload } = await post({ op: 'pull' }, ctx({ GIT_CLONE_MAX_MB: String(1024 / (1024 * 1024)) }));

    expect(response.status).toBe(413);
    expect(payload.message).toContain('GIT_CLONE_MAX_MB');
    expect(payload.message).toMatch(/sync limit/i);
  });

  it('reports Git-LFS on a pull rather than filling the project with placeholder text', async () => {
    seed('octocat/linked-game', {
      'assets/car.glb': { content: 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 900\n' },
    });

    const { response, payload } = await post({ op: 'pull' });

    expect(response.status).toBe(422);
    expect(payload.message).toContain('assets/car.glb');
  });

  /**
   * 🔴 The guard runs BEFORE `lastSyncedCommitSha` moves, and that ordering is load-bearing.
   *
   * That column is the platform's record of what the repository looked like when we last AGREED with
   * it, and it is what the next push's fast-forward check is measured against. Advancing it for a tree
   * we refused would claim agreement with bytes the user never received — so the following push would
   * measure against a commit this project has never held and fast-forward straight over it.
   */
  it('leaves the sync pointer untouched when it refuses', async () => {
    seed('octocat/linked-game', { 'assets/level.glb': { content: 'a'.repeat(4096) } });

    await post({ op: 'pull' }, ctx({ GIT_CLONE_MAX_MB: String(1024 / (1024 * 1024)) }));

    expect((await storedProject())?.lastSyncedCommitSha).toBe('sha-from-the-last-time-we-agreed');
  });

  /**
   * `pull-overwrite` is the divergence dialog's "use the version from my repository" button, and it
   * reads the tree through the same helper. It is asserted separately because it is a SECOND door on
   * the same rule, and the whole defect being fixed here was a door nobody counted.
   */
  it('applies the same refusal to the pull-overwrite divergence choice', async () => {
    seed('octocat/linked-game', {
      'assets/car.glb': { content: 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 900\n' },
    });

    const { response, payload } = await post({ op: 'resolve', choice: 'pull-overwrite' });

    expect(response.status).toBe(422);
    expect(payload.message).toContain('assets/car.glb');
  });
});

/**
 * The history page size — CLAMPED, never validated (`clampHistoryLimit`).
 *
 * It arrives in a browser body, so both wrong answers are silent and they point in opposite
 * directions: an absurd number is an unbounded read on our egress, and a REFUSAL is an error card
 * where the user asked for a list of their own commits. `parseUserEffort`'s rule — resolve down,
 * never invent something more expensive — plus a floor, because `Number(undefined)` and an empty
 * form field both produce values that would otherwise mean "ask the provider for no rows at all"
 * and render an empty history for a repository full of commits.
 *
 * Driven as a pure function AND observably at the wire below (`per_page`), because a clamp that is
 * computed and then not passed to the provider is exactly as unbounded as no clamp at all.
 */
describe('clampHistoryLimit', () => {
  const clamp = async (raw: unknown) =>
    (await import('~/routes/api.projects.$projectId.github')).clampHistoryLimit(raw);

  it.each([
    ['undefined — no field at all', undefined, 20],
    ['null', null, 20],
    ['zero, which is what an empty field produces', 0, 20],
    ['a negative number', -5, 20],
    ['a non-number', 'banana', 20],
    ['NaN itself', Number.NaN, 20],

    /*
     * Infinity is not finite, so it takes the DEFAULT rather than the maximum — which is the safe
     * direction (a bounded page, not the largest one we permit) and is worth pinning because the
     * obvious reading of the code says 100.
     */
    ['Infinity', Number.POSITIVE_INFINITY, 20],
    ['one', 1, 1],
    ['the maximum', 100, 100],
    ['well past the maximum', 1000, 100],
    ['a numeric string, as JSON bodies carry', '50', 50],
    ['a fraction, floored rather than passed on', 20.7, 20],
  ])('clamps %s', async (_label, raw, expected) => {
    expect(await clamp(raw)).toBe(expected);
  });
});

/**
 * 🔴 THE THREE READ OPS (§4.13a) — and the one whose whole point is what it does NOT write.
 *
 * `branches`, `commits` and `tree` all sit AFTER the linked-repo gate, so no caller-supplied
 * coordinate reaches a provider: they can only ever read the project's own repository. That is the
 * rule whose absence made the inherited `git-proxy` an open forwarder, and it is why these ops need
 * no `parseCloneTarget` and no SSRF wall of their own.
 *
 * What they DO need is the separation `readBranchTree` exists for. `pull()` reads a tree and stamps
 * `lastSyncedCommitSha` — "this project has agreed with that commit" — and the next push's
 * fast-forward check is measured against it. `tree` is the Review-changes read: looking at a branch
 * is not agreeing with it. The cheap way to build this op (call `pull()`, it already reads a tree)
 * would move that pointer for a branch the user merely glanced at, and the next push would then
 * measure against a commit this project has never held and fast-forward straight over the work in
 * the repository. Nothing throws. The user loses commits.
 *
 * So the pointer assertion below is the load-bearing one in this block, and it is written as the
 * sibling of the pull block's "leaves the sync pointer untouched when it refuses" — same fact, one
 * about a refusal and one about a SUCCESS, which is the harder half to remember.
 */
describe('the branch read ops on the project git route', () => {
  let tmp: string;
  let project: Project;

  const AGREED = 'sha-from-the-last-time-we-agreed';

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'git-read-route-'));

    const projects = new FsProjectStore(tmp);
    project = await projects.create({ userId: USER.id, name: 'Linked game', templateId: 'blank' });

    await projects.update(project.id, {
      provider: 'github',
      linkedRepo: 'octocat/linked-game',
      linkedBranch: 'main',
      lastSyncedCommitSha: AGREED,
    });

    setProjectStore(projects);
    setUserRateLimitStore(new MemoryUserRateLimitStore());
    setGitTokenStore(connected('github'));
  });

  afterEach(async () => {
    setProjectStore(undefined);
    setUserRateLimitStore(undefined);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function post(body: Record<string, unknown>, context: unknown = ctx()) {
    const { action } = await import('~/routes/api.projects.$projectId.github');

    const response = (await action({
      request: new Request('https://app.example.com/api/projects/p/github', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      params: { projectId: project.id },
      context,
    } as never)) as Response;

    return { response, payload: (await response.json()) as Record<string, unknown> };
  }

  const storedProject = () => new FsProjectStore(tmp).get(project.id);

  /** A real parent chain, which `seedBranch` does not build — every seed commit is a root commit. */
  function seedHistory(fullName: string, count: number, branch = 'main') {
    world.store.addRepo(fullName, branch);

    let parent: string | undefined;

    for (let i = 0; i < count; i++) {
      const treeSha = world.store.putTree([{ path: 'a.txt', sha: world.store.putBlobUtf8(`v${i}\n`) }]);
      parent = world.store.putCommit(treeSha, parent ? [parent] : [], `commit ${i}`);
    }

    world.store.branches.set(branch, parent!);

    return parent!;
  }

  /** What the provider was actually asked for — a clamp not passed on is not a clamp. */
  const lastCommitsRequest = () =>
    [...world.github.requests].reverse().find((entry) => entry.path.endsWith('/commits'))?.body as
      | { per_page?: number; sha?: string; page?: number }
      | undefined;

  describe('branches', () => {
    it('lists every branch with its head, its default flag and its protection', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'x\n' } });
      world.store.seedBranch('feature', { 'src/game.ts': { content: 'y\n' } });
      world.store.protectedBranches.add('main');

      const { response, payload } = await post({ op: 'branches' });
      const branches = payload.branches as Array<Record<string, unknown>>;

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(branches.map((b) => b.name).sort()).toEqual(['feature', 'main']);
      expect(branches.find((b) => b.name === 'main')).toMatchObject({
        head: world.store.branches.get('main'),
        isDefault: true,
        protected: true,
      });
      expect(branches.find((b) => b.name === 'feature')).toMatchObject({ isDefault: false, protected: false });
    });

    /**
     * 🔴 AN EMPTY REPOSITORY IS AN ORDINARY STATE, NOT A FAILURE.
     *
     * Real GitHub answers **409 "Git Repository is empty"** to every ref read on a repo with no
     * commits — and Save creates exactly such a repository moments before this is first called. A
     * branch picker that shows an error card on a freshly-created repo reads as the button being
     * broken (`share/build-failure.ts`), so the adapter normalises it and the route hands back an
     * empty list.
     */
    it('returns an empty list for a repository with no commits, rather than an error', async () => {
      world.store.addRepo('octocat/linked-game', 'main');

      const { response, payload } = await post({ op: 'branches' });

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({ ok: true, branches: [] });
    });
  });

  describe('commits', () => {
    it('returns the linked branch history, newest first, as summaries and never contents', async () => {
      seedHistory('octocat/linked-game', 3);

      const { response, payload } = await post({ op: 'commits' });
      const commits = payload.commits as Array<Record<string, unknown>>;

      expect(response.status).toBe(200);
      expect(commits.map((c) => c.message)).toEqual(['commit 2', 'commit 1', 'commit 0']);
      expect(commits[0]).toMatchObject({ sha: expect.any(String), author: 'Fake Author', date: expect.any(String) });
      expect(Object.keys(commits[0]).sort()).toEqual(['author', 'date', 'message', 'sha']);
    });

    it('honours the requested limit, and asks the provider for exactly that many', async () => {
      seedHistory('octocat/linked-game', 5);

      const { payload } = await post({ op: 'commits', limit: 2 });

      expect((payload.commits as unknown[]).length).toBe(2);
      expect(lastCommitsRequest()?.per_page).toBe(2);
    });

    /**
     * The one that matters for egress: an absurd page size CLAMPS at the wire rather than being
     * refused. Asserted on `per_page` and not merely on the row count, because a limit computed and
     * then not passed to the provider is exactly as unbounded as no limit at all.
     */
    it('clamps an absurd limit to the maximum instead of refusing the request', async () => {
      seedHistory('octocat/linked-game', 3);

      const { response, payload } = await post({ op: 'commits', limit: 5000 });

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(lastCommitsRequest()?.per_page).toBe(100);
    });

    /** Zero is what an empty field produces — and "ask for no rows" renders a full history as empty. */
    it.each([
      ['a missing limit', undefined],
      ['zero', 0],
      ['a negative limit', -3],
      ['a non-number', 'banana'],
    ])('falls back to the default page size for %s', async (_label, limit) => {
      seedHistory('octocat/linked-game', 3);

      const { response } = await post({ op: 'commits', ...(limit === undefined ? {} : { limit }) });

      expect(response.status).toBe(200);
      expect(lastCommitsRequest()?.per_page).toBe(20);
    });

    it('pages through the history with the cursor it handed back', async () => {
      seedHistory('octocat/linked-game', 5);

      const first = await post({ op: 'commits', limit: 2 });

      expect((first.payload.commits as Array<{ message: string }>).map((c) => c.message)).toEqual([
        'commit 4',
        'commit 3',
      ]);
      expect(first.payload.nextCursor).toBe('2');

      const second = await post({ op: 'commits', limit: 2, cursor: first.payload.nextCursor as string });

      expect((second.payload.commits as Array<{ message: string }>).map((c) => c.message)).toEqual([
        'commit 2',
        'commit 1',
      ]);
    });

    it('reads the branch named in the body, and the linked branch when none is named', async () => {
      seedHistory('octocat/linked-game', 2);
      seedHistory('octocat/linked-game', 1, 'feature');

      expect((await post({ op: 'commits', branch: 'feature' })).payload.commits).toHaveLength(1);
      expect(lastCommitsRequest()?.sha).toBe('feature');

      expect((await post({ op: 'commits' })).payload.commits).toHaveLength(2);
      expect(lastCommitsRequest()?.sha).toBe('main');
    });
  });

  describe('tree — the Review-changes read', () => {
    /**
     * 🔴 THE ACCEPTANCE. Files and head come back; `lastSyncedCommitSha` does not move.
     *
     * Mutation-verified by routing this op through `pull()` — the cheap implementation anyone would
     * reach for, since it already reads a tree — which makes this test, and only this test, fail.
     */
    it('returns the branch files and head and leaves the sync pointer exactly where it was', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'export const x = 1;\n' } });

      const { response, payload } = await post({ op: 'tree' });

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({ ok: true, head: world.store.branches.get('main'), branch: 'main' });
      expect(Object.keys(payload.files as object)).toEqual(['src/game.ts']);
      expect((await storedProject())?.lastSyncedCommitSha).toBe(AGREED);
    });

    /**
     * The CONTROL for the line above. Without it that assertion passes for a project store that
     * never records anything, or a harness whose `update` silently fails — i.e. it would go green
     * for a route that stamps the pointer on every read.
     */
    it('and the pointer really can move — a pull on the same project advances it', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'export const x = 1;\n' } });

      await post({ op: 'pull' });

      expect((await storedProject())?.lastSyncedCommitSha).toBe(world.store.branches.get('main'));
    });

    it('reads the branch named in the body, not only the linked one', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'trunk\n' } });
      world.store.seedBranch('feature', { 'src/other.ts': { content: 'branch\n' } });

      const { payload } = await post({ op: 'tree', branch: 'feature' });

      expect(payload).toMatchObject({ ok: true, branch: 'feature', head: world.store.branches.get('feature') });
      expect(Object.keys(payload.files as object)).toEqual(['src/other.ts']);
      expect((await storedProject())?.lastSyncedCommitSha).toBe(AGREED);
    });

    /**
     * The guard runs INSIDE `readBranchTree`, before anything is returned — refusing a tree after
     * handing it back is not refusing it. And the refusal wears THIS door's words: a user comparing
     * a branch is not importing and not syncing, and a refusal that describes the wrong operation
     * reads as the wrong button being broken (`share/build-failure.ts`).
     */
    it('refuses an oversize branch with the review wording, naming the limit and its env var', async () => {
      seed('octocat/linked-game', { 'assets/level.glb': { content: 'a'.repeat(4096) } });

      const { response, payload } = await post({ op: 'tree' }, ctx({ GIT_CLONE_MAX_MB: String(1024 / (1024 * 1024)) }));

      expect(response.status).toBe(413);
      expect(payload.message).toContain('GIT_CLONE_MAX_MB');
      expect(payload.message).toMatch(/branch limit/i);
      expect(payload.message).toMatch(/cannot be compared with your project/i);

      // The door-specific half: the other doors' sentences must not appear on this one.
      expect(payload.message).not.toMatch(/import limit|sync limit/i);
      expect(payload.message).not.toMatch(/imported|pulled into this project/i);
    });

    it('reports Git-LFS with the review wording rather than handing back placeholder text', async () => {
      seed('octocat/linked-game', {
        'assets/car.glb': { content: 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 900\n' },
      });

      const { response, payload } = await post({ op: 'tree' });

      expect(response.status).toBe(422);
      expect(payload.message).toContain('assets/car.glb');
      expect(payload.message).toMatch(/reviewing it would replace those files with placeholder text/i);
      expect(payload.message).not.toMatch(/importing it would|pulling it would/i);
    });

    /** And a refusal moves nothing either — the pull block's rule, asserted on this door too. */
    it('leaves the sync pointer untouched when it refuses', async () => {
      seed('octocat/linked-game', { 'assets/level.glb': { content: 'a'.repeat(4096) } });

      await post({ op: 'tree' }, ctx({ GIT_CLONE_MAX_MB: String(1024 / (1024 * 1024)) }));

      expect((await storedProject())?.lastSyncedCommitSha).toBe(AGREED);
    });

    /**
     * `null` from `readBranchTree` is "that branch has no commits", and it must never be flattened
     * into an empty file map: `planRestore` refuses an empty incoming map by design ("a restore is
     * never a wipe"), so a caller handed `{}` would restore nothing and report success.
     */
    it('refuses a branch with no commits rather than returning an empty file map', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'x\n' } });

      const { response, payload } = await post({ op: 'tree', branch: 'ghost' });

      expect(response.status).toBe(409);
      expect(payload.message).toContain('ghost');
      expect(payload.message).toMatch(/no commits to compare/i);
      expect(payload.files).toBeUndefined();
    });
  });

  /**
   * 🔴 THE TREE READ IS RATE-LIMITED BEFORE THE OUTBOUND CALL, like the clone op.
   *
   * A whole-repository read is the expensive shape whatever door it arrives through — the same
   * `GIT_CLONE_MAX_MB` ceiling bounds one of these as bounds an import — so a limiter that counts
   * AFTER the fetch is not a limiter, it is a 429 attached to a bill we have already paid. Nothing
   * in the response reveals the difference, which is why it is asserted observably: zero requests
   * reached the fake provider.
   */
  describe('the per-user tree-read rate limit', () => {
    const exhausted: UserRateLimitStore = {
      hit: async (_key, _rule, now) => ({ allowed: false, remaining: 0, resetAt: now + 15 * 60 * 1000 }),
    };

    it('refuses with 429 naming BRANCH READS, and reaches the provider ZERO times', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'x\n' } });
      setUserRateLimitStore(exhausted);

      const before = world.github.requests.length;
      const { response, payload } = await post({ op: 'tree' });

      expect(response.status).toBe(429);
      expect(payload.isRetryable).toBe(true);

      /*
       * The subject is threaded through rather than defaulted: `RateLimitedError`'s default names
       * "repository imports", and telling someone who pressed Review changes that they have made too
       * many imports sends them to look for a problem that does not exist.
       */
      expect(payload.message).toMatch(/too many branch reads/i);
      expect(payload.message).not.toMatch(/repository imports/i);

      expect(world.github.requests.length).toBe(before);
    });

    /** The CONTROL: same project, same op, one difference — the budget — and the outcome flips. */
    it('serves the same read when the budget is not spent', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'x\n' } });

      const { response } = await post({ op: 'tree' });

      expect(response.status).toBe(200);
      expect(world.github.requests.length).toBeGreaterThan(0);
    });

    it('lets a user read TREE_READ_RATE_LIMIT.max branches an hour and no more', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'x\n' } });

      for (let i = 0; i < TREE_READ_RATE_LIMIT.max; i++) {
        expect((await post({ op: 'tree' })).response.status).toBe(200);
      }

      expect((await post({ op: 'tree' })).response.status).toBe(429);
    });

    /**
     * Its OWN bucket. Sharing the clone budget would let a handful of branch reads spend a user's
     * whole import allowance — and the two are deliberately different numbers for a stated reason
     * (an import names an arbitrary repository; a tree read can only re-read this project's own).
     */
    it('counts against the branch-read bucket, never the clone budget', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'x\n' } });

      const seen: string[] = [];
      const memory = new MemoryUserRateLimitStore();

      setUserRateLimitStore({
        hit: async (key, rule, now) => {
          seen.push(key);
          return memory.hit(key, rule, now);
        },
      });

      await post({ op: 'tree' });

      expect(seen).toContain(`git-tree-read:${USER.id}`);
      expect(seen.some((key) => key.startsWith('git-clone:'))).toBe(false);
    });

    /** The read ops that are one small API call are NOT charged against the whole-tree budget. */
    it.each([['branches'], ['commits']])('does not spend the tree-read budget on %s', async (op) => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'x\n' } });
      setUserRateLimitStore(exhausted);

      expect((await post({ op })).response.status).toBe(200);
    });
  });
});

/**
 * 🔴 THE TWO BRANCH WRITE OPS (§4.13, T6) — and the tuple defect on the divergence escape hatch.
 *
 * These are the only ops in this route that create or destroy a ref in somebody else's account, and
 * every failure mode below is silent:
 *
 *   - **A create must touch NO file.** That is the entire feature: the user's in-progress work
 *     carries onto the new branch exactly as it is. A create that also wrote a tree would discard
 *     whatever they were in the middle of, and the response would still say `ok`. Asserted
 *     observably — zero blob/tree/commit writes reached the provider — because nothing in the
 *     payload distinguishes the two.
 *   - **A create must write BOTH tuple fields** (§4.5.4b, migration 0006). `linkedBranch` without
 *     `lastSyncedCommitSha` leaves the project claiming agreement with a commit on a DIFFERENT
 *     branch, so the next push measures its fast-forward against a commit this branch never held.
 *   - **A collision never suffixes and never adopts.** `ensureRepo`'s rule: a name the user did not
 *     choose is a surprise, and adopting somebody else's branch is destructive. So the existing ref
 *     is asserted UNMOVED, not merely "an error came back".
 *   - **The two delete refusals are different sentences**, compared to each other, because the
 *     recoveries differ and a single generic refusal passes every `status === 409` assertion.
 *
 * And the defect this task fixes: `resolve { choice: 'push-to-new-branch' }` returned the new branch
 * name and updated NOTHING, so the project stayed pointed at the branch it had just been forced off,
 * still carrying the stale sha that caused the divergence — every later push diverging against the
 * same commit, with the user's work on a branch the project did not know about.
 */
describe('the branch write ops on the project git route', () => {
  let tmp: string;
  let project: Project;

  const AGREED = 'sha-from-the-last-time-we-agreed';

  /** Written by the caller of `link()`; each test decides its own starting tuple. */
  async function link(fields: Partial<Project>) {
    await new FsProjectStore(tmp).update(project.id, fields);
  }

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'git-branch-route-'));

    const projects = new FsProjectStore(tmp);
    project = await projects.create({ userId: USER.id, name: 'Linked game', templateId: 'blank' });

    await projects.update(project.id, {
      provider: 'github',
      linkedRepo: 'octocat/linked-game',
      linkedBranch: 'main',
    });

    setProjectStore(projects);
    setUserRateLimitStore(new MemoryUserRateLimitStore());
    setGitTokenStore(connected('github'));
  });

  afterEach(async () => {
    setProjectStore(undefined);
    setUserRateLimitStore(undefined);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /**
   * `projectId` defaults to the project every test here links, and is overridable for the one case
   * that needs TWO projects looking at the same repository — see the distinct-sentences test, where
   * driving both refusals with the same branch NAME is the only thing that makes them comparable.
   */
  async function post(body: Record<string, unknown>, options: { projectId?: string; context?: unknown } = {}) {
    const { action } = await import('~/routes/api.projects.$projectId.github');

    const response = (await action({
      request: new Request('https://app.example.com/api/projects/p/github', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      params: { projectId: options.projectId ?? project.id },
      context: options.context ?? ctx(),
    } as never)) as Response;

    return { response, payload: (await response.json()) as Record<string, unknown> };
  }

  const storedProject = () => new FsProjectStore(tmp).get(project.id);

  /**
   * Every request that WRITES content — blobs, trees, commits, and the ref moves that publish them.
   *
   * `createRef` is deliberately absent: creating a branch IS a `POST /git/refs`, so counting it here
   * would make the "no file operation" assertion unsatisfiable by any correct implementation. What
   * must be zero is the tree-building machinery, which is what a create-that-also-pushed would use.
   */
  const contentWrites = () =>
    world.github.requests.filter(
      (entry) =>
        (entry.method === 'POST' && /\/git\/(blobs|trees|commits)$/.test(entry.path)) ||
        (entry.method === 'PATCH' && entry.path.startsWith('/git/refs/')),
    );

  describe('create-branch', () => {
    /**
     * 🔴 THE ACCEPTANCE: both tuple fields, one call — and the sha is the one we branched FROM.
     *
     * The head assertion is what makes this more than "a row changed": a create that stamped the
     * live head of the *default* branch, or left the previous value in place, would satisfy a bare
     * "linkedBranch moved" check while pointing the fast-forward measurement at the wrong commit.
     */
    it('creates the branch, repoints the project, and records the sha it branched from', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'export const x = 1;\n' } });

      const head = world.store.branches.get('main');
      await link({ lastSyncedCommitSha: head });

      const { response, payload } = await post({ op: 'create-branch', name: 'feature/hud' });

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({ ok: true, branch: 'feature/hud', head });

      // The ref really exists on the provider, at the commit we said we branched from.
      expect(world.store.branches.get('feature/hud')).toBe(head);

      const stored = await storedProject();
      expect(stored?.linkedBranch).toBe('feature/hud');
      expect(stored?.lastSyncedCommitSha).toBe(head);
    });

    /**
     * 🔴 NO FILE IS TOUCHED — requirement 34, asserted observably.
     *
     * The user's in-progress work carries onto the new branch untouched, which is the whole point of
     * the feature. A create implemented as "push the current tree to a new branch" would look
     * identical in the response and would silently publish whatever the browser last sent.
     */
    it('performs NO file operation — no blob, tree or commit write reaches the provider', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'export const x = 1;\n' } });
      await link({ lastSyncedCommitSha: world.store.branches.get('main') });

      const before = contentWrites().length;

      expect((await post({ op: 'create-branch', name: 'feature/hud' })).response.status).toBe(200);
      expect(contentWrites().length).toBe(before);

      // And the branch it came from is byte-for-byte where it was.
      expect([...world.store.filesAt('main').keys()]).toEqual(['src/game.ts']);
    });

    /**
     * The CONTROL for the line above. Without it "no content writes happened" passes for a harness
     * whose filter matches nothing — i.e. it would go green for a create that pushed the whole tree.
     */
    it('and content writes really are observable — a push on the same project makes some', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'export const x = 1;\n' } });
      await link({ lastSyncedCommitSha: world.store.branches.get('main') });

      const before = contentWrites().length;

      await post({
        op: 'push',
        files: { 'src/game.ts': { type: 'file', content: 'export const x = 2;\n', isBinary: false } },
      });

      expect(contentWrites().length).toBeGreaterThan(before);
    });

    /**
     * You branch off WHAT YOU ARE LOOKING AT (requirement 33). With nothing synced the base is the
     * live head of the branch the project is ON — never the repository default, which would silently
     * discard the branch point the user can see on screen.
     */
    it('branches from the live head of the current branch when the project has never synced', async () => {
      world.store.addRepo('octocat/linked-game', 'main');
      world.store.seedBranch('main', { 'a.txt': { content: 'trunk\n' } });
      world.store.seedBranch('feature', { 'b.txt': { content: 'branch\n' } });
      await link({ linkedBranch: 'feature', lastSyncedCommitSha: undefined });

      const { payload } = await post({ op: 'create-branch', name: 'feature/hud' });

      expect(payload).toMatchObject({ ok: true, head: world.store.branches.get('feature') });
      expect(world.store.branches.get('feature/hud')).toBe(world.store.branches.get('feature'));
      expect(world.store.branches.get('feature/hud')).not.toBe(world.store.branches.get('main'));
    });

    /**
     * 🔴 A DIVERGED PROJECT BRANCHES FROM THE SYNCED SHA, **NOT** THE LIVE HEAD — and on its face
     * "branch from the older commit" reads as a bug, which is why this test exists and why it says why.
     *
     * `decideBranchCreateBase` prefers `lastSyncedCommitSha` UNCONDITIONALLY, including when the
     * remote branch has moved ahead of it. That is the deliberate decision recorded in
     * `branch-ops.ts`, and the reason is `fastForwardPush`: it replaces the tree WHOLESALE. Branch at
     * a head this project has never held, then push the browser's files onto it, and every commit the
     * project never saw — a teammate's work — is deleted, silently, on a branch the user believes is
     * simply "my work, somewhere else". Branching at the commit we agreed with produces a branch that
     * matches what the user can actually see, and their first push to it is an honest fast-forward.
     *
     * The plan's own wording ("`lastSyncedCommitSha` when in sync, otherwise the live head") admits
     * the other reading, so this is the case that pins which one shipped. The route tests otherwise
     * cover only in-sync and never-synced, where the two readings agree and nothing distinguishes them.
     */
    it('branches from the SYNCED sha even when the branch head has moved ahead', async () => {
      world.store.addRepo('octocat/linked-game', 'main');

      /* The commit this project agreed with... */
      const agreed = world.store.seedBranch('main', { 'a.txt': { content: 'v1\n' } });

      /* ...and a commit on top of it that this project has never seen (a teammate pushed). */
      const theirTree = world.store.putTree([{ path: 'a.txt', sha: world.store.putBlobUtf8('v2\n') }]);
      const liveHead = world.store.putCommit(theirTree, [agreed], 'a teammate pushed');
      world.store.branches.set('main', liveHead);

      await link({ lastSyncedCommitSha: agreed });

      const { response, payload } = await post({ op: 'create-branch', name: 'feature/hud' });

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({ ok: true, branch: 'feature/hud', head: agreed });

      /* The ref really is at the agreed commit on the provider — not at the head we never held. */
      expect(world.store.branches.get('feature/hud')).toBe(agreed);
      expect(world.store.branches.get('feature/hud')).not.toBe(liveHead);

      /* The row records the same sha, so the next push measures its fast-forward against it. */
      const stored = await storedProject();
      expect(stored?.linkedBranch).toBe('feature/hud');
      expect(stored?.lastSyncedCommitSha).toBe(agreed);

      /* And the branch we diverged from is untouched — the teammate's commit is still its head. */
      expect(world.store.branches.get('main')).toBe(liveHead);
    });

    /**
     * 🔴 T2 IS ACTUALLY WIRED — asserted with `validateBranchName`'s OWN sentence, not a generic 400.
     *
     * A route that skipped validation would still refuse this name, at the provider, several hundred
     * milliseconds later, with the provider's words. The rule-naming sentence is the evidence that
     * the local check ran.
     */
    it.each([
      ['a name with a space', 'my feature', /cannot contain spaces/i],
      ['a name with a reserved character', 'feature^2', /git reserves it/i],
      ['an empty name', '', /enter a branch name/i],
      ['reflog syntax', 'feature@{1}', /reflog syntax/i],
    ])('refuses %s with the rule it broke, and reaches the provider ZERO times', async (_label, name, expected) => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'x\n' } });
      await link({ lastSyncedCommitSha: world.store.branches.get('main') });

      const before = world.github.requests.length;
      const { response, payload } = await post({ op: 'create-branch', name });

      expect(response.status).toBe(400);
      expect(payload.message).toMatch(expected);
      expect(world.github.requests.length).toBe(before);
    });

    /**
     * 🔴 A COLLISION NEVER SUFFIXES AND NEVER ADOPTS.
     *
     * The typed name comes back so the dialog can put it in the field for editing, and the existing
     * ref is asserted UNMOVED — the failure worth catching is not "an error was returned", it is a
     * create that quietly became a force-push onto somebody else's branch.
     */
    it('returns name-taken with the typed name, and does not move the existing ref', async () => {
      world.store.addRepo('octocat/linked-game', 'main');
      world.store.seedBranch('main', { 'a.txt': { content: 'trunk\n' } });
      world.store.seedBranch('feature/hud', { 'b.txt': { content: 'someone elses work\n' } });

      const theirs = world.store.branches.get('feature/hud');
      await link({ lastSyncedCommitSha: world.store.branches.get('main') });

      const { response, payload } = await post({ op: 'create-branch', name: 'feature/hud' });

      expect(response.status).toBe(409);
      expect(payload).toMatchObject({ error: true, kind: 'name-taken', name: 'feature/hud' });
      expect(payload.message).toContain('feature/hud');

      // Untouched: same head, same content, and no `-2` invented anywhere.
      expect(world.store.branches.get('feature/hud')).toBe(theirs);
      expect([...world.store.filesAt('feature/hud').keys()]).toEqual(['b.txt']);
      expect([...world.store.branches.keys()]).not.toContain('feature/hud-2');

      // And the project did not follow a branch it never created.
      expect((await storedProject())?.linkedBranch).toBe('main');
    });

    /**
     * 🔴 A LINKED REPOSITORY WITH ZERO COMMITS (Open Question 7). There is nothing to branch from,
     * and inventing an empty branch is the answer that looks like it worked. The refusal names the
     * cause and the next action, and the project row is untouched.
     */
    it('refuses on a repository with no commits, naming the reason and writing nothing', async () => {
      world.store.addRepo('octocat/linked-game', 'main');
      await link({ lastSyncedCommitSha: undefined });

      const { response, payload } = await post({ op: 'create-branch', name: 'feature/hud' });

      expect(response.status).toBe(409);
      expect(payload.message).toMatch(/no commits yet/i);
      expect(payload.message).toMatch(/commit your changes first/i);

      const stored = await storedProject();
      expect(stored?.linkedBranch).toBe('main');
      expect(stored?.lastSyncedCommitSha).toBeUndefined();
      expect(world.store.branches.has('feature/hud')).toBe(false);
    });

    /** Nested and unicode names are legal refs; they must survive the round trip unmangled. */
    it.each([['feature/hud/v2'], ['fix/ünïcode-название']])('creates the legal ref %j unmangled', async (name) => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'x\n' } });
      await link({ lastSyncedCommitSha: world.store.branches.get('main') });

      const { payload } = await post({ op: 'create-branch', name });

      expect(payload).toMatchObject({ ok: true, branch: name });
      expect(world.store.branches.has(name)).toBe(true);
      expect((await storedProject())?.linkedBranch).toBe(name);
    });
  });

  describe('delete-branch', () => {
    /* These assert WHICH branch may be deleted; the feature switch has its own suite below. */
    beforeEach(() => {
      branchDeleteGate.open = true;
    });

    afterEach(() => {
      branchDeleteGate.open = false;
    });

    it('deletes an ordinary branch and leaves the project where it is', async () => {
      world.store.addRepo('octocat/linked-game', 'main');
      world.store.seedBranch('main', { 'a.txt': { content: 'trunk\n' } });
      world.store.seedBranch('feature/old', { 'b.txt': { content: 'stale\n' } });
      await link({ lastSyncedCommitSha: world.store.branches.get('main') });

      const { response, payload } = await post({ op: 'delete-branch', name: 'feature/old' });

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({ ok: true, branch: 'feature/old' });
      expect(world.store.branches.has('feature/old')).toBe(false);

      const stored = await storedProject();
      expect(stored?.linkedBranch).toBe('main');
      expect(stored?.lastSyncedCommitSha).toBe(world.store.branches.get('main'));
    });

    /**
     * 🔴 THE CURRENT BRANCH IS REFUSED, because §4.5.4b's tuple is all-or-nothing: deleting it leaves
     * a COMPLETE link pointing at nothing, and every later push, pull and mount fails against a
     * branch the provider has never heard of — reported as "my repository is gone".
     */
    it('refuses the branch the project is on, and the ref survives', async () => {
      world.store.addRepo('octocat/linked-game', 'main');
      world.store.seedBranch('main', { 'a.txt': { content: 'trunk\n' } });
      world.store.seedBranch('feature/hud', { 'b.txt': { content: 'live work\n' } });
      await link({ linkedBranch: 'feature/hud' });

      const { response, payload } = await post({ op: 'delete-branch', name: 'feature/hud' });

      expect(response.status).toBe(409);
      expect(payload.message).toMatch(/switch to another branch first/i);
      expect(world.store.branches.has('feature/hud')).toBe(true);
    });

    /** The default branch is READ from the provider, never guessed — `master` here, not `main`. */
    it("refuses the repository's real default branch, whatever it is called", async () => {
      world.store.addRepo('octocat/linked-game', 'master');
      world.store.seedBranch('master', { 'a.txt': { content: 'trunk\n' } });
      world.store.seedBranch('feature/hud', { 'b.txt': { content: 'work\n' } });
      await link({ linkedBranch: 'feature/hud' });

      const { response, payload } = await post({ op: 'delete-branch', name: 'master' });

      expect(response.status).toBe(409);
      expect(payload.message).toMatch(/default branch/i);
      expect(payload.message).toContain('master');
      expect(world.store.branches.has('master')).toBe(true);
    });

    /**
     * The CONTROL for the line above, and the reason the default is read rather than assumed: on a
     * repository whose trunk is `master`, a hardcoded `main` would refuse a name that does not exist
     * and happily delete the real trunk. Here `main` is an ordinary branch and deleting it succeeds.
     */
    it('deletes a branch called main when main is NOT the default', async () => {
      world.store.addRepo('octocat/linked-game', 'master');
      world.store.seedBranch('master', { 'a.txt': { content: 'trunk\n' } });
      world.store.seedBranch('main', { 'b.txt': { content: 'not the trunk\n' } });
      await link({ linkedBranch: 'master' });

      const { response } = await post({ op: 'delete-branch', name: 'main' });

      expect(response.status).toBe(200);
      expect(world.store.branches.has('main')).toBe(false);
      expect(world.store.branches.has('master')).toBe(true);
    });

    /**
     * 🔴 THE ACCEPTANCE: **two different sentences**, compared to each other — with the branch NAME
     * held constant, which is the whole strength of this test.
     *
     * A pair of `status === 409` assertions passes for a route that returns one generic "you cannot
     * delete that" for both — and the recoveries are genuinely different: switch away, versus you
     * cannot do this from here at all. Told the wrong one, the user goes looking for a control that
     * will not help them (`share/build-failure.ts`'s recorded lesson).
     *
     * ⚠️ **AND COMPARING TWO REFUSALS ABOUT DIFFERENT BRANCHES PROVES NOTHING.** The first version of
     * this test deleted `feature/hud` from one project and `master` from another, so the single
     * generic template anyone would actually write — `This project is on ${name}…` returned for both
     * cases — passed it, because the interpolated names differed. Mutation-verified: it stayed GREEN
     * with `decideBranchDelete` collapsed to one shared sentence, while the pure test failed. Its
     * comment claimed it defeated exactly that, which is this repo's "false claim in a comment" class.
     *
     * So both refusals now name **`main`**, and the ONLY thing that can differ between them is the
     * rule that fired: project A is ON `main` (current-branch rule), project B is on `feature/hud` in
     * the same repository, whose default is `main` (default-branch rule). Two projects rather than
     * two repositories because the fake shares one branch namespace across repos (`FakeRepoStore`),
     * and `defaultBranches` is the per-repo fact — one repo keeps that ambiguity out of the test.
     */
    it('gives the current-branch and default-branch refusals DIFFERENT sentences for the SAME name', async () => {
      world.store.addRepo('octocat/linked-game', 'main');
      world.store.seedBranch('main', { 'a.txt': { content: 'trunk\n' } });
      world.store.seedBranch('feature/hud', { 'b.txt': { content: 'work\n' } });

      /* Project A is sitting ON `main`, so deleting `main` is the current-branch case. */
      await link({ linkedBranch: 'main' });

      /* Project B looks at the SAME repository from `feature/hud`, so `main` is the default case. */
      const projects = new FsProjectStore(tmp);
      const onFeature = await projects.create({ userId: USER.id, name: 'Second game', templateId: 'blank' });
      await projects.update(onFeature.id, {
        provider: 'github',
        linkedRepo: 'octocat/linked-game',
        linkedBranch: 'feature/hud',
      });

      const current = await post({ op: 'delete-branch', name: 'main' });
      const isDefault = await post({ op: 'delete-branch', name: 'main' }, { projectId: onFeature.id });

      expect(current.response.status).toBe(409);
      expect(isDefault.response.status).toBe(409);

      /* The sentences differ on the RULE, because the name they interpolate is identical. */
      expect(current.payload.message).not.toBe(isDefault.payload.message);

      /* And each says which rule fired, so the difference is the right one rather than any difference. */
      expect(current.payload.message).toMatch(/switch to another branch first/i);
      expect(isDefault.payload.message).toMatch(/default branch/i);

      /* Neither refusal is a delete: `main` is still there after both. */
      expect(world.store.branches.has('main')).toBe(true);
    });

    /**
     * An absent branch SUCCEEDS — the intent is already satisfied, and GitHub reports it as 422
     * "Reference does not exist" (not the 404 one would guess), which the adapter swallows for this
     * endpoint only. A refusal here would make a double-click on Delete look like a failure.
     */
    it('succeeds for a branch that is already gone', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'x\n' } });
      await link({ lastSyncedCommitSha: world.store.branches.get('main') });

      const { response, payload } = await post({ op: 'delete-branch', name: 'never-existed' });

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({ ok: true, branch: 'never-existed' });
    });

    it('refuses an empty name before asking the provider anything', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'x\n' } });

      const before = world.github.requests.length;
      const { response, payload } = await post({ op: 'delete-branch' });

      expect(response.status).toBe(400);
      expect(payload.message).toMatch(/choose a branch to delete/i);
      expect(world.github.requests.length).toBe(before);
    });
  });

  /**
   * 🔴 BOTH WRITES ARE RATE-LIMITED BEFORE THE OUTBOUND CALL.
   *
   * These land in a real person's account with their name on them, so a runaway client would fill
   * somebody's repository with rubbish they then clean up by hand. A limiter that counted AFTER the
   * call is not a limiter — it is a 429 attached to a ref that already exists — which is why the
   * assertion is observable rather than on the status alone.
   */
  /**
   * 🔴 THE SWITCH IS A SERVER REFUSAL, NOT A HIDDEN MENU ROW (owner, 2026-08-22).
   *
   * The chip stops rendering "Delete a branch…", and that is cosmetic: `op: 'delete-branch'` stays
   * reachable by anyone with a session and a project id. A capability turned off only in a component
   * is the `withSecurity` `requireAuth` mistake — a wall in a place the caller does not have to go
   * through. These run with the gate at its REAL production value.
   */
  describe('branch deletion is switched off', () => {
    it('refuses with 409 and leaves the branch standing', async () => {
      world.store.addRepo('octocat/linked-game', 'main');
      world.store.seedBranch('main', { 'a.txt': { content: 'trunk\n' } });
      world.store.seedBranch('feature/old', { 'b.txt': { content: 'stale\n' } });

      const { response } = await post({ op: 'delete-branch', name: 'feature/old' });

      expect(response.status).toBe(409);
      expect(world.store.branches.has('feature/old'), 'the branch was deleted anyway').toBe(true);
    });

    /**
     * A refusal that names no way forward reads as a broken button — `share/build-failure.ts`. The
     * owner's whole reason for allowing this is that the user can still do it on the provider.
     */
    it('tells the user where they CAN delete it', async () => {
      world.store.addRepo('octocat/linked-game', 'main');
      world.store.seedBranch('main', { 'a.txt': { content: 'trunk\n' } });
      world.store.seedBranch('feature/old', { 'b.txt': { content: 'stale\n' } });

      const { payload } = await post({ op: 'delete-branch', name: 'feature/old' });

      expect(String(payload.message)).toMatch(/GitHub or GitLab/i);
    });

    /**
     * ⚠️ BEFORE the rate limiter, not after. A refusal placed downstream of the budget lets an
     * anonymous-ish caller burn a real user's branch-write allowance on an op that can never run —
     * the refusal costs them nothing and costs the user their quota.
     */
    it('refuses without spending the branch-write budget', async () => {
      world.store.addRepo('octocat/linked-game', 'main');
      world.store.seedBranch('main', { 'a.txt': { content: 'trunk\n' } });

      let hits = 0;
      setUserRateLimitStore({
        hit: async (_key, _rule, now) => {
          hits += 1;
          return { allowed: true, remaining: 1, resetAt: now + 60_000 };
        },
      });

      await post({ op: 'delete-branch', name: 'feature/old' });

      expect(hits, 'the gate sits downstream of the rate limiter').toBe(0);
    });

    /**
     * CONTROL. Without this the three above pass for a route that refuses EVERY branch op — or for
     * one that 409s on everything — and the suite would read as "the switch works" while the feature
     * beside it was broken.
     */
    it('CONTROL — create-branch is untouched by the switch', async () => {
      world.store.addRepo('octocat/linked-game', 'main');
      world.store.seedBranch('main', { 'a.txt': { content: 'trunk\n' } });
      await link({ lastSyncedCommitSha: world.store.branches.get('main') });

      const { response } = await post({ op: 'create-branch', name: 'feature/hud' });

      expect(response.status).toBe(200);
      expect(world.store.branches.has('feature/hud')).toBe(true);
    });
  });

  describe('the per-user branch-write rate limit', () => {
    /*
     * The budget is a property of the OP, not of whether the op happens to be enabled today, and
     * `delete-branch` is half of what proves both ops share one bucket. Open the switch so the
     * limiter is what refuses, not the gate in front of it.
     */
    beforeEach(() => {
      branchDeleteGate.open = true;
    });

    afterEach(() => {
      branchDeleteGate.open = false;
    });

    const exhausted: UserRateLimitStore = {
      hit: async (_key, _rule, now) => ({ allowed: false, remaining: 0, resetAt: now + 15 * 60 * 1000 }),
    };

    it.each([
      ['create-branch', { op: 'create-branch', name: 'feature/hud' }],
      ['delete-branch', { op: 'delete-branch', name: 'feature/old' }],
    ])('refuses %s with 429 naming BRANCH OPERATIONS, reaching the provider ZERO times', async (_label, body) => {
      world.store.addRepo('octocat/linked-game', 'main');
      world.store.seedBranch('main', { 'a.txt': { content: 'trunk\n' } });
      world.store.seedBranch('feature/old', { 'b.txt': { content: 'stale\n' } });
      await link({ lastSyncedCommitSha: world.store.branches.get('main') });
      setUserRateLimitStore(exhausted);

      const before = world.github.requests.length;
      const { response, payload } = await post(body);

      expect(response.status).toBe(429);
      expect(payload.isRetryable).toBe(true);

      /*
       * `RateLimitedError`'s default names "repository imports". Telling someone who pressed New
       * branch that they have made too many imports sends them to look for a problem that does not
       * exist — the subject is threaded through for exactly this.
       */
      expect(payload.message).toMatch(/too many branch operations/i);
      expect(payload.message).not.toMatch(/repository imports|branch reads/i);

      expect(world.github.requests.length).toBe(before);

      // Nothing happened on either side of the wall.
      expect(world.store.branches.has('feature/hud')).toBe(false);
      expect(world.store.branches.has('feature/old')).toBe(true);
    });

    /** The CONTROL: same project, same ops, one difference — the budget — and the outcome flips. */
    it('serves both writes when the budget is not spent', async () => {
      world.store.addRepo('octocat/linked-game', 'main');
      world.store.seedBranch('main', { 'a.txt': { content: 'trunk\n' } });
      world.store.seedBranch('feature/old', { 'b.txt': { content: 'stale\n' } });
      await link({ lastSyncedCommitSha: world.store.branches.get('main') });

      expect((await post({ op: 'delete-branch', name: 'feature/old' })).response.status).toBe(200);
      expect((await post({ op: 'create-branch', name: 'feature/hud' })).response.status).toBe(200);
    });

    /**
     * ONE bucket shared by both writes, and it is NOT the clone or tree-read budget — a handful of
     * branch operations must not spend a user's whole import allowance, and vice versa.
     */
    it('counts both ops against the branch-write bucket, never the clone or tree-read ones', async () => {
      world.store.addRepo('octocat/linked-game', 'main');
      world.store.seedBranch('main', { 'a.txt': { content: 'trunk\n' } });
      world.store.seedBranch('feature/old', { 'b.txt': { content: 'stale\n' } });
      await link({ lastSyncedCommitSha: world.store.branches.get('main') });

      const seen: string[] = [];
      const memory = new MemoryUserRateLimitStore();

      setUserRateLimitStore({
        hit: async (key, rule, now) => {
          seen.push(key);
          return memory.hit(key, rule, now);
        },
      });

      await post({ op: 'create-branch', name: 'feature/hud' });
      await post({ op: 'delete-branch', name: 'feature/old' });

      expect(seen).toEqual([`git-branch-write:${USER.id}`, `git-branch-write:${USER.id}`]);
      expect(seen.some((key) => key.startsWith('git-clone:') || key.startsWith('git-tree-read:'))).toBe(false);
    });

    it('lets a user perform BRANCH_WRITE_RATE_LIMIT.max writes an hour and no more', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'x\n' } });
      await link({ lastSyncedCommitSha: world.store.branches.get('main') });

      /*
       * Delete of an absent branch: a real write op that changes nothing, so the budget is the only
       * thing under test.
       */
      for (let i = 0; i < BRANCH_WRITE_RATE_LIMIT.max; i++) {
        expect((await post({ op: 'delete-branch', name: `gone-${i}` })).response.status).toBe(200);
      }

      expect((await post({ op: 'delete-branch', name: 'one-too-many' })).response.status).toBe(429);
    });
  });

  /**
   * 🔴 DEFECT 1 (fixed 2026-08-21): `push-to-new-branch` moved the work and left the project behind.
   *
   * This arm is the divergence dialog's escape hatch: it pushes the browser's files to a fresh
   * `platform/<date>` branch. It returned that branch name and updated NOTHING, while `push` and
   * `save` both update — so the project stayed pointed at the branch it had just been forced off,
   * still carrying the stale `lastSyncedCommitSha` that caused the divergence in the first place.
   * Every later push then measured against that same stale commit and diverged again, and the user's
   * work sat on a branch the project did not know existed.
   *
   * Mutation-verified: removing the `projects.update` from that arm fails these tests and nothing
   * else in the suite.
   */
  describe('push-to-new-branch — the project follows the branch it escaped to', () => {
    const files = { 'src/game.ts': { type: 'file' as const, content: 'export const x = 3;\n', isBinary: false } };

    it('leaves linkedBranch and lastSyncedCommitSha equal to what the response named', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'export const x = 1;\n' } });
      await link({ lastSyncedCommitSha: AGREED });

      const { response, payload } = await post({ op: 'resolve', choice: 'push-to-new-branch', files });

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(payload.branch).toEqual(expect.any(String));
      expect(payload.commitSha).toEqual(expect.any(String));

      const stored = await storedProject();
      expect(stored?.linkedBranch).toBe(payload.branch);
      expect(stored?.lastSyncedCommitSha).toBe(payload.commitSha);

      // The stale sha that caused the divergence is gone, so the next push does not re-diverge.
      expect(stored?.lastSyncedCommitSha).not.toBe(AGREED);
    });

    /**
     * The consequence, driven rather than reasoned about: an ordinary push straight afterwards must
     * fast-forward. Before the fix it measured against the stale sha on the OLD branch and diverged
     * — the second symptom, and the one the user actually reports.
     */
    it('lets the very next push fast-forward instead of diverging again', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'export const x = 1;\n' } });
      await link({ lastSyncedCommitSha: AGREED });

      const escaped = await post({ op: 'resolve', choice: 'push-to-new-branch', files });
      const next = await post({
        op: 'push',
        files: { 'src/game.ts': { type: 'file', content: 'export const x = 4;\n', isBinary: false } },
      });

      expect(next.response.status).toBe(200);
      expect(next.payload).toMatchObject({ ok: true });
      expect(next.payload.divergence).toBeUndefined();

      // It landed on the escape branch, not back on the one the divergence came from.
      expect(world.store.branches.get(escaped.payload.branch as string)).toBe(next.payload.commitSha);
      expect((await storedProject())?.linkedBranch).toBe(escaped.payload.branch);
    });

    /**
     * The CONTROL: the tuple write is not a blanket "always repoint". `pull-overwrite` — the other
     * divergence choice — reads the tree and must leave `linkedBranch` exactly where it is.
     */
    it('and the other divergence choice does NOT repoint the branch', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'export const x = 1;\n' } });
      await link({ lastSyncedCommitSha: AGREED });

      const { response } = await post({ op: 'resolve', choice: 'pull-overwrite' });

      expect(response.status).toBe(200);
      expect((await storedProject())?.linkedBranch).toBe('main');
    });
  });
});

/**
 * 🔴 THE TWO TREE-REPLACING OPS (§4.13, §4.12, T7) — the doors that overwrite the user's whole project.
 *
 * `switch-branch` and `discard` are the only ops on this route whose success means every file the user
 * is looking at is about to be replaced. Everything asserted below fails SILENTLY:
 *
 *   - **The guard runs before the pointer moves.** `readBranchTree` refuses a tree the client can never
 *     apply (oversize, LFS) — and a switch that stamped `linkedBranch` + `lastSyncedCommitSha` first
 *     would leave the project claiming to be on a branch whose bytes it never received, with every
 *     later push measuring its fast-forward against a commit this tree has never held.
 *   - **Both tuple fields, one update, and the head we ACTUALLY just read** (§4.5.4b, migration 0006).
 *     A stale sha re-creates the measured 2026-08-03 false divergence *against the very commit we are
 *     holding in memory*; a stale branch aims every later push at the branch the user just left. Both
 *     are asserted as one exact `updates` array rather than two field reads, because "the row ended up
 *     right" also passes for two writes that raced, and for a sha copied out of an earlier branch list.
 *   - **A commit-less branch is a refusal, never an empty map.** `planRestore` refuses an empty incoming
 *     map by design ("a restore is never a wipe"), so handing the client `{}` restores nothing and
 *     reports success — the switch simply does not happen and nothing says so.
 *   - **Discard on an unlinked project names the missing link.** There is no other copy of an unlinked
 *     project's files, so the one reading that must be foreclosed is "delete everything".
 *   - **Neither may run while a generation holds the project** (§4.12). A restore landing between two
 *     file actions leaves a mix of two different ideas that the user can neither see nor undo.
 *
 * The refusal WORDING is asserted per door for `share/build-failure.ts`'s reason — told a limit was hit
 * by an operation they did not perform, a user concludes the button is broken — and each door also
 * asserts that the OTHER doors' sentences are absent, because a shared refusal passes every
 * `status === 413` check while describing the wrong button.
 */
describe('the tree-replacing ops on the project git route — switch-branch and discard', () => {
  let tmp: string;
  let project: Project;

  const AGREED = 'sha-from-the-last-time-we-agreed';

  /**
   * Every `update` the ROUTE performed, in order.
   *
   * Recorded rather than read back off the row: "writes nothing" and "writes both fields in one call"
   * are claims about the WRITES, and a row inspected afterwards cannot distinguish one correct update
   * from two that happened to end in the same place — nor a refusal that wrote and rolled back.
   */
  let updates: Array<Record<string, unknown>>;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'git-tree-route-'));

    const base = new FsProjectStore(tmp);
    project = await base.create({ userId: USER.id, name: 'Linked game', templateId: 'blank' });

    // The starting tuple is written on the BASE store, so setup never shows up in `updates`.
    await base.update(project.id, {
      provider: 'github',
      linkedRepo: 'octocat/linked-game',
      linkedBranch: 'main',
      lastSyncedCommitSha: AGREED,
    });

    updates = [];

    const recording: ProjectStore = {
      create: (input) => base.create(input),
      get: (id) => base.get(id),
      listByUser: (userId) => base.listByUser(userId),
      update: (id, patch) => {
        updates.push({ ...patch });
        return base.update(id, patch);
      },
      delete: (id) => base.delete(id),
      getByShareId: (shareId) => base.getByShareId(shareId),
      listGallery: (limit) => base.listGallery(limit),
      listGallerySubmissions: (limit) => base.listGallerySubmissions(limit),
    };

    setProjectStore(recording);
    setUserRateLimitStore(new MemoryUserRateLimitStore());
    setGitTokenStore(connected('github'));

    // A claim left behind by another test would refuse every op here for a reason nothing prints.
    _resetClaims();
  });

  afterEach(async () => {
    _resetClaims();
    setProjectStore(undefined);
    setUserRateLimitStore(undefined);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function post(body: Record<string, unknown>, options: { projectId?: string; context?: unknown } = {}) {
    const { action } = await import('~/routes/api.projects.$projectId.github');

    const response = (await action({
      request: new Request('https://app.example.com/api/projects/p/github', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      params: { projectId: options.projectId ?? project.id },
      context: options.context ?? ctx(),
    } as never)) as Response;

    return { response, payload: (await response.json()) as Record<string, unknown> };
  }

  const storedProject = () => new FsProjectStore(tmp).get(project.id);

  /** A repo whose source is over any sane ceiling, on the branch each door will be pointed at. */
  const OVERSIZE = { 'assets/level.glb': { content: 'a'.repeat(4096) } };
  const TINY_LIMIT = () => ctx({ GIT_CLONE_MAX_MB: String(1024 / (1024 * 1024)) });

  const LFS = {
    'assets/car.glb': { content: 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 900\n' },
  };

  describe('switch-branch', () => {
    /**
     * 🔴 THE ACCEPTANCE, and the CONTROL for everything after it. Without a switch that demonstrably
     * works, every refusal below passes for an op that refuses unconditionally — which is the cheerful
     * way a guard goes green while the feature is dead.
     */
    it('returns the target branch tree and writes BOTH tuple fields in ONE update', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'trunk\n' } });

      const mainHead = world.store.branches.get('main');
      const featureHead = world.store.seedBranch('feature', { 'src/boost.ts': { content: 'branch\n' } });

      const { response, payload } = await post({ op: 'switch-branch', branch: 'feature' });

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({ ok: true, branch: 'feature', head: featureHead });
      expect(Object.keys(payload.files as object)).toEqual(['src/boost.ts']);

      // One update, both fields, and the sha is the one this request read — not the one it started with.
      expect(updates).toEqual([{ linkedBranch: 'feature', lastSyncedCommitSha: featureHead }]);
      expect(featureHead).not.toBe(mainHead);
      expect(featureHead).not.toBe(AGREED);

      const stored = await storedProject();
      expect(stored?.linkedBranch).toBe('feature');
      expect(stored?.lastSyncedCommitSha).toBe(featureHead);
    });

    /**
     * 🔴 THE HEAD IS THE ONE WE JUST READ — never one the client saw in an earlier branch list.
     *
     * The stale-sha family has more members than "the value that was already there", and the row-level
     * assertion above cannot separate them: a branch listed a minute ago, then pushed to from a git
     * client, hands back a head that is *plausible, well-formed and wrong*. Stamping it claims agreement
     * with a commit whose bytes we did not fetch, so the next push fast-forwards straight over the work
     * that landed in between — the 2026-08-03 false divergence pointed the other way.
     */
    it('records the head it just read, not the head the branch had when it was last listed', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'trunk\n' } });

      const listedHead = world.store.seedBranch('feature', { 'src/boost.ts': { content: 'v1\n' } });

      // The client lists the branches — this is the head it now holds.
      const listing = await post({ op: 'branches' });
      expect(
        (listing.payload.branches as Array<Record<string, unknown>>).find((b) => b.name === 'feature'),
      ).toMatchObject({ head: listedHead });

      // Somebody pushes to that branch from a git client before the switch is pressed.
      const liveHead = world.store.seedBranch('feature', { 'src/boost.ts': { content: 'v2\n' } });
      expect(liveHead).not.toBe(listedHead);

      const { payload } = await post({ op: 'switch-branch', branch: 'feature' });

      expect(payload.head).toBe(liveHead);
      expect(updates).toEqual([{ linkedBranch: 'feature', lastSyncedCommitSha: liveHead }]);
      expect((await storedProject())?.lastSyncedCommitSha).not.toBe(listedHead);
    });

    /**
     * `null` from `readBranchTree` means "that branch has no commits", and flattening it into `{}` is
     * not a smaller version of the same answer — `planRestore` refuses an empty map, so the client
     * would restore nothing, report success, and leave the project pointing at a branch it never went
     * to. Nothing throws and nothing on screen disagrees.
     */
    it('refuses a branch with no commits, hands back no files, and writes nothing', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'trunk\n' } });

      const { response, payload } = await post({ op: 'switch-branch', branch: 'ghost' });

      expect(response.status).toBe(409);
      expect(payload.message).toContain('ghost');
      expect(payload.message).toMatch(/no commits/i);
      expect(payload.files).toBeUndefined();

      expect(updates).toEqual([]);
      expect(await storedProject()).toMatchObject({ linkedBranch: 'main', lastSyncedCommitSha: AGREED });
    });

    it('refuses an empty branch name before asking the provider anything', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'trunk\n' } });

      const before = world.github.requests.length;
      const { response, payload } = await post({ op: 'switch-branch', branch: '' });

      expect(response.status).toBe(400);
      expect(payload.message).toMatch(/choose a branch/i);
      expect(world.github.requests.length).toBe(before);
      expect(updates).toEqual([]);
    });

    /**
     * The guard runs INSIDE `readBranchTree`, and the refusal wears THIS door's words. A user pressing
     * Switch is not importing, not syncing, not reviewing and not discarding — and each of those
     * sentences would satisfy a bare status assertion while sending them to look for a button they
     * never pressed.
     */
    it('refuses an oversize branch with the SWITCH wording, naming the limit and its env var', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'trunk\n' } });
      world.store.seedBranch('feature', OVERSIZE);

      const { response, payload } = await post({ op: 'switch-branch', branch: 'feature' }, { context: TINY_LIMIT() });

      expect(response.status).toBe(413);
      expect(payload.message).toContain('GIT_CLONE_MAX_MB');
      expect(payload.message).toMatch(/branch limit/i);
      expect(payload.message).toMatch(/cannot be switched to/i);

      // The other doors' sentences must not appear on this one.
      expect(payload.message).not.toMatch(/import limit|sync limit/i);
      expect(payload.message).not.toMatch(/imported|pulled into this project|compared with your project|restored/i);
    });

    it('reports Git-LFS with the SWITCH wording rather than handing back placeholder text', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'trunk\n' } });
      world.store.seedBranch('feature', LFS);

      const { response, payload } = await post({ op: 'switch-branch', branch: 'feature' });

      expect(response.status).toBe(422);
      expect(payload.message).toContain('assets/car.glb');
      expect(payload.message).toMatch(/switching to it would replace those files with placeholder text/i);
      expect(payload.message).not.toMatch(/importing it would|pulling it would|reviewing it would/i);
      expect(payload.message).not.toMatch(/discarding your changes/i);
    });

    /**
     * 🔴 THE ORDERING. `assertFetchedTreeUsable` runs BEFORE the pointer write, so a refused switch
     * leaves the project exactly where it was. The opposite order stamps a branch whose bytes the
     * client was never given: the project believes it is on `feature`, the files on disk are `main`,
     * and the next push measures a fast-forward against a commit this tree has never held.
     */
    it('moves NEITHER tuple field when the tree is refused', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'trunk\n' } });
      world.store.seedBranch('feature', OVERSIZE);

      await post({ op: 'switch-branch', branch: 'feature' }, { context: TINY_LIMIT() });

      expect(updates).toEqual([]);
      expect(await storedProject()).toMatchObject({ linkedBranch: 'main', lastSyncedCommitSha: AGREED });
    });

    it('leaves the tuple alone on an LFS refusal too', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'trunk\n' } });
      world.store.seedBranch('feature', LFS);

      await post({ op: 'switch-branch', branch: 'feature' });

      expect(updates).toEqual([]);
      expect(await storedProject()).toMatchObject({ linkedBranch: 'main', lastSyncedCommitSha: AGREED });
    });
  });

  describe('discard', () => {
    /**
     * 🔴 THE ACCEPTANCE, and the control for the refusals: the linked branch's bytes come back and the
     * pointer does NOT move. It already names this branch, and the server has not seen the user's files
     * — only the client can know whether the reset landed, so agreeing here would be agreeing with an
     * outcome nobody has observed.
     */
    it('returns the linked branch tree and moves the pointer nowhere', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'committed\n' } });

      const { response, payload } = await post({ op: 'discard' });

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({ ok: true, branch: 'main', head: world.store.branches.get('main') });
      expect(Object.keys(payload.files as object)).toEqual(['src/game.ts']);

      expect(updates).toEqual([]);
      expect(await storedProject()).toMatchObject({ linkedBranch: 'main', lastSyncedCommitSha: AGREED });
    });

    /**
     * The CONTROL for the line above. Without it "the pointer did not move" passes for a recording
     * store that never records and a project row that never changes — i.e. it would go green for a
     * route that stamps the pointer on every read.
     */
    it('and the pointer really can move — a pull on the same project advances it', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'committed\n' } });

      await post({ op: 'pull' });

      expect(updates).toEqual([{ lastSyncedCommitSha: world.store.branches.get('main') }]);
      expect((await storedProject())?.lastSyncedCommitSha).not.toBe(AGREED);
    });

    /**
     * 🔴 UNLINKED IS ITS OWN SENTENCE, and it must never read as "delete everything".
     *
     * Discard is the one operation in the product whose purpose is destruction, so a user who pressed
     * it on an unlinked project needs both halves: nothing happened, AND what would make it work. The
     * generic "not linked to a repository yet" gate is correct and useless here — it withholds the
     * recovery, and `share/build-failure.ts` records what a user concludes when a refusal names no
     * cause. There is genuinely nothing to reset TO: an unlinked project's files exist nowhere else.
     */
    it('refuses on an unlinked project by naming the missing link, and touches nothing', async () => {
      const solo = await new FsProjectStore(tmp).create({
        userId: USER.id,
        name: 'Never linked',
        templateId: 'blank',
      });

      const before = world.github.requests.length;
      const { response, payload } = await post({ op: 'discard' }, { projectId: solo.id });

      expect(response.status).toBe(409);
      expect(payload.message).toMatch(/not linked to a repository/i);
      expect(payload.message).toMatch(/link it to github/i);
      expect(payload.message).toMatch(/nothing has been changed/i);

      // It offers the action that fixes it, rather than only reporting that the button is unavailable.
      expect(payload.link).toBe(true);

      // And it can never be read as an offer to wipe the project.
      expect(payload.message).not.toMatch(/delete|erase|wipe|remove everything/i);

      expect(payload.files).toBeUndefined();
      expect(updates).toEqual([]);
      expect(world.github.requests.length).toBe(before);

      const stored = await new FsProjectStore(tmp).get(solo.id);
      expect(stored?.linkedRepo ?? null).toBeNull();
      expect(stored?.linkedBranch ?? null).toBeNull();
    });

    it('refuses when the linked branch has no commits, rather than restoring emptiness', async () => {
      world.store.addRepo('octocat/linked-game', 'main');

      const { response, payload } = await post({ op: 'discard' });

      expect(response.status).toBe(409);
      expect(payload.message).toContain('main');
      expect(payload.message).toMatch(/no commits/i);
      expect(payload.files).toBeUndefined();
      expect(updates).toEqual([]);
    });

    it('refuses an oversize branch with the DISCARD wording, naming the limit and its env var', async () => {
      seed('octocat/linked-game', OVERSIZE);

      const { response, payload } = await post({ op: 'discard' }, { context: TINY_LIMIT() });

      expect(response.status).toBe(413);
      expect(payload.message).toContain('GIT_CLONE_MAX_MB');
      expect(payload.message).toMatch(/branch limit/i);
      expect(payload.message).toMatch(/cannot be restored/i);

      expect(payload.message).not.toMatch(/import limit|sync limit/i);
      expect(payload.message).not.toMatch(/imported|pulled into this project|compared with your project|switched to/i);
    });

    it('reports Git-LFS with the DISCARD wording rather than handing back placeholder text', async () => {
      seed('octocat/linked-game', LFS);

      const { response, payload } = await post({ op: 'discard' });

      expect(response.status).toBe(422);
      expect(payload.message).toContain('assets/car.glb');
      expect(payload.message).toMatch(
        /discarding your changes and restoring it would replace those files with placeholder text/i,
      );
      expect(payload.message).not.toMatch(
        /importing it would|pulling it would|reviewing it would|switching to it would/i,
      );
    });

    /** The guard is ahead of anything that could record agreement here as well. */
    it('writes nothing when the tree is refused', async () => {
      seed('octocat/linked-game', OVERSIZE);

      await post({ op: 'discard' }, { context: TINY_LIMIT() });

      expect(updates).toEqual([]);
      expect(await storedProject()).toMatchObject({ linkedBranch: 'main', lastSyncedCommitSha: AGREED });
    });
  });

  /**
   * 🔴 A GENERATION OWNS THE TREE WHILE IT RUNS (§4.12).
   *
   * Both ops replace the whole working tree, which is exactly the interleaving the one-build-at-a-time
   * claim exists to prevent: a restore landing between two file actions leaves a mix of two different
   * ideas that the user can neither see nor undo, and the artifact rows keep streaming as if nothing
   * happened. The refusal is asserted observably — zero outbound requests — because a route that
   * fetched the tree and then refused has already spent the read it was supposed to prevent.
   */
  describe('while a generation holds the project', () => {
    /** The claim is always released, or every later test in this file inherits the refusal. */
    async function whileClaimed<T>(run: () => Promise<T>): Promise<T> {
      const release = claimProject(project.id, USER.id);

      try {
        return await run();
      } finally {
        release();
      }
    }

    /**
     * ⚠️ THE SHARED HALF IS SHARED AND THE VERB IS NOT, and this test used to assert otherwise.
     *
     * It pinned `before changing branches` for BOTH ops, which is how the sentence came to be served
     * to Discard — a refusal telling a user they cannot do a thing they never asked for, the exact
     * class T4 had just removed from `RateLimitedError`. The `wrongVerb` column is what makes the
     * distinction load-bearing: asserting only that each message contains its own verb would still
     * pass for one generic sentence containing both.
     */
    it.each([
      ['switch-branch', { op: 'switch-branch', branch: 'feature' }, /before changing branches/i, /discarding/i],
      ['discard', { op: 'discard' }, /before discarding your changes/i, /changing branches/i],
    ])(
      'refuses %s with the build-in-flight sentence in ITS words, and fetches nothing',
      async (_name, body, verb, wrongVerb) => {
        seed('octocat/linked-game', { 'src/game.ts': { content: 'trunk\n' } });
        world.store.seedBranch('feature', { 'src/boost.ts': { content: 'branch\n' } });

        const before = world.github.requests.length;

        const { response, payload } = await whileClaimed(() => post(body));

        expect(response.status).toBe(409);

        /* The condition and the advice are one fact for both ops — that half genuinely is shared. */
        expect(payload.message).toMatch(/building right now/i);
        expect(payload.message).toMatch(/wait for it to finish, or press stop/i);

        expect(payload.message).toMatch(verb);
        expect(payload.message).not.toMatch(wrongVerb);

        expect(payload.ok).toBeUndefined();
        expect(payload.files).toBeUndefined();
        expect(updates).toEqual([]);
        expect(world.github.requests.length).toBe(before);
      },
    );

    /**
     * The CONTROL. Same project, same body, one difference — the claim is released — and the outcome
     * flips. Without it the refusals above pass for an op that never works at all, and for a claim that
     * was never taken.
     */
    it.each([
      ['switch-branch', { op: 'switch-branch', branch: 'feature' }],
      ['discard', { op: 'discard' }],
    ])('serves the same %s once the generation has finished', async (_name, body) => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'trunk\n' } });
      world.store.seedBranch('feature', { 'src/boost.ts': { content: 'branch\n' } });

      const release = claimProject(project.id, USER.id);
      release();

      const { response, payload } = await post(body);

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(Object.keys(payload.files as object).length).toBeGreaterThan(0);
    });

    /**
     * ⚠️ The read is a REFUSAL, not a takeover — `isProjectClaimed` must not sweep or mutate the claim
     * it reports on. A refusal with a side effect behaves differently depending on how many times the
     * button was pressed, and a reader that tidied up a stale claim would silently turn off the warning
     * that says something failed to release its `finally`.
     */
    it('does not consume the claim — a second press is refused exactly the same way', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'trunk\n' } });

      await whileClaimed(async () => {
        expect((await post({ op: 'discard' })).response.status).toBe(409);
        expect((await post({ op: 'discard' })).response.status).toBe(409);
      });
    });
  });

  /**
   * The tree-read budget covers these doors too. A whole-repository read is the expensive shape
   * whatever door it arrives through, and a limiter that counts AFTER the fetch is not a limiter — it
   * is a 429 attached to a bill already paid. The subject is threaded through rather than defaulted:
   * `RateLimitedError` says "repository imports" by itself, which sends someone who pressed Discard to
   * look for a problem that does not exist.
   */
  describe('the per-user tree-read budget', () => {
    const exhausted: UserRateLimitStore = {
      hit: async (_key, _rule, now) => ({ allowed: false, remaining: 0, resetAt: now + 15 * 60 * 1000 }),
    };

    it.each([
      ['switch-branch', { op: 'switch-branch', branch: 'feature' }],
      ['discard', { op: 'discard' }],
    ])('refuses %s with 429 naming BRANCH READS, and reaches the provider ZERO times', async (_name, body) => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'trunk\n' } });
      world.store.seedBranch('feature', { 'src/boost.ts': { content: 'branch\n' } });
      setUserRateLimitStore(exhausted);

      const before = world.github.requests.length;
      const { response, payload } = await post(body);

      expect(response.status).toBe(429);
      expect(payload.message).toMatch(/too many branch reads/i);
      expect(payload.message).not.toMatch(/repository imports/i);
      expect(world.github.requests.length).toBe(before);
      expect(updates).toEqual([]);
    });

    it('counts a switch against the branch-read bucket, never the clone or branch-write ones', async () => {
      seed('octocat/linked-game', { 'src/game.ts': { content: 'trunk\n' } });
      world.store.seedBranch('feature', { 'src/boost.ts': { content: 'branch\n' } });

      const seen: string[] = [];
      const memory = new MemoryUserRateLimitStore();

      setUserRateLimitStore({
        hit: async (key, rule, now) => {
          seen.push(key);
          return memory.hit(key, rule, now);
        },
      });

      await post({ op: 'switch-branch', branch: 'feature' });

      expect(seen).toContain(`git-tree-read:${USER.id}`);
      expect(seen.some((key) => key.startsWith('git-clone:') || key.startsWith('git-branch-write:'))).toBe(false);
    });
  });
});
