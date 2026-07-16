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

  /** branch → commitSha. */
  readonly branches = new Map<string, string>();

  readonly repos = new Set<string>();

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
      createForAuthenticatedUser: async (params: { name: string; private: boolean; description?: string }) => {
        record('POST', '/user/repos', params);

        const fullName = `${login}/${params.name}`;

        if (store.repos.has(fullName)) {
          // Real GitHub: 422 "name already exists on this account".
          throw new FakeHttpError(422, 'Repository creation failed: name already exists on this account.', {
            headers: {},
          });
        }

        store.repos.add(fullName);

        return { data: { full_name: fullName, default_branch: 'main' } };
      },
      get: async (params: { owner: string; repo: string }) => {
        record('GET', `/repos/${params.owner}/${params.repo}`);

        const fullName = `${params.owner}/${params.repo}`;

        if (!store.repos.has(fullName)) {
          throw new FakeHttpError(404, 'Not Found', { headers: {} });
        }

        return { data: { full_name: fullName, default_branch: 'main' } };
      },
    },
    git: {
      getRef: async (params: { ref: string }) => {
        record('GET', `/git/ref/${params.ref}`);

        const branch = params.ref.replace(/^heads\//, '');
        const head = store.branches.get(branch);

        if (!head) {
          throw new FakeHttpError(404, 'Not Found', { headers: {} });
        }

        return { data: { object: { sha: head } } };
      },
      createBlob: async (params: { content: string; encoding: 'utf-8' | 'base64' }) => {
        record('POST', '/git/blobs', params);

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
        store.branches.set(params.ref.replace(/^refs\/heads\//, ''), params.sha);

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

      return json({ path_with_namespace: fullName, default_branch: 'main' });
    }

    const projectMatch = path.match(/^\/projects\/([^/]+)(.*)$/);

    if (projectMatch) {
      const rest = projectMatch[2];

      if (rest === '') {
        const fullName = decodeURIComponent(projectMatch[1]);

        return store.repos.has(fullName)
          ? json({ path_with_namespace: fullName, default_branch: 'main' })
          : json({ message: '404 Project Not Found' }, 404);
      }

      const branchMatch = rest.match(/^\/repository\/branches\/(.+)$/);

      if (branchMatch) {
        const head = store.branches.get(decodeURIComponent(branchMatch[1]));

        return head ? json({ commit: { id: head } }) : json({ message: '404 Branch Not Found' }, 404);
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
