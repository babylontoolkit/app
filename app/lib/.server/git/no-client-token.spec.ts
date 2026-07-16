/**
 * The client may never supply the git token (SPEC §4.5.4b, §5).
 *
 * ## What this pins, and why a comment was not enough
 *
 * The sync route used to open with `if (body.token) return body.token` — a raw PAT the browser kept in
 * `localStorage` and re-sent in the POST body on every push, with the inherited `git:github.com`
 * connector cookie as a fallback. Under repo-primary persistence that credential stopped being a
 * convenience and became the key to the ONLY permanent copy of the user's game: a token that lives in
 * a browser and crosses the wire on every save is a leak with a retry loop, and unlike a platform key
 * it keeps working off-platform, against the user's whole account, after it leaks.
 *
 * Both paths are deleted. But "we deleted it" is a claim in a doc comment, and this repo has already
 * learned what a false claim in a comment is worth (`shell-strip.ts` said it streamed in real time
 * while withholding files for 51 seconds). So it is asserted two ways:
 *
 *   - **Behaviourally** — a body carrying a token, for a user with no stored connection, must produce
 *     the re-connect prompt. If the field were honoured, that request would succeed instead.
 *   - **At the source level** — the token-from-client shape cannot reappear in the route or the client.
 *     This is the half that catches the real regression: someone re-adding a `token` field in good
 *     faith while debugging, where the behavioural test would still pass because they also wired a
 *     working store. Same discipline as `upstream-routes.spec.ts` and the brand gate.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsProjectStore, setProjectStore } from '~/lib/.server/projects/store';
import { setGitTokenStore, type GitTokenStore } from './token-store';
import type { Project } from '~/lib/.server/projects/types';

const USER = { id: 'user-1', email: 'a@example.com', emailVerified: true } as const;

vi.mock('~/lib/.server/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireVerifiedUser: async () => USER,
  requireUser: async () => USER,
}));

/**
 * A store with no rows: this user has never connected a provider.
 *
 * `put` throws rather than no-oping. A sync request must never CREATE a connection — only the OAuth
 * callback may. If the body's token were ever honoured and filed away, this is what would catch it.
 */
const emptyTokenStore: GitTokenStore = {
  get: async () => null,
  put: async () => {
    throw new Error('The sync route must never write a token — only the OAuth callback may.');
  },
  delete: async () => {
    throw new Error('The sync route must never delete a connection.');
  },
  listByUser: async () => [],
};

let tmp: string;
let project: Project;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'git-token-pin-'));

  const projects = new FsProjectStore(tmp);
  project = await projects.create({
    userId: USER.id,
    name: 'My game',
    templateId: 'racing',
    provider: 'github',
    linkedRepo: 'octocat/my-game',
    linkedBranch: 'main',
  });

  setProjectStore(projects);
  setGitTokenStore(emptyTokenStore);
});

afterEach(async () => {
  setProjectStore(undefined);
  setGitTokenStore(null);
  await fs.rm(tmp, { recursive: true, force: true });
});

async function post(body: Record<string, unknown>) {
  const { action } = await import('~/routes/api.projects.$projectId.github');

  return action({
    request: new Request('https://app.example.com/api/projects/p/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'git:github.com={"token":"gho_from_a_cookie"}' },
      body: JSON.stringify(body),
    }),
    params: { projectId: project.id },
    context: {},
  } as never);
}

describe('the sync route never takes a token from the caller', () => {
  /**
   * The whole point. A token in the body used to BE the auth path; now the request is indistinguishable
   * from one without it, because the field is not read.
   */
  it.each(['push', 'pull'])('ignores body.token on %s and demands a real connection', async (op) => {
    const response = await post({ op, token: 'gho_a_token_the_client_supplied' });
    const payload = (await response.json()) as { reconnect?: boolean; kind?: string; message?: string };

    expect(response.status).toBe(401);
    expect(payload).toMatchObject({ reconnect: true, kind: 'auth' });
    expect(payload.message).toMatch(/connect/i);
  });

  /** The inherited connector cookie was the fallback path. It is gone too — the cookie above is set. */
  it('ignores the inherited git:github.com connector cookie', async () => {
    const response = await post({ op: 'push' });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reconnect: true });
  });

  /** A lapsed connection is LOUD (§4.5.4b) — never a save that quietly does nothing and reports ok. */
  it('never reports ok when it cannot authenticate', async () => {
    const response = await post({ op: 'push', token: 'gho_x' });

    expect(await response.json()).not.toMatchObject({ ok: true });
  });
});

describe('the token-from-client shape cannot reappear', () => {
  /**
   * Comments are stripped before matching, and that is not a convenience — it is the difference
   * between a gate and a tripwire. Both files DOCUMENT the deleted paths by name ("this route used to
   * read `body.token`", "the `git:github.com` cookie fallback is gone"), because a reader who does not
   * know what was removed will put it back. A gate that fires on the explanation of a fix would force
   * someone to delete that explanation to get green — buying a passing test by removing the very
   * warning that keeps the code correct.
   */
  const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  const code = async (file: string) => stripComments(await fs.readFile(path.resolve(process.cwd(), file), 'utf8'));

  it('the route neither declares nor reads a token field', async () => {
    const source = await code('app/routes/api.projects.$projectId.github.ts');

    // A `token` in the Body interface, or any read of one off the parsed body.
    expect(source).not.toMatch(/^\s*token\??:/m);
    expect(source).not.toMatch(/body\.token/);
  });

  it('the route does not read a connector cookie', async () => {
    const source = await code('app/routes/api.projects.$projectId.github.ts');

    expect(source).not.toMatch(/git:github\.com|parseCookies|headers\.get\(['"]?[Cc]ookie/);
  });

  /** The other half: the browser must not be holding one to send. */
  it('the sync UI holds no token and sends none', async () => {
    const source = await code('app/components/github/GitHubSyncButton.tsx');

    expect(source).not.toMatch(/token/i);
    expect(source).not.toMatch(/localStorage|githubConnectionStore/);
  });
});
