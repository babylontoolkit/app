/**
 * In-memory fake GitHub + GitLab servers, for the provider contract suite (SPEC §4.5.4b).
 *
 * ## Why fakes rather than mocks
 *
 * The contract that matters is a ROUND-TRIP: a PNG pushed and re-fetched must be sha256-identical. A
 * mock that returns a canned blob proves nothing about that — it proves we can read our own fixture.
 * So these are real (tiny) content-addressed stores: a push genuinely writes blobs/trees/commits, and
 * a fetch genuinely reads back whatever the push actually stored. If the provider mangles bytes on the
 * way in, the round-trip test fails, which is the entire point.
 *
 * ## The quirks these fakes reproduce ON PURPOSE
 *
 * A fake that is nicer than the real thing hides the bugs the real thing causes. Reproduced:
 *   - **Both providers return base64 for EVERYTHING on read**, including plain text. This is what makes
 *     `fetchTree` need a classifier at all, and what the old extension-allowlist got wrong.
 *   - **GitHub wraps blob base64 at 60 columns with newlines.** A decoder that forwards the string
 *     verbatim instead of decoding to bytes will round-trip corrupted content.
 *   - **GitHub signals rate limiting as a 403** with `x-ratelimit-remaining: 0`, not a 429.
 *   - **GitLab uses a real 429** with `RateLimit-Reset` as an absolute epoch second.
 *   - **GitLab has no upsert** — `create` on an existing path is an error, as is `update` on a missing
 *     one — which is why the adapter reads the remote tree before composing `actions[]`.
 *
 * Both fakes record every request they receive (`requests`) so the suite can assert on what was
 * SERIALIZED and sent, not merely on what came back — the `anthropic.spec.ts` discipline. A push that
 * quietly included `.env` but returned success would pass a response-only assertion.
 */
import { createHash } from 'node:crypto';

/** Content-addressed like the real thing, so identical content collapses to one sha. */
function sha(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

/** Real GitHub wraps blob base64 at 60 columns. Reproduced so our decoder has to cope. */
function wrapBase64(base64: string): string {
  return (base64.match(/.{1,60}/g) ?? []).join('\n') + '\n';
}

export interface RecordedRequest {
  method: string;
  path: string;
  body?: unknown;
}

/** A failure the fake should inject on the NEXT matching request — for the error-path tests. */
export interface FailureRule {
  /** Substring match on the request path. */
  match: string;
  status: number;
  headers?: Record<string, string>;
  message?: string;

  /** Fail this many times, then succeed. Omit = fail forever. */
  times?: number;
}

/**
 * The shared repo model behind both fakes.
 *
 * Deliberately stores bytes as base64 with NO wrapping internally: wrapping is a wire-format quirk of
 * GitHub's read API, applied at egress, so the GitLab fake does not inherit it.
 */
export class FakeRepoStore {
  /** blobSha → unwrapped base64 content. */
  readonly blobs = new Map<string, string>();

  /** treeSha → path → blobSha. */
  readonly trees = new Map<string, Map<string, string>>();

  /** commitSha → {treeSha, parents, message}. */
  readonly commits = new Map<string, { treeSha: string; parents: string[]; message: string }>();

  /**
   * branch → commitSha.
   *
   * ⚠️ **ONE NAMESPACE FOR THE WHOLE FAKE, not one per repository** — as are `blobs`, `trees` and
   * `commits`. The fake models one repository's git data and a SET of names that exist, which has
   * been sufficient because every path through it operates on a single repo. Stated here because it
   * bounds what a cross-repo test can prove: listing branches for repo B returns repo A's branches,
   * so a test asserting isolation must assert on the REQUEST (`h.requests` — the path actually sent)
   * or on an unregistered repo's 404, never on the returned branch names. A test that appears to
   * prove per-repo isolation against this fake is proving nothing, which is worse than not having it.
   */
  readonly branches = new Map<string, string>();

  readonly repos = new Set<string>();

  /**
   * fullName → default branch, for repos that do not use the fake's own default.
   *
   * ⚠️ Separate from `repos` rather than replacing it with a `Map`, and that is not laziness: both
   * fakes and two spec files already read `repos` as a set of names, and a repo whose metadata is
   * missing must still EXIST. A `Map` makes "registered" and "has metadata" the same fact, so a test
   * that forgets the second silently asserts against the first.
   *
   * It exists at all because `default_branch: 'main'` used to be hardcoded at four call sites, which
   * meant every repository in every fake agreed — and a `getDefaultBranch` test cannot tell a real
   * lookup from a constant when every answer is the same constant.
   */
  readonly defaultBranches = new Map<string, string>();

  /**
   * Branches the provider will refuse to write.
   *
   * A set rather than a flag on the branch, for `defaultBranches`' stated reason: a branch that exists
   * and is unprotected must still EXIST, so "registered" and "has metadata" stay different facts.
   */
  readonly protectedBranches = new Set<string>();

  /** The fake's own default, matching what both providers create a repo with. */
  static readonly DEFAULT_BRANCH = 'main';

  /** Register a repo, optionally with a default branch that is NOT `main`. */
  addRepo(fullName: string, defaultBranch?: string): void {
    this.repos.add(fullName);

    if (defaultBranch) {
      this.defaultBranches.set(fullName, defaultBranch);
    }
  }

  defaultBranchOf(fullName: string): string {
    return this.defaultBranches.get(fullName) ?? FakeRepoStore.DEFAULT_BRANCH;
  }

  putBlobBase64(base64: string): string {
    const id = sha(`blob:${base64}`);
    this.blobs.set(id, base64);

    return id;
  }

  putBlobUtf8(text: string): string {
    return this.putBlobBase64(Buffer.from(text, 'utf-8').toString('base64'));
  }

  putTree(entries: Array<{ path: string; sha: string }>): string {
    const id = sha(`tree:${entries.map((e) => `${e.path}:${e.sha}`).join('|')}`);
    this.trees.set(id, new Map(entries.map((e) => [e.path, e.sha])));

    return id;
  }

  putCommit(treeSha: string, parents: string[], message: string): string {
    const id = sha(`commit:${treeSha}:${parents.join(',')}:${message}:${this.commits.size}`);
    this.commits.set(id, { treeSha, parents, message });

    return id;
  }

  /** The file map of a branch as `path → unwrapped base64`, for assertions. */
  filesAt(branch: string): Map<string, string> {
    const head = this.branches.get(branch);
    const out = new Map<string, string>();

    if (!head) {
      return out;
    }

    const tree = this.trees.get(this.commits.get(head)!.treeSha)!;

    for (const [path, blobSha] of tree) {
      out.set(path, this.blobs.get(blobSha)!);
    }

    return out;
  }

  /**
   * A branch's commits, newest first, walked through first parents.
   *
   * ⚠️ It takes a BRANCH NAME, and returns `[]` for one that does not exist rather than throwing — a
   * history read of an absent branch is an empty list on both providers, not a failure.
   */
  historyOf(branch: string): Array<{ sha: string; message: string }> {
    const out: Array<{ sha: string; message: string }> = [];
    let cursor = this.branches.get(branch);

    /* Bounded: a fake with a cyclic parent chain must fail a test, never hang the suite. */
    for (let step = 0; cursor && step < 1000; step++) {
      const commit = this.commits.get(cursor);

      if (!commit) {
        break;
      }

      out.push({ sha: cursor, message: commit.message });
      cursor = commit.parents[0];
    }

    return out;
  }

  /** Seed a branch with content, as if a user had pushed from VS Code. */
  seedBranch(branch: string, files: Record<string, { content: string; base64?: boolean }>): string {
    const entries = Object.entries(files).map(([path, file]) => ({
      path,
      sha: file.base64 ? this.putBlobBase64(file.content) : this.putBlobUtf8(file.content),
    }));

    const treeSha = this.putTree(entries);
    const commitSha = this.putCommit(treeSha, [], 'seed');
    this.branches.set(branch, commitSha);

    return commitSha;
  }
}

class FakeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly response: { headers: Record<string, string> },
  ) {
    super(message);
  }
}

/**
 * A fake Octokit — only the endpoints `GitHubProvider` actually calls.
 *
 * Typed as `any` at the boundary because reproducing Octokit's full generated types would be a
 * multi-thousand-line exercise that tests nothing; the provider's real type-safety against Octokit is
 * checked by `tsc` at the call site, not here.
 */
export function createFakeGitHub(options: { login?: string; store?: FakeRepoStore } = {}) {
  const store = options.store ?? new FakeRepoStore();
  const login = options.login ?? 'testuser';
  const requests: RecordedRequest[] = [];
  const failures: FailureRule[] = [];

  const maybeFail = (path: string) => {
    const rule = failures.find((f) => path.includes(f.match) && (f.times === undefined || f.times > 0));

    if (!rule) {
      return;
    }

    if (rule.times !== undefined) {
      rule.times--;
    }

    throw new FakeHttpError(rule.status, rule.message ?? `Injected ${rule.status}`, { headers: rule.headers ?? {} });
  };

  /**
   * Record the request, THEN decide whether it fails.
   *
   * The order matters. `requests` means "what the provider sent us", and a request that got a 500 was
   * still sent — so failing first made every failed call invisible. Two things that costs us: a test
   * cannot assert "only ONE attempt was made" on an error path (the attempts leave no trace), and the
   * contract suite's `JSON.stringify(requests)` secret scan would not see a `.env` that went out on a
   * request the provider happened to reject.
   */
  const record = (method: string, path: string, body?: unknown) => {
    requests.push({ method, path, body });
    maybeFail(path);
  };

  const octokit = {
    users: {
      getAuthenticated: async () => {
        record('GET', '/user');
        return { data: { login } };
      },
    },
    repos: {
      /**
       * ⚠️ `auto_init` IS MODELLED, because ignoring it is what let `auto_init:false` ship.
       *
       * Real GitHub's Git Data API refuses to work at all on a repository with no commits — blobs,
       * trees and commits all answer 409. So `auto_init:true` is not cosmetic: it is the difference
       * between a usable repo and a total outage of Save. A fake that ignores the flag cannot tell those
       * two worlds apart, and every test passes in both.
       */
      createForAuthenticatedUser: async (params: {
        name: string;
        private: boolean;
        description?: string;
        auto_init?: boolean;
      }) => {
        record('POST', '/user/repos', params);

        const fullName = `${login}/${params.name}`;

        if (store.repos.has(fullName)) {
          // Real GitHub: 422 "name already exists on this account".
          throw new FakeHttpError(422, 'Repository creation failed: name already exists on this account.', {
            headers: {},
          });
        }

        store.repos.add(fullName);

        /*
         * auto_init makes GitHub write an initial commit (a README) — which is what makes the repo
         * non-empty, and therefore what makes the Git Data API usable at all.
         */
        if (params.auto_init) {
          const tree = store.putTree([{ path: 'README.md', sha: store.putBlobUtf8(`# ${params.name}\n`) }]);
          store.branches.set('main', store.putCommit(tree, [], 'Initial commit'));
        }

        return { data: { full_name: fullName, default_branch: store.defaultBranchOf(fullName) } };
      },
      listBranches: async (params: { owner: string; repo: string; per_page: number; page: number }) => {
        record('GET', `/repos/${params.owner}/${params.repo}/branches`, params);

        const fullName = `${params.owner}/${params.repo}`;

        if (!store.repos.has(fullName)) {
          throw new FakeHttpError(404, 'Not Found', { headers: {} });
        }

        /*
         * ⚠️ 409, NOT an empty array. A repository with no commits refuses every ref read on real
         * GitHub — the same quirk that broke every first save in 2026-07 (`isEmptyRepository`). A
         * fake that returned `[]` here would let an adapter with no empty-repo handling pass, and the
         * failure would then appear only against real GitHub, on a repo Save had just created.
         */
        if (store.commits.size === 0) {
          throw new FakeHttpError(409, 'Git Repository is empty.', { headers: {} });
        }

        const all = [...store.branches].map(([name, sha]) => ({
          name,
          commit: { sha },
          protected: store.protectedBranches.has(name),
        }));

        const start = (params.page - 1) * params.per_page;

        return { data: all.slice(start, start + params.per_page) };
      },
      listCommits: async (params: { owner: string; repo: string; sha: string; per_page: number; page: number }) => {
        record('GET', `/repos/${params.owner}/${params.repo}/commits`, params);

        const fullName = `${params.owner}/${params.repo}`;

        if (!store.repos.has(fullName)) {
          throw new FakeHttpError(404, 'Not Found', { headers: {} });
        }

        if (store.commits.size === 0) {
          throw new FakeHttpError(409, 'Git Repository is empty.', { headers: {} });
        }

        const history = store.historyOf(params.sha).map((entry) => ({
          sha: entry.sha,
          commit: { message: entry.message, author: { name: 'Fake Author', date: '2026-08-21T00:00:00Z' } },
        }));

        const start = (params.page - 1) * params.per_page;

        return { data: history.slice(start, start + params.per_page) };
      },
      get: async (params: { owner: string; repo: string }) => {
        record('GET', `/repos/${params.owner}/${params.repo}`);

        const fullName = `${params.owner}/${params.repo}`;

        if (!store.repos.has(fullName)) {
          throw new FakeHttpError(404, 'Not Found', { headers: {} });
        }

        return { data: { full_name: fullName, default_branch: store.defaultBranchOf(fullName) } };
      },
    },
    git: {
      /**
       * 🔴 AN EMPTY REPOSITORY ANSWERS 409, NOT 404 — the fake said 404 and that hid a total outage.
       *
       * This one line asserted a belief about GitHub that is FALSE, and every test agreed with it. Real
       * GitHub distinguishes two states this used to collapse into one:
       *
       *   - the REPOSITORY has no commits at all -> 409 "Git Repository is empty."
       *   - the repo has commits, this BRANCH does not exist -> 404 "Not Found"
       *
       * `Save` CREATES the repo (§4.5.4b), so the first state is the one every new project hits, on its
       * very first save — and `getBranchHead` only mapped 404 to null, so it threw and the save failed
       * with "Not saved". **The one path every new project must take had never worked**, and the whole
       * suite was green because the fake was wrong in exactly the same direction as the code.
       *
       * Found by pushing to real github.com (2026-07-17), which CLAUDE.md said was the honest next thing
       * and predicted this precise failure: "every test points at a fake server that we wrote to match
       * our own understanding of the API".
       */
      getRef: async (params: { ref: string }) => {
        record('GET', `/git/ref/${params.ref}`);

        const branch = params.ref.replace(/^heads\//, '');
        const head = store.branches.get(branch);

        if (!head) {
          throw store.commits.size === 0
            ? new FakeHttpError(409, 'Git Repository is empty.', { headers: {} })
            : new FakeHttpError(404, 'Not Found', { headers: {} });
        }

        return { data: { object: { sha: head } } };
      },
      createBlob: async (params: { content: string; encoding: 'utf-8' | 'base64' }) => {
        record('POST', '/git/blobs', params);

        /*
         * 🔴 THE WALL. Real GitHub's Git Data API refuses EVERYTHING on a repository with no commits —
         * not just ref reads. This is the 409 that actually broke Save (measured live 2026-07-17: eight
         * retried `POST /git/blobs -> 409` before the save gave up), and it is why `auto_init` must be
         * true: there is no way to write the first commit through this API at all.
         *
         * Modelled here so nobody can "tidy" `auto_init` back to false and still see a green suite.
         */
        if (store.commits.size === 0) {
          throw new FakeHttpError(409, 'Git Repository is empty.', { headers: {} });
        }

        /*
         * Real GitHub normalises both encodings to stored BYTES. Reproducing that is what makes the
         * round-trip test meaningful: push utf-8, read back base64.
         */
        const base64 =
          params.encoding === 'base64'
            ? params.content.replace(/\s/g, '')
            : Buffer.from(params.content).toString('base64');

        return { data: { sha: store.putBlobBase64(base64) } };
      },
      createTree: async (params: { tree: Array<{ path: string; sha: string }> }) => {
        record('POST', '/git/trees', params);
        return { data: { sha: store.putTree(params.tree.map((t) => ({ path: t.path, sha: t.sha }))) } };
      },
      createCommit: async (params: { message: string; tree: string; parents: string[] }) => {
        record('POST', '/git/commits', params);
        return { data: { sha: store.putCommit(params.tree, params.parents, params.message) } };
      },
      updateRef: async (params: { ref: string; sha: string; force: boolean }) => {
        record('PATCH', `/git/refs/${params.ref}`, params);

        const branch = params.ref.replace(/^heads\//, '');
        const current = store.branches.get(branch);
        const commit = store.commits.get(params.sha);

        /*
         * Real GitHub enforces fast-forward when force=false: the update is rejected unless the current
         * head is an ancestor of the new commit. Our provider must never be the only thing standing
         * between a user and a clobbered branch, so the fake enforces it too.
         */
        if (!params.force && current && !commit?.parents.includes(current)) {
          throw new FakeHttpError(422, 'Update is not a fast forward', { headers: {} });
        }

        store.branches.set(branch, params.sha);

        return { data: {} };
      },
      createRef: async (params: { ref: string; sha: string }) => {
        record('POST', '/git/refs', params);

        const branch = params.ref.replace(/^refs\/heads\//, '');

        /*
         * ⚠️ REAL GITHUB REFUSES A CREATE ONTO AN EXISTING REF with 422 "Reference already exists" —
         * `createRef` has no `force` and cannot move one. A fake that overwrote instead would let a
         * provider that silently clobbers somebody's branch pass every test, which is the one
         * outcome `GitProvider.createBranch`'s comment calls a force-push wearing a friendlier verb.
         */
        if (store.branches.has(branch)) {
          throw new FakeHttpError(422, 'Reference already exists', { headers: {} });
        }

        /*
         * ⚠️ REAL GITHUB RETURNS 422 FOR AN UNKNOWN SHA TOO — "Object does not exist" — i.e. the SAME
         * status as the duplicate above, with only the prose distinguishing them. Modelling it is what
         * lets a test prove `createBranch` does not report "that name is taken" for a bad source sha.
         * A fake that accepted any sha makes that defect unreachable, which is how it shipped.
         */
        if (!store.commits.has(params.sha)) {
          throw new FakeHttpError(422, 'Object does not exist', { headers: {} });
        }

        store.branches.set(branch, params.sha);

        return { data: {} };
      },
      deleteRef: async (params: { ref: string }) => {
        record('DELETE', `/git/refs/${params.ref}`, params);

        const branch = params.ref.replace(/^heads\//, '');

        /* Real GitHub: 422 "Reference does not exist" — NOT a 404, which is what one would guess. */
        if (!store.branches.has(branch)) {
          throw new FakeHttpError(422, 'Reference does not exist', { headers: {} });
        }

        store.branches.delete(branch);

        return { data: {} };
      },
      getCommit: async (params: { commit_sha: string }) => {
        record('GET', `/git/commits/${params.commit_sha}`);

        const commit = store.commits.get(params.commit_sha);

        if (!commit) {
          throw new FakeHttpError(404, 'Not Found', { headers: {} });
        }

        return { data: { tree: { sha: commit.treeSha } } };
      },
      getTree: async (params: { tree_sha: string }) => {
        record('GET', `/git/trees/${params.tree_sha}`);

        const tree = store.trees.get(params.tree_sha);

        if (!tree) {
          throw new FakeHttpError(404, 'Not Found', { headers: {} });
        }

        return {
          data: {
            truncated: truncateNext.value,
            tree: [...tree].map(([path, blobSha]) => ({ path, sha: blobSha, type: 'blob' })),
          },
        };
      },
      getBlob: async (params: { file_sha: string }) => {
        record('GET', `/git/blobs/${params.file_sha}`);

        const content = store.blobs.get(params.file_sha);

        if (content === undefined) {
          throw new FakeHttpError(404, 'Not Found', { headers: {} });
        }

        // Real GitHub ALWAYS returns base64, wrapped at 60 columns — even for plain text.
        return { data: { content: wrapBase64(content), encoding: 'base64' } };
      },
    },
  };

  const truncateNext = { value: false };

  return {
    store,
    requests,
    octokit: octokit as unknown as import('@octokit/rest').Octokit,

    /** Inject a provider failure (rate limit, auth, 5xx) on the next matching request. */
    failWith: (rule: FailureRule) => failures.push(rule),

    /** Make the next tree read report GitHub's silent truncation. */
    setTruncated: (value: boolean) => (truncateNext.value = value),
  };
}

/** A fake GitLab REST API as a `fetch` implementation. */
export function createFakeGitLab(options: { login?: string; store?: FakeRepoStore } = {}) {
  const store = options.store ?? new FakeRepoStore();
  const login = options.login ?? 'testuser';
  const requests: RecordedRequest[] = [];
  const failures: FailureRule[] = [];

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : (input as Request).url);
    const path = url.pathname.replace('/api/v4', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;

    // Record BEFORE failing — a rejected request was still sent. See `record` in the GitHub fake.
    requests.push({ method, path, body });

    const rule = failures.find((f) => path.includes(f.match) && (f.times === undefined || f.times > 0));

    if (rule) {
      if (rule.times !== undefined) {
        rule.times--;
      }

      return json({ message: rule.message ?? `Injected ${rule.status}` }, rule.status, rule.headers);
    }

    if (path === '/user') {
      return json({ username: login });
    }

    if (path === '/projects' && method === 'POST') {
      const fullName = `${login}/${body.path ?? body.name}`;

      if (store.repos.has(fullName)) {
        // Real GitLab: 400 with a validation message, not a 422.
        return json({ message: { path: ['has already been taken'] } }, 400);
      }

      store.repos.add(fullName);

      return json({ path_with_namespace: fullName, default_branch: store.defaultBranchOf(fullName) });
    }

    const projectMatch = path.match(/^\/projects\/([^/]+)(.*)$/);

    if (projectMatch) {
      const rest = projectMatch[2];

      if (rest === '') {
        const fullName = decodeURIComponent(projectMatch[1]);

        return store.repos.has(fullName)
          ? json({ path_with_namespace: fullName, default_branch: store.defaultBranchOf(fullName) })
          : json({ message: '404 Project Not Found' }, 404);
      }

      const branchMatch = rest.match(/^\/repository\/branches\/(.+)$/);

      if (branchMatch) {
        const name = decodeURIComponent(branchMatch[1]);

        if (method === 'DELETE') {
          /* GitLab: 404 for an absent branch — where GitHub uses 422. The seam absorbs the difference. */
          if (!store.branches.has(name)) {
            return json({ message: '404 Branch Not Found' }, 404);
          }

          if (store.protectedBranches.has(name)) {
            return json({ message: 'Protected branch cannot be deleted' }, 405);
          }

          store.branches.delete(name);

          return json(undefined, 204);
        }

        const head = store.branches.get(name);

        return head ? json({ commit: { id: head } }) : json({ message: '404 Branch Not Found' }, 404);
      }

      /*
       * Branch LIST and CREATE share the collection path; the method separates them.
       *
       * The match is strict equality, not a prefix, so `/repository/branches/main` cannot reach here
       * whatever the order — deliberately, because a prefix match would let a single-branch READ fall
       * through to the collection and answer the wrong question with a 200.
       */
      if (rest === '/repository/branches') {
        const fullName = decodeURIComponent(projectMatch[1]);

        if (!store.repos.has(fullName)) {
          return json({ message: '404 Project Not Found' }, 404);
        }

        if (method === 'POST') {
          const name = url.searchParams.get('branch')!;
          const from = url.searchParams.get('ref')!;

          /* Real GitLab validates rather than conflicting: 400, not GitHub's 422. */
          if (store.branches.has(name)) {
            return json({ message: 'Branch already exists' }, 400);
          }

          if (!store.commits.has(from)) {
            return json({ message: '400 Invalid reference name' }, 400);
          }

          store.branches.set(name, from);

          return json({ name, commit: { id: from } });
        }

        /*
         * ⚠️ A project with no commits answers 404 here, where GitHub answers 409. Reproducing BOTH
         * shapes is the point of having two fakes — an adapter that handles only one passes half the
         * contract suite and fails against the other provider in production.
         */
        if (store.commits.size === 0) {
          return json({ message: '404 Repository Not Found' }, 404);
        }

        const entries = [...store.branches].map(([name, sha]) => ({
          name,
          commit: { id: sha },
          default: name === store.defaultBranchOf(fullName),
          protected: store.protectedBranches.has(name),
        }));

        /*
         * 🔴 REAL PAGING, not a permanently-empty `x-next-page`.
         *
         * Every other GitLab arm hardcodes the last-page header, which meant the multi-page walk in
         * `_paginate` was UNREACHABLE through the fake — and that walk is now shared with `fetchTree`,
         * the reload path. An unreachable loop behind a passing suite is the "test drove around the
         * wiring" shape this codebase keeps recording, so the one collection a test can grow past a
         * page pages honestly.
         */
        const perPage = Number(url.searchParams.get('per_page') ?? '100');
        const page = Number(url.searchParams.get('page') ?? '1');
        const start = (page - 1) * perPage;
        const slice = entries.slice(start, start + perPage);
        const hasMore = start + perPage < entries.length;

        return json(slice, 200, { 'x-next-page': hasMore ? String(page + 1) : '' });
      }

      if (rest === '/repository/commits' && method === 'GET') {
        const fullName = decodeURIComponent(projectMatch[1]);

        if (!store.repos.has(fullName)) {
          return json({ message: '404 Project Not Found' }, 404);
        }

        const perPage = Number(url.searchParams.get('per_page') ?? '20');
        const page = Number(url.searchParams.get('page') ?? '1');
        const history = store.historyOf(url.searchParams.get('ref_name') ?? '');
        const start = (page - 1) * perPage;

        return json(
          history.slice(start, start + perPage).map((entry) => ({
            id: entry.sha,
            title: entry.message.split('\n', 1)[0],
            author_name: 'Fake Author',
            created_at: '2026-08-21T00:00:00Z',
          })),
          200,
          { 'x-next-page': '' },
        );
      }

      if (rest.startsWith('/repository/tree')) {
        const refSha = url.searchParams.get('ref')!;
        const commit = store.commits.get(refSha);

        if (!commit) {
          return json({ message: '404 Tree Not Found' }, 404);
        }

        const entries = [...store.trees.get(commit.treeSha)!].map(([p, s]) => ({ id: s, path: p, type: 'blob' }));

        // Reproduce GitLab's pagination: one page here, but the header must be present and empty.
        return json(entries, 200, { 'x-next-page': '' });
      }

      const blobMatch = rest.match(/^\/repository\/blobs\/(.+)$/);

      if (blobMatch) {
        const content = store.blobs.get(blobMatch[1]);

        // GitLab, like GitHub, returns base64 for everything — but unwrapped.
        return content === undefined
          ? json({ message: '404 Blob Not Found' }, 404)
          : json({ content, encoding: 'base64' });
      }

      if (rest === '/repository/commits' && method === 'POST') {
        const branch: string = body.branch;
        const head = store.branches.get(branch);
        const existing = head ? new Map(store.trees.get(store.commits.get(head)!.treeSha)!) : new Map<string, string>();

        for (const action of body.actions as Array<{
          action: string;
          file_path: string;
          content?: string;
          encoding?: string;
        }>) {
          // GitLab has no upsert — the verbs are strict, and the adapter must pick the right one.
          if (action.action === 'create' && existing.has(action.file_path)) {
            return json({ message: `A file with this name already exists: ${action.file_path}` }, 400);
          }

          if (action.action === 'update' && !existing.has(action.file_path)) {
            return json({ message: `A file with this name doesn't exist: ${action.file_path}` }, 400);
          }

          if (action.action === 'delete') {
            existing.delete(action.file_path);
            continue;
          }

          const base64 =
            action.encoding === 'base64'
              ? action.content!.replace(/\s/g, '')
              : Buffer.from(action.content!, 'utf-8').toString('base64');

          existing.set(action.file_path, store.putBlobBase64(base64));
        }

        const treeSha = store.putTree([...existing].map(([path, s]) => ({ path, sha: s })));
        const commitSha = store.putCommit(treeSha, head ? [head] : [], body.commit_message);
        store.branches.set(branch, commitSha);

        return json({ id: commitSha, parent_ids: head ? [head] : [] });
      }
    }

    return json({ message: `Unhandled ${method} ${path}` }, 404);
  };

  return {
    store,
    requests,
    fetchImpl,
    failWith: (rule: FailureRule) => failures.push(rule),
  };
}
