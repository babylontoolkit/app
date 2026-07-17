/**
 * Many chats per project (SPEC §4.5.6), and the two ways that goes silently wrong.
 *
 * 1. **The id.** A chat's local id is a per-browser counter (`getNextId` → "1", "2", "3"), so keying the
 *    server transcript by it makes two devices' chat "1" the same object. Under §4.5.4b the
 *    conversation is the only thing we still store for the user, so that overwrite is data loss.
 * 2. **The reaper.** `deleteMessages` deleted ONE key because there only was one. With many chats, a
 *    key-delete succeeds while leaving every real transcript behind — orphaned bytes with nothing left
 *    that can name them, still ours after the user pressed Delete.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsObjectStore } from '~/lib/.server/storage/store';
import { setObjectStore } from '~/lib/.server/storage';
import {
  deleteChat,
  deleteMessages,
  getChat,
  getChatOrLegacy,
  isValidChatId,
  legacyChatId,
  legacyMessagesKey,
  listChats,
  messagesKey,
  putChat,
  type StoredChat,
} from './message-store';

let tmp: string;
let objects: FsObjectStore;

const PROJECT = 'prj_abc';
const CHAT_A = '11111111-1111-4111-8111-111111111111';
const CHAT_B = '22222222-2222-4222-8222-222222222222';

const chat = (serverChatId: string, over: Partial<StoredChat> = {}): StoredChat => ({
  serverChatId,
  title: 'A chat',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  messages: [{ role: 'user', content: 'hi' }],
  ...over,
});

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'message-store-'));
  objects = new FsObjectStore(path.join(tmp, 'objects'));
  setObjectStore(objects);
});

afterEach(async () => {
  setObjectStore(undefined);
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('the chat id is not the browser’s chat id', () => {
  /**
   * 🔴 The bug this whole design exists to prevent. `getNextId` is `max(local keys) + 1`, so EVERY
   * browser's first chat is "1". If "1" were a valid key, a laptop and a desktop editing one project
   * would write the same object and one would silently destroy the other.
   */
  it('refuses a local counter id', () => {
    for (const local of ['1', '2', '17', '0']) {
      expect(isValidChatId(local)).toBe(false);
      expect(() => messagesKey(PROJECT, local)).toThrow(/invalid chat id/i);
    }
  });

  it('refuses path traversal out of the project’s prefix', () => {
    for (const nasty of ['../other', '../../seeds/prj_xyz', 'a/b', '..', '']) {
      expect(isValidChatId(nasty)).toBe(false);
      expect(() => messagesKey(PROJECT, nasty)).toThrow(/invalid chat id/i);
    }
  });

  it('accepts a real UUID and keys it under the project', () => {
    expect(isValidChatId(CHAT_A)).toBe(true);
    expect(messagesKey(PROJECT, CHAT_A)).toBe(`messages/${PROJECT}/${CHAT_A}.json`);
  });

  it('accepts what crypto.randomUUID actually produces', () => {
    for (let i = 0; i < 20; i++) {
      expect(isValidChatId(crypto.randomUUID())).toBe(true);
    }
  });

  /** Two browsers, same project, both minting locally — the ids must not meet. */
  it('gives two devices different keys for their first chat', () => {
    const laptop = crypto.randomUUID();
    const desktop = crypto.randomUUID();

    expect(messagesKey(PROJECT, laptop)).not.toBe(messagesKey(PROJECT, desktop));
  });
});

describe('a project holds many chats', () => {
  it('round-trips two chats independently', async () => {
    await putChat(PROJECT, chat(CHAT_A, { title: 'Spec' }));
    await putChat(PROJECT, chat(CHAT_B, { title: 'Execute' }));

    expect((await getChat(PROJECT, CHAT_A))?.title).toBe('Spec');
    expect((await getChat(PROJECT, CHAT_B))?.title).toBe('Execute');
  });

  it('lists them newest activity first, without bodies', async () => {
    await putChat(PROJECT, chat(CHAT_A, { title: 'Older', updatedAt: '2026-01-01T00:00:00.000Z' }));
    await putChat(PROJECT, chat(CHAT_B, { title: 'Newer', updatedAt: '2026-06-01T00:00:00.000Z' }));

    const chats = await listChats(PROJECT);

    expect(chats.map((c) => c.title)).toEqual(['Newer', 'Older']);
    expect(chats[0]).not.toHaveProperty('messages');
    expect(chats[0].messageCount).toBe(1);
  });

  it('is empty for a project that has never chatted', async () => {
    expect(await listChats(PROJECT)).toEqual([]);
  });

  it('does not see another project’s chats', async () => {
    await putChat('prj_other', chat(CHAT_A));

    expect(await listChats(PROJECT)).toEqual([]);
    expect(await getChat(PROJECT, CHAT_A)).toBeNull();
  });

  it('deletes one chat without touching its siblings', async () => {
    await putChat(PROJECT, chat(CHAT_A));
    await putChat(PROJECT, chat(CHAT_B));

    await deleteChat(PROJECT, CHAT_A);

    expect(await getChat(PROJECT, CHAT_A)).toBeNull();
    expect(await getChat(PROJECT, CHAT_B)).not.toBeNull();
  });

  it('treats an unreadable chat as a miss rather than throwing', async () => {
    await objects.put(messagesKey(PROJECT, CHAT_A), new TextEncoder().encode('{not json'));

    expect(await getChat(PROJECT, CHAT_A)).toBeNull();
    expect(await listChats(PROJECT)).toEqual([]);
  });
});

describe('conversations from before §4.5.6 still open', () => {
  const putLegacy = (messages: unknown[] = [{ role: 'user', content: 'old' }]) =>
    objects.put(
      legacyMessagesKey(PROJECT),
      new TextEncoder().encode(JSON.stringify({ messages, title: undefined, createdAt: '2026-01-01T00:00:00.000Z' })),
    );

  it('adopts the single-transcript object as a chat', async () => {
    await putLegacy();

    const chats = await listChats(PROJECT);

    expect(chats).toHaveLength(1);
    expect(chats[0].serverChatId).toBe(legacyChatId(PROJECT));
  });

  it('reads it by its synthetic id', async () => {
    await putLegacy();

    const found = await getChatOrLegacy(PROJECT, legacyChatId(PROJECT));

    expect(found?.messages).toEqual([{ role: 'user', content: 'old' }]);
  });

  /** The synthetic id must never collide with a minted one — v4 has `4`/`8-b` where this has `0`. */
  it('has an id no minted UUID can equal', () => {
    const legacy = legacyChatId(PROJECT);

    expect(isValidChatId(legacy)).toBe(true);
    expect(legacy[14]).toBe('0');

    for (let i = 0; i < 50; i++) {
      expect(crypto.randomUUID()).not.toBe(legacy);
    }
  });

  it('is stable across calls and distinct per project', () => {
    expect(legacyChatId(PROJECT)).toBe(legacyChatId(PROJECT));
    expect(legacyChatId(PROJECT)).not.toBe(legacyChatId('prj_different'));
  });

  /** Continuing it migrates it — otherwise the same conversation lists twice, forever. */
  it('migrates to its own object when continued, and drops the old key', async () => {
    await putLegacy();

    await putChat(PROJECT, chat(legacyChatId(PROJECT), { title: 'Continued' }));

    expect(await objects.get(legacyMessagesKey(PROJECT))).toBeNull();

    const chats = await listChats(PROJECT);

    expect(chats).toHaveLength(1);
    expect(chats[0].title).toBe('Continued');
  });

  /** If that delete ever fails, the duplicate must not become visible. */
  it('shows the real object once even if the legacy key survives', async () => {
    await putLegacy();
    await objects.put(
      messagesKey(PROJECT, legacyChatId(PROJECT)),
      new TextEncoder().encode(JSON.stringify(chat(legacyChatId(PROJECT), { title: 'Continued' }))),
    );

    const chats = await listChats(PROJECT);

    expect(chats).toHaveLength(1);
    expect(chats[0].title).toBe('Continued');
  });

  it('deletes both homes so it cannot come back', async () => {
    await putLegacy();
    await putChat(PROJECT, chat(legacyChatId(PROJECT)));

    await deleteChat(PROJECT, legacyChatId(PROJECT));

    expect(await listChats(PROJECT)).toEqual([]);
  });
});

describe('deleting a project sweeps the prefix', () => {
  /**
   * 🔴 The reaper used to delete one key. With many chats that succeeds while leaving every transcript
   * behind — and the project id needed to find them goes with the row.
   */
  it('deletes every chat, not just one', async () => {
    await putChat(PROJECT, chat(CHAT_A));
    await putChat(PROJECT, chat(CHAT_B));

    await deleteMessages(PROJECT);

    expect(await objects.list(`messages/${PROJECT}/`)).toEqual([]);
  });

  it('sweeps the legacy key too', async () => {
    await objects.put(legacyMessagesKey(PROJECT), new TextEncoder().encode('{"messages":[]}'));
    await putChat(PROJECT, chat(CHAT_A));

    await deleteMessages(PROJECT);

    expect(await objects.get(legacyMessagesKey(PROJECT))).toBeNull();
    expect(await listChats(PROJECT)).toEqual([]);
  });

  it('leaves other projects alone', async () => {
    await putChat(PROJECT, chat(CHAT_A));
    await putChat('prj_other', chat(CHAT_A));

    await deleteMessages(PROJECT);

    expect(await getChat('prj_other', CHAT_A)).not.toBeNull();
  });

  it('is a no-op for a project with no chats', async () => {
    await expect(deleteMessages(PROJECT)).resolves.toBeUndefined();
  });
});
