import { describe, it, expect } from 'vitest';
import { identityForMount, type ChatIdentity } from './mount-identity';

/**
 * The chat a user is navigating AWAY from when they hit "New chat, same game" — a real conversation
 * with a real transcript on the server. Every field here is a live atom at the moment of the mount.
 */
const previousChat = (): ChatIdentity => ({
  chatId: '1',
  description: 'start dev server',
  urlId: 'start-dev-server',
  metadata: {
    projectId: 'proj-kart-racer',
    serverChatId: '11111111-2222-3333-4444-555555555555',
  },
});

describe('identityForMount — "New chat, same game" (§4.5.6)', () => {
  describe('a fresh chat is born with no identity', () => {
    it('drops the previous chat serverChatId — the field whose collision DESTROYS the old transcript', () => {
      const next = identityForMount({ current: previousChat(), projectId: 'proj-kart-racer', freshChat: true });

      /*
       * The bug this pins: `ensureServerChatId` returns the existing id if the atom has one, so an
       * inherited `serverChatId` makes the new chat's first save overwrite the OLD chat's server object
       * — the only copy the platform holds (§4.5.4b). Nothing throws; the sidebar count never moves.
       */
      expect(next.metadata.serverChatId).toBeUndefined();
    });

    it('drops the previous chatId — an inherited one overwrites the old IndexedDB record', () => {
      const next = identityForMount({ current: previousChat(), projectId: 'proj-kart-racer', freshChat: true });

      // `storeMessageHistory` mints a local id only `if (!chatId.get())`.
      expect(next.chatId).toBeUndefined();
    });

    it('drops the previous title and slug — the header labelled a new chat with the old chat name', () => {
      const next = identityForMount({ current: previousChat(), projectId: 'proj-kart-racer', freshChat: true });

      expect(next.description).toBeUndefined();
      expect(next.urlId).toBeUndefined();
    });

    it('keeps the project — the whole point is that the GAME comes along', () => {
      const next = identityForMount({ current: previousChat(), projectId: 'proj-kart-racer', freshChat: true });

      expect(next.metadata.projectId).toBe('proj-kart-racer');
    });

    it('carries NOTHING but the project, whatever the shape of the metadata grows into', () => {
      /*
       * The property, not the field list. A spread would keep passing the assertions above while
       * silently carrying any field added to `IChatMetadata` later — and the failure mode of carrying
       * one is data loss. Asserting the exact key set is what makes a future addition break here first.
       */
      const next = identityForMount({ current: previousChat(), projectId: 'p1', freshChat: true });

      expect(Object.keys(next.metadata)).toEqual(['projectId']);
    });

    it('does not mutate the caller state', () => {
      const current = previousChat();
      identityForMount({ current, projectId: 'p1', freshChat: true });

      expect(current.metadata.serverChatId).toBe('11111111-2222-3333-4444-555555555555');
    });
  });

  describe('a restore keeps its identity — the transcript owns it', () => {
    it('preserves serverChatId, so a device switch does not re-upload the chat under a second id', () => {
      const next = identityForMount({ current: previousChat(), projectId: 'proj-kart-racer', freshChat: false });

      expect(next.metadata.serverChatId).toBe('11111111-2222-3333-4444-555555555555');
    });

    it('preserves the local id, title and slug', () => {
      const next = identityForMount({ current: previousChat(), projectId: 'proj-kart-racer', freshChat: false });

      expect(next.chatId).toBe('1');
      expect(next.description).toBe('start dev server');
      expect(next.urlId).toBe('start-dev-server');
    });

    it('pins the project even when the previous metadata pointed somewhere else', () => {
      const current = previousChat();
      current.metadata.projectId = 'proj-something-else';

      const next = identityForMount({ current, projectId: 'proj-kart-racer', freshChat: false });

      expect(next.metadata.projectId).toBe('proj-kart-racer');
    });

    it('handles a first-ever mount, where there is no previous chat at all', () => {
      const blank: ChatIdentity = { chatId: undefined, description: undefined, urlId: undefined, metadata: {} };
      const next = identityForMount({ current: blank, projectId: 'p1', freshChat: false });

      expect(next.metadata).toEqual({ projectId: 'p1' });
      expect(next.chatId).toBeUndefined();
    });
  });

  describe('the two modes are genuinely different', () => {
    it('fresh and restore disagree about serverChatId given identical inputs', () => {
      /*
       * The control. If `identityForMount` were accidentally reduced to one branch, every assertion
       * above could still pass for the wrong reason — this is the one that says the flag does anything.
       */
      const current = previousChat();
      const fresh = identityForMount({ current, projectId: 'p1', freshChat: true });
      const restored = identityForMount({ current, projectId: 'p1', freshChat: false });

      expect(fresh.metadata.serverChatId).toBeUndefined();
      expect(restored.metadata.serverChatId).toBe('11111111-2222-3333-4444-555555555555');
    });
  });
});
