import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PENDING_OPEN_KEY,
  PENDING_REMIX_KEY,
  setPendingOpenProject,
  takePendingProjectMount,
  takePendingRemix,
} from './pending-remix';

/**
 * The pending-mount baton hands a project id from a remix page or the dashboard to the builder on its
 * next load. Two properties matter for correctness (§4.1, §4.8):
 *   - read-once: a refresh must NOT re-mount over later work;
 *   - open beats remix: an explicit dashboard "Open" is the more specific intent.
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
    expect(takePendingProjectMount()).toBe('proj-open');
    expect(takePendingProjectMount()).toBeNull();
  });

  it('prefers an open id over a remix id when both are parked', () => {
    store.set(PENDING_REMIX_KEY, 'proj-remix');
    setPendingOpenProject('proj-open');

    expect(takePendingProjectMount()).toBe('proj-open');
  });

  it('falls back to the remix id when no open id is parked', () => {
    store.set(PENDING_REMIX_KEY, 'proj-remix');

    expect(takePendingProjectMount()).toBe('proj-remix');
  });

  it('returns null when nothing is parked', () => {
    expect(takePendingProjectMount()).toBeNull();
  });
});
