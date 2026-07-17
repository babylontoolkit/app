/**
 * A restored chat must be VISIBLE, and there must be exactly ONE of it (SPEC §4.5.6).
 *
 * 🔴 Both of these shipped broken and were reported as "no chats at all show in the left sidebar":
 *
 *   1. `restoreTranscript` wrote the local chat with `urlId: undefined`. The sidebar renders only
 *      `urlId && description`, so every restored conversation was invisible — present in IndexedDB,
 *      addressable by nobody, and indistinguishable from data loss.
 *   2. It minted a fresh `getNextId` on every restore, so each open of the same project deposited
 *      another identical local chat. Four opens of one project left four copies, all carrying the same
 *      `serverChatId`.
 *
 * The server chat id is a conversation's identity; the local record is this browser's cache of it. At
 * most one local record per server id, and it must be findable.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAll, getNextId, getUrlId, openDatabase, setMessages, type IChatMetadata } from './db';
import { slugForChat } from './chat-slug';

let db: IDBDatabase;

beforeEach(async () => {
  db = (await openDatabase())!;
});

afterEach(() => {
  db.close();
  indexedDB.deleteDatabase('boltHistory');
});

/** What the sidebar actually renders — see `Menu.client.tsx`'s `loadEntries`. */
const sidebarVisible = async () => (await getAll(db)).filter((chat) => chat.urlId && chat.description);

const write = (id: string, urlId: string | undefined, title: string, meta: IChatMetadata) =>
  setMessages(db, id, [{ id: 'm1', role: 'user', content: 'hi' }] as never, urlId, title, undefined, meta);

describe('slugForChat', () => {
  it('makes a URL-safe slug from the title the user recognises', () => {
    expect(slugForChat('Kart Racer', 'prj_1')).toBe('kart-racer');
    expect(slugForChat('Shopping Cart Racing!!', 'prj_1')).toBe('shopping-cart-racing');
  });

  it('never returns empty — an empty urlId is an invisible chat', () => {
    expect(slugForChat(undefined, 'prj_1')).toBe('prj_1');
    expect(slugForChat('', 'prj_1')).toBe('prj_1');
    expect(slugForChat('!!!', 'prj_1')).toBe('prj_1');
    expect(slugForChat('   ', 'prj_1')).toBe('prj_1');
  });

  it('trims stray separators rather than emitting -foo-', () => {
    expect(slugForChat('  Kart Racer  ', 'prj_1')).toBe('kart-racer');
    expect(slugForChat('--Kart--Racer--', 'prj_1')).toBe('kart-racer');
  });

  it('bounds the length', () => {
    expect(slugForChat('a'.repeat(200), 'prj_1').length).toBeLessThanOrEqual(40);
  });
});

describe('a restored chat is visible in the sidebar', () => {
  /** 🔴 The reported bug: written with no urlId, so the sidebar showed nothing. */
  it('is NOT visible when written without a urlId — the bug', async () => {
    await write('1', undefined, 'Kart Racer', { projectId: 'prj_1', serverChatId: 'srv-1' });

    expect(await getAll(db)).toHaveLength(1);
    expect(await sidebarVisible()).toHaveLength(0);
  });

  it('is visible when written with the slug the restore now computes', async () => {
    const urlId = await getUrlId(db, slugForChat('Kart Racer', 'prj_1'));
    await write('1', urlId, 'Kart Racer', { projectId: 'prj_1', serverChatId: 'srv-1' });

    const visible = await sidebarVisible();

    expect(visible).toHaveLength(1);
    expect(visible[0].urlId).toBe('kart-racer');
  });

  it('de-duplicates slugs across two projects that share a title', async () => {
    const first = await getUrlId(db, slugForChat('Kart Racer', 'prj_1'));
    await write('1', first, 'Kart Racer', { projectId: 'prj_1', serverChatId: 'srv-1' });

    const second = await getUrlId(db, slugForChat('Kart Racer', 'prj_2'));
    await write('2', second, 'Kart Racer', { projectId: 'prj_2', serverChatId: 'srv-2' });

    expect(first).toBe('kart-racer');
    expect(second).toBe('kart-racer-2');
    expect(await sidebarVisible()).toHaveLength(2);
  });
});

describe('one local chat per server chat id', () => {
  /**
   * The dedupe `restoreTranscript` performs: find the local record for this conversation before
   * minting a new one. Reproduces the "four opens, four copies" report.
   */
  const findLocalFor = async (serverChatId: string) =>
    (await getAll(db)).find((chat) => chat.metadata?.serverChatId === serverChatId);

  it('finds the existing record rather than minting a second', async () => {
    await write('1', 'kart-racer', 'Kart Racer', { projectId: 'prj_1', serverChatId: 'srv-1' });

    const existing = await findLocalFor('srv-1');

    expect(existing?.id).toBe('1');
    expect(existing?.urlId).toBe('kart-racer');
  });

  it('reopening four times leaves ONE local chat, not four', async () => {
    for (let open = 0; open < 4; open++) {
      const existing = await findLocalFor('srv-1');
      const id = existing?.id ?? (await getNextId(db));
      const urlId = existing?.urlId ?? (await getUrlId(db, slugForChat('Kart Racer', 'prj_1')));

      await write(id, urlId, 'Kart Racer', { projectId: 'prj_1', serverChatId: 'srv-1' });
    }

    expect(await getAll(db)).toHaveLength(1);
    expect(await sidebarVisible()).toHaveLength(1);
  });

  /** Without the dedupe — the shipped behaviour — four opens really did leave four. */
  it('minting blindly leaves four, which is what was reported', async () => {
    for (let open = 0; open < 4; open++) {
      await write(await getNextId(db), undefined, 'Kart Racer', { projectId: 'prj_1', serverChatId: 'srv-1' });
    }

    expect(await getAll(db)).toHaveLength(4);
  });

  it('keeps distinct conversations distinct', async () => {
    await write('1', 'spec', 'Spec phase', { projectId: 'prj_1', serverChatId: 'srv-1' });
    await write('2', 'execute', 'Execute phase', { projectId: 'prj_1', serverChatId: 'srv-2' });

    expect(await getAll(db)).toHaveLength(2);
    expect((await findLocalFor('srv-1'))?.description).toBe('Spec phase');
    expect((await findLocalFor('srv-2'))?.description).toBe('Execute phase');
  });
});
