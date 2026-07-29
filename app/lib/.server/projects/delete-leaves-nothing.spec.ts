/**
 * Deleting a project deletes the project (SPEC §4.5.4b, §4.8, §5).
 *
 * 🔴 **This is written because it was not true.** `DELETE /api/projects/:id` removed the row and left
 * `messages/{projectId}.json` in object storage forever — and the id needed to find it again went with
 * the row, so it was unreachable as well as undeleted. "Delete my project" left the user's whole
 * conversation on our servers, silently, with the UI reporting success.
 *
 * It survived because the messages key was private to the messages route: nothing else could address a
 * conversation, so nothing else could reap one. That is the same shape as the orphaned snapshot
 * payloads §4.5.4b keeps turning up — bytes outliving the record that named them.
 *
 * The project id is the only handle on ANY of a user's bytes here (both the seed and the chat live at
 * keys derived from it), so this test asserts the property rather than the call: after a delete,
 * storage holds nothing belonging to that project.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsObjectStore } from '~/lib/.server/storage/store';
import { setObjectStore } from '~/lib/.server/storage';
import { FsChatIndex, setChatIndex } from './chat-index';
import { FsProjectStore, setProjectStore } from './store';
import { listChats, putChat } from './message-store';
import { putRemixSeed, seedKey } from '~/lib/.server/share/seed-store';
import { putWorkingCopy, workingCopyKey } from './working-copy';
import type { Project } from './types';

const USER = { id: 'user-1', email: 'a@example.com', emailVerified: true } as const;

vi.mock('~/lib/.server/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireVerifiedUser: async () => USER,
  requireUser: async () => USER,
}));

/**
 * The sandbox reaper is mocked, not driven: `~/lib/.server/sandbox/service` imports `@codesandbox/sdk`
 * at module scope, so an unmocked route import drags the vendor SDK (and its API-key requirement) into
 * a test about object storage. What matters here is the CALL — that the VM is reaped, exactly once,
 * with the id the row carried, before the row that names it is gone.
 */
const deleteSandbox = vi.fn<(sandboxId: string, context?: unknown) => Promise<void>>();

vi.mock('~/lib/.server/sandbox/service', () => ({
  deleteSandbox: (...args: [string, unknown?]) => deleteSandbox(...args),
}));

/** The monitor is stubbed so the best-effort failure path can be asserted as REPORTED, not swallowed. */
const captureException = vi.fn();

vi.mock('~/lib/.server/monitoring', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMonitor: () => ({
    captureException,
    captureMessage: vi.fn(),
    alert: vi.fn(),
    track: vi.fn(),
  }),
}));

let tmp: string;
let objects: FsObjectStore;
let projects: FsProjectStore;
let mine: Project;
let theirs: Project;

beforeEach(async () => {
  deleteSandbox.mockReset();
  deleteSandbox.mockResolvedValue(undefined);
  captureException.mockReset();

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'project-delete-'));
  objects = new FsObjectStore(path.join(tmp, 'objects'));
  projects = new FsProjectStore(path.join(tmp, 'projects'));

  setObjectStore(objects);

  // Both stores, or this writes into the developer's real `.data/` — see `message-store.spec.ts`.
  setChatIndex(new FsChatIndex(path.join(tmp, 'index')));
  setProjectStore(projects);

  mine = await projects.create({ userId: USER.id, name: 'Mine', templateId: 'racing' });
  theirs = await projects.create({ userId: 'someone-else', name: 'Theirs', templateId: 'racing' });
});

afterEach(async () => {
  setObjectStore(undefined);
  setChatIndex(undefined);
  setProjectStore(undefined);
  await fs.rm(tmp, { recursive: true, force: true });
});

const deleteProject = async (projectId: string) => {
  const { action } = await import('~/routes/api.projects.$projectId');

  return action({
    request: new Request('https://app.example.com/api/projects/p', { method: 'DELETE' }),
    params: { projectId },
    context: {},
  } as never);
};

/**
 * A project has many chats (§4.5.6), so "give it a chat" gives it several — the reaper's job is to
 * sweep the prefix, and a fixture with one chat cannot tell a prefix sweep from a key delete.
 */
const giveItAChat = async (projectId: string, count = 2) => {
  for (let i = 0; i < count; i++) {
    await putChat(projectId, {
      serverChatId: crypto.randomUUID(),
      title: `Chat ${i}`,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      messages: [{ role: 'user', content: 'hi' }],
    });
  }
};

describe('deleting a project leaves nothing behind', () => {
  it('deletes the conversations — the bug this file exists for', async () => {
    await giveItAChat(mine.id);
    expect(await listChats(mine.id)).toHaveLength(2);

    await deleteProject(mine.id);

    expect(await listChats(mine.id)).toEqual([]);
  });

  /**
   * 🔴 A key-delete would pass the test above only if it happened to delete the single key a fixture
   * created. With many chats it deletes nothing and reports success, so this pins the SWEEP.
   */
  it('deletes every chat, not merely the first', async () => {
    await giveItAChat(mine.id, 5);

    await deleteProject(mine.id);

    expect(await objects.list(`messages/${mine.id}/`)).toEqual([]);
  });

  it('deletes the remix seed', async () => {
    await putRemixSeed(mine.id, { 'a.ts': { type: 'file', content: 'x', isBinary: false } });

    await deleteProject(mine.id);

    expect(await objects.get(seedKey(mine.id))).toBeNull();
  });

  /*
   * The working copy (§4.5.4c) holds the project's ENTIRE file tree, so an orphaned one is the worst
   * version of the bug this file exists for: the user deleted their game and the platform kept all of
   * it. Unconditional, like the seed — a hint that disagrees with storage leaves the bytes behind.
   */
  it('deletes the working copy', async () => {
    await putWorkingCopy(mine.id, {
      projectId: mine.id,
      seq: 1,
      updatedAt: 'now',
      files: { 'a.ts': { type: 'file', content: 'x', isBinary: false } },
    });

    await deleteProject(mine.id);

    expect(await objects.get(workingCopyKey(mine.id))).toBeNull();
  });

  /*
   * The VM (migration 0013, plan T4). Same orphan rule as the bytes above, with money attached: the
   * sandbox id lives ONLY on this row, so a delete that skips the reap leaves a machine billing by the
   * second that nothing in the product can name. The legacy per-user registry already produced a fleet
   * of exactly these (`scripts/sweep-legacy-sandboxes.mjs`); this is what stops the delete path from
   * making more.
   */
  it('deletes the project’s sandbox when the row carries one', async () => {
    await projects.update(mine.id, { sandboxId: 'sbx_mine' });

    await deleteProject(mine.id);

    expect(deleteSandbox).toHaveBeenCalledTimes(1);
    expect(deleteSandbox.mock.calls[0][0]).toBe('sbx_mine');
  });

  /**
   * The common case — a WebContainer or local build, where no VM was ever created. A provider call on
   * a project with no sandbox is not merely wasted: `deleteSandbox` requires the API key, so on a build
   * with none configured it would THROW on every delete.
   */
  it('never calls the provider when there is no sandbox', async () => {
    await deleteProject(mine.id);

    expect(deleteSandbox).not.toHaveBeenCalled();
  });

  /**
   * 🔴 Ordering, not tidiness: the row is the only thing that names the VM. Reap after the row is gone
   * and a failure in `store.delete` — or a crash between the two — strands a billing machine with
   * nothing left that can address it, which is the exact failure this whole file is about. Asserted by
   * READING the store from inside the provider call rather than by call order, because "the row still
   * exists at that moment" is the property; the sequence of two statements is only how it is achieved.
   */
  it('reaps the sandbox BEFORE deleting the row that names it', async () => {
    await projects.update(mine.id, { sandboxId: 'sbx_mine' });

    let rowAtReapTime: Project | null = null;

    deleteSandbox.mockImplementation(async () => {
      rowAtReapTime = await projects.get(mine.id);
    });

    await deleteProject(mine.id);

    expect(rowAtReapTime).not.toBeNull();
    expect(await projects.get(mine.id)).toBeNull();
  });

  /**
   * Best-effort, per `deleteSandbox`'s own contract: a provider outage must not make a project
   * undeletable — the user pressed Delete, and refusing would hold their project hostage to a vendor.
   * But best-effort is not silent: an orphan VM is a bill nobody sees, so the failure is REPORTED.
   */
  it('still deletes the project when the provider fails, and reports the failure', async () => {
    await projects.update(mine.id, { sandboxId: 'sbx_mine' });
    deleteSandbox.mockRejectedValue(new Error('provider is down'));

    const response = await deleteProject(mine.id);

    expect(response.status).toBe(200);
    expect(await projects.get(mine.id)).toBeNull();
    expect(captureException).toHaveBeenCalledTimes(1);
    expect((captureException.mock.calls[0][0] as Error).message).toBe('provider is down');
    expect(captureException.mock.calls[0][1]).toMatchObject({
      tags: { projectId: mine.id, sandboxId: 'sbx_mine' },
    });
  });

  it('deletes the project row', async () => {
    await deleteProject(mine.id);

    expect(await projects.get(mine.id)).toBeNull();
  });

  /**
   * The property, not the call list. A field added to a project later — another object at another
   * derived key — should fail here rather than quietly leak, so this asserts on ALL storage rather
   * than on the two things that happen to exist today.
   */
  it('leaves NOTHING in storage under that project id', async () => {
    await giveItAChat(mine.id);
    await putRemixSeed(mine.id, { 'a.ts': { type: 'file', content: 'x', isBinary: false } });

    await deleteProject(mine.id);

    const everything = await objects.list('');

    expect(everything.filter((o) => o.key.includes(mine.id))).toEqual([]);
  });

  it('reports success', async () => {
    const response = await deleteProject(mine.id);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe('a delete cannot reach across projects', () => {
  /** The walls come first: someone else's id is indistinguishable from a nonexistent one (§4.5.3). */
  it('404s for someone else’s project and touches nothing', async () => {
    await giveItAChat(theirs.id);

    expect((await deleteProject(theirs.id)).status).toBe(404);

    expect(await projects.get(theirs.id)).not.toBeNull();
    expect(await listChats(theirs.id)).toHaveLength(2);
  });

  it('404s for an id that does not exist, identically', async () => {
    expect((await deleteProject('prj_does_not_exist')).status).toBe(404);
  });

  it('leaves other projects’ bytes alone', async () => {
    await giveItAChat(mine.id);
    await giveItAChat(theirs.id);

    await deleteProject(mine.id);

    expect(await listChats(theirs.id)).toHaveLength(2);
  });
});

describe('deleting a project that has nothing stored', () => {
  /** The common case — a project deleted before it ever generated. The reaper must not throw. */
  it('succeeds when there is no chat and no seed', async () => {
    expect((await deleteProject(mine.id)).status).toBe(200);
    expect(await projects.get(mine.id)).toBeNull();
  });
});
