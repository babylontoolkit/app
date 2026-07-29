/**
 * The two sandbox routes (SPEC §4.5.3, §5, §8, `spec/sandbox-codesandbox.md` §11 M1).
 *
 * These replaced the per-USER registry, which keyed a VM by the user id and therefore handed a user's
 * SECOND project the FIRST one's filesystem — project B silently BECOMING project A, then pushing A's
 * code to B's repo. The fix is that the sandbox id lives on the PROJECT row and every route reads it
 * from there, so the assertions below are mostly about things that must never appear on the wire and
 * must never be left running.
 *
 * What is pinned here, and why each failure is silent:
 *
 *   - **Someone else's project answers 404 with ZERO provider calls.** A 403 confirms the id exists
 *     (§4.5.3), and a provider call made on the way to refusing is a VM we paid to fork for an
 *     attacker.
 *   - **A create RECORDS the id.** If it does not, the very next request reads no sandbox, forks
 *     again, and the user's project is a fresh template — with the old VM billing until its idle
 *     timeout. Nothing throws.
 *   - **Concurrent creates converge on ONE id and the loser is DESTROYED.** An orphan VM is a bill
 *     with no owner and no panel that can find it.
 *   - **A resume of a deleted sandbox falls back to create ONCE.** Without it the project is bricked
 *     into a permanent 503 with no path back for the user.
 *
 * The whole CodeSandbox service is mocked: a real network call from a test is a hard failure here, in
 * the same spirit as `outbound-auth.spec.ts` stubbing `fetch` to throw.
 *
 * ⚠️ Lives beside the code it exercises, never in `app/routes/` — Remix compiles a spec in that folder
 * as a route and the manifest then imports `vitest` at runtime, 500ing every request (§4.5.6).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsProjectStore, setProjectStore } from '~/lib/.server/projects/store';
import type { Project } from '~/lib/.server/projects/types';
import { resetRateWindows } from '~/lib/.server/monitoring/failure-rate';
import { resetSandboxCreateLimits } from './create-limit';

const USER = { id: 'user-1', email: 'a@example.com', emailVerified: true } as const;

vi.mock('~/lib/.server/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireVerifiedUser: async () => USER,
  requireUser: async () => USER,
}));

/*
 * The provider seam. Every export the routes touch is a spy, so "did this refusal cost us a VM?" is a
 * question the test can actually answer.
 */
const service = vi.hoisted(() => ({
  createSandboxForProject: vi.fn(),
  resumeSandbox: vi.fn(),
  sandboxExists: vi.fn(),
  deleteSandbox: vi.fn(),
  createBrowserSession: vi.fn(),
  createPreviewAccess: vi.fn(),

  /*
   * The running-VM cap's two provider calls (`vm-cap.ts`). They live here because this mock object
   * REPLACES the whole module: an export the route path reaches that is missing from it is a
   * `TypeError` in the middle of a session mint, not a compile error.
   */
  listRunningSandboxes: vi.fn(),
  hibernateSandbox: vi.fn(),
}));

vi.mock('./service', () => service);
vi.mock('~/lib/.server/sandbox/service', () => service);

/*
 * The monitoring seam (plan T13, `monitoring/sandbox-rates.ts`).
 *
 * These are SPIES WRAPPING THE REAL IMPLEMENTATION, not replacements: every call still feeds the real
 * `sharedRateWindow`, so nothing here can pass against a `sandbox-rates.ts` that has stopped working —
 * the spies only make "which attempt was recorded, and as what?" a question this suite can ask.
 *
 * Asserting through the windows alone was the first choice and it cannot express these cases: a window
 * exposes nothing but an alert, so "a successful create was recorded" would have to be inferred from
 * ~8 requests NOT alerting, which passes just as well when nothing was recorded at all. The rate
 * arithmetic itself — the denominator, the thresholds, the independence of the three windows — is
 * pinned directly in `sandbox-rates.spec.ts` against the real windows; what belongs HERE is that the
 * route calls it on every path, including the two paths that are easy to forget: a failure that throws
 * out of the route, and a success that nobody thinks of as an event.
 */
const rates = vi.hoisted(() => ({ recordSandboxOutcome: vi.fn(), recordSandboxCleanBoot: vi.fn() }));

vi.mock('~/lib/.server/monitoring/sandbox-rates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/.server/monitoring/sandbox-rates')>();

  return {
    recordSandboxOutcome: rates.recordSandboxOutcome.mockImplementation(actual.recordSandboxOutcome),
    recordSandboxCleanBoot: rates.recordSandboxCleanBoot.mockImplementation(actual.recordSandboxCleanBoot),
  };
});

/** What the route recorded this test, as `[kind, failed]` pairs — the readable form of the assertions. */
const recordedOutcomes = () => rates.recordSandboxOutcome.mock.calls.map((call) => [call[1], call[2]]);

/** What the route recorded about how a resume came back, as `wasClean` booleans. */
const recordedCleanBoots = () => rates.recordSandboxCleanBoot.mock.calls.map((call) => call[1]);

let tmp: string;
let projects: FsProjectStore;
let mine: Project;
let theirs: Project;

/** Every provider call this test suite can observe — the "zero provider calls" assertion reads this. */
const providerCalls = () => Object.values(service).reduce((total, spy) => total + spy.mock.calls.length, 0);

beforeEach(async () => {
  vi.stubEnv('CODESANDBOX_API_KEY', 'csb_test_key');
  resetSandboxCreateLimits();

  /* `mockClear`, never `mockReset` — the spies carry the real implementation and must keep it. */
  rates.recordSandboxOutcome.mockClear();
  rates.recordSandboxCleanBoot.mockClear();

  // A rate that leaks between tests is not a rate; the real windows are shared per process.
  resetRateWindows();

  for (const spy of Object.values(service)) {
    spy.mockReset();
  }

  service.createBrowserSession.mockResolvedValue({ session: 'scoped' });
  service.createPreviewAccess.mockResolvedValue({ url: 'https://p.csb.app/?preview_token=t', expiresAt: 'later' });
  service.deleteSandbox.mockResolvedValue(undefined);

  /* Nothing else running by default, so the cap is a no-op for every test that is not about it. */
  service.listRunningSandboxes.mockResolvedValue([]);
  service.hibernateSandbox.mockResolvedValue(undefined);

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-routes-'));
  projects = new FsProjectStore(tmp);
  setProjectStore(projects);

  mine = await projects.create({ userId: USER.id, name: 'Mine', templateId: 'racing' });
  theirs = await projects.create({ userId: 'someone-else', name: 'Theirs', templateId: 'racing' });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  setProjectStore(undefined);
  await fs.rm(tmp, { recursive: true, force: true });
});

async function session(body: unknown, method = 'POST') {
  const { action } = await import('~/routes/api.sandbox.session');

  return action({
    request: new Request('http://localhost/api/sandbox/session', {
      method,

      // A GET/HEAD Request cannot carry a body at all — the method test uses DELETE for that reason.
      ...(method === 'GET' || method === 'HEAD'
        ? {}
        : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    }),
    params: {},
    context: {},
  } as never);
}

async function preview(query: string) {
  const { loader } = await import('~/routes/api.sandbox.preview');

  return loader({
    request: new Request(`http://localhost/api/sandbox/preview?${query}`),
    params: {},
    context: {},
  } as never);
}

describe('both walls, before anything is spent (§4.5.3)', () => {
  it('404s — never 403 — for someone else’s project, with ZERO provider calls', async () => {
    const response = await session({ projectId: theirs.id });

    expect(response.status).toBe(404);
    expect(providerCalls()).toBe(0);

    // And nothing was recorded on their row on the way to refusing.
    expect((await projects.get(theirs.id))!.sandboxId).toBeUndefined();
  });

  it('404s identically for a project id that does not exist', async () => {
    expect((await session({ projectId: 'prj_nope' })).status).toBe(404);
    expect(providerCalls()).toBe(0);
  });

  it('400s when no projectId is supplied — there is no per-user fallback any more', async () => {
    /*
     * The registry this replaced would happily have served a VM for a request that named no project
     * at all. Refusing is the whole point: a session is scoped to one sandbox, and without a project
     * there is nothing that says which.
     */
    for (const body of [{}, { projectId: '' }, { projectId: '   ' }, { projectId: 42 }]) {
      const response = await session(body);
      expect(response.status).toBe(400);
    }

    expect(providerCalls()).toBe(0);
  });

  it('405s a non-POST before touching anything', async () => {
    expect((await session({ projectId: mine.id }, 'GET')).status).toBe(405);
    expect((await session({ projectId: mine.id }, 'DELETE')).status).toBe(405);
    expect(providerCalls()).toBe(0);
  });

  it('503s with configured:false when the provider is not configured', async () => {
    vi.stubEnv('CODESANDBOX_API_KEY', '');

    const response = await session({ projectId: mine.id });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ configured: false });
    expect(providerCalls()).toBe(0);
  });

  it('preview 404s for someone else’s project with ZERO provider calls', async () => {
    await projects.update(theirs.id, { sandboxId: 'sb-theirs' });

    const response = await preview(`projectId=${theirs.id}&port=5173`);

    expect(response.status).toBe(404);
    expect(providerCalls()).toBe(0);
  });

  it('preview 400s without a projectId, and 404s when the project has no VM yet', async () => {
    expect((await preview('port=5173')).status).toBe(400);
    expect((await preview(`projectId=${mine.id}&port=5173`)).status).toBe(404);
    expect(providerCalls()).toBe(0);
  });

  it('preview mints against the id on the ROW, never one from the caller', async () => {
    await projects.update(mine.id, { sandboxId: 'sb-mine' });

    const response = await preview(`projectId=${mine.id}&port=5173&sandboxId=sb-someone-else`);

    expect(response.status).toBe(200);
    expect(service.createPreviewAccess).toHaveBeenCalledWith('sb-mine', 5173, expect.anything());
  });
});

describe('create records the sandbox on the project row', () => {
  it('forks once and writes the id, so the next request resumes instead of forking again', async () => {
    service.createSandboxForProject.mockResolvedValue({ sandboxId: 'sb-1', bootupType: 'FORK' });

    const response = await session({ projectId: mine.id });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sandboxId: 'sb-1', bootupType: 'FORK', created: true });

    /* The load-bearing half: without this write the very next open forks a fresh template. */
    expect((await projects.get(mine.id))!.sandboxId).toBe('sb-1');

    // It never asked whether a sandbox it does not have exists.
    expect(service.sandboxExists).not.toHaveBeenCalled();
    expect(service.deleteSandbox).not.toHaveBeenCalled();
  });

  it('resumes the RECORDED id on the next request and forks nothing', async () => {
    await projects.update(mine.id, { sandboxId: 'sb-1' });
    service.sandboxExists.mockResolvedValue(true);
    service.resumeSandbox.mockResolvedValue({ sandboxId: 'sb-1', bootupType: 'RESUME' });

    const response = await session({ projectId: mine.id });

    expect(await response.json()).toMatchObject({ sandboxId: 'sb-1', bootupType: 'RESUME', created: false });
    expect(service.resumeSandbox).toHaveBeenCalledWith('sb-1', expect.anything(), expect.anything());
    expect(service.createSandboxForProject).not.toHaveBeenCalled();
  });

  it('reports a CLEAN resume honestly rather than as a restore', async () => {
    /*
     * `CLEAN` means the hibernation snapshot expired and setup re-ran — the files are template state.
     * Swallowing it hands the user an empty project with no error (§4.5.4c refills it).
     */
    await projects.update(mine.id, { sandboxId: 'sb-1' });
    service.sandboxExists.mockResolvedValue(true);
    service.resumeSandbox.mockResolvedValue({ sandboxId: 'sb-1', bootupType: 'CLEAN' });

    expect(await (await session({ projectId: mine.id })).json()).toMatchObject({ bootupType: 'CLEAN' });
  });

  it('🔴 REFUSES with a retryable 503 when it cannot confirm the recorded sandbox exists', async () => {
    /*
     * Forking here would replace the user's game with a fresh template on a network blip, and the old
     * VM would bill on with nothing naming it.
     */
    await projects.update(mine.id, { sandboxId: 'sb-1' });
    service.sandboxExists.mockResolvedValue(undefined);

    const response = await session({ projectId: mine.id });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ retryable: true });
    expect(service.createSandboxForProject).not.toHaveBeenCalled();
    expect(service.resumeSandbox).not.toHaveBeenCalled();
    expect((await projects.get(mine.id))!.sandboxId).toBe('sb-1');
  });

  it('creates when the recorded sandbox is confirmed GONE, and records the replacement', async () => {
    await projects.update(mine.id, { sandboxId: 'sb-dead' });
    service.sandboxExists.mockResolvedValue(false);
    service.createSandboxForProject.mockResolvedValue({ sandboxId: 'sb-2', bootupType: 'FORK' });

    expect(await (await session({ projectId: mine.id })).json()).toMatchObject({ sandboxId: 'sb-2' });
    expect((await projects.get(mine.id))!.sandboxId).toBe('sb-2');

    /* `sb-dead` is already 404 at the provider — asking to delete it would only generate noise. */
    expect(service.deleteSandbox).not.toHaveBeenCalled();
  });
});

describe('reset', () => {
  it('🔴 forks a replacement, records it, and DISPOSES the VM it replaced', async () => {
    /*
     * The one case where the previous VM is deliberately abandoned, so it is the one case that must
     * destroy it. Skipping the delete leaves a running VM nothing can name again.
     */
    await projects.update(mine.id, { sandboxId: 'sb-old' });
    service.sandboxExists.mockResolvedValue(true);
    service.createSandboxForProject.mockResolvedValue({ sandboxId: 'sb-new', bootupType: 'FORK' });

    const response = await session({ projectId: mine.id, reset: true });

    expect(await response.json()).toMatchObject({ sandboxId: 'sb-new', created: true });
    expect((await projects.get(mine.id))!.sandboxId).toBe('sb-new');
    expect(service.deleteSandbox).toHaveBeenCalledWith('sb-old', expect.anything(), expect.anything());
    expect(service.resumeSandbox).not.toHaveBeenCalled();
  });

  it('still succeeds when disposing the old VM fails — a dispose is best-effort, never fatal', async () => {
    await projects.update(mine.id, { sandboxId: 'sb-old' });
    service.sandboxExists.mockResolvedValue(true);
    service.createSandboxForProject.mockResolvedValue({ sandboxId: 'sb-new', bootupType: 'FORK' });
    service.deleteSandbox.mockRejectedValue(new Error('provider is having a day'));

    const response = await session({ projectId: mine.id, reset: true });

    expect(response.status).toBe(200);
    expect((await projects.get(mine.id))!.sandboxId).toBe('sb-new');
  });

  it('does not treat a truthy-ish reset value as a reset', async () => {
    /* Only `true`. `"false"`, `1` and `"yes"` all destroy a VM if they are read as intent. */
    await projects.update(mine.id, { sandboxId: 'sb-old' });
    service.sandboxExists.mockResolvedValue(true);
    service.resumeSandbox.mockResolvedValue({ sandboxId: 'sb-old', bootupType: 'RESUME' });

    await session({ projectId: mine.id, reset: 'false' });

    expect(service.createSandboxForProject).not.toHaveBeenCalled();
    expect(service.deleteSandbox).not.toHaveBeenCalled();
  });
});

describe('🔴 concurrent creates converge on one sandbox and the loser is destroyed', () => {
  it('records exactly one id and disposes the fork that lost', async () => {
    /*
     * Two tabs open one project. Both read `sandboxId` unset and both fork a template. Last write
     * wins, and without the compare-and-set the LOSER keeps running: a VM billing by the second that
     * nothing can name again, with a live write session pointed at it — so the user can be typing
     * into a filesystem that no longer belongs to their project.
     *
     * The interleaving is forced through the STORE rather than through call order: whichever request
     * forks first completes its write, and only then does the other one's fork return. Gating on "the
     * first caller into the mock" instead would deadlock whenever the runtime scheduled the two
     * requests the other way round — the flake this test had on its first draft.
     */
    let firstWriteLanded!: () => void;
    const written = new Promise<void>((resolve) => {
      firstWriteLanded = resolve;
    });

    const update = projects.update.bind(projects);
    vi.spyOn(projects, 'update').mockImplementation(async (id, patch) => {
      const result = await update(id, patch);

      if (patch.sandboxId) {
        firstWriteLanded();
      }

      return result;
    });

    let forks = 0;
    service.createSandboxForProject.mockImplementation(async () => {
      forks += 1;

      if (forks === 1) {
        return { sandboxId: 'sb-first', bootupType: 'FORK' };
      }

      /* The loser is still inside its fork when the winner's id lands on the row. */
      await written;

      return { sandboxId: 'sb-second', bootupType: 'FORK' };
    });

    const [firstBody, secondBody] = (await Promise.all(
      [session({ projectId: mine.id }), session({ projectId: mine.id })].map(async (pending) => (await pending).json()),
    )) as Array<{ sandboxId: string; bootupType: string; created: boolean }>;

    expect(forks).toBe(2);

    // Both callers are pointed at the SAME sandbox, whichever of them won.
    expect(firstBody).toMatchObject({ sandboxId: 'sb-first' });
    expect(secondBody).toMatchObject({ sandboxId: 'sb-first' });
    expect([firstBody.created, secondBody.created].filter(Boolean)).toHaveLength(1);

    // The row names it once, and the loser is gone.
    expect((await projects.get(mine.id))!.sandboxId).toBe('sb-first');
    expect(service.deleteSandbox).toHaveBeenCalledWith('sb-second', expect.anything(), expect.anything());
    expect(service.deleteSandbox).toHaveBeenCalledTimes(1);

    /*
     * And the loser is not told it booted a fresh template — it joined something that already
     * existed, which may hold real files.
     */
    const loser = [firstBody, secondBody].find((body) => body.created === false);
    expect(loser).toMatchObject({ sandboxId: 'sb-first', bootupType: 'RESUME' });

    // The session is minted for the canonical sandbox, never for the discarded one.
    expect(service.createBrowserSession).toHaveBeenCalledWith('sb-first', expect.anything(), expect.anything());
    expect(service.createBrowserSession).not.toHaveBeenCalledWith('sb-second', expect.anything(), expect.anything());
  });
});

describe('a resume of a deleted sandbox falls back to create — once', () => {
  it('creates and records the replacement when the resume proves the VM is gone', async () => {
    /*
     * `sandboxExists` said it was there and the resume disagrees — deleted provider-side between the
     * two calls, or an existence check answering from a stale cache. Without the fallback the project
     * is bricked into a permanent 503: every later request repeats the check, gets the same answer,
     * and fails the same way.
     */
    await projects.update(mine.id, { sandboxId: 'sb-stale' });
    service.sandboxExists.mockResolvedValue(true);
    service.resumeSandbox.mockRejectedValue(Object.assign(new Error('Sandbox not found'), { status: 404 }));
    service.createSandboxForProject.mockResolvedValue({ sandboxId: 'sb-fresh', bootupType: 'FORK' });

    const response = await session({ projectId: mine.id });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sandboxId: 'sb-fresh', created: true });
    expect((await projects.get(mine.id))!.sandboxId).toBe('sb-fresh');
  });

  it('🔴 does NOT fall back on a transient failure — it surfaces the error instead', async () => {
    /*
     * Re-creating on a 500 is the "replace the user's project with a template" direction the whole
     * lifecycle module exists to avoid, and it would do so while the real VM is still running.
     */
    await projects.update(mine.id, { sandboxId: 'sb-live' });
    service.sandboxExists.mockResolvedValue(true);
    service.resumeSandbox.mockRejectedValue(Object.assign(new Error('upstream exploded'), { status: 500 }));

    const response = await session({ projectId: mine.id });

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(service.createSandboxForProject).not.toHaveBeenCalled();
    expect((await projects.get(mine.id))!.sandboxId).toBe('sb-live');
  });
});

describe('the fork ceiling is enforced on the route, not only in the pure function', () => {
  it('429s with a Retry-After once the account has burned its hourly budget', async () => {
    vi.stubEnv('CODESANDBOX_MAX_CREATES_PER_HOUR', '2');
    service.createSandboxForProject.mockImplementation(async () => ({
      sandboxId: `sb-${service.createSandboxForProject.mock.calls.length}`,
      bootupType: 'FORK',
    }));

    const a = await projects.create({ userId: USER.id, name: 'A', templateId: 'racing' });
    const b = await projects.create({ userId: USER.id, name: 'B', templateId: 'racing' });
    const c = await projects.create({ userId: USER.id, name: 'C', templateId: 'racing' });

    expect((await session({ projectId: a.id })).status).toBe(200);
    expect((await session({ projectId: b.id })).status).toBe(200);

    const refused = await session({ projectId: c.id });

    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0);

    /* Refused BEFORE the fork: a rate limit that spends the thing it is rationing is not a limit. */
    expect(service.createSandboxForProject).toHaveBeenCalledTimes(2);
    expect((await projects.get(c.id))!.sandboxId).toBeUndefined();
  });

  it('does not consume budget when the provider fails to fork', async () => {
    vi.stubEnv('CODESANDBOX_MAX_CREATES_PER_HOUR', '1');
    service.createSandboxForProject.mockRejectedValueOnce(new Error('fork failed'));

    await session({ projectId: mine.id });

    service.createSandboxForProject.mockResolvedValue({ sandboxId: 'sb-ok', bootupType: 'FORK' });

    expect((await session({ projectId: mine.id })).status).toBe(200);
  });
});

describe('the running-VM cap MAKES ROOM on the route, and never refuses (§11, `vm-cap.ts`)', () => {
  /** Two other projects of this user, already holding running sandboxes of different ages. */
  const twoOtherProjectsRunning = async () => {
    const older = await projects.create({ userId: USER.id, name: 'Older', templateId: 'racing' });
    const newer = await projects.create({ userId: USER.id, name: 'Newer', templateId: 'racing' });

    await projects.update(older.id, { sandboxId: 'sb-old' });
    await projects.update(newer.id, { sandboxId: 'sb-new' });

    service.listRunningSandboxes.mockResolvedValue([
      { sandboxId: 'sb-old', startedAt: 1_000 },
      { sandboxId: 'sb-new', startedAt: 900_000 },
    ]);
  };

  it('🔴 opening a THIRD project still returns a session, and hibernates exactly the oldest VM', async () => {
    /*
     * The acceptance case for T5. Per-project sandboxes (T1–T3) mean a user with three open projects
     * has three VMs billing until each one's own idle timeout; hibernating the oldest costs a 1–3s
     * resume and nothing else. Refusing the session instead would trade a bill for "you cannot open
     * your project", which is the worse failure.
     */
    await twoOtherProjectsRunning();
    service.createSandboxForProject.mockResolvedValue({ sandboxId: 'sb-third', bootupType: 'FORK' });

    const response = await session({ projectId: mine.id });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sandboxId: 'sb-third', created: true });

    // Exactly the oldest, and only the oldest: cap 2 keeps the new VM plus one other.
    expect(service.hibernateSandbox).toHaveBeenCalledTimes(1);
    expect(service.hibernateSandbox).toHaveBeenCalledWith('sb-old', expect.anything(), expect.anything());

    /* The session is minted for the kept sandbox — and BEFORE the sweep, see the ordering test below. */
    expect(service.createBrowserSession).toHaveBeenCalledWith('sb-third', expect.anything(), expect.anything());

    // And no row was touched — hibernation is reversible, so the project keeps naming its VM.
    expect((await projects.get(mine.id))!.sandboxId).toBe('sb-third');
  });

  it('applies the cap to a RESUME too, not only to a fresh fork', async () => {
    /* Flipping back to an existing project is the ordinary way an account goes over the cap. */
    await twoOtherProjectsRunning();
    await projects.update(mine.id, { sandboxId: 'sb-mine' });
    service.sandboxExists.mockResolvedValue(true);
    service.resumeSandbox.mockResolvedValue({ sandboxId: 'sb-mine', bootupType: 'RESUME' });

    expect((await session({ projectId: mine.id })).status).toBe(200);
    expect(service.hibernateSandbox).toHaveBeenCalledWith('sb-old', expect.anything(), expect.anything());
  });

  it('honours a raised cap — nothing sleeps when the operator allows three', async () => {
    vi.stubEnv('CODESANDBOX_MAX_RUNNING_VMS', '3');
    await twoOtherProjectsRunning();
    service.createSandboxForProject.mockResolvedValue({ sandboxId: 'sb-third', bootupType: 'FORK' });

    expect((await session({ projectId: mine.id })).status).toBe(200);
    expect(service.hibernateSandbox).not.toHaveBeenCalled();
  });

  it('🔴 still returns a session when hibernation itself fails', async () => {
    /* Best-effort by contract: a cost optimisation that can fail an open is not a cost optimisation. */
    await twoOtherProjectsRunning();
    service.listRunningSandboxes.mockRejectedValue(new Error('provider is having a day'));
    service.createSandboxForProject.mockResolvedValue({ sandboxId: 'sb-third', bootupType: 'FORK' });

    const response = await session({ projectId: mine.id });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sandboxId: 'sb-third' });
  });

  it('🔴 never hibernates ANOTHER USER’s sandbox, even when it is the oldest VM the provider lists', async () => {
    /*
     * `listRunningSandboxes` is workspace-wide — the API key is ours and every user's VM is in that
     * list. Two things make this a per-user cap: the candidate set comes from `listByUser(user.id)`,
     * and the provider list is intersected with it. Lose either and one user opening a third project
     * puts a STRANGER's project to sleep — silently, since hibernation throws nothing and the victim
     * only experiences a resume wait the next time they type.
     *
     * The numbers are chosen so that both mutations change the answer: without the intersection the
     * stranger's VM is the oldest candidate and sleeps first; without the per-user scoping it enters
     * the candidate set from the project rows and sleeps just the same.
     */
    const theirsToo = await projects.create({ userId: 'someone-else', name: 'Theirs too', templateId: 'racing' });
    const mine2 = await projects.create({ userId: USER.id, name: 'Mine 2', templateId: 'racing' });
    const mine3 = await projects.create({ userId: USER.id, name: 'Mine 3', templateId: 'racing' });

    await projects.update(theirsToo.id, { sandboxId: 'sb-theirs' });
    await projects.update(mine2.id, { sandboxId: 'sb-mine-2' });
    await projects.update(mine3.id, { sandboxId: 'sb-mine-3' });

    service.listRunningSandboxes.mockResolvedValue([
      { sandboxId: 'sb-theirs', startedAt: 1_000, lastActiveAt: 1_000 },
      { sandboxId: 'sb-mine-2', startedAt: 300_000, lastActiveAt: 300_000 },
      { sandboxId: 'sb-mine-3', startedAt: 600_000, lastActiveAt: 600_000 },
      { sandboxId: 'sb-third', startedAt: 900_000, lastActiveAt: 900_000 },
    ]);
    service.createSandboxForProject.mockResolvedValue({ sandboxId: 'sb-third', bootupType: 'FORK' });

    expect((await session({ projectId: mine.id })).status).toBe(200);

    /* Exactly one of THIS user's other VMs — the older — and nothing belonging to anyone else. */
    expect(service.hibernateSandbox).toHaveBeenCalledTimes(1);
    expect(service.hibernateSandbox).toHaveBeenCalledWith('sb-mine-2', expect.anything(), expect.anything());
    expect(service.hibernateSandbox.mock.calls.map((call) => call[0])).not.toContain('sb-theirs');

    // Their row still names their VM: hibernation is reversible, but it was never asked for here.
    expect((await projects.get(theirsToo.id))!.sandboxId).toBe('sb-theirs');
  });

  it('🔴 mints the session BEFORE the cost sweep runs — the credential never queues behind it', async () => {
    /*
     * The sweep is best-effort and deadline-bounded, but it is still up to five seconds of provider
     * round trips, and the user is waiting on the credential that lets their project boot. Ordering it
     * first would add that latency to every open of a third project — and unlike a failure, latency
     * bought here shows up as nothing at all in the logs.
     */
    await twoOtherProjectsRunning();
    service.createSandboxForProject.mockResolvedValue({ sandboxId: 'sb-third', bootupType: 'FORK' });

    expect((await session({ projectId: mine.id })).status).toBe(200);

    expect(service.createBrowserSession.mock.invocationCallOrder[0]).toBeLessThan(
      service.listRunningSandboxes.mock.invocationCallOrder[0],
    );
    expect(service.createBrowserSession.mock.invocationCallOrder[0]).toBeLessThan(
      service.hibernateSandbox.mock.invocationCallOrder[0],
    );
  });

  it('does not spend a provider list when the account has no other sandbox', async () => {
    service.createSandboxForProject.mockResolvedValue({ sandboxId: 'sb-only', bootupType: 'FORK' });

    expect((await session({ projectId: mine.id })).status).toBe(200);
    expect(service.listRunningSandboxes).not.toHaveBeenCalled();
  });
});

describe('every sandbox attempt is recorded, not only the ones that fail (T13)', () => {
  /*
   * 🔴 THE DENOMINATOR, at the call site.
   *
   * `sandbox-rates.ts` computes a RATE, so it needs the successes as much as the failures — a window
   * fed only its failures reads 100% and alerts on the eighth one no matter how healthy the platform
   * is, which turns the signal into a per-event alarm somebody switches off. That property is arithmetic
   * and is pinned in `sandbox-rates.spec.ts`; what is pinned HERE is the half nobody remembers to write:
   * the route calling `record…(…, false)` on the paths where nothing went wrong.
   *
   * The failure side has its own trap — three of the four failure paths leave this route by THROWING
   * (a fork that rejects, a resume that rejects, and the refusal that returns 503 before either), so a
   * recording placed after the provider call is skipped exactly when it matters most.
   */
  it('records a SUCCESSFUL create as a non-failure', async () => {
    /*
     * The mundane case, and the one a "record the failures" implementation gets wrong: nothing here is
     * an event to a human, and without it the create window has no denominator at all.
     */
    service.createSandboxForProject.mockResolvedValue({ sandboxId: 'sb-1', bootupType: 'FORK' });

    expect((await session({ projectId: mine.id })).status).toBe(200);
    expect(recordedOutcomes()).toEqual([['create', false]]);

    /*
     * A fresh fork is template state by definition — feeding it to the clean-boot window would bury
     * the signal under the very thing that window exists to distinguish from.
     */
    expect(recordedCleanBoots()).toEqual([]);
  });

  it('records a FAILING create as a failure, even though the route throws', async () => {
    service.createSandboxForProject.mockRejectedValue(new Error('the provider is having a day'));

    const response = await session({ projectId: mine.id });

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(recordedOutcomes()).toEqual([['create', true]]);
  });

  it('records a SUCCESSFUL resume as a non-failure, plus how it came back', async () => {
    await projects.update(mine.id, { sandboxId: 'sb-1' });
    service.sandboxExists.mockResolvedValue(true);
    service.resumeSandbox.mockResolvedValue({ sandboxId: 'sb-1', bootupType: 'RESUME' });

    expect((await session({ projectId: mine.id })).status).toBe(200);

    expect(recordedOutcomes()).toEqual([['resume', false]]);

    /* An ordinary resume is the clean-boot window's denominator — same argument, one window over. */
    expect(recordedCleanBoots()).toEqual([false]);
  });

  it('🔴 records a CLEAN resume as a clean boot — a success no failure metric can ever show', async () => {
    /*
     * The request succeeded and the user got a working sandbox, so the failure windows will never see
     * this. But `CLEAN` means the hibernation snapshot had expired and setup re-ran, so the files are
     * template state and the project the user is looking at came from the §4.5.4c working copy rather
     * than from the VM. It is the closest thing this subsystem has to a data-loss signal, and it is
     * invisible by construction — exactly the shape of every metric this codebase has watched die
     * reporting zero.
     */
    await projects.update(mine.id, { sandboxId: 'sb-1' });
    service.sandboxExists.mockResolvedValue(true);
    service.resumeSandbox.mockResolvedValue({ sandboxId: 'sb-1', bootupType: 'CLEAN' });

    expect((await session({ projectId: mine.id })).status).toBe(200);

    expect(recordedCleanBoots()).toEqual([true]);
    expect(recordedOutcomes(), 'a CLEAN resume is a SUCCESS — it must never enter a failure window').toEqual([
      ['resume', false],
    ]);
  });

  it('records a FAILING resume as a failure when the error is not a fallback case', async () => {
    await projects.update(mine.id, { sandboxId: 'sb-live' });
    service.sandboxExists.mockResolvedValue(true);
    service.resumeSandbox.mockRejectedValue(Object.assign(new Error('upstream exploded'), { status: 500 }));

    expect((await session({ projectId: mine.id })).status).toBeGreaterThanOrEqual(500);
    expect(recordedOutcomes()).toEqual([['resume', true]]);
  });

  it('🔴 records the 503 REFUSAL as a failed resume', async () => {
    /*
     * From the user's side a refusal IS a failed open: they asked for their project and did not get it.
     * It is reached only when `sandboxExists` could not find out — i.e. the provider is unreachable,
     * the precise platform-wide condition this window exists to surface. Leaving it unrecorded makes a
     * total provider outage look like an IDLE window: no attempts, no failures, no alert, while every
     * user in the product is staring at a retryable 503.
     */
    await projects.update(mine.id, { sandboxId: 'sb-1' });
    service.sandboxExists.mockResolvedValue(undefined);

    expect((await session({ projectId: mine.id })).status).toBe(503);
    expect(recordedOutcomes()).toEqual([['resume', true]]);
  });

  it('records BOTH halves of the resume→create fallback', async () => {
    /*
     * The resume genuinely failed and the create genuinely succeeded, so both windows should hear about
     * their own attempt. The recording lives inside `createAndRecord` precisely so this path cannot
     * diverge from the ordinary create path.
     */
    await projects.update(mine.id, { sandboxId: 'sb-stale' });
    service.sandboxExists.mockResolvedValue(true);
    service.resumeSandbox.mockRejectedValue(Object.assign(new Error('Sandbox not found'), { status: 404 }));
    service.createSandboxForProject.mockResolvedValue({ sandboxId: 'sb-fresh', bootupType: 'FORK' });

    expect((await session({ projectId: mine.id })).status).toBe(200);
    expect(recordedOutcomes()).toEqual([
      ['resume', true],
      ['create', false],
    ]);
  });

  it('🔴 records NOTHING when WE refuse for rate limiting', async () => {
    /*
     * A 429 is us rationing forks, not the provider failing — the provider was never called. Counting it
     * would let one user's runaway loop (a reload storm, a broken client retry) trip a platform-wide
     * "nobody can start a project" alert while the platform is perfectly healthy, which is how an
     * operator learns to ignore the signal.
     */
    vi.stubEnv('CODESANDBOX_MAX_CREATES_PER_HOUR', '1');
    service.createSandboxForProject.mockResolvedValue({ sandboxId: 'sb-1', bootupType: 'FORK' });

    const other = await projects.create({ userId: USER.id, name: 'Other', templateId: 'racing' });

    expect((await session({ projectId: mine.id })).status).toBe(200);

    rates.recordSandboxOutcome.mockClear();

    expect((await session({ projectId: other.id })).status).toBe(429);
    expect(recordedOutcomes()).toEqual([]);
    expect(recordedCleanBoots()).toEqual([]);
  });

  it('records nothing at all when a wall refuses before the provider is reached', async () => {
    /*
     * Someone else's project (404) and an unconfigured deploy (503) are refusals that never touch the
     * provider. Recording them would report an outage caused by an unauthenticated poke at the route.
     */
    expect((await session({ projectId: theirs.id })).status).toBe(404);

    vi.stubEnv('CODESANDBOX_API_KEY', '');
    expect((await session({ projectId: mine.id })).status).toBe(503);

    expect(recordedOutcomes()).toEqual([]);
    expect(recordedCleanBoots()).toEqual([]);
  });
});
