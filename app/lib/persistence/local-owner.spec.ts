/**
 * The local-ownership rules (`local-owner.ts`).
 *
 * These decide what one account may read out of a browser that another account has also used, and
 * every failure mode is silent — a too-permissive rule shows a stranger's conversation and throws
 * nothing, a too-strict one hides the user's own work and also throws nothing. So the tests below are
 * written against the DECISIONS rather than the shapes, and each of the three adoption branches has a
 * control proving the opposite input reaches the opposite answer.
 */
import { describe, expect, it } from 'vitest';
import {
  LOCAL_SINGLE_USER_ID,
  NO_VIEWER,
  UNKNOWN_VIEWER,
  filterOwnedRecords,
  ownsLocalRecord,
  planAdoption,
  viewerFromSession,
  type AdoptableChat,
  type LocalViewer,
} from './local-owner';

const alice: LocalViewer = { status: 'user', id: 'alice' };
const bob: LocalViewer = { status: 'user', id: 'bob' };

function chat(id: string, extra: Partial<AdoptableChat> = {}): AdoptableChat {
  return { id, ...extra };
}

describe('viewerFromSession', () => {
  it('reports UNKNOWN while the session is loading, even though the empty session looks local', () => {
    /*
     * The trap this pins: `EMPTY_SESSION` is `{ loading: true, accountsEnabled: false }`, and a
     * resolved local-mode session is `{ loading: false, accountsEnabled: false }`. Read the second
     * field first and every booting page is handed the local single-user id — i.e. shown every record
     * on the machine — for as long as `/api/me` takes to answer.
     */
    expect(viewerFromSession({ loading: true, accountsEnabled: false, user: undefined })).toEqual(UNKNOWN_VIEWER);
    expect(viewerFromSession({ loading: true, accountsEnabled: true, user: undefined })).toEqual(UNKNOWN_VIEWER);
  });

  it('reports the signed-in account', () => {
    const viewer = viewerFromSession({
      loading: false,
      accountsEnabled: true,
      user: { id: 'alice' } as never,
    });

    expect(viewer).toEqual({ status: 'user', id: 'alice' });
  });

  it('reports the single local user when accounts are not configured', () => {
    expect(viewerFromSession({ loading: false, accountsEnabled: false, user: undefined })).toEqual({
      status: 'user',
      id: LOCAL_SINGLE_USER_ID,
    });
  });

  it('reports NOBODY when accounts exist and nobody is signed in', () => {
    expect(viewerFromSession({ loading: false, accountsEnabled: true, user: undefined })).toEqual(NO_VIEWER);
  });
});

describe('ownsLocalRecord', () => {
  it('matches on the owner id', () => {
    expect(ownsLocalRecord({ ownerId: 'alice' }, alice)).toBe(true);
    expect(ownsLocalRecord({ ownerId: 'alice' }, bob)).toBe(false);
  });

  it('gives an UNSTAMPED record to nobody — never to everybody', () => {
    // The permissive reading of this line IS the bug the module exists to remove.
    expect(ownsLocalRecord({}, alice)).toBe(false);
    expect(ownsLocalRecord({ ownerId: undefined }, alice)).toBe(false);
  });

  it('gives nothing to a viewer we could not identify, and nothing to a guest', () => {
    expect(ownsLocalRecord({ ownerId: 'alice' }, UNKNOWN_VIEWER)).toBe(false);
    expect(ownsLocalRecord({ ownerId: 'alice' }, NO_VIEWER)).toBe(false);

    // ...and an unstamped record does not become visible just because nobody claims it.
    expect(ownsLocalRecord({}, UNKNOWN_VIEWER)).toBe(false);
    expect(ownsLocalRecord({}, NO_VIEWER)).toBe(false);
  });
});

describe('filterOwnedRecords', () => {
  it('keeps only the viewer’s own records, in order', () => {
    const records = [
      { id: '1', ownerId: 'alice' },
      { id: '2', ownerId: 'bob' },
      { id: '3' },
      { id: '4', ownerId: 'alice' },
    ];

    expect(filterOwnedRecords(records, alice).map((r) => r.id)).toEqual(['1', '4']);
    expect(filterOwnedRecords(records, bob).map((r) => r.id)).toEqual(['2']);
  });

  it('returns nothing at all for an unresolved session — the offline-fallback hole', () => {
    /*
     * `localChatList` deliberately filters nothing, so this is the only thing standing between a 401
     * (an expired session reaches the sidebar's catch as an ordinary error) and every chat on the
     * machine being listed.
     */
    const records = [{ id: '1', ownerId: 'alice' }, { id: '2', ownerId: 'bob' }, { id: '3' }];

    expect(filterOwnedRecords(records, UNKNOWN_VIEWER)).toEqual([]);
    expect(filterOwnedRecords(records, NO_VIEWER)).toEqual([]);
  });
});

describe('planAdoption', () => {
  const base = { viewer: alice, unsyncedAdopted: false, serverAnswered: true };

  it('adopts a legacy chat the server confirms is the viewer’s', () => {
    const plan = planAdoption({
      ...base,
      chats: [chat('1', { metadata: { serverChatId: 'uuid-a' } })],
      ownedServerChatIds: new Set(['uuid-a']),
    });

    expect(plan.ownerId).toBe('alice');
    expect(plan.chatIds).toEqual(['1']);
  });

  it('leaves a legacy chat the server does NOT confirm — the cross-account case', () => {
    // Bob's chat, sitting in the shared browser. Alice has no claim on it and never will.
    const plan = planAdoption({
      ...base,
      chats: [chat('1', { metadata: { serverChatId: 'uuid-bob' } })],
      ownedServerChatIds: new Set(['uuid-a']),
    });

    expect(plan.chatIds).toEqual([]);
  });

  it('adopts an unsynced legacy chat once, then never again for this browser', () => {
    const chats = [chat('1')];

    expect(planAdoption({ ...base, chats, ownedServerChatIds: new Set() }).chatIds).toEqual(['1']);

    // The second account to sign in inherits nothing.
    expect(
      planAdoption({ ...base, viewer: bob, unsyncedAdopted: true, chats, ownedServerChatIds: new Set() }).chatIds,
    ).toEqual([]);
  });

  it('never re-stamps a record that already has an owner', () => {
    /*
     * Ownership is decided once and is final. Re-attributing on a later sign-in would be the original
     * leak with an audit trail — and note the server CONFIRMS this id, so only the `ownerId` guard
     * stops it.
     */
    const plan = planAdoption({
      ...base,
      viewer: bob,
      chats: [chat('1', { ownerId: 'alice', metadata: { serverChatId: 'uuid-a' } })],
      ownedServerChatIds: new Set(['uuid-a']),
    });

    expect(plan.chatIds).toEqual([]);
  });

  it('does nothing when the server did not answer, and does not burn the one-shot marker', () => {
    /*
     * A failed `/api/chats` yields an empty owned set, which is shaped exactly like "you own no
     * chats". Acting on it would stamp nothing while closing the window, orphaning every legacy chat
     * on the machine permanently — a silent, unrecoverable outcome.
     */
    const plan = planAdoption({
      ...base,
      serverAnswered: false,
      chats: [chat('1'), chat('2', { metadata: { serverChatId: 'uuid-a' } })],
      ownedServerChatIds: new Set(),
    });

    expect(plan).toEqual({ chatIds: [], markUnsyncedAdopted: false });
    expect(plan.ownerId).toBeUndefined();
  });

  it('does nothing for an unresolved or signed-out viewer', () => {
    for (const viewer of [UNKNOWN_VIEWER, NO_VIEWER]) {
      const plan = planAdoption({ ...base, viewer, chats: [chat('1')], ownedServerChatIds: new Set() });

      expect(plan).toEqual({ chatIds: [], markUnsyncedAdopted: false });
    }
  });

  it('closes the window even when there was nothing to adopt', () => {
    // Leaving it open "until there is something to claim" leaves it open for the NEXT account.
    const plan = planAdoption({ ...base, chats: [], ownedServerChatIds: new Set() });

    expect(plan.chatIds).toEqual([]);
    expect(plan.markUnsyncedAdopted).toBe(true);
  });

  it('mixes the three branches in one pass', () => {
    const plan = planAdoption({
      ...base,
      chats: [
        chat('mine-synced', { metadata: { serverChatId: 'uuid-a' } }),
        chat('theirs-synced', { metadata: { serverChatId: 'uuid-bob' } }),
        chat('unsynced'),
        chat('already-owned', { ownerId: 'bob' }),
      ],
      ownedServerChatIds: new Set(['uuid-a']),
    });

    expect(plan.chatIds).toEqual(['mine-synced', 'unsynced']);
  });
});
