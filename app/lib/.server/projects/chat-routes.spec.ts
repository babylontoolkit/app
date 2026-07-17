/**
 * The per-chat routes (SPEC §4.5.3, §4.5.6, §5).
 *
 * Both ids in `/api/projects/:projectId/messages/:chatId` are values the CALLER chooses, so this pins
 * both walls: the project goes through `requireOwnedProject` (404, never 403 — a 403 confirms the id
 * exists and is an enumeration oracle), and the chat id must be one we could have minted.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsObjectStore } from '~/lib/.server/storage/store';
import { setObjectStore } from '~/lib/.server/storage';
import { FsProjectStore, setProjectStore } from './store';
import { getChat, listChats, MAX_CHATS_PER_PROJECT, putChat } from './message-store';
import type { Project } from './types';

const USER = { id: 'user-1', email: 'a@example.com', emailVerified: true } as const;

vi.mock('~/lib/.server/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireVerifiedUser: async () => USER,
  requireUser: async () => USER,
}));

const CHAT_A = '11111111-1111-4111-8111-111111111111';
const CHAT_B = '22222222-2222-4222-8222-222222222222';

let tmp: string;
let objects: FsObjectStore;
let projects: FsProjectStore;
let mine: Project;
let theirs: Project;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-routes-'));
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

const seed = (projectId: string, serverChatId: string, over: Record<string, unknown> = {}) =>
  putChat(projectId, {
    serverChatId,
    title: 'A chat',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messages: [{ role: 'user', content: 'hi' }],
    ...over,
  });

const listRoute = async (projectId: string) => {
  const { loader } = await import('~/routes/api.projects.$projectId.messages');
  return loader({
    request: new Request('https://app.example.com/x'),
    params: { projectId },
    context: {},
  } as never);
};

const readRoute = async (projectId: string, chatId: string) => {
  const { loader } = await import('~/routes/api.projects.$projectId.messages.$chatId');
  return loader({
    request: new Request('https://app.example.com/x'),
    params: { projectId, chatId },
    context: {},
  } as never);
};

const writeRoute = async (projectId: string, chatId: string, body: unknown, method = 'PUT') => {
  const { action } = await import('~/routes/api.projects.$projectId.messages.$chatId');
  return action({
    request: new Request('https://app.example.com/x', { method, body: JSON.stringify(body) }),
    params: { projectId, chatId },
    context: {},
  } as never);
};

describe('listing a project’s chats', () => {
  it('returns them for the owner', async () => {
    await seed(mine.id, CHAT_A);
    await seed(mine.id, CHAT_B);

    const body = (await (await listRoute(mine.id)).json()) as { chats: unknown[] };

    expect(body.chats).toHaveLength(2);
  });

  /** "Nothing yet" is a real answer here — every project between created and first message. */
  it('returns an empty list, not a 404, for a project that has never chatted', async () => {
    const response = await listRoute(mine.id);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ chats: [] });
  });

  it('404s for someone else’s project', async () => {
    await seed(theirs.id, CHAT_A);

    expect((await listRoute(theirs.id)).status).toBe(404);
  });

  it('404s identically for a project that does not exist', async () => {
    expect((await listRoute('prj_nope')).status).toBe(404);
  });
});

describe('reading one chat', () => {
  it('returns it for the owner', async () => {
    await seed(mine.id, CHAT_A);

    const body = (await (await readRoute(mine.id, CHAT_A)).json()) as { chat: { messages: unknown[] } };

    expect(body.chat.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  /** Unlike the list, a named chat that is gone is a 404 — an empty one invites saving over it. */
  it('404s for a chat that does not exist', async () => {
    expect((await readRoute(mine.id, CHAT_A)).status).toBe(404);
  });

  it('404s for someone else’s project even with a valid chat id', async () => {
    await seed(theirs.id, CHAT_A);

    expect((await readRoute(theirs.id, CHAT_A)).status).toBe(404);
  });

  /** 🔴 The id is caller-supplied — a traversal must not escape the project's own prefix. */
  it('400s on an id that is not a chat id', async () => {
    for (const nasty of ['../../seeds/prj_other', '1', 'not-a-uuid']) {
      expect((await readRoute(mine.id, nasty)).status).toBe(400);
    }
  });

  /** The walls run in order: ownership is decided before the id is even inspected. */
  it('404s rather than 400s when BOTH the project and the id are bad', async () => {
    expect((await readRoute(theirs.id, '../escape')).status).toBe(404);
  });
});

describe('saving a chat', () => {
  it('writes it and reports success', async () => {
    const response = await writeRoute(mine.id, CHAT_A, { messages: [{ role: 'user', content: 'yo' }], title: 'Spec' });

    expect(response.status).toBe(200);

    const stored = await getChat(mine.id, CHAT_A);

    expect(stored?.title).toBe('Spec');
    expect(stored?.messages).toEqual([{ role: 'user', content: 'yo' }]);
  });

  it('refuses a body that is not a list of messages', async () => {
    expect((await writeRoute(mine.id, CHAT_A, { messages: 'nope' })).status).toBe(400);
    expect((await writeRoute(mine.id, CHAT_A, {})).status).toBe(400);
  });

  it('404s for someone else’s project and writes nothing', async () => {
    expect((await writeRoute(theirs.id, CHAT_A, { messages: [] })).status).toBe(404);
    expect(await getChat(theirs.id, CHAT_A)).toBeNull();
  });

  it('400s on an id that is not a chat id', async () => {
    expect((await writeRoute(mine.id, '../escape', { messages: [] })).status).toBe(400);
  });

  it('keeps createdAt as the chat’s birthday and moves updatedAt', async () => {
    await writeRoute(mine.id, CHAT_A, { messages: [], createdAt: '2020-01-01T00:00:00.000Z' });

    const stored = await getChat(mine.id, CHAT_A);

    expect(stored?.createdAt).toBe('2020-01-01T00:00:00.000Z');
    expect(stored?.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
  });

  describe('the chat cap', () => {
    const fill = async (count: number) => {
      for (let i = 0; i < count; i++) {
        await seed(mine.id, crypto.randomUUID());
      }
    };

    it('refuses a NEW chat past the cap', async () => {
      await fill(MAX_CHATS_PER_PROJECT);

      expect((await writeRoute(mine.id, CHAT_A, { messages: [] })).status).toBe(409);
    });

    /**
     * 🔴 The cap must never cost someone the conversation they are IN. Refusing a new chat is an
     * inconvenience; refusing to save an existing one is data loss, on the only copy we hold.
     */
    it('still saves an EXISTING chat at the cap', async () => {
      await fill(MAX_CHATS_PER_PROJECT - 1);
      await seed(mine.id, CHAT_A);

      expect(await listChats(mine.id)).toHaveLength(MAX_CHATS_PER_PROJECT);

      const response = await writeRoute(mine.id, CHAT_A, { messages: [{ role: 'user', content: 'still working' }] });

      expect(response.status).toBe(200);
      expect((await getChat(mine.id, CHAT_A))?.messages).toEqual([{ role: 'user', content: 'still working' }]);
    });
  });
});

describe('deleting one chat', () => {
  it('deletes it and leaves the project and its siblings alone', async () => {
    await seed(mine.id, CHAT_A);
    await seed(mine.id, CHAT_B);

    const response = await writeRoute(mine.id, CHAT_A, {}, 'DELETE');

    expect(response.status).toBe(200);
    expect(await getChat(mine.id, CHAT_A)).toBeNull();
    expect(await getChat(mine.id, CHAT_B)).not.toBeNull();
    expect(await projects.get(mine.id)).not.toBeNull();
  });

  it('404s for someone else’s chat and deletes nothing', async () => {
    await seed(theirs.id, CHAT_A);

    expect((await writeRoute(theirs.id, CHAT_A, {}, 'DELETE')).status).toBe(404);
    expect(await getChat(theirs.id, CHAT_A)).not.toBeNull();
  });

  it('succeeds for a chat that is already gone', async () => {
    expect((await writeRoute(mine.id, CHAT_A, {}, 'DELETE')).status).toBe(200);
  });
});
