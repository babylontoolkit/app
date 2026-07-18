/**
 * Versioned storage for the KIE marketplace price list (SPEC §4.6, spec/billing.md).
 *
 * Doc-sync rules applied to money, mirroring the template pin (`templates/pin.ts`): versions are
 * IMMUTABLE objects keyed by a minted id, "which one is live" is a separate pointer, changing prices
 * is a deliberate admin PROMOTION (validated before the pointer moves), and rollback is re-pointing
 * at any version still in the store. Billing never fetches kie.ai at generation time — it reads the
 * promoted list, exactly as generations never depend on GitHub at runtime (§4.3).
 *
 * ## The sync/async seam — why there is an in-process cache
 *
 * `ratesFor`/`creditsForUsage` are synchronous and called throughout the money path; the ObjectStore
 * is async. So the ACTIVE list is cached in-process: async entry points call `ensureMarketPrices()`
 * once (proxy start, admin routes, /api/me), and every synchronous consumer reads
 * `activeMarketPrices()`. Before the first ensure — and whenever the store is unreadable — the BAKED
 * list answers. That direction of degradation is deliberate: the baked list is real, current-at-build
 * pricing, so a storage outage costs at most price DRIFT since the last bake, never a dead billing
 * path and never a zero-rate.
 *
 * ⚠️ A failed `ensureMarketPrices` must never block a generation — it logs and falls back. The
 * operator's promoted list going unreadable is an ops alert, not a user-facing outage.
 */
import { createScopedLogger } from '~/utils/logger';
import type { ObjectStore } from '~/lib/.server/storage';
import { getObjectStore } from '~/lib/.server/storage';
import type { MarketPriceList } from './market-prices';
import { validateMarketPriceList } from './market-prices';
import { BAKED_MARKET_PRICES } from './baked-market-prices';

const logger = createScopedLogger('market-price-store');

const VERSION_PREFIX = 'pricing/kie-market/versions';
const POINTER_KEY = 'pricing/kie-market/active.json';

/** How long a loaded list is trusted before the next ensure re-reads the pointer. */
const CACHE_TTL_MS = 60_000;

export interface MarketPricePointer {
  versionId: string;
  activatedAt: string;
  activatedBy: 'promote' | 'rollback';

  /** Optional operator note ("Kling reprice July"), shown in the version history. */
  note?: string;
}

export interface MarketPriceVersionListing {
  versionId: string;
  size: number;
  storedAt?: string;
}

export function versionKey(versionId: string): string {
  return `${VERSION_PREFIX}/${versionId.replace(/[^a-zA-Z0-9._-]/g, '__')}.json`;
}

/*
 * ------------------------------------------------------------------------------------------------ *
 * The in-process active-list cache
 * ------------------------------------------------------------------------------------------------
 */

interface CacheState {
  list: MarketPriceList;

  /** null = the baked list is active (nothing promoted, or the store was unreadable). */
  versionId: string | null;
  loadedAt: number;
}

let cache: CacheState | undefined;

/**
 * The active price list, synchronously. Baked until `ensureMarketPrices` has loaded a promotion.
 *
 * This is THE read every synchronous money-path consumer uses (`billing/rates.ts`). It can never
 * throw and never return a partial list — the cache only ever holds a list that passed validation.
 */
export function activeMarketPrices(): MarketPriceList {
  return cache?.list ?? BAKED_MARKET_PRICES;
}

/** Which version is live — null means the baked fallback. Surfaced in the admin panel, never guessed. */
export function activeMarketPriceVersionId(): string | null {
  return cache?.versionId ?? null;
}

/** Tests + promotion use this; nothing else should. */
export function invalidateMarketPricesCache(): void {
  cache = undefined;
}

/**
 * Refresh the cache from storage if it is stale. Called at async entry points (agent proxy, admin
 * routes, /api/me); everything downstream reads synchronously.
 */
export async function ensureMarketPrices(context?: unknown): Promise<MarketPriceList> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.list;
  }

  try {
    const store = getObjectStore(context);
    const loaded = await readActiveList(store);

    cache = { ...loaded, loadedAt: Date.now() };
  } catch (error) {
    logger.warn(`Could not load the promoted price list; the baked list stands: ${(error as Error).message}`);

    // Cache the fallback too — a broken store must not be re-probed on every generation.
    cache = { list: BAKED_MARKET_PRICES, versionId: null, loadedAt: Date.now() };
  }

  return cache.list;
}

async function readActiveList(store: ObjectStore): Promise<{ list: MarketPriceList; versionId: string | null }> {
  const pointer = await readPointer(store);

  if (!pointer) {
    return { list: BAKED_MARKET_PRICES, versionId: null };
  }

  const list = await loadVersion(store, pointer.versionId);

  if (!list) {
    /*
     * A pointer at a missing/corrupt version behaves like the template pin's missing snapshot: serve
     * the fallback for now, but do NOT delete or repoint anything — that is the admin's call to make
     * with the version history in front of them.
     */
    logger.error(`Active price pointer names ${pointer.versionId}, which is missing or invalid; baked list stands.`);
    return { list: BAKED_MARKET_PRICES, versionId: null };
  }

  return { list, versionId: pointer.versionId };
}

/*
 * ------------------------------------------------------------------------------------------------ *
 * Pointer + versions
 * ------------------------------------------------------------------------------------------------
 */

export async function readPointer(store: ObjectStore): Promise<MarketPricePointer | null> {
  const bytes = await store.get(POINTER_KEY);

  if (!bytes) {
    return null;
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as MarketPricePointer;
    return parsed?.versionId ? parsed : null;
  } catch {
    // A corrupt pointer is a missing pointer (the baked list stands), not an outage.
    return null;
  }
}

/** A stored version's list, revalidated on read — bytes at rest are not trusted to still be a price list. */
export async function loadVersion(store: ObjectStore, versionId: string): Promise<MarketPriceList | null> {
  const bytes = await store.get(versionKey(versionId));

  if (!bytes) {
    return null;
  }

  try {
    const checked = validateMarketPriceList(JSON.parse(new TextDecoder().decode(bytes)));
    return checked.ok ? checked.list : null;
  } catch {
    return null;
  }
}

/** Every version still in the store — the rollback menu. Newest first. */
export async function listVersions(store: ObjectStore): Promise<MarketPriceVersionListing[]> {
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

/** `mp_YYYYMMDDHHMMSS` — sortable, human-legible, and unique at the cadence admins actually promote. */
function mintVersionId(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');

  return (
    `mp_${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

export type PromoteResult = { ok: true; pointer: MarketPricePointer } | { ok: false; errors: string[] };

/**
 * Promote a new price list: validate → store immutable version → move the pointer → refresh the cache.
 *
 * Validation runs BEFORE anything is written (the template-promotion rule: the current list stays
 * untouched on a refusal), and the pointer only ever names bytes that were just written — so the
 * active list can never be a list that failed validation, even across a crash between the two writes
 * (a stored version with no pointer is just an unused version).
 */
export async function promoteMarketPrices(
  store: ObjectStore,
  candidate: unknown,
  options?: { note?: string },
): Promise<PromoteResult> {
  const checked = validateMarketPriceList(candidate);

  if (!checked.ok) {
    return { ok: false, errors: checked.errors };
  }

  const versionId = mintVersionId(new Date());
  await store.put(
    versionKey(versionId),
    new TextEncoder().encode(JSON.stringify(checked.list, null, 2)),
    'application/json',
  );

  const pointer: MarketPricePointer = {
    versionId,
    activatedAt: new Date().toISOString(),
    activatedBy: 'promote',
    note: options?.note?.trim() || undefined,
  };
  await writePointer(store, pointer);

  cache = { list: checked.list, versionId, loadedAt: Date.now() };
  logger.info(
    `Promoted marketplace price list ${versionId} (${Object.keys(checked.list.llm).length} llm rows, ${Object.keys(checked.list.media).length} media models)`,
  );

  return { ok: true, pointer };
}

export type RollbackResult = { ok: true; pointer: MarketPricePointer } | { ok: false; message: string };

/**
 * Re-point at a version still in the store. Rolling back to bytes we no longer have (or that no
 * longer validate) is refused — the pointer must never name a list that cannot serve.
 */
export async function rollbackMarketPrices(store: ObjectStore, versionId: string): Promise<RollbackResult> {
  const list = await loadVersion(store, versionId);

  if (!list) {
    return { ok: false, message: `No valid stored price list named ${versionId}.` };
  }

  const pointer: MarketPricePointer = {
    versionId,
    activatedAt: new Date().toISOString(),
    activatedBy: 'rollback',
  };
  await writePointer(store, pointer);

  cache = { list, versionId, loadedAt: Date.now() };
  logger.warn(`Rolled marketplace prices back to ${versionId}`);

  return { ok: true, pointer };
}

async function writePointer(store: ObjectStore, pointer: MarketPricePointer): Promise<void> {
  await store.put(POINTER_KEY, new TextEncoder().encode(JSON.stringify(pointer, null, 2)), 'application/json');
}
