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
 * Every token a provider is ever built with on this route — the direct observation.
 *
 * The IMPORT op (`op: 'clone'`, §4.13) is the one operation here that can legitimately run with NO
 * credential at all: a public repository clones for a user who has never connected an account. That
 * makes "it returned 401" a weaker signal for clone than it is for push — a clone can fail for reasons
 * that have nothing to do with the token — so the assertion that actually matters is this one: whatever
 * the caller put in the body, the string the provider gets is never it.
 *
 * Only `buildProvider` (the ANONYMOUS constructor) is replaced. `resolveProvider` stays real, so the
 * empty token store still produces the genuine `auth` failure and the fallback under test is the
 * shipped one, not a stub of it.
 */
const providerTokens: string[] = [];

vi.mock('./resolve', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return {
    ...actual,
    buildProvider: (_provider: string, token: string) => {
      providerTokens.push(token);

      // A repository an anonymous read cannot see — the connect-prompt path (`git/clone.ts`).
      return { getDefaultBranch: async () => null, fetchTree: async () => null };
    },
  };
});

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
  providerTokens.length = 0;
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
  it.each([
    'push',
    'pull',

    /*
     * The seven branch-client ops (§4.13a). Every one of them reaches a provider on the SESSION's
     * credential, so every one of them is a door the deleted `body.token` path could be reintroduced
     * through — and `branches`, `commits` and `tree` are the ones most likely to look harmless, being
     * reads. They are listed individually rather than derived from the route's `op` union on purpose:
     * a list generated from the code under test grows silently when the code does, which is the one
     * thing this file exists to prevent.
     */
    'branches',
    'commits',
    'tree',
    'create-branch',
    'delete-branch',
    'switch-branch',
    'discard',
  ])('ignores body.token on %s and demands a real connection', async (op) => {
    const response = await post({ op, token: 'gho_a_token_the_client_supplied' });
    const payload = (await response.json()) as {
      ok?: boolean;
      reconnect?: boolean;
      kind?: string;
      message?: string;
    };

    expect(response.status).toBe(401);
    expect(payload).toMatchObject({ reconnect: true, kind: 'auth' });
    expect(payload.message).toMatch(/connect/i);

    // A lapsed connection is LOUD — never an op that quietly does nothing and reports success.
    expect(payload).not.toMatchObject({ ok: true });

    /*
     * ⚠️ A FORWARD guard, and vacuous today — say so rather than let it read as coverage.
     * For these ops `resolveProvider` throws on the empty store before `buildProvider` is ever
     * reached, so `providerTokens` is empty and this passes trivially. The non-vacuous version of
     * this assertion is the clone case below, which asserts `length > 0` first. This line exists so
     * that an op which later grows an anonymous-read path cannot acquire one built from body.token.
     */
    expect(providerTokens).not.toContain('gho_a_token_the_client_supplied');
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

  /**
   * IMPORT (`op: 'clone'`, §4.13) — the op this whole feature added, and the one that superseded the
   * flow this file exists because of.
   *
   * Before it, cloning asked the user by `window.prompt` for a username and a personal access token,
   * stored that credential in a plaintext, non-httpOnly `git:<domain>` cookie, and sent it as browser
   * Basic auth. So the request shape this test drives — a token in the body AND a connector cookie on
   * the header — is not a hypothetical regression, it is exactly what the product used to do. Both are
   * present here and both must be inert.
   */
  it('ignores body.token AND the connector cookie on a clone, and demands a connection', async () => {
    const response = await post({
      op: 'clone',
      repo: 'octocat/private-thing',
      token: 'gho_a_token_the_client_supplied',
      username: 'octocat',
      password: 'hunter2',
    });

    const payload = (await response.json()) as { ok?: boolean; reconnect?: boolean; kind?: string; message?: string };

    expect(response.status).toBe(401);
    expect(payload).toMatchObject({ reconnect: true, kind: 'auth' });
    expect(payload).not.toMatchObject({ ok: true });

    // A CONNECT prompt, never a credential prompt — the whole point of superseding the old flow.
    expect(payload.message).toMatch(/connect/i);
    expect(payload.message).not.toMatch(/token|password|username/i);
  });

  /**
   * ⚠️ The assertion that a 401 alone cannot make.
   *
   * A clone MAY legitimately run unauthenticated (a public repo), so "it refused" does not by itself
   * prove the body's token was ignored — a route that honoured it would also refuse, for a different
   * reason, against a repo that does not exist. This reads the token the provider was actually
   * constructed with: it is the empty string, and it is never the one the caller sent.
   */
  it('never builds a provider from a caller-supplied credential', async () => {
    await post({ op: 'clone', repo: 'octocat/private-thing', token: 'gho_a_token_the_client_supplied' });

    expect(providerTokens.length).toBeGreaterThan(0);
    expect(providerTokens).not.toContain('gho_a_token_the_client_supplied');
    expect(providerTokens.every((t) => t === '')).toBe(true);
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

  /** The clone helper reads its credential from the SESSION; there is no other input it could take. */
  it('the clone module neither declares nor reads a caller-supplied credential', async () => {
    const source = await code('app/lib/.server/git/clone.ts');

    expect(source).not.toMatch(/^\s*(token|username|password)\??:/m);
    expect(source).not.toMatch(/body\.(token|username|password)/);
    expect(source).not.toMatch(/git:github\.com|parseCookies|headers\.get\(['"]?[Cc]ookie/);
  });

  /**
   * The other half: the browser must not be holding one to send.
   *
   * ⚠️ These assertions are `/token/i` against the WHOLE file, which is deliberately blunt — it fires
   * on an identifier, a comment, a prop name, anything. That is only tolerable because these components
   * genuinely have no business naming a credential at all: they post a repo coordinate and the server
   * does the rest. A future component that legitimately needs the word will need a narrower rule here,
   * not an exemption.
   *
   * The two IMPORT doors are listed for the reason the file exists: cloning is where the browser used
   * to prompt for a PAT and write it to a cookie, so they are the components most likely to have it put
   * back. `StarterTemplates` is not listed separately — it links to `/git?url=…` and reaches the
   * workspace through `GitUrlImport`, so it is covered by the door it goes through.
   */
  it.each([
    ['the sync UI', 'app/components/github/GitHubSyncButton.tsx'],
    ['the clone button', 'app/components/chat/GitCloneButton.tsx'],
    ['the /git?url= import', 'app/components/git/GitUrlImport.client.tsx'],
  ])('%s holds no token and sends none', async (_label, file) => {
    const source = await code(file);

    expect(source).not.toMatch(/token/i);
    expect(source).not.toMatch(/localStorage|githubConnectionStore/);
  });
});
