/**
 * The client half of the server-side clone (§4.13, T5 of `_specs/server-side-git-clone_plan.md`).
 *
 * Two properties are load-bearing here and both fail SILENTLY:
 *
 *   - **It returns an outcome and never throws.** An import is long, visible, and expensive, and it
 *     runs with a project already registered behind it. A thrown error at a caller that forgot a
 *     `catch` is a spinner that stops and a user who does not know why — the opposite of §4.5.4b's
 *     "a failed save is LOUD". So every failure shape (401, an HTML 500 page, a dead socket) is
 *     asserted here as a VALUE, each with a control proving the assertion could see a throw.
 *   - **The map is normalised at the fetch boundary, identically to the pull path.** A repo carrying
 *     a nested workdir prefix round-trips its damage into the sandbox otherwise, and an import is the
 *     FIRST thing that happens to these files — every later path inherits whatever lands here. The
 *     test drives `pullFromRepo` and `cloneRepoIntoProject` with the SAME payload and compares, which
 *     is an assertion a hand-copied second normaliser cannot satisfy.
 *
 * And one that is a security boundary rather than a correctness one: the browser sends no credential.
 * That is asserted on the SERIALIZED body, not on the arguments object — a token added to `input` and
 * spread into the payload would pass an arguments-shaped check and still ship on the wire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import { cloneRepoIntoProject, pullFromRepo } from './projects';

const file = (content: string) => ({ type: 'file' as const, content, isBinary: false });

/** A repo written by the `home/project`-only era of `toRepoRelativePath`: everything one level too deep. */
const damagedTree: SerializedFileMap = {
  'project/workspace/src/Game.ts': file('export class Game {}'),
  'project/workspace/README.md': file('# game'),
  'project/workspace': { type: 'folder' },
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** An HTML 500 page: a real `Response` whose `.json()` rejects, which is how this reaches us live. */
function htmlResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    },
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('cloneRepoIntoProject — the happy path', () => {
  it('carries the server’s answer back intact', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        ok: true,
        files: { 'src/Game.ts': file('export class Game {}') },
        head: 'abc123',
        repo: 'octocat/hello-world',
        branch: 'main',
        provider: 'github',
      }),
    );

    await expect(cloneRepoIntoProject('p1', { repo: 'octocat/hello-world' })).resolves.toEqual({
      ok: true,
      files: { 'src/Game.ts': file('export class Game {}') },
      head: 'abc123',
      repo: 'octocat/hello-world',
      branch: 'main',
      provider: 'github',
    });
  });

  /**
   * A secret the import declined to carry is REPORTED, never silently dropped — the user's `.env` not
   * arriving is a fact they need, and a quiet omission reads as a broken import days later.
   */
  it('carries `skippedSecrets` through to the caller', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: true, files: {}, skippedSecrets: ['.env', '.env.production', '.npmrc'] }),
    );

    const outcome = await cloneRepoIntoProject('p1', { repo: 'octocat/hello-world' });

    expect(outcome.skippedSecrets).toEqual(['.env', '.env.production', '.npmrc']);
  });
});

describe('normalization at the fetch boundary', () => {
  it('heals a nested workdir prefix on the way in', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, files: damagedTree, head: 'abc123' }));

    const outcome = await cloneRepoIntoProject('p1', { repo: 'octocat/hello-world' });

    expect(outcome.files).toEqual({
      'src/Game.ts': file('export class Game {}'),
      'README.md': file('# game'),
    });

    // The workdir root itself normalises to nothing and is dropped, never handed on as a file.
    expect(Object.keys(outcome.files ?? {})).not.toContain('project/workspace');
  });

  /**
   * The assertion that matters: IDENTICAL to the pull path. Comparing against a literal would pass for
   * a second, hand-copied normaliser that has drifted — comparing the two functions' output for one
   * payload cannot.
   */
  it('produces byte-for-byte what `pullFromRepo` produces for the same payload', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, files: damagedTree, head: 'abc123' }));

    const pulled = await pullFromRepo('p1');
    const cloned = await cloneRepoIntoProject('p1', { repo: 'octocat/hello-world' });

    expect(cloned.files).toEqual(pulled.files);

    // Control: the payload really did need normalising, or the comparison above proves nothing.
    expect(pulled.files).not.toEqual(damagedTree);
  });

  it('leaves a healthy tree alone', async () => {
    const healthy: SerializedFileMap = { 'src/Game.ts': file('x'), 'README.md': file('y') };
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, files: healthy }));

    await expect(cloneRepoIntoProject('p1', { repo: 'o/r' })).resolves.toMatchObject({ files: healthy });
  });
});

describe('failures are values, never throws', () => {
  /** The acceptance case: a lapsed connection sends the user back through OAuth, loudly, without throwing. */
  it('surfaces a 401 as `{ ok: false, reconnect: true }` and does not throw', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: false, reconnect: true, message: 'Your GitHub connection expired.' }, 401),
    );

    const outcome = await cloneRepoIntoProject('p1', { repo: 'octocat/private' }).catch(() => 'THREW' as const);

    // The control: had it thrown, this is what we would be looking at.
    expect(outcome).not.toBe('THREW');
    expect(outcome).toMatchObject({ ok: false, reconnect: true });
  });

  it('turns an HTML 500 page into a retryable failure rather than a silent success', async () => {
    fetchMock.mockResolvedValue(htmlResponse(500));

    const outcome = await cloneRepoIntoProject('p1', { repo: 'o/r' }).catch(() => 'THREW' as const);

    expect(outcome).not.toBe('THREW');
    expect(outcome).toMatchObject({ ok: false, retryable: true });
    expect((outcome as { files?: unknown }).files).toBeUndefined();
  });

  /** A 4xx with an unreadable body is NOT retryable — retrying a bad repo name forever helps nobody. */
  it('does not mark an unreadable 4xx retryable', async () => {
    fetchMock.mockResolvedValue(htmlResponse(404));

    await expect(cloneRepoIntoProject('p1', { repo: 'o/r' })).resolves.toMatchObject({
      ok: false,
      retryable: false,
    });
  });

  it('turns a dead socket into a retryable failure rather than an unhandled rejection', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const outcome = await cloneRepoIntoProject('p1', { repo: 'o/r' }).catch(() => 'THREW' as const);

    expect(outcome).not.toBe('THREW');
    expect(outcome).toMatchObject({ ok: false, retryable: true });
  });

  /** A terminal server refusal (a bad coordinate) is passed through as-is, not rewritten as retryable. */
  it('passes a terminal refusal through untouched', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, message: 'That is not a repository URL.' }, 400));

    await expect(cloneRepoIntoProject('p1', { repo: 'not a repo' })).resolves.toEqual({
      ok: false,
      message: 'That is not a repository URL.',
    });
  });
});

describe('the request it actually sends', () => {
  it('POSTs `{ op: "clone", … }` to the project’s git route with the session cookie', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, files: {} }));

    await cloneRepoIntoProject('proj-42', { repo: 'octocat/hello-world', branch: 'dev', provider: 'gitlab' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe('/api/projects/proj-42/github');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(init.body as string)).toEqual({
      op: 'clone',
      repo: 'octocat/hello-world',
      branch: 'dev',
      provider: 'gitlab',
    });
  });

  /**
   * 🔴 The security property of the whole feature: the server resolves the credential from the caller's
   * session, so the BROWSER never holds one. Asserted on the serialized body — an arguments-shaped
   * check passes for a token that was spread into the payload and shipped.
   */
  it('sends no credential of any kind on the wire', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, files: {} }));

    await cloneRepoIntoProject('proj-42', { repo: 'https://ghp_notatoken@github.com/octocat/hello-world.git' });

    const body = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string;

    for (const field of ['token', 'accessToken', 'username', 'password', 'auth', 'credential']) {
      expect(body).not.toContain(`"${field}"`);
    }

    /*
     * Control: the raw coordinate the user typed IS forwarded verbatim (reducing it to a repo — and
     * refusing what it must — is the server's job, `git/clone.ts`), so the scan above is running over
     * a body that genuinely contains credential-shaped text and is matching on FIELDS, not substrings.
     */
    expect(body).toContain('ghp_notatoken');
  });

  it('omits `branch` and `provider` when the caller did not choose them', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, files: {} }));

    await cloneRepoIntoProject('proj-42', { repo: 'octocat/hello-world' });

    const body = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string;

    expect(JSON.parse(body)).toEqual({ op: 'clone', repo: 'octocat/hello-world' });
  });
});
