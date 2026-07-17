import { describe, it, expect } from 'vitest';
import { mergeChatList, localChatList, type ServerChat } from './chat-list';
import type { ChatHistoryItem } from './useChatHistory';

const serverChat = (over: Partial<ServerChat> = {}): ServerChat => ({
  serverChatId: '11111111-1111-1111-1111-111111111111',
  projectId: 'proj-kart',
  projectName: 'Kart Racer',
  title: 'add a boost pad',
  createdAt: '2026-07-16T10:00:00.000Z',
  updatedAt: '2026-07-16T10:00:00.000Z',
  messageCount: 4,
  ...over,
});

const localChat = (over: Partial<ChatHistoryItem> = {}): ChatHistoryItem => ({
  id: '1',
  urlId: 'add-a-boost-pad',
  description: 'add a boost pad',
  messages: [],
  timestamp: '2026-07-16T10:00:00.000Z',
  metadata: { projectId: 'proj-kart', serverChatId: '11111111-1111-1111-1111-111111111111' },
  ...over,
});

describe('mergeChatList — the server-backed sidebar (§4.5.6)', () => {
  describe('a chat from another device', () => {
    it('is listed even though this browser has never seen it', () => {
      /*
       * The whole point. Before this, the sidebar was `getAll(indexedDb)` — a chat started on a laptop
       * simply did not exist on a desktop, though its transcript was on the server all along.
       */
      const merged = mergeChatList([serverChat()], []);

      expect(merged).toHaveLength(1);
      expect(merged[0].description).toBe('add a boost pad');
      expect(merged[0].metadata?.serverChatId).toBe('11111111-1111-1111-1111-111111111111');
    });

    it('is marked non-local, since Export and Duplicate need an IndexedDB record', () => {
      expect(mergeChatList([serverChat()], [])[0].local).toBe(false);
    });

    it('carries the project it belongs to, so one flat list can say which game', () => {
      expect(mergeChatList([serverChat()], [])[0].projectName).toBe('Kart Racer');
    });
  });

  describe('a chat this browser also has', () => {
    it('keeps the LOCAL id — the server id is not what Export looks up', () => {
      const merged = mergeChatList([serverChat()], [localChat({ id: '7' })]);

      expect(merged[0].id).toBe('7');
      expect(merged[0].local).toBe(true);
    });

    it('prefers the SERVER title — another device may have renamed it', () => {
      const merged = mergeChatList([serverChat({ title: 'renamed on the laptop' })], [localChat()]);

      expect(merged[0].description).toBe('renamed on the laptop');
    });

    it('appears exactly once, not twice', () => {
      expect(mergeChatList([serverChat()], [localChat()])).toHaveLength(1);
    });
  });

  describe('a local chat with no server id', () => {
    it('is kept — it is the chat the user is in right now, just not saved yet', () => {
      /*
       * A conversation with no project, or nothing said yet, has never been uploaded. Dropping it
       * because the server has not heard of it would delete the current chat out from under the user.
       */
      const fresh = localChat({ id: '9', description: 'thinking out loud', metadata: undefined });
      const merged = mergeChatList([], [fresh]);

      expect(merged).toHaveLength(1);
      expect(merged[0].id).toBe('9');
      expect(merged[0].local).toBe(true);
    });
  });

  describe('a local chat whose server chat is gone', () => {
    it('is dropped — a delete on another device has to stick here too', () => {
      const merged = mergeChatList([], [localChat()]);
      expect(merged).toHaveLength(0);
    });
  });

  describe('nothing is ever invisible', () => {
    /*
     * 🔴 The regression this guards. The old sidebar filtered on `item.urlId && item.description`, and
     * both came only from the model's first artifact — so a chat the model never wrote a file in (a
     * question answered in prose, a failed generation, a Stop) rendered nothing and reported nothing.
     * Reported as "no chats at all show in the left sidebar".
     */
    it('lists a chat with no title', () => {
      const merged = mergeChatList([serverChat({ title: undefined })], []);

      expect(merged).toHaveLength(1);
      expect(merged[0].description).toBeTruthy();
    });

    it('always links by the SERVER id — a title slug is not unique across users', () => {
      /*
       * The multi-user bug. `/chat/start-dev-server` was upstream's title slug, de-duplicated against
       * ONE browser's IndexedDB (`getUrlId` appends `-2`). Two users who both type "start dev server"
       * get the same URL, and the de-duplication cannot see across accounts — so it can never be a
       * server key. It also puts the conversation's title in the URL bar and every proxy log on the way.
       *
       * Pinned even for a chat whose LOCAL record still carries an old slug: the link is the identity.
       */
      const merged = mergeChatList([serverChat()], [localChat({ urlId: 'start-dev-server' })]);

      expect(merged[0].urlId).toBe('11111111-1111-1111-1111-111111111111');
      expect(merged[0].urlId).not.toBe('start-dev-server');
    });

    it('lists a local-only chat with neither', () => {
      const merged = mergeChatList(
        [],
        [localChat({ id: '3', urlId: undefined, description: undefined, metadata: undefined })],
      );

      expect(merged).toHaveLength(1);
      expect(merged[0].urlId).toBeTruthy();
      expect(merged[0].description).toBeTruthy();
    });
  });

  describe('"the server said none" is not "the server said nothing"', () => {
    /*
     * 🔴 The trap, pinned because I walked straight into it writing the fallback. `mergeChatList` drops
     * a local chat whose server chat is absent — right when the server has genuinely spoken, fatal when
     * it merely failed to answer. Using it as the offline fallback empties the sidebar on a flaky
     * connection, and looks exactly like every conversation having been deleted.
     */
    it('mergeChatList with an empty server list drops synced chats — by design', () => {
      expect(mergeChatList([], [localChat()])).toHaveLength(0);
    });

    it('localChatList keeps them, which is why the fallback must use it', () => {
      const offline = localChatList([localChat()]);

      expect(offline).toHaveLength(1);
      expect(offline[0].description).toBe('add a boost pad');
    });

    it('localChatList still lists a chat with no title or urlId', () => {
      const bare = localChatList([localChat({ id: '4', urlId: undefined, description: undefined })]);

      expect(bare[0].urlId).toBeTruthy();
      expect(bare[0].description).toBeTruthy();
    });
  });

  describe('order', () => {
    it('is newest activity first', () => {
      const merged = mergeChatList(
        [
          serverChat({ serverChatId: 'aaaaaaaa-1111-1111-1111-111111111111', updatedAt: '2026-07-16T09:00:00.000Z' }),
          serverChat({ serverChatId: 'bbbbbbbb-1111-1111-1111-111111111111', updatedAt: '2026-07-16T11:00:00.000Z' }),
        ],
        [],
      );

      expect(merged.map((c) => c.metadata?.serverChatId)).toEqual([
        'bbbbbbbb-1111-1111-1111-111111111111',
        'aaaaaaaa-1111-1111-1111-111111111111',
      ]);
    });

    it('breaks a same-millisecond tie deterministically rather than by luck', () => {
      const at = '2026-07-16T10:00:00.000Z';
      const args = [
        serverChat({ serverChatId: 'bbbbbbbb-1111-1111-1111-111111111111', updatedAt: at }),
        serverChat({ serverChatId: 'aaaaaaaa-1111-1111-1111-111111111111', updatedAt: at }),
      ];

      const once = mergeChatList(args, []).map((c) => c.id);
      const twice = mergeChatList([...args].reverse(), []).map((c) => c.id);

      expect(once).toEqual(twice);
    });
  });
});
