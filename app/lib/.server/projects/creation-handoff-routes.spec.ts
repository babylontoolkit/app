/**
 * The creation handoff on the project route (SPEC §4.4a, §4.5.3, §4.2.8, migration 0016).
 *
 * The handoff is what an unbuilt project still owes its owner: the machine-written creation brief —
 * which carries `CREATION_BRIEF_MARKER` and therefore switches ten server-side protections ON for the
 * first build turn — plus the user's own words. It lived in `localStorage`, which made it a fact about
 * a DEVICE: open an unbuilt project on a second machine and there was no handoff card, and the first
 * build turn went out with no brief at all. The build still ran and was simply worse, with nothing
 * throwing and the token count going DOWN. That is §4.2.8's stated failure mode, and it is why every
 * assertion here is about the ROW rather than about a status code.
 *
 * Three properties, each of which fails silently:
 *
 * - **`null` must clear it.** That is how the first build turn ends New Project mode. A route that
 *   cannot express "cleared" is a project that offers to build itself forever.
 * - **Malformed input clears rather than throws.** A corrupt handoff is exactly a project that should
 *   stop offering to build itself — and a 500 here would leave the mode stuck instead.
 * - **The brief is CAPPED.** It arrives in a browser body and it is sent to the model on the most
 *   expensive turn in the product, so an unbounded one is an unbounded per-turn bill, forever
 *   (`MAX_INSTRUCTIONS_CHARS`'s reasoning, one field to the left).
 *
 * Plus the two walls, as everywhere a project is touched: a session AND ownership, with someone else's
 * project answering **404, not 403** — a 403 confirms the id exists and turns the route into an
 * enumeration oracle.
 *
 * ⚠️ Route specs live BESIDE the code they exercise, never under `app/routes/` — Remix compiles a spec
 * file there as a route and the manifest imports `vitest` at runtime, which 500s every request.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsProjectStore, setProjectStore } from './store';
import type { AuthUser } from '~/lib/.server/supabase/auth';
import type { Project } from './types';

const USER: AuthUser = {
  id: 'user-1',
  email: 'creator@example.com',
  emailVerified: true,
  displayName: 'Creator',
  isAdmin: false,
  isLocal: false,
};

// A mutable "who is signed in" — null exercises the 401 path.
let currentUser: AuthUser | null = USER;

vi.mock('~/lib/.server/supabase/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/.server/supabase/auth')>();
  const authed = async () => {
    if (!currentUser) {
      throw new actual.UnauthorizedError();
    }

    return currentUser;
  };

  return { ...actual, requireVerifiedUser: authed, requireUser: authed };
});

/**
 * Mocked, not driven: `~/lib/.server/sandbox/service` imports `@codesandbox/sdk` at module scope, so an
 * unmocked route import drags the vendor SDK (and its API key) into a test about a jsonb column.
 */
vi.mock('~/lib/.server/sandbox/service', () => ({
  deleteSandbox: async () => undefined,
}));

/**
 * The caps, read from the route rather than re-typed here.
 *
 * A second copy of `24_000` in a test asserts that the number has not changed, which is not the rule —
 * the rule is that whatever the route decided is what actually lands in the row. The constants are
 * module-private on purpose (nothing else may cap this text differently), so the test reads them out
 * of the source instead of asking for them to be exported for its own convenience.
 */
const ROUTE_SOURCE_PATH = path.resolve(process.cwd(), 'app/routes/api.projects.$projectId.ts');

async function capFromSource(name: string): Promise<number> {
  const source = await fs.readFile(ROUTE_SOURCE_PATH, 'utf8');
  const match = source.match(new RegExp(`${name}\\s*=\\s*([0-9_]+)`));

  // Control: if the route stops declaring the cap, this test must fail loudly, not silently pass.
  expect(match, `${name} must be declared in ${ROUTE_SOURCE_PATH}`).toBeTruthy();

  return Number(match![1].replace(/_/g, ''));
}

const BRIEF = `Build the game described above.\n<!-- creation-brief -->\nPlay contract: navigate('/play', { gameMode: 'KartRacerMode' }).`;

let tmp: string;
let projects: FsProjectStore;
let mine: Project;
let theirs: Project;

beforeEach(async () => {
  // FS backends only — never Supabase, and never the developer's real `.data/`.
  vi.stubEnv('SUPABASE_URL', undefined as unknown as string);
  vi.stubEnv('SUPABASE_ANON_KEY', undefined as unknown as string);

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'creation-handoff-routes-'));
  vi.stubEnv('PLATFORM_DATA_DIR', tmp);

  projects = new FsProjectStore(path.join(tmp, 'projects'));
  setProjectStore(projects);

  mine = await projects.create({ userId: USER.id, name: 'Kart Racer', templateId: 'racing' });
  theirs = await projects.create({ userId: 'someone-else', name: 'Theirs', templateId: 'racing' });

  currentUser = USER;
});

afterEach(async () => {
  setProjectStore(undefined);
  await fs.rm(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const patch = async (projectId: string, body: unknown) => {
  const { action } = await import('~/routes/api.projects.$projectId');

  return action({
    request: new Request('https://app.example.com/api/projects/x', {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
    params: { projectId },
    context: {},
  } as never);
};

const load = async (projectId: string) => {
  const { loader } = await import('~/routes/api.projects.$projectId');

  return loader({
    request: new Request('https://app.example.com/api/projects/x'),
    params: { projectId },
    context: {},
  } as never);
};

/** What a GET actually hands the browser — the only view the handoff card ever gets. */
const wireHandoff = async (projectId: string) => {
  const body = (await (await load(projectId)).json()) as { project: Project };
  return body.project.creationHandoff;
};

/** What is on the row, independent of anything the wire layer chooses to strip. */
const storedHandoff = async (projectId: string) => (await projects.get(projectId))?.creationHandoff;

describe('storing and reading back the handoff', () => {
  it('a PATCH stores it and a later GET returns it — a second device sees the same handoff', async () => {
    expect((await patch(mine.id, { creationHandoff: { brief: BRIEF, userPrompt: 'a kart racer' } })).status).toBe(200);

    /*
     * Read through the ROUTE, not the store: the whole point of moving this off `localStorage` is that
     * a browser which never created the project can fetch it. A field persisted but stripped by
     * `toWireProject` would pass a store test and still leave the second device with no brief.
     */
    expect(await wireHandoff(mine.id)).toEqual({ brief: BRIEF, userPrompt: 'a kart racer' });
  });

  it('keeps the brief when there were no user words — the card path had none, and inventing some is worse', async () => {
    await patch(mine.id, { creationHandoff: { brief: BRIEF } });

    const handoff = await wireHandoff(mine.id);
    expect(handoff?.brief).toBe(BRIEF);
    expect(handoff?.userPrompt).toBeUndefined();
  });

  it('a rename does not disturb the handoff — an unrelated PATCH must not end New Project mode', async () => {
    await patch(mine.id, { creationHandoff: { brief: BRIEF } });
    await patch(mine.id, { name: 'Renamed' });

    expect((await storedHandoff(mine.id))?.brief).toBe(BRIEF);
  });
});

describe('clearing it', () => {
  /*
   * 🔴 The end state. `null` is sent when the first build turn is SENT — not when it succeeds, because
   * a failed build is retried and the retry must still carry the brief. If the route could not express
   * "cleared", the project would go on offering to build itself after it had been built.
   */
  it('PATCH with null clears it', async () => {
    await patch(mine.id, { creationHandoff: { brief: BRIEF, userPrompt: 'a kart racer' } });
    expect(await storedHandoff(mine.id)).toBeTruthy();

    expect((await patch(mine.id, { creationHandoff: null })).status).toBe(200);

    expect(await storedHandoff(mine.id)).toBeUndefined();
    expect(await wireHandoff(mine.id)).toBeUndefined();
  });

  /*
   * A corrupt handoff is exactly a project that should stop offering to build itself: a brief that is
   * missing, empty, or not a string cannot carry `CREATION_BRIEF_MARKER`, so building from it is
   * strictly worse than not offering. Throwing instead would leave the mode stuck with no way out.
   */
  it.each([
    ['a missing brief', { userPrompt: 'a kart racer' }],
    ['an empty brief', { brief: '' }],
    ['a non-string brief', { brief: { text: BRIEF } }],
    ['an empty object', {}],
    ['a bare string', 'just build it'],
    ['an array', [BRIEF]],
    ['a number', 7],
  ])('%s clears rather than throwing', async (_label, value) => {
    await patch(mine.id, { creationHandoff: { brief: BRIEF } });

    const response = await patch(mine.id, { creationHandoff: value });

    expect(response.status).toBe(200);
    expect(await storedHandoff(mine.id)).toBeUndefined();
  });
});

describe('the caps (§4.2.8)', () => {
  it('truncates an oversized brief to the route’s own limit', async () => {
    const cap = await capFromSource('MAX_HANDOFF_BRIEF_CHARS');

    await patch(mine.id, { creationHandoff: { brief: 'x'.repeat(cap * 2) } });

    expect((await storedHandoff(mine.id))?.brief).toHaveLength(cap);
  });

  it('truncates an oversized userPrompt to the route’s own limit', async () => {
    const cap = await capFromSource('MAX_HANDOFF_PROMPT_CHARS');

    await patch(mine.id, { creationHandoff: { brief: BRIEF, userPrompt: 'y'.repeat(cap * 2) } });

    expect((await storedHandoff(mine.id))?.userPrompt).toHaveLength(cap);
  });

  it('leaves a real brief byte-identical — the cap must never quietly edit the marker out', async () => {
    /*
     * The control on the two truncation tests. A cap of zero would satisfy them both; what makes the
     * cap correct is that ordinary text passes through untouched, marker and all.
     */
    await patch(mine.id, { creationHandoff: { brief: BRIEF, userPrompt: 'a kart racer' } });

    expect(await storedHandoff(mine.id)).toEqual({ brief: BRIEF, userPrompt: 'a kart racer' });
  });
});

describe('the two walls (§4.5.3)', () => {
  it('401s when unauthenticated, and writes nothing', async () => {
    currentUser = null;

    expect((await patch(mine.id, { creationHandoff: { brief: BRIEF } })).status).toBe(401);
    expect((await load(mine.id)).status).toBe(401);

    currentUser = USER;
    expect(await storedHandoff(mine.id)).toBeUndefined();
  });

  it('404s — never 403 — for someone else’s project, and writes nothing to it', async () => {
    /*
     * 403 would confirm the id exists. The status is the enumeration oracle, so it is asserted
     * exactly, not merely as "not 200".
     */
    const response = await patch(theirs.id, { creationHandoff: { brief: BRIEF } });

    expect(response.status).toBe(404);
    expect(await storedHandoff(theirs.id)).toBeUndefined();
  });

  it('cannot CLEAR someone else’s handoff either — a null is a write', async () => {
    await projects.update(theirs.id, { creationHandoff: { brief: BRIEF } });

    expect((await patch(theirs.id, { creationHandoff: null })).status).toBe(404);
    expect((await storedHandoff(theirs.id))?.brief).toBe(BRIEF);
  });

  it('404s identically for a project that does not exist', async () => {
    expect((await patch('prj_nope', { creationHandoff: { brief: BRIEF } })).status).toBe(404);
    expect((await load('prj_nope')).status).toBe(404);
  });
});
