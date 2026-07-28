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
}));

vi.mock('./service', () => service);
vi.mock('~/lib/.server/sandbox/service', () => service);

let tmp: string;
let projects: FsProjectStore;
let mine: Project;
let theirs: Project;

/** Every provider call this test suite can observe — the "zero provider calls" assertion reads this. */
const providerCalls = () => Object.values(service).reduce((total, spy) => total + spy.mock.calls.length, 0);

beforeEach(async () => {
  vi.stubEnv('CODESANDBOX_API_KEY', 'csb_test_key');
  resetSandboxCreateLimits();

  for (const spy of Object.values(service)) {
    spy.mockReset();
  }

  service.createBrowserSession.mockResolvedValue({ session: 'scoped' });
  service.createPreviewAccess.mockResolvedValue({ url: 'https://p.csb.app/?preview_token=t', expiresAt: 'later' });
  service.deleteSandbox.mockResolvedValue(undefined);

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
    expect(service.resumeSandbox).toHaveBeenCalledWith('sb-1', expect.anything());
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
    expect(service.deleteSandbox).toHaveBeenCalledWith('sb-old', expect.anything());
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
    expect(service.deleteSandbox).toHaveBeenCalledWith('sb-second', expect.anything());
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
