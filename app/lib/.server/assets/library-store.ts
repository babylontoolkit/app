/**
 * Versioned storage for the Synty asset library manifest (SPEC §4.4d).
 *
 * The template-pin/market-price rules applied to the asset library: versions are IMMUTABLE objects
 * keyed by a minted id, "which one is live" is a separate pointer, changing the library is a
 * deliberate admin PROMOTION (validated before the pointer moves), and rollback re-points at bytes
 * that still validate. Generations NEVER fetch `repo.babylontoolkit.com` at runtime — they read the
 * promoted manifest, exactly as they never depend on GitHub (§4.3).
 *
 * ## The one deliberate difference from the price store: there is NO baked fallback
 *
 * Prices have a baked list because a zero-rate bills wrong; the asset library has NOTHING until an
 * admin promotes one, because the honest degraded state is "no library" — the prompt then simply
 * omits the block and the brief tells the model to build with the `classes/` demo content and
 * primitives. Telling the model about a library we cannot enumerate is how invented asset paths end
 * up in shipped games. Degrading a capability to "off" is honest; degrading it to "on" invents one.
 *
 * Same sync/async seam as the price store: `activeAssetLibrary()` synchronously for prompt building,
 * `ensureAssetLibrary()` at async doorways (agent proxy entry, admin routes). A failed load serves
 * "no library" and never blocks a generation.
 */
import { createScopedLogger } from '~/utils/logger';
import type { ObjectStore } from '~/lib/.server/storage';
import { getObjectStore } from '~/lib/.server/storage';
import type { AssetLibraryManifest } from './library-manifest';
import { validateAssetLibraryManifest } from './library-manifest';

const logger = createScopedLogger('asset-library-store');

const VERSION_PREFIX = 'assets/library/versions';
const POINTER_KEY = 'assets/library/active.json';

/** How long a loaded manifest is trusted before the next ensure re-reads the pointer. */
const CACHE_TTL_MS = 60_000;

export interface AssetLibraryPointer {
  versionId: string;
  activatedAt: string;
  activatedBy: 'promote' | 'rollback';

  /** Optional operator note ("August Synty export"), shown in the version history. */
  note?: string;
}

export interface AssetLibraryVersionListing {
  versionId: string;
  size: number;
  storedAt?: string;
}

export function assetVersionKey(versionId: string): string {
  return `${VERSION_PREFIX}/${versionId.replace(/[^a-zA-Z0-9._-]/g, '__')}.json`;
}

/*
 * ------------------------------------------------------------------------------------------------ *
 * The in-process active-manifest cache
 * ------------------------------------------------------------------------------------------------
 */

interface CacheState {
  /** undefined = no library is pinned (or the store was unreadable) — the prompt emits no block. */
  manifest: AssetLibraryManifest | undefined;
  versionId: string | null;
  loadedAt: number;
}

let cache: CacheState | undefined;

/**
 * The active manifest, synchronously — or undefined when nothing is pinned. This is THE read the
 * prompt builder uses; it can never throw and never returns a manifest that failed validation.
 */
export function activeAssetLibrary(): AssetLibraryManifest | undefined {
  return cache?.manifest;
}

/** Which version is live — null means no library is pinned. Surfaced in the admin panel. */
export function activeAssetLibraryVersionId(): string | null {
  return cache?.versionId ?? null;
}

/** Tests + promotion use this; nothing else should. */
export function invalidateAssetLibraryCache(): void {
  cache = undefined;
}

/**
 * Refresh the cache from storage if stale. Called at async doorways; everything downstream reads
 * synchronously. Never throws — an unreadable store degrades to "no library" (and is cached, so a
 * broken store is not re-probed on every generation).
 */
export async function ensureAssetLibrary(store: ObjectStore): Promise<AssetLibraryManifest | undefined> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.manifest;
  }

  try {
    const pointer = await readAssetPointer(store);

    if (!pointer) {
      cache = { manifest: undefined, versionId: null, loadedAt: Date.now() };
      return undefined;
    }

    const manifest = await loadAssetVersion(store, pointer.versionId);

    if (!manifest) {
      /*
       * A pointer at a missing/corrupt version: serve "no library" for now, but do NOT delete or
       * repoint anything — that is the admin's call with the version history in front of them.
       */
      logger.error(`Asset library pointer names ${pointer.versionId}, which is missing or invalid; no library serves.`);
      cache = { manifest: undefined, versionId: null, loadedAt: Date.now() };

      return undefined;
    }

    cache = { manifest, versionId: pointer.versionId, loadedAt: Date.now() };

    return manifest;
  } catch (error) {
    logger.warn(`Could not load the asset library; generations run without one: ${(error as Error).message}`);
    cache = { manifest: undefined, versionId: null, loadedAt: Date.now() };

    return undefined;
  }
}

/**
 * The proxy-doorway form: resolve the store from the request context, and NEVER throw — even
 * `getObjectStore` failing (misconfigured storage) degrades to "no library" rather than taking a
 * generation down. Mirrors `ensureMarketPrices(context)`.
 */
export async function ensureAssetLibraryForContext(context?: unknown): Promise<AssetLibraryManifest | undefined> {
  try {
    return await ensureAssetLibrary(getObjectStore(context));
  } catch (error) {
    logger.warn(`Asset library unavailable (storage unresolvable): ${(error as Error).message}`);
    cache = { manifest: undefined, versionId: null, loadedAt: Date.now() };

    return undefined;
  }
}

/*
 * ------------------------------------------------------------------------------------------------ *
 * Pointer + versions
 * ------------------------------------------------------------------------------------------------
 */

export async function readAssetPointer(store: ObjectStore): Promise<AssetLibraryPointer | null> {
  const bytes = await store.get(POINTER_KEY);

  if (!bytes) {
    return null;
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as AssetLibraryPointer;
    return parsed?.versionId ? parsed : null;
  } catch {
    // A corrupt pointer is a missing pointer (no library serves), not an outage.
    return null;
  }
}

/** A stored version, revalidated on read — bytes at rest are not trusted to still be a manifest. */
export async function loadAssetVersion(store: ObjectStore, versionId: string): Promise<AssetLibraryManifest | null> {
  const bytes = await store.get(assetVersionKey(versionId));

  if (!bytes) {
    return null;
  }

  try {
    const checked = validateAssetLibraryManifest(JSON.parse(new TextDecoder().decode(bytes)));
    return checked.ok ? checked.manifest : null;
  } catch {
    return null;
  }
}

/** Every version still in the store — the rollback menu. Newest first. */
export async function listAssetVersions(store: ObjectStore): Promise<AssetLibraryVersionListing[]> {
  const objects = await store.list(`${VERSION_PREFIX}/`);

  return objects
    .map((o) => ({
      versionId:
        o.key
          .split('/')
          .pop()
          ?.replace(/\.json$/, '') ?? '',
      size: o.size,
      storedAt: o.lastModified,
    }))
    .filter((v) => v.versionId.length > 0)
    .sort((a, b) => b.versionId.localeCompare(a.versionId));
}

/** `al_YYYYMMDDHHMMSS` — sortable, human-legible, unique at the cadence admins actually promote. */
function mintVersionId(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');

  return (
    `al_${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

export type AssetPromoteResult = { ok: true; pointer: AssetLibraryPointer } | { ok: false; errors: string[] };

/**
 * Promote a manifest: validate → store immutable version → move the pointer → refresh the cache.
 * Validation runs BEFORE anything is written (the current library stays untouched on a refusal), and
 * the pointer only ever names bytes that were just written.
 */
export async function promoteAssetLibrary(
  store: ObjectStore,
  candidate: unknown,
  options?: { note?: string },
): Promise<AssetPromoteResult> {
  const checked = validateAssetLibraryManifest(candidate);

  if (!checked.ok) {
    return { ok: false, errors: checked.errors };
  }

  const versionId = mintVersionId(new Date());
  await store.put(
    assetVersionKey(versionId),
    new TextEncoder().encode(JSON.stringify(checked.manifest, null, 2)),
    'application/json',
  );

  const pointer: AssetLibraryPointer = {
    versionId,
    activatedAt: new Date().toISOString(),
    activatedBy: 'promote',
    note: options?.note?.trim() || undefined,
  };
  await writePointer(store, pointer);

  cache = { manifest: checked.manifest, versionId, loadedAt: Date.now() };

  const assetCount = checked.manifest.packs.reduce((sum, pack) => sum + pack.assets.length, 0);
  logger.info(`Promoted asset library ${versionId} (${checked.manifest.packs.length} packs, ${assetCount} assets)`);

  return { ok: true, pointer };
}

export type AssetRollbackResult = { ok: true; pointer: AssetLibraryPointer } | { ok: false; message: string };

/**
 * Re-point at a version still in the store. Rolling back to bytes we no longer have (or that no
 * longer validate) is refused — the pointer must never name a manifest that cannot serve.
 */
export async function rollbackAssetLibrary(store: ObjectStore, versionId: string): Promise<AssetRollbackResult> {
  const manifest = await loadAssetVersion(store, versionId);

  if (!manifest) {
    return { ok: false, message: `No valid stored asset library named ${versionId}.` };
  }

  const pointer: AssetLibraryPointer = {
    versionId,
    activatedAt: new Date().toISOString(),
    activatedBy: 'rollback',
  };
  await writePointer(store, pointer);

  cache = { manifest, versionId, loadedAt: Date.now() };
  logger.warn(`Rolled the asset library back to ${versionId}`);

  return { ok: true, pointer };
}

/**
 * Unpin: delete the pointer (versions stay for re-promotion). "Make the library go away" must mean
 * the prompt stops advertising it — the block simply disappears on the next ensure.
 */
export async function unpinAssetLibrary(store: ObjectStore): Promise<void> {
  await store.delete(POINTER_KEY);
  cache = { manifest: undefined, versionId: null, loadedAt: Date.now() };
  logger.warn('Asset library unpinned — generations run without one.');
}

async function writePointer(store: ObjectStore, pointer: AssetLibraryPointer): Promise<void> {
  await store.put(POINTER_KEY, new TextEncoder().encode(JSON.stringify(pointer, null, 2)), 'application/json');
}
