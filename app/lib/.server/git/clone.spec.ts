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
  CLONE_RATE_LIMIT,
  MemoryUserRateLimitStore,
  setUserRateLimitStore,
  type UserRateLimitStore,
} from '~/lib/.server/security/user-rate-limit';
import { FsProjectStore, setProjectStore } from '~/lib/.server/projects/store';
import { bytesToBase64, type SerializedFileMap } from '~/lib/binary/binary-files';
import type { Project } from '~/lib/.server/projects/types';

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
