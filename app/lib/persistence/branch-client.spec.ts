/**
 * The client half of the branch operations (§4.13a, T9 of `_specs/github-branch-client_plan.md`).
 *
 * A separate file from `link-repo.spec.ts` / `clone-repo.spec.ts` for the reason those two are
 * separate from each other: each of them is a contract for ONE claim, and folding a third in makes
 * every header describe somebody else's function. What is pinned here is the shape shared by all
 * seven helpers, and each property below is silent when it breaks.
 *
 *   - **Every failure is a VALUE.** These helpers replace the user's whole working tree or write to
 *     their own GitHub account, so a failure has to be LOUD at the call site — and a thrown error at
 *     a caller that forgot a `catch` is the opposite of loud: it is a spinner that stops with nothing
 *     said. Asserted with a control (`.catch(() => 'THREW')`) proving each assertion could have seen
 *     a throw, since `expect(x).toMatchObject({ ok: false })` on a value that never arrived is a test
 *     that passes by not running.
 *   - **The refusal shape is normalised.** The route's refusals are `{ error: true, message }` with
 *     NO `ok` field at all, so an outcome built from the payload alone is `{ ok: undefined }` —
 *     falsy, and therefore invisible to a reader, but not the `false` a caller comparing `=== false`
 *     reads. Every refusal fixture here deliberately omits `ok`.
 *   - **A non-JSON body is an outcome, not a `SyntaxError`.** An HTML 500 page is what a proxy or a
 *     dead worker actually returns, and `response.json()` REJECTS on it — the one failure that gets
 *     past a `!response.ok` check and lands as an unhandled rejection (`link-repo.spec.ts:34-43`).
 *   - **Assertions are on the SERIALIZED body**, never on the arguments: an arguments-shaped check
 *     passes for a value that was destructured away before `JSON.stringify` ran, and a field that is
 *     `undefined` disappears through `JSON.stringify` entirely.
 *   - **No helper carries a credential.** The server resolves it from the session
 *     (`no-client-token.spec.ts`); a `token` on the wire here is the deleted browser-PAT flow coming
 *     back through a new door. Asserted on the wire AND at the source level, because the wire test
 *     only sees the parameters a test happens to pass.
 *   - **Files are normalised at the fetch boundary**, as `getRepoStatus`/`pullFromRepo` do. The
 *     fixture carries a nested workdir prefix, so a helper that skipped the normalisation — or one
 *     that "normalised" by returning the map untouched — fails here rather than passing vacuously.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import {
  createBranch,
  deleteBranch,
  discardChanges,
  listBranches,
  listCommits,
  readBranchTree,
  switchBranch,
  type BranchOutcomeBase,
  type BranchTreeOutcome,
} from './projects';

const PROJECT = 'proj-42';
const HEAD = 'a'.repeat(40);

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

/** The body as it went over the wire — parsed back from the string, never read off the arguments. */
function sentBody(): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(init.body as string);
}

function rawBody(): string {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return init.body as string;
}

const dirent = (content: string) => ({ type: 'file' as const, content, isBinary: false });

/** An ordinary, already repo-relative tree — the success fixture, so `toEqual` can stay exact. */
const RELATIVE_TREE: SerializedFileMap = { 'src/main.ts': dirent('export const main = 1;\n') };

interface HelperCase {
  label: string;
  invoke: () => Promise<BranchOutcomeBase>;

  /** The COMPLETE serialized body this call must produce. */
  body: Record<string, unknown>;

  /** A success payload of this helper's own wire shape. */
  success: Record<string, unknown>;
}

const HELPERS: HelperCase[] = [
  {
    label: 'listBranches',
    invoke: () => listBranches(PROJECT),
    body: { op: 'branches' },
    success: { ok: true, branches: [{ name: 'main', head: HEAD, isDefault: true, protected: true }] },
  },
  {
    label: 'listCommits',
    invoke: () => listCommits(PROJECT, { branch: 'feature/hud', limit: 20, cursor: 'page-2' }),
    body: { op: 'commits', branch: 'feature/hud', limit: 20, cursor: 'page-2' },
    success: {
      ok: true,
      commits: [{ sha: HEAD, message: 'add the HUD', author: 'mackey', date: '2026-08-22T00:00:00.000Z' }],
      nextCursor: 'page-3',
    },
  },
  {
    label: 'readBranchTree',
    invoke: () => readBranchTree(PROJECT, { branch: 'feature/hud' }),
    body: { op: 'tree', branch: 'feature/hud' },
    success: { ok: true, branch: 'feature/hud', head: HEAD, files: RELATIVE_TREE },
  },
  {
    label: 'createBranch',
    invoke: () => createBranch(PROJECT, 'feature/hud'),
    body: { op: 'create-branch', name: 'feature/hud' },
    success: { ok: true, branch: 'feature/hud', head: HEAD },
  },
  {
    label: 'deleteBranch',
    invoke: () => deleteBranch(PROJECT, 'old-experiment'),
    body: { op: 'delete-branch', name: 'old-experiment' },
    success: { ok: true, branch: 'old-experiment' },
  },
  {
    label: 'switchBranch',
    invoke: () => switchBranch(PROJECT, 'feature/hud'),
    body: { op: 'switch-branch', branch: 'feature/hud' },
    success: { ok: true, branch: 'feature/hud', head: HEAD, files: RELATIVE_TREE },
  },
  {
    label: 'discardChanges',
    invoke: () => discardChanges(PROJECT),
    body: { op: 'discard' },
    success: { ok: true, branch: 'main', head: HEAD, files: RELATIVE_TREE },
  },
];

describe('the request each helper sends', () => {
  /**
   * 🔴 On the SERIALIZED body, and on the WHOLE body rather than a `toMatchObject` subset: the op
   * string is what the route switches on, so a helper posting `op: 'tree'` where it meant
   * `switch-branch` reads a branch instead of moving the project onto it — a no-op the user
   * experiences as "the switch button does nothing", with a 200 behind it.
   */
  it.each(HELPERS)('$label puts its op and params on the wire', async ({ invoke, body, success }) => {
    fetchMock.mockResolvedValue(jsonResponse(success));

    await invoke();

    expect(sentBody()).toEqual(body);
  });

  it('POSTs to the project git route with the session cookie', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await listBranches(PROJECT);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe(`/api/projects/${PROJECT}/github`);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
  });

  /*
   * The two helpers with an optional input object default it to `{}`. The assertion is exact
   * equality, not `toMatchObject`: `{ op: 'commits', branch: undefined }` and `{ op: 'commits' }`
   * serialize identically, but a spread that invented `{ limit: 0 }` would not — and a zero limit is
   * a page of nothing that reads as "this branch has no history".
   */
  it('listCommits sends the op alone when the caller passes no filters', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, commits: [] }));

    await listCommits(PROJECT);

    expect(sentBody()).toEqual({ op: 'commits' });
  });

  it('readBranchTree sends the op alone when the caller names no branch', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, files: {} }));

    await readBranchTree(PROJECT);

    expect(sentBody()).toEqual({ op: 'tree' });
  });
});

describe('no helper puts a credential on the wire', () => {
  it.each(HELPERS)('$label sends no token field', async ({ invoke, success }) => {
    fetchMock.mockResolvedValue(jsonResponse(success));

    await invoke();

    /*
     * On the raw text as well: a `token: undefined` vanishes through `JSON.stringify`, so a
     * key-based check alone would agree with a wrapper that forwarded one whenever it had one.
     */
    expect(Object.keys(sentBody())).not.toContain('token');
    expect(rawBody()).not.toContain('token');
  });

  /**
   * The half the wire test cannot see: it only ever inspects the parameters this spec chose to pass.
   * A `token` argument re-added in good faith while debugging would be invisible to it and would
   * reach the wire the moment one production caller filled it in. Same discipline as
   * `no-client-token.spec.ts`, which pins the server end of the same rule.
   */
  it('and none of them accepts a token argument', async () => {
    const file = await fs.readFile(path.resolve(process.cwd(), 'app/lib/persistence/projects.ts'), 'utf8');
    const start = file.indexOf('branches */');
    const section = file
      .slice(start)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');

    /*
     * The CONTROL. A renamed section marker would slice to nothing, and `expect('').not.toMatch(…)`
     * passes forever — a scanner that silently matches nothing reports a clean bill of health for
     * code it never read.
     */
    for (const name of [
      'listBranches',
      'listCommits',
      'readBranchTree',
      'createBranch',
      'deleteBranch',
      'switchBranch',
      'discardChanges',
    ]) {
      expect(section).toContain(`export async function ${name}(`);
    }

    expect(section).not.toMatch(/token/i);
  });
});

describe('the happy path', () => {
  it.each(HELPERS)('$label returns the payload it was given', async ({ invoke, success }) => {
    fetchMock.mockResolvedValue(jsonResponse(success));

    await expect(invoke()).resolves.toEqual(success);
  });
});

describe('failures are values, never throws', () => {
  /**
   * The route refuses with `{ error: true, message }` and NO `ok` — the exact shape the wrapper has
   * to normalise. A caller reading `if (outcome.ok === false)` sees nothing at all otherwise, and
   * `!outcome.ok` on `undefined` is only accidentally right.
   */
  it.each(HELPERS)('$label turns a 409 refusal into ok:false with the server’s words', async ({ invoke }) => {
    fetchMock.mockResolvedValue(jsonResponse({ error: true, message: 'That branch is protected.' }, 409));

    const outcome = await invoke().catch(() => 'THREW' as const);

    // The control: had it thrown, this is what we would be looking at.
    expect(outcome).not.toBe('THREW');
    expect(outcome).toMatchObject({ ok: false, message: 'That branch is protected.' });
    expect((outcome as BranchOutcomeBase).ok).toBe(false);

    // A refused branch name is not worth retrying, and nothing may invent that it is.
    expect((outcome as BranchOutcomeBase).retryable).toBeFalsy();
  });

  it.each(HELPERS)('$label turns a 400 refusal into ok:false', async ({ invoke }) => {
    fetchMock.mockResolvedValue(jsonResponse({ error: true, message: 'Choose a branch.' }, 400));

    const outcome = await invoke().catch(() => 'THREW' as const);

    expect(outcome).not.toBe('THREW');
    expect(outcome).toMatchObject({ ok: false, message: 'Choose a branch.' });
  });

  /**
   * 🔴 The one that reaches the call site as an unhandled `SyntaxError` if `.json()` is not guarded:
   * `response.json()` REJECTS on an HTML body, so a `!response.ok` branch never runs.
   */
  it.each(HELPERS)('$label turns an HTML 500 into an outcome, not a SyntaxError', async ({ invoke }) => {
    fetchMock.mockResolvedValue(htmlResponse(500));

    const outcome = await invoke().catch((error: unknown) => (error instanceof SyntaxError ? 'SYNTAX' : 'THREW'));

    expect(outcome).not.toBe('SYNTAX');
    expect(outcome).not.toBe('THREW');
    expect(outcome).toMatchObject({ ok: false, retryable: true, message: expect.stringContaining('500') });
  });

  it.each(HELPERS)('$label turns a dead socket into a retryable outcome', async ({ invoke }) => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const outcome = await invoke().catch(() => 'THREW' as const);

    expect(outcome).not.toBe('THREW');
    expect(outcome).toMatchObject({ ok: false, retryable: true });
    expect((outcome as BranchOutcomeBase).message).toBeTruthy();
  });

  /**
   * `reconnect` is the field that drives the re-auth prompt, and it rides on a refusal — i.e. on the
   * branch that REBUILDS the outcome (`{ ...payload, ok: false }`). A normalisation that returned a
   * fresh object instead of spreading would drop it, and the user would get a flat "that failed" for
   * a lapsed OAuth connection, with the one button that fixes it never rendered.
   */
  it.each(HELPERS)('$label surfaces reconnect from a 401', async ({ invoke }) => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: true, message: 'Reconnect GitHub.', kind: 'auth', reconnect: true }, 401),
    );

    const outcome = await invoke().catch(() => 'THREW' as const);

    expect(outcome).not.toBe('THREW');
    expect(outcome).toMatchObject({ ok: false, reconnect: true, message: 'Reconnect GitHub.' });
  });

  /** A refusal with no words at all still has to say something, or the UI renders an empty alert. */
  it('names the status when the body carries no message', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: true }, 503));

    await expect(listBranches(PROJECT)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('503'),
    });
  });

  /**
   * 🔴 THE RETRY SIGNAL HAS TWO SPELLINGS ON THE WIRE, and reading only one reports a whole class of
   * failure as "not worth retrying".
   *
   * The git route's own mapper (`providerErrorResponse`) sends `retryable`. Anything that is not a
   * `GitProviderError` rethrows to `http.ts`'s uniform envelope, which sends **`isRetryable`** — the
   * same fact under a second name. A client reading only the first would surface a JSON-bodied 500 as
   * `retryable: undefined` while the NON-JSON 500 path infers `true` from the status: the same
   * failure, two different answers, decided by whether the server happened to return JSON.
   *
   * ⚠️ **THE STATUS ON THE FIRST FIXTURE IS LOAD-BEARING AND MUST STAY BELOW 500.** A `500` there
   * confounds the two hypotheses: `payload.retryable ?? (500 >= 500)` is `true` whether or not the
   * `isRetryable` clause exists, so the test named for that clause goes green with it deleted — the
   * exact vacuity this codebase records as "not a weak test, no test". `429` is the shape that
   * actually occurs: `RateLimitedError` is `statusCode 429` + `isRetryable true`, and five of the
   * seven ops are rate-limited server-side, so without the clause a temporary limit is reported to
   * the user as permanent, silently.
   */
  it('reads either spelling of the retry signal, and falls back to the status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: true, message: 'Slow down.', isRetryable: true }, 429));
    await expect(listBranches(PROJECT)).resolves.toMatchObject({ ok: false, retryable: true });

    // The route's own mapper wins when it spoke, even against the status heuristic.
    fetchMock.mockResolvedValue(jsonResponse({ error: true, message: 'Bad name.', retryable: false }, 500));
    await expect(listBranches(PROJECT)).resolves.toMatchObject({ ok: false, retryable: false });

    // Neither field: a 4xx is the user's to fix, so it is NOT retryable.
    fetchMock.mockResolvedValue(jsonResponse({ error: true, message: 'Choose a branch.' }, 400));
    await expect(listBranches(PROJECT)).resolves.toMatchObject({ ok: false, retryable: false });
  });

  /**
   * `name-taken` is the refusal the create dialog acts on rather than merely reports: it puts the
   * TYPED name straight back in the field. Both fields ride on the same rebuilt refusal object as
   * `reconnect`, and the route never suffixes to `-2` — so losing them turns an editable collision
   * into a dead end.
   */
  it('keeps kind and the typed name on a create collision', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: true, message: 'That branch already exists.', kind: 'name-taken', name: 'feature/hud' },
        409,
      ),
    );

    await expect(createBranch(PROJECT, 'feature/hud')).resolves.toMatchObject({
      ok: false,
      kind: 'name-taken',
      name: 'feature/hud',
    });
  });

  /**
   * The switch is the one transport failure that has to reassure: it fires after the user pressed a
   * button that REPLACES their working tree, so "it failed" alone reads as "my work is gone".
   */
  it('tells the user their work survived a failed switch', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const outcome = await switchBranch(PROJECT, 'feature/hud');

    expect(outcome.message).toMatch(/your work is still here/i);
  });
});

describe('files are normalised at the fetch boundary', () => {
  /**
   * A repo damaged by the 2026-07-27 nested-workdir push holds keys like
   * `/home/project/src/main.ts`. These files are about to REPLACE the working tree, so a raw key is
   * not a cosmetic path bug: `planRestore` matches nothing, concludes every store file was deleted,
   * and wipes the project.
   *
   * The fixture mixes a prefixed key with an already-relative one, so a helper that returned the map
   * untouched fails on the first key and a helper that stripped indiscriminately fails on the second.
   */
  const PREFIXED_TREE: SerializedFileMap = {
    '/home/project/src/main.ts': dirent('export const main = 1;\n'),
    'README.md': dirent('# game\n'),
  };

  const FILE_HELPERS = [
    { label: 'readBranchTree', invoke: () => readBranchTree(PROJECT, { branch: 'feature/hud' }) },
    { label: 'switchBranch', invoke: () => switchBranch(PROJECT, 'feature/hud') },
    { label: 'discardChanges', invoke: () => discardChanges(PROJECT) },
  ];

  it.each(FILE_HELPERS)('$label re-keys a tree carrying a workdir prefix', async ({ invoke }) => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, branch: 'feature/hud', head: HEAD, files: PREFIXED_TREE }));

    const { files } = (await invoke()) as BranchTreeOutcome;

    expect(Object.keys(files ?? {}).sort()).toEqual(['README.md', 'src/main.ts']);
    expect(Object.keys(files ?? {})).not.toContain('/home/project/src/main.ts');

    // Re-keyed, never re-encoded: the dirent must arrive byte-identical (binaries ride in it).
    expect(files?.['src/main.ts']).toBe(PREFIXED_TREE['/home/project/src/main.ts']);
  });

  /**
   * The CONTROL for the guard around the normalisation. Every refusal above already exercises it, but
   * a payload that is a SUCCESS with no `files` is the shape a future op could take, and
   * `normalizeRepoFileMap(undefined)` throws.
   */
  it.each(FILE_HELPERS)('$label survives a response that carries no files', async ({ invoke }) => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, branch: 'feature/hud', head: HEAD }));

    await expect(invoke()).resolves.toEqual({ ok: true, branch: 'feature/hud', head: HEAD });
  });

  /**
   * The CONTROL for the other direction: the listing helpers must not have grown a files pass. Their
   * payloads come back byte-identical — asserted above by `toEqual(success)` in the happy path, and
   * here specifically for a payload whose keys LOOK path-shaped, which is the value a copy-pasted
   * normalisation would mangle.
   */
  it('leaves a listing response untouched', async () => {
    const payload = { ok: true, branches: [{ name: '/home/project', head: HEAD, isDefault: false, protected: false }] };
    fetchMock.mockResolvedValue(jsonResponse(payload));

    await expect(listBranches(PROJECT)).resolves.toEqual(payload);
  });
});
