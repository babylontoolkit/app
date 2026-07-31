/**
 * The import baton — "the next page load is the tail of an import" (`pending-import.ts`).
 *
 * Small, and load-bearing for a reason that is invisible from the code: `importChat` ends with
 * `window.location.href = …`, a FULL page load, so nothing else survives to tell the next page that an
 * import is landing. Its files arrive by artifact replay after the chat renders, and without this flag
 * that load is indistinguishable from opening any other chat — workbench up, files trickling into it in
 * full view, which is the whole defect the splash exists to prevent.
 *
 * Two properties fail silently and are pinned here: a baton that is not read-once re-opens a splash over
 * a project whose files landed long ago (and, because the settle then finds a quiet map, it sits for the
 * floor doing nothing); and a module that touches `sessionStorage` unguarded breaks SSR, where these
 * functions are evaluated with no such global.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasPendingImport, PENDING_IMPORT_KEY, setPendingImport, takePendingImport } from './pending-import';

/** The same stub the sibling baton's spec uses — these tests run in node, with no DOM. */
function stubSessionStorage(): Map<string, string> {
  const store = new Map<string, string>();

  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });

  return store;
}

describe('the import baton', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = stubSessionStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is absent until an import sets it', () => {
    expect(hasPendingImport()).toBe(false);
    expect(takePendingImport()).toBe(false);
  });

  it('survives the write and reads back as pending', () => {
    setPendingImport();

    expect(hasPendingImport()).toBe(true);
    expect(store.get(PENDING_IMPORT_KEY)).toBeDefined();
  });

  /**
   * 🔴 READ-ONCE. The consuming read has to clear the key, or every later refresh of that chat raises
   * the splash again over a workspace that finished filling minutes ago — a surface covering nothing,
   * for the length of the settle floor, on a project the user is trying to work in.
   */
  it('is consumed by the first take and gone for every one after it', () => {
    setPendingImport();

    expect(takePendingImport()).toBe(true);
    expect(takePendingImport()).toBe(false);
    expect(hasPendingImport()).toBe(false);
  });

  /**
   * The peek must NOT consume. Two hook instances read this on the same load; if the peek ate the baton
   * the instance that actually starts the wait could find nothing — the exact shape of the mount-baton
   * bug that `hasPendingProjectMount` documents.
   */
  it('peeks without consuming', () => {
    setPendingImport();

    expect(hasPendingImport()).toBe(true);
    expect(hasPendingImport()).toBe(true);
    expect(takePendingImport()).toBe(true);
  });
});

describe('SSR safety', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /*
   * This module is imported by `useChatHistory`, which Remix evaluates on the SERVER — and it is read
   * at module evaluation there (`importTailPending`), so an unguarded access is not a subtle
   * degradation, it is a 500 on every page.
   */
  it('degrades to "no import" with no sessionStorage, and never throws', () => {
    vi.stubGlobal('sessionStorage', undefined);

    expect(() => setPendingImport()).not.toThrow();
    expect(hasPendingImport()).toBe(false);
    expect(takePendingImport()).toBe(false);
  });
});

/**
 * CONTROL — every assertion above is worthless if the stub is not actually wired to the module. This
 * proves a write through the module's own API is visible in the backing store, so a build where these
 * functions silently did nothing would fail here rather than pass everything.
 */
describe('CONTROL', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drives the real module through the stubbed storage', () => {
    const store = stubSessionStorage();

    setPendingImport();
    expect([...store.keys()]).toEqual([PENDING_IMPORT_KEY]);

    takePendingImport();
    expect([...store.keys()]).toEqual([]);
  });
});
