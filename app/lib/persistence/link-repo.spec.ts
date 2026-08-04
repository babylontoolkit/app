/**
 * The client half of "record where this project lives" (§4.5.4b, T9 of
 * `_specs/server-side-git-clone_plan.md`).
 *
 * A separate file from `clone-repo.spec.ts` rather than a block inside it, deliberately: that file's
 * header is a contract for the CLONE — the map normalisation at the fetch boundary, the credential that
 * never leaves the server — and none of it is true of the link, whose single reason to exist is the
 * opposite kind of claim (one field that must be on the wire). Folding them makes the doc comment of
 * each half describe the other.
 *
 * Two properties, both silent:
 *
 *   - **`provider` is on the wire.** The route defaults a missing provider to `github` for rows linked
 *     before §4.5.4b, so an omission does not fail — it records a GitLab project as GitHub, and the
 *     first symptom is a push resolving the wrong token against the wrong host. Asserted on the
 *     SERIALIZED body: an arguments-shaped check passes for a value that was destructured away before
 *     `JSON.stringify` ran.
 *   - **It returns an outcome and never throws.** Its one production caller runs it after an import's
 *     files have already landed, inside that function's rollback `catch` — so a throw here does not
 *     lose a pointer, it deletes the project. Every failure shape is asserted as a VALUE, each with a
 *     control proving the assertion could have seen a throw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkProjectToRepo } from './projects';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** An HTML error page: a real `Response` whose `.json()` rejects, which is how this reaches us live. */
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

const link = (provider: 'github' | 'gitlab' = 'gitlab') =>
  linkProjectToRepo('proj-42', { repo: 'group/my-game', branch: 'trunk', provider });

describe('the request it actually sends', () => {
  it('POSTs the complete tuple under `op: "link"` with the session cookie', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await link();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe('/api/projects/proj-42/github');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(init.body as string)).toEqual({
      op: 'link',
      repo: 'group/my-game',
      branch: 'trunk',
      provider: 'gitlab',
    });
  });

  /**
   * 🔴 The reason the wrapper exists at all. Asserted on the raw body text as well as the parsed
   * object, because `provider: undefined` disappears entirely through `JSON.stringify` — a deep-equal
   * against an object that also omits it would agree with a body that silently dropped the field.
   */
  it('always carries `provider` on the wire', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await link('gitlab');

    const body = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string;

    expect(body).toContain('"provider"');
    expect(body).toContain('"gitlab"');
  });

  /**
   * 🔴 The commit an import already holds must reach the wire, or every later open of that project
   * mounts as `diverged` against the commit it was cloned from (measured live 2026-08-03; see
   * `mount-source.spec.ts` for the rule and for what the false divergence costs downstream).
   *
   * Asserted on the raw body for the same reason `provider` is: `head: undefined` vanishes through
   * `JSON.stringify`, so a deep-equal against an object that also omits it agrees with a wrapper that
   * silently dropped the field.
   */
  it('carries the cloned head when the caller has one', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await linkProjectToRepo('proj-42', {
      repo: 'group/my-game',
      branch: 'trunk',
      provider: 'github',
      head: 'a'.repeat(40),
    });

    const body = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string;

    expect(body).toContain('"head"');
    expect(JSON.parse(body)).toMatchObject({ head: 'a'.repeat(40) });
  });

  /* The CONTROL: a bare link has no head, and must not invent one. */
  it('omits head entirely when the caller has none', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await link();

    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string).not.toContain('"head"');
  });

  it('carries github just as explicitly', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await link('github');

    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).toMatchObject({
      provider: 'github',
    });
  });
});

describe('failures are values, never throws', () => {
  it('turns a 4xx refusal into `{ ok: false }` carrying the server’s words', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, message: 'That project is not yours.' }, 404));

    const outcome = await link().catch(() => 'THREW' as const);

    // The control: had it thrown, this is what we would be looking at.
    expect(outcome).not.toBe('THREW');
    expect(outcome).toEqual({ ok: false, message: 'That project is not yours.' });
  });

  it('turns a 5xx into `{ ok: false }` and names the status when the body says nothing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 503));

    const outcome = await link().catch(() => 'THREW' as const);

    expect(outcome).not.toBe('THREW');
    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining('503') });
  });

  it('turns a dead socket into `{ ok: false }` rather than an unhandled rejection', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const outcome = await link().catch(() => 'THREW' as const);

    expect(outcome).not.toBe('THREW');
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { message?: string }).message).toBeTruthy();
  });

  /** An HTML 500 page must not become a silent success — the project would read LINKED with no row behind it. */
  it('does not let a non-JSON body become a success', async () => {
    fetchMock.mockResolvedValue(htmlResponse(500));

    const outcome = await link().catch(() => 'THREW' as const);

    expect(outcome).not.toBe('THREW');
    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining('500') });
  });

  /** A 200 whose body forgot to say `ok` is not an agreement either. */
  it('does not treat a 200 with no `ok` as linked', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await expect(link()).resolves.toMatchObject({ ok: false });
  });
});

describe('the happy path', () => {
  it('reports `{ ok: true }` and nothing else', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, project: { id: 'proj-42' } }));

    await expect(link()).resolves.toEqual({ ok: true });
  });
});
