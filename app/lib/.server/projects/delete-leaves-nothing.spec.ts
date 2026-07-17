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
import { FsProjectStore, setProjectStore } from './store';
import { listChats, putChat } from './message-store';
import { putRemixSeed, seedKey } from '~/lib/.server/share/seed-store';
import type { Project } from './types';

const USER = { id: 'user-1', email: 'a@example.com', emailVerified: true } as const;

vi.mock('~/lib/.server/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireVerifiedUser: async () => USER,
  requireUser: async () => USER,
}));

let tmp: string;
let objects: FsObjectStore;
let projects: FsProjectStore;
let mine: Project;
let theirs: Project;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'project-delete-'));
  objects = new FsObjectStore(path.join(tmp, 'objects'));
  projects = new FsProjectStore(path.join(tmp, 'projects'));

  setObjectStore(objects);
  setProjectStore(projects);

  mine = await projects.create({ userId: USER.id, name: 'Mine', templateId: 'racing' });
  theirs = await projects.create({ userId: 'someone-else', name: 'Theirs', templateId: 'racing' });
});

afterEach(async () => {
  setObjectStore(undefined);
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
