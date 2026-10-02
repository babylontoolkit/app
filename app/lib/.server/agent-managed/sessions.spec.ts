/**
 * One Managed Agents session per chat (`sessions.ts`, managed-agents-engine plan T4).
 *
 * Every case runs against the REAL `FsChatIndex` in a throwaway directory — never the developer's
 * `.data/chats` (the index falls back to it) — and a "second device" is a second call with nothing
 * shared but the index, which is exactly what a second browser has.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsChatIndex, getChatIndex, setChatIndex } from '~/lib/.server/projects/chat-index';
import { NotFoundError } from '~/lib/.server/projects/ownership';
import { listChats, putChat } from '~/lib/.server/projects/message-store';
import { setObjectStore } from '~/lib/.server/storage';
import { FsObjectStore } from '~/lib/.server/storage/store';
import {
  getManagedSessionId,
  getManagedSettledAt,
  getOrCreateManagedSession,
  ManagedSessionError,
  setManagedSettledAt,
} from './sessions';

const USER = 'user-a';
const PROJECT = randomUUID();
const OTHER_PROJECT = randomUUID();

let tmp: string;
let index: FsChatIndex;
let minted: number;

/** A `create` that mints a new fake session id per call and counts them. */
function creator() {
  return vi.fn(async () => `sesn_${++minted}`);
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-sessions-'));
  index = new FsChatIndex(path.join(tmp, 'index'));
  setChatIndex(index);
  setObjectStore(new FsObjectStore(path.join(tmp, 'objects')));
  minted = 0;
});

afterEach(async () => {
  setChatIndex(undefined);
  setObjectStore(undefined);
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('getOrCreateManagedSession', () => {
  it("creates the session on the chat's first managed turn and records it on the chat row", async () => {
    const chatId = randomUUID();
    const create = creator();

    const ref = await getOrCreateManagedSession({ userId: USER, projectId: PROJECT, chatId, create });

    expect(ref).toEqual({ sessionId: 'sesn_1', created: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect((await index.get(chatId))?.managedSessionId).toBe('sesn_1');
  });

  it('a second device opening the chat continues the SAME session and creates nothing', async () => {
    const chatId = randomUUID();
    await getOrCreateManagedSession({ userId: USER, projectId: PROJECT, chatId, create: creator() });

    /* Device two: a fresh index instance over the same storage, no in-memory state shared. */
    setChatIndex(new FsChatIndex(path.join(tmp, 'index')));

    const create = creator();
    const ref = await getOrCreateManagedSession({ userId: USER, projectId: PROJECT, chatId, create });

    expect(ref).toEqual({ sessionId: 'sesn_1', created: false });
    expect(create).not.toHaveBeenCalled();
    expect(await getManagedSessionId(PROJECT, chatId)).toBe('sesn_1');
  });

  it("another project's chat id is refused as not found, and its session is never returned", async () => {
    const chatId = randomUUID();
    await getOrCreateManagedSession({ userId: USER, projectId: PROJECT, chatId, create: creator() });

    const create = creator();
    const error = await getOrCreateManagedSession({
      userId: 'user-b',
      projectId: OTHER_PROJECT,
      chatId,
      create,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.statusCode).toBe(404);
    expect(error.message).toBe('Chat not found.');
    expect(create).not.toHaveBeenCalled();
    expect(await getManagedSessionId(OTHER_PROJECT, chatId)).toBeNull();

    /* CONTROL: the owner still gets it. */
    expect(await getManagedSessionId(PROJECT, chatId)).toBe('sesn_1');
  });

  it('a chat already indexed under another project (no session yet) is refused too', async () => {
    const chatId = randomUUID();
    const now = new Date().toISOString();
    await index.upsert({ id: chatId, projectId: OTHER_PROJECT, messageCount: 2, createdAt: now, updatedAt: now });

    const create = creator();
    const error = await getOrCreateManagedSession({ userId: USER, projectId: PROJECT, chatId, create }).catch((e) => e);

    expect(error).toBeInstanceOf(NotFoundError);
    expect(create).not.toHaveBeenCalled();
    expect((await index.get(chatId))?.projectId).toBe(OTHER_PROJECT);
  });

  it('the same answer for a non-existent and a malformed chat id — the error never teaches the format', async () => {
    const malformed = await getOrCreateManagedSession({
      userId: USER,
      projectId: PROJECT,
      chatId: '../../seeds/x',
      create: creator(),
    }).catch((e) => e);

    expect(malformed).toBeInstanceOf(NotFoundError);
    expect(malformed.message).toBe('Chat not found.');
  });

  it('a turn with no chat id cannot have a session — a descriptive 400, nothing created', async () => {
    const create = creator();
    const error = await getOrCreateManagedSession({
      userId: USER,
      projectId: PROJECT,
      chatId: undefined,
      create,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(ManagedSessionError);
    expect(error.statusCode).toBe(400);
    expect(error.message).toMatch(/session per chat/);
    expect(create).not.toHaveBeenCalled();
  });

  it('two racing first turns: the FIRST recorded session wins, the loser is discarded, both continue the winner', async () => {
    const chatId = randomUUID();
    const discard = vi.fn(async () => undefined);

    /*
     * Hold both creates open until both requests have read "no session yet" — the real race. Without
     * the barrier the second call would simply read the first one's row.
     */
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    let waiting = 0;

    const create = vi.fn(async () => {
      const id = `sesn_${++minted}`;
      waiting += 1;

      if (waiting === 2) {
        release();
      }

      await barrier;

      return id;
    });

    const [a, b] = await Promise.all([
      getOrCreateManagedSession({ userId: USER, projectId: PROJECT, chatId, create, discard }),
      getOrCreateManagedSession({ userId: USER, projectId: PROJECT, chatId, create, discard }),
    ]);

    expect(create).toHaveBeenCalledTimes(2);
    expect(a.sessionId).toBe(b.sessionId);
    expect([a.created, b.created].sort()).toEqual([false, true]);

    const stored = (await index.get(chatId))?.managedSessionId;
    expect(stored).toBe(a.sessionId);

    const loser = stored === 'sesn_1' ? 'sesn_2' : 'sesn_1';
    expect(discard).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledWith(loser);
  });

  it('a failing discard never fails the turn', async () => {
    const chatId = randomUUID();
    await index.claimManagedSession({
      id: chatId,
      projectId: PROJECT,
      sessionId: 'sesn_winner',
      now: new Date().toISOString(),
    });

    /* Simulate the read-before-claim seeing nothing (the race), then a claim that loses. */
    const real = index.get.bind(index);
    let first = true;
    vi.spyOn(index, 'get').mockImplementation(async (id) => {
      if (first) {
        first = false;
        return null;
      }

      return real(id);
    });

    const ref = await getOrCreateManagedSession({
      userId: USER,
      projectId: PROJECT,
      chatId,
      create: async () => 'sesn_loser',
      discard: async () => {
        throw new Error('archive failed');
      },
    });

    expect(ref).toEqual({ sessionId: 'sesn_winner', created: false });
  });
});

describe('the session survives the transcript save (`putChat` → `upsert`)', () => {
  it('saving the transcript after the first managed turn keeps the session pointer', async () => {
    const chatId = randomUUID();
    await getOrCreateManagedSession({ userId: USER, projectId: PROJECT, chatId, create: creator() });

    const now = new Date().toISOString();
    await getChatIndex().upsert({
      id: chatId,
      projectId: PROJECT,
      title: 'Kart',
      messageCount: 4,
      createdAt: now,
      updatedAt: now,
    });

    const row = await index.get(chatId);
    expect(row?.managedSessionId).toBe('sesn_1');
    expect(row?.title).toBe('Kart');
    expect(row?.messageCount).toBe(4);
  });

  it('a save that re-homes the chat id into another project DROPS the session (mirrors migration 0026)', async () => {
    const chatId = randomUUID();
    await getOrCreateManagedSession({ userId: USER, projectId: PROJECT, chatId, create: creator() });

    const now = new Date().toISOString();
    await index.upsert({ id: chatId, projectId: OTHER_PROJECT, messageCount: 1, createdAt: now, updatedAt: now });

    expect((await index.get(chatId))?.managedSessionId).toBeUndefined();

    /* So the new "owner" of the row gets a FRESH session, never the victim's. */
    const ref = await getOrCreateManagedSession({
      userId: 'user-b',
      projectId: OTHER_PROJECT,
      chatId,
      create: async () => 'sesn_fresh',
    });

    expect(ref).toEqual({ sessionId: 'sesn_fresh', created: true });
  });

  it('upsert cannot WRITE a session either — only claimManagedSession can', async () => {
    const chatId = randomUUID();
    const now = new Date().toISOString();
    await index.upsert({
      id: chatId,
      projectId: PROJECT,
      messageCount: 1,
      createdAt: now,
      updatedAt: now,
      managedSessionId: 'sesn_forged',
    });

    expect((await index.get(chatId))?.managedSessionId).toBeUndefined();
  });
});

describe('the sidebar (`listChats`) — a claimed row neither hides nor invents a chat', () => {
  it('a session claimed before the first save lists nothing (no ghost), then the saved chat lists normally with its session', async () => {
    const chatId = randomUUID();
    await getOrCreateManagedSession({ userId: USER, projectId: PROJECT, chatId, create: creator() });

    /* The row exists, the transcript does not yet — the objects decide what exists. */
    expect(await listChats(PROJECT)).toEqual([]);

    const now = new Date().toISOString();
    await putChat(PROJECT, {
      serverChatId: chatId,
      title: 'Kart racer',
      createdAt: now,
      updatedAt: now,
      messages: [{ id: 'm1', role: 'user', content: 'make a kart racer' }] as never,
    });

    const listed = await listChats(PROJECT);
    expect(listed.map((c) => c.serverChatId)).toEqual([chatId]);
    expect(await getManagedSessionId(PROJECT, chatId)).toBe('sesn_1');
  });
});

describe('settlement cursor (T7)', () => {
  it('reads back what was written, only for the owning project', async () => {
    const chatId = randomUUID();
    await getOrCreateManagedSession({ userId: USER, projectId: PROJECT, chatId, create: creator() });

    expect(await getManagedSettledAt(PROJECT, chatId)).toBeNull();

    await setManagedSettledAt(PROJECT, chatId, '2026-10-01T12:00:00.123Z');

    expect(await getManagedSettledAt(PROJECT, chatId)).toBe('2026-10-01T12:00:00.123Z');
    expect(await getManagedSettledAt(OTHER_PROJECT, chatId)).toBeNull();
    expect(await getManagedSessionId(PROJECT, chatId)).toBe('sesn_1');
  });

  it("refuses to write another project's cursor", async () => {
    const chatId = randomUUID();
    await getOrCreateManagedSession({ userId: USER, projectId: PROJECT, chatId, create: creator() });

    await expect(setManagedSettledAt(OTHER_PROJECT, chatId, '2026-10-01T12:00:00Z')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await getManagedSettledAt(PROJECT, chatId)).toBeNull();
  });

  it('the transcript save keeps the cursor too', async () => {
    const chatId = randomUUID();
    await getOrCreateManagedSession({ userId: USER, projectId: PROJECT, chatId, create: creator() });
    await setManagedSettledAt(PROJECT, chatId, '2026-10-01T12:00:00Z');

    const now = new Date().toISOString();
    await index.upsert({ id: chatId, projectId: PROJECT, messageCount: 6, createdAt: now, updatedAt: now });

    expect(await getManagedSettledAt(PROJECT, chatId)).toBe('2026-10-01T12:00:00Z');
  });
});
