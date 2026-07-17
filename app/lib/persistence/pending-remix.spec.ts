import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PENDING_CHAT_KEY,
  PENDING_FRESH_CHAT_KEY,
  PENDING_OPEN_KEY,
  PENDING_REMIX_KEY,
  setPendingOpenProject,
  takePendingProjectMount,
  takePendingRemix,
} from './pending-remix';

/**
 * The pending-mount baton hands a project id from a remix page or the dashboard to the builder on its
 * next load. Four properties matter for correctness (§4.1, §4.8, §4.5.6):
 *   - read-once: a refresh must NOT re-mount over later work;
 *   - open beats remix: an explicit dashboard "Open" is the more specific intent;
 *   - the chat slots never go stale: a leftover id silently opens the WRONG conversation, which reads
 *     as data loss to the user while everything is in fact still there;
 *   - a remix never inherits a chat id: it is a new project, and that id names a conversation belonging
 *     to the project it was cloned FROM.
 */
describe('pending project mount baton', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads a remix id once and clears it', () => {
    store.set(PENDING_REMIX_KEY, 'proj-remix');

    expect(takePendingRemix()).toBe('proj-remix');
    expect(takePendingRemix()).toBeNull();
  });

  it('parks and takes an open id, once', () => {
    setPendingOpenProject('proj-open');

    expect(store.get(PENDING_OPEN_KEY)).toBe('proj-open');
    expect(takePendingProjectMount()).toEqual({ projectId: 'proj-open', serverChatId: undefined, freshChat: false });
    expect(takePendingProjectMount()).toBeNull();
  });

  it('prefers an open id over a remix id when both are parked', () => {
    store.set(PENDING_REMIX_KEY, 'proj-remix');
    setPendingOpenProject('proj-open');

    expect(takePendingProjectMount()?.projectId).toBe('proj-open');
  });

  it('falls back to the remix id when no open id is parked', () => {
    store.set(PENDING_REMIX_KEY, 'proj-remix');

    expect(takePendingProjectMount()).toEqual({ projectId: 'proj-remix', freshChat: false });
  });

  it('returns null when nothing is parked', () => {
    expect(takePendingProjectMount()).toBeNull();
  });
});

describe('which conversation comes back (§4.5.6)', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to the latest chat — no id, no fresh flag', () => {
    setPendingOpenProject('proj');

    expect(store.has(PENDING_CHAT_KEY)).toBe(false);
    expect(store.has(PENDING_FRESH_CHAT_KEY)).toBe(false);
    expect(takePendingProjectMount()).toEqual({ projectId: 'proj', serverChatId: undefined, freshChat: false });
  });

  it('carries a specific chat id', () => {
    setPendingOpenProject('proj', 'chat-abc');

    expect(takePendingProjectMount()).toEqual({ projectId: 'proj', serverChatId: 'chat-abc', freshChat: false });
  });

  it('carries the fresh-chat intent, with no chat id', () => {
    setPendingOpenProject('proj', 'fresh');

    expect(takePendingProjectMount()).toEqual({ projectId: 'proj', serverChatId: undefined, freshChat: true });
  });

  /**
   * 🔴 The stale-slot bug. Park a specific chat, then open a project normally: without the clear, the
   * second open silently restores the FIRST project's conversation.
   */
  it('clears a previous chat id when the next open does not name one', () => {
    setPendingOpenProject('proj-a', 'chat-abc');
    setPendingOpenProject('proj-b');

    expect(takePendingProjectMount()).toEqual({ projectId: 'proj-b', serverChatId: undefined, freshChat: false });
  });

  it('clears a previous fresh flag when the next open does not want one', () => {
    setPendingOpenProject('proj-a', 'fresh');
    setPendingOpenProject('proj-b');

    expect(takePendingProjectMount()?.freshChat).toBe(false);
  });

  it('clears a previous chat id when the next open is fresh', () => {
    setPendingOpenProject('proj-a', 'chat-abc');
    setPendingOpenProject('proj-b', 'fresh');

    expect(takePendingProjectMount()).toEqual({ projectId: 'proj-b', serverChatId: undefined, freshChat: true });
  });

  it('clears a previous fresh flag when the next open names a chat', () => {
    setPendingOpenProject('proj-a', 'fresh');
    setPendingOpenProject('proj-b', 'chat-xyz');

    expect(takePendingProjectMount()).toEqual({ projectId: 'proj-b', serverChatId: 'chat-xyz', freshChat: false });
  });

  /** A remix is a NEW project — a chat id from an earlier open names someone else's conversation. */
  it('never hands a leftover chat id to a remix', () => {
    setPendingOpenProject('proj-a', 'chat-abc');
    takePendingProjectMount();

    store.set(PENDING_CHAT_KEY, 'chat-abc');
    store.set(PENDING_REMIX_KEY, 'proj-clone');

    expect(takePendingProjectMount()).toEqual({ projectId: 'proj-clone', freshChat: false });
  });

  it('consumes the chat slots even on the remix path, so they cannot leak forward', () => {
    store.set(PENDING_CHAT_KEY, 'chat-abc');
    store.set(PENDING_FRESH_CHAT_KEY, '1');
    store.set(PENDING_REMIX_KEY, 'proj-clone');

    takePendingProjectMount();

    expect(store.has(PENDING_CHAT_KEY)).toBe(false);
    expect(store.has(PENDING_FRESH_CHAT_KEY)).toBe(false);
  });

  it('reads the chat slots once', () => {
    setPendingOpenProject('proj', 'chat-abc');

    expect(takePendingProjectMount()?.serverChatId).toBe('chat-abc');
    expect(store.has(PENDING_CHAT_KEY)).toBe(false);
  });
});
