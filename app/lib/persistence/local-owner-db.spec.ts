/**
 * The stamping half of local ownership — `setMessages` and `stampChatOwners` against a real IndexedDB.
 *
 * `local-owner.spec.ts` pins the RULES; these pin the two database behaviours that the rules assume
 * and that no pure test can see. Both fail silently in opposite directions: a write that forgets to
 * stamp hides a chat from its own author, and a stamp that overwrites hands one account's
 * conversation to another.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAll, getMessages, openDatabase, setMessages, stampChatOwners } from './db';
import { NO_VIEWER, UNKNOWN_VIEWER, setLocalViewer } from './local-owner';

let db: IDBDatabase;

beforeEach(async () => {
  db = (await openDatabase())!;
  setLocalViewer(UNKNOWN_VIEWER);
});

afterEach(() => {
  db.close();
  indexedDB.deleteDatabase('boltHistory');
  setLocalViewer(UNKNOWN_VIEWER);
});

const message = [{ id: 'm1', role: 'user', content: 'hi' }] as never;

const write = (id: string, description = 'a chat') => setMessages(db, id, message, id, description);

describe('setMessages stamping', () => {
  it('stamps the signed-in account onto every write', async () => {
    setLocalViewer({ status: 'user', id: 'alice' });
    await write('1');

    expect((await getMessages(db, '1')).ownerId).toBe('alice');
  });

  it('PRESERVES an existing owner when the session has not resolved yet', async () => {
    /*
     * The boot race: `/api/me` answers after first paint, and the user can be typing before it does.
     * `put` replaces the whole record, so clobbering the owner with `undefined` here would un-own a
     * live conversation and hide it from the person writing it — visible only as their own chat
     * disappearing from the sidebar mid-generation.
     */
    setLocalViewer({ status: 'user', id: 'alice' });
    await write('1', 'first');

    setLocalViewer(UNKNOWN_VIEWER);
    await write('1', 'second');

    const stored = await getMessages(db, '1');
    expect(stored.ownerId).toBe('alice');
    expect(stored.description).toBe('second');
  });

  it('does not invent an owner for a signed-out write', async () => {
    setLocalViewer(NO_VIEWER);
    await write('1');

    expect((await getMessages(db, '1')).ownerId).toBeUndefined();
  });

  it('re-stamps to the account that is actually writing', async () => {
    // Not the same as re-attributing an old record: this is a live write, by a known user.
    setLocalViewer({ status: 'user', id: 'alice' });
    await write('1');

    setLocalViewer({ status: 'user', id: 'bob' });
    await write('1');

    expect((await getMessages(db, '1')).ownerId).toBe('bob');
  });
});

describe('stampChatOwners', () => {
  it('stamps only the ids in the plan, and leaves the rest of the record alone', async () => {
    setLocalViewer(NO_VIEWER);
    await write('1', 'kart racer');
    await write('2', 'someone else');

    expect(await stampChatOwners(db, ['1'], 'alice')).toBe(1);

    const stamped = await getMessages(db, '1');
    expect(stamped.ownerId).toBe('alice');
    expect(stamped.description).toBe('kart racer');
    expect(stamped.urlId).toBe('1');
    expect(stamped.messages).toHaveLength(1);

    expect((await getMessages(db, '2')).ownerId).toBeUndefined();
  });

  it('never overwrites a record that has been claimed since the plan was made', async () => {
    setLocalViewer({ status: 'user', id: 'alice' });
    await write('1');

    // A plan built moments earlier, when the record was still unowned. Bob has no claim on it now.
    expect(await stampChatOwners(db, ['1'], 'bob')).toBe(0);
    expect((await getMessages(db, '1')).ownerId).toBe('alice');
  });

  it('skips an id that no longer exists rather than recreating it', async () => {
    // Putting one back would resurrect a chat the user deleted in another tab.
    expect(await stampChatOwners(db, ['gone'], 'alice')).toBe(0);
    expect(await getAll(db)).toHaveLength(0);
  });

  it('is a no-op for an empty plan', async () => {
    expect(await stampChatOwners(db, [], 'alice')).toBe(0);
  });
});
