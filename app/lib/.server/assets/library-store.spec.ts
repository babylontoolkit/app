/**
 * Asset library pin store — promote/rollback/unpin + the "no baked fallback" rule (SPEC §4.4d).
 *
 * The store's one deliberate divergence from the market-price pattern is that its degraded state is
 * "NO library" rather than a baked one: telling the model about a library we cannot enumerate is how
 * invented asset paths ship. Several tests pin that direction of degradation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ObjectStore } from '~/lib/.server/storage';
import type { AssetLibraryManifest } from './library-manifest';
import {
  activeAssetLibrary,
  activeAssetLibraryVersionId,
  assetVersionKey,
  ensureAssetLibrary,
  invalidateAssetLibraryCache,
  listAssetVersions,
  promoteAssetLibrary,
  readAssetLibrarySettings,
  readAssetPointer,
  rollbackAssetLibrary,
  setAssetLibraryEnabled,
  unpinAssetLibrary,
} from './library-store';

function memoryStore(): ObjectStore {
  const objects = new Map<string, Uint8Array>();

  return {
    backend: 'filesystem',
    put: async (key, bytes) => void objects.set(key, bytes),
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => void objects.delete(key),
    list: async (prefix) =>
      [...objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ key: k, size: v.length })),
  };
}

function manifest(note = 'v1'): AssetLibraryManifest {
  return {
    version: 1,
    baseUrl: 'https://repo.babylontoolkit.com/',
    note,
    packs: [
      {
        id: 'synty-military',
        title: 'Polygon Military',
        assets: [{ path: 'packs/military/Soldier_01.gltf', name: 'Soldier_01' }],
      },
    ],
  };
}

beforeEach(() => invalidateAssetLibraryCache());
afterEach(() => invalidateAssetLibraryCache());

describe('the active library', () => {
  it('is UNDEFINED before anything is promoted — no baked fallback, no invented capability', () => {
    expect(activeAssetLibrary()).toBeUndefined();
    expect(activeAssetLibraryVersionId()).toBeNull();
  });

  it('is the promoted manifest immediately after a promotion (no TTL wait)', async () => {
    const store = memoryStore();
    const result = await promoteAssetLibrary(store, manifest());

    expect(result.ok).toBe(true);
    expect(activeAssetLibrary()?.packs[0].id).toBe('synty-military');
    expect(activeAssetLibraryVersionId()).toMatch(/^al_\d{14}$/);
  });

  it('loads a promotion made by another process via ensure', async () => {
    const store = memoryStore();
    await promoteAssetLibrary(store, manifest());
    invalidateAssetLibraryCache(); // simulate a different process

    expect(activeAssetLibrary()).toBeUndefined();

    const loaded = await ensureAssetLibrary(store);

    expect(loaded?.packs[0].id).toBe('synty-military');
    expect(activeAssetLibrary()).toBe(loaded);
  });

  it('degrades to "no library" on a broken store WITHOUT throwing, and caches the answer', async () => {
    const broken: ObjectStore = {
      backend: 'filesystem',
      put: async () => {
        throw new Error('disk on fire');
      },
      get: async () => {
        throw new Error('disk on fire');
      },
      delete: async () => {
        throw new Error('disk on fire');
      },
      list: async () => {
        throw new Error('disk on fire');
      },
    };

    await expect(ensureAssetLibrary(broken)).resolves.toBeUndefined();
    expect(activeAssetLibrary()).toBeUndefined();

    // Cached: the second call must not re-probe (same broken store, still no throw).
    await expect(ensureAssetLibrary(broken)).resolves.toBeUndefined();
  });

  it('degrades to "no library" when the pointer names a missing version — and repoints NOTHING', async () => {
    const store = memoryStore();
    const promoted = await promoteAssetLibrary(store, manifest());

    expect(promoted.ok).toBe(true);

    if (promoted.ok) {
      await store.delete(assetVersionKey(promoted.pointer.versionId));
    }

    invalidateAssetLibraryCache();

    await expect(ensureAssetLibrary(store)).resolves.toBeUndefined();

    // The pointer survives — repointing is the admin's call with the history in front of them.
    expect(await readAssetPointer(store)).not.toBeNull();
  });
});

describe('promote', () => {
  it('refuses an invalid manifest BEFORE writing anything — the current library stays untouched', async () => {
    const store = memoryStore();
    await promoteAssetLibrary(store, manifest('good'));

    const before = activeAssetLibraryVersionId();

    const result = await promoteAssetLibrary(store, { version: 1, baseUrl: 'https://x.com/', packs: [] });

    expect(result.ok).toBe(false);
    expect(activeAssetLibraryVersionId()).toBe(before);
    expect(await listAssetVersions(store)).toHaveLength(1);
  });

  it('stores versions immutably — a second promote adds a version, never rewrites one', async () => {
    const store = memoryStore();
    await promoteAssetLibrary(store, manifest('first'));

    // Version ids are second-granularity; force distinct ids without a real wait.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await promoteAssetLibrary(store, manifest('second'));

    const versions = await listAssetVersions(store);

    expect(versions).toHaveLength(2);
    expect(activeAssetLibrary()?.note).toBe('second');
  }, 10_000);

  it('carries the operator note on the pointer', async () => {
    const store = memoryStore();
    const result = await promoteAssetLibrary(store, manifest(), { note: 'August Synty export' });

    expect(result.ok && result.pointer.note).toBe('August Synty export');
  });
});

describe('rollback', () => {
  it('re-points at a stored version and refuses one that is missing', async () => {
    const store = memoryStore();
    const first = await promoteAssetLibrary(store, manifest('first'));
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await promoteAssetLibrary(store, manifest('second'));

    expect(first.ok).toBe(true);

    if (first.ok) {
      const rolled = await rollbackAssetLibrary(store, first.pointer.versionId);

      expect(rolled.ok).toBe(true);
      expect(activeAssetLibrary()?.note).toBe('first');
    }

    const missing = await rollbackAssetLibrary(store, 'al_19700101000000');
    expect(missing.ok).toBe(false);
  }, 10_000);
});

/*
 * The "Use Asset Library" feature switch (Settings → Admin → Features). The owner's rule is absolute:
 * switched OFF, the pinned library must behave as if it never existed — it MUST NEVER leak into a
 * project. `activeAssetLibrary()` is the single read the prompt builder uses, so every test here
 * pins that seam. A regression fails silently (the block just reappears; nothing throws).
 */
describe('the Use-Asset-Library feature switch', () => {
  it('defaults ON: absent settings serve the pinned library', async () => {
    const store = memoryStore();
    await promoteAssetLibrary(store, manifest());
    invalidateAssetLibraryCache();

    await expect(readAssetLibrarySettings(store)).resolves.toEqual({ enabled: true });
    await expect(ensureAssetLibrary(store)).resolves.toBeDefined();
    expect(activeAssetLibrary()).toBeDefined();
  });

  it('OFF hides a valid pin completely — no manifest, no version id, exactly like no library', async () => {
    const store = memoryStore();
    await promoteAssetLibrary(store, manifest());

    await setAssetLibraryEnabled(store, false);

    expect(activeAssetLibrary()).toBeUndefined();
    expect(activeAssetLibraryVersionId()).toBeNull();

    // A fresh process reading the same store arrives at the same answer.
    invalidateAssetLibraryCache();
    await expect(ensureAssetLibrary(store)).resolves.toBeUndefined();
    expect(activeAssetLibrary()).toBeUndefined();

    // The pin itself survives, dormant — re-enabling must not need a re-promotion.
    expect(await readAssetPointer(store)).not.toBeNull();
  });

  it('promoting WHILE OFF moves the pin but leaks nothing to the model', async () => {
    const store = memoryStore();
    await setAssetLibraryEnabled(store, false);

    const result = await promoteAssetLibrary(store, manifest());

    expect(result.ok).toBe(true);
    expect(activeAssetLibrary()).toBeUndefined();
    expect(activeAssetLibraryVersionId()).toBeNull();
  });

  it('rolling back WHILE OFF moves the pin but leaks nothing to the model', async () => {
    const store = memoryStore();
    const first = await promoteAssetLibrary(store, manifest('first'));

    expect(first.ok).toBe(true);
    await setAssetLibraryEnabled(store, false);

    if (first.ok) {
      const rolled = await rollbackAssetLibrary(store, first.pointer.versionId);
      expect(rolled.ok).toBe(true);
    }

    expect(activeAssetLibrary()).toBeUndefined();
  });

  it('switching back ON serves the dormant pin again, immediately, without a re-promotion', async () => {
    const store = memoryStore();
    await promoteAssetLibrary(store, manifest('kept'));
    await setAssetLibraryEnabled(store, false);

    expect(activeAssetLibrary()).toBeUndefined();

    await setAssetLibraryEnabled(store, true);

    expect(activeAssetLibrary()?.note).toBe('kept');
    expect(activeAssetLibraryVersionId()).toMatch(/^al_\d{14}$/);
  });

  it('corrupt settings are not an admin decision — they default ON, never silently disable', async () => {
    const store = memoryStore();
    await promoteAssetLibrary(store, manifest());
    await store.put('assets/library/settings.json', new TextEncoder().encode('{not json'), 'application/json');
    invalidateAssetLibraryCache();

    await expect(readAssetLibrarySettings(store)).resolves.toEqual({ enabled: true });
    await expect(ensureAssetLibrary(store)).resolves.toBeDefined();
  });

  it('only an explicit false disables — a missing `enabled` field reads as ON', async () => {
    const store = memoryStore();
    await store.put('assets/library/settings.json', new TextEncoder().encode('{}'), 'application/json');

    await expect(readAssetLibrarySettings(store)).resolves.toMatchObject({ enabled: true });
  });
});

describe('unpin', () => {
  it('removes the pointer, keeps the versions, and the active library becomes undefined', async () => {
    const store = memoryStore();
    await promoteAssetLibrary(store, manifest());

    await unpinAssetLibrary(store);

    expect(activeAssetLibrary()).toBeUndefined();
    expect(await readAssetPointer(store)).toBeNull();
    expect(await listAssetVersions(store)).toHaveLength(1); // re-promotable

    invalidateAssetLibraryCache();
    await expect(ensureAssetLibrary(store)).resolves.toBeUndefined();
  });
});
