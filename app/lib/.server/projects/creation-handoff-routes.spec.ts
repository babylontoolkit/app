/**
 * The creation handoff on the project route (SPEC §4.4a, §4.5.3, §4.2.8, migration 0016).
 *
 * The handoff is what an unbuilt project still owes its owner: the user's own words, carried until
 * their first build turn, plus the phase plan. (The machine-written creation BRIEF is retired — owner,
 * 2026-08-08 — an old client still sending one has it silently dropped.) It lived in `localStorage`,
 * which made it a fact about a DEVICE: open an unbuilt project on a second machine and there was no
 * handoff card and no carried prompt. That is why every assertion here is about the ROW rather than
 * about a status code.
 *
 * Three properties, each of which fails silently:
 *
 * - **`null` must clear it.** That is how the first build turn ends New Project mode. A route that
 *   cannot express "cleared" is a project that offers to build itself forever.
 * - **A non-object clears rather than throws.** A corrupt handoff is exactly a project that should
 *   stop offering to build itself — and a 500 here would leave the mode stuck instead.
 * - **The prompt is CAPPED.** It arrives in a browser body and it reaches the model, so an unbounded
 *   one is an unbounded per-turn bill (`MAX_INSTRUCTIONS_CHARS`'s reasoning).
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

const PROMPT = 'a kart racer with boost pads and drifting';

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
    expect((await patch(mine.id, { creationHandoff: { userPrompt: PROMPT } })).status).toBe(200);

    /*
     * Read through the ROUTE, not the store: the whole point of moving this off `localStorage` is that
     * a browser which never created the project can fetch it. A field persisted but stripped by
     * `toWireProject` would pass a store test and still leave the second device with no prompt.
     */
    expect(await wireHandoff(mine.id)).toEqual({ userPrompt: PROMPT });
  });

  it('keeps the handoff when there were no user words — the card path had none, and inventing some is worse', async () => {
    await patch(mine.id, { creationHandoff: {} });

    const handoff = await wireHandoff(mine.id);
    expect(handoff).toBeTruthy();
    expect(handoff?.userPrompt).toBeUndefined();
  });

  /** A legacy client still sending the retired brief has it silently dropped — never stored, never wired. */
  it('drops the retired brief field from an old client, keeping the rest', async () => {
    await patch(mine.id, { creationHandoff: { brief: '<old machine brief>', userPrompt: PROMPT } });

    const handoff = await wireHandoff(mine.id);
    expect(handoff).toEqual({ userPrompt: PROMPT });
    expect(JSON.stringify(handoff)).not.toContain('old machine brief');
  });

  it('a rename does not disturb the handoff — an unrelated PATCH must not end New Project mode', async () => {
    await patch(mine.id, { creationHandoff: { userPrompt: PROMPT } });
    await patch(mine.id, { name: 'Renamed' });

    expect((await storedHandoff(mine.id))?.userPrompt).toBe(PROMPT);
  });
});

/**
 * 🔴 THE PHASE PLAN (§4.4e, migration 0020) — two rules the brief's own rules get WRONG.
 *
 * Creation is now Game → Frontend → Art → Verify, driven by a plan stored in this same column. The
 * plan is what says which phases are still owed, and the whole handoff is NULL only once the last
 * phase completes.
 *
 * Both rules below shipped untested on the first pass, and a mutation proved it: removing the split
 * malformed rule left all 18 assertions green.
 */
describe('the phase plan', () => {
  const plan = (next: number, done: unknown[] = []) => ({ v: 1, phases: ['game', 'frontend', 'art'], next, done });

  it('stores a plan alongside the prompt and hands it back on the wire', async () => {
    await patch(mine.id, {
      creationHandoff: { userPrompt: PROMPT, plan: plan(1, [{ id: 'game', state: 'finished' }]) },
    });

    const handoff = await wireHandoff(mine.id);
    expect(handoff?.plan?.next).toBe(1);
    expect(handoff?.plan?.phases).toEqual(['game', 'frontend', 'art']);
    expect(handoff?.plan?.done.map((d) => d.id)).toEqual(['game']);
  });

  /*
   * 🔴 A MALFORMED PLAN DROPS THE PLAN AND KEEPS THE BRIEF.
   *
   * The brief's rule — "anything malformed clears, because a corrupt handoff is exactly a project
   * that should stop offering to build itself" — is right for a brief and catastrophic for a plan:
   * clearing on a corrupt plan strands a HALF-BUILT project with no way to resume, after the user has
   * already paid for the phases that ran. Two fields, two failure modes, deliberately not one rule.
   */
  it('drops a malformed plan but KEEPS the handoff — a corrupt plan must not strand a half-built project', async () => {
    for (const bad of [{ v: 99 }, { v: 1, phases: [] }, { v: 1, phases: ['nope'] }, 'plan', 42, []]) {
      await patch(mine.id, { creationHandoff: null });
      await patch(mine.id, { creationHandoff: { userPrompt: PROMPT, plan: bad } });

      const handoff = await storedHandoff(mine.id);
      expect(handoff?.userPrompt).toBe(PROMPT);
      expect(handoff?.plan).toBeUndefined();
    }
  });

  it('CONTROL: a non-object handoff still clears everything, plan included', async () => {
    await patch(mine.id, { creationHandoff: { userPrompt: PROMPT, plan: plan(1) } });
    await patch(mine.id, { creationHandoff: 'just build it' });

    expect(await storedHandoff(mine.id)).toBeUndefined();
  });

  /*
   * 🔴 `next` ONLY EVER MOVES FORWARD.
   *
   * The PATCH is a full replace, so without a merge a second tab, a stale bundle or an out-of-order
   * retry rewinds the counter and re-runs a phase that already ran — paying for it twice and
   * overwriting files that were correct. The ledger's `seq` lesson applied to a counter that decides
   * what gets rebuilt: a read-then-write check is a race, so the merge IS the write.
   */
  it('never rewinds the plan — a stale tab cannot re-run a finished phase', async () => {
    await patch(mine.id, {
      creationHandoff: { userPrompt: PROMPT, plan: plan(2, [{ id: 'game', state: 'finished' }]) },
    });
    await patch(mine.id, { creationHandoff: { userPrompt: PROMPT, plan: plan(0) } });

    const handoff = await storedHandoff(mine.id);
    expect(handoff?.plan?.next).toBe(2);
    expect(handoff?.plan?.done.map((d) => d.id)).toEqual(['game']);
  });

  it('CONTROL: a plan that really is ahead still advances — the merge is not a freeze', async () => {
    await patch(mine.id, { creationHandoff: { userPrompt: PROMPT, plan: plan(1) } });
    await patch(mine.id, { creationHandoff: { userPrompt: PROMPT, plan: plan(2) } });

    expect((await storedHandoff(mine.id))?.plan?.next).toBe(2);
  });

  /*
   * The merge must never resurrect a cleared handoff, or a completed plan could not end — and the end
   * of the plan is the only thing that stops the project offering to build itself forever.
   */
  it('an explicit null still clears a project mid-plan', async () => {
    await patch(mine.id, { creationHandoff: { userPrompt: PROMPT, plan: plan(2) } });
    await patch(mine.id, { creationHandoff: null });

    expect(await storedHandoff(mine.id)).toBeUndefined();
  });
});

describe('clearing it', () => {
  /*
   * 🔴 The end state. `null` is sent when the first build turn is SENT. If the route could not express
   * "cleared", the project would go on offering to build itself after it had been built.
   */
  it('PATCH with null clears it', async () => {
    await patch(mine.id, { creationHandoff: { userPrompt: PROMPT } });
    expect(await storedHandoff(mine.id)).toBeTruthy();

    expect((await patch(mine.id, { creationHandoff: null })).status).toBe(200);

    expect(await storedHandoff(mine.id)).toBeUndefined();
    expect(await wireHandoff(mine.id)).toBeUndefined();
  });

  /*
   * A corrupt handoff is exactly a project that should stop offering to build itself. Throwing instead
   * would leave the mode stuck with no way out. (An object — even an empty one — is a VALID handoff:
   * the card path carries no words, so `{}` means "created, never built, nothing typed".)
   */
  it.each([
    ['a bare string', 'just build it'],
    ['an array', [PROMPT]],
    ['a number', 7],
  ])('%s clears rather than throwing', async (_label, value) => {
    await patch(mine.id, { creationHandoff: { userPrompt: PROMPT } });

    const response = await patch(mine.id, { creationHandoff: value });

    expect(response.status).toBe(200);
    expect(await storedHandoff(mine.id)).toBeUndefined();
  });
});

describe('the cap (§4.2.8)', () => {
  it('truncates an oversized userPrompt to the route’s own limit', async () => {
    const cap = await capFromSource('MAX_HANDOFF_PROMPT_CHARS');

    await patch(mine.id, { creationHandoff: { userPrompt: 'y'.repeat(cap * 2) } });

    expect((await storedHandoff(mine.id))?.userPrompt).toHaveLength(cap);
  });

  it('leaves a real prompt byte-identical — the cap must never quietly edit it', async () => {
    /*
     * The control on the truncation test. A cap of zero would satisfy it; what makes the cap correct
     * is that ordinary text passes through untouched.
     */
    await patch(mine.id, { creationHandoff: { userPrompt: PROMPT } });

    expect(await storedHandoff(mine.id)).toEqual({ userPrompt: PROMPT });
  });
});

describe('the two walls (§4.5.3)', () => {
  it('401s when unauthenticated, and writes nothing', async () => {
    currentUser = null;

    expect((await patch(mine.id, { creationHandoff: { userPrompt: PROMPT } })).status).toBe(401);
    expect((await load(mine.id)).status).toBe(401);

    currentUser = USER;
    expect(await storedHandoff(mine.id)).toBeUndefined();
  });

  it('404s — never 403 — for someone else’s project, and writes nothing to it', async () => {
    /*
     * 403 would confirm the id exists. The status is the enumeration oracle, so it is asserted
     * exactly, not merely as "not 200".
     */
    const response = await patch(theirs.id, { creationHandoff: { userPrompt: PROMPT } });

    expect(response.status).toBe(404);
    expect(await storedHandoff(theirs.id)).toBeUndefined();
  });

  it('cannot CLEAR someone else’s handoff either — a null is a write', async () => {
    await projects.update(theirs.id, { creationHandoff: { userPrompt: PROMPT } });

    expect((await patch(theirs.id, { creationHandoff: null })).status).toBe(404);
    expect((await storedHandoff(theirs.id))?.userPrompt).toBe(PROMPT);
  });

  it('404s identically for a project that does not exist', async () => {
    expect((await patch('prj_nope', { creationHandoff: { userPrompt: PROMPT } })).status).toBe(404);
    expect((await load('prj_nope')).status).toBe(404);
  });
});
