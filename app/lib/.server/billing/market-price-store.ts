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
import { BAKED_COMET_PRICES } from './baked-comet-prices';

const logger = createScopedLogger('market-price-store');

/**
 * Which gateway a price list belongs to.
 *
 * ⚠️ **Declared here rather than imported from `agent/config.ts`, deliberately.** That module's
 * `PlatformProviderName` is the same set minus `Anthropic`, but importing it would close the cycle
 * `config -> rates -> market-price-store -> config`. `billing.spec.ts` asserts the two lists agree
 * instead, which is the same guarantee without the edge — the identical trade `model-families.ts`
 * makes to stay client-safe.
 *
 * `Anthropic` is absent because it is not a marketplace: Anthropic's rates are first-party and live
 * in `MODEL_RATES`, hand-maintained in code. There is nothing for an operator to promote.
 */
export const MARKET_PRICE_PROVIDERS = ['KIE', 'Comet'] as const;
export type MarketPriceProvider = (typeof MARKET_PRICE_PROVIDERS)[number];

/**
 * The storage slug per provider.
 *
 * 🔴 **`KIE` keeps `kie` byte-identically, and that is load-bearing.** Every promoted version and
 * every pointer already in a deployed store lives under `pricing/kie-market/...`; renaming the slug
 * would strand them — the pointer read would miss, the baked list would quietly take over, and an
 * operator's carefully promoted prices would stop being the ones charged with nothing throwing. A
 * migration was avoidable here, so it was avoided.
 */
const STORE_SLUG: Record<MarketPriceProvider, string> = {
  KIE: 'kie',
  Comet: 'comet',
};

/** The baked fallback per provider — real, current-at-build pricing, never a zero rate. */
const BAKED_BY_PROVIDER: Record<MarketPriceProvider, MarketPriceList> = {
  KIE: BAKED_MARKET_PRICES,
  Comet: BAKED_COMET_PRICES,
};

/**
 * Every marketplace list a generation on `platformProvider` prices from — and there are usually TWO.
 *
 * 🔴 KIE's list is ALWAYS in the answer, on every provider, because `getModelTier` prices the §4.6.1a
 * paid rungs from it regardless of who is serving. So an Anthropic or Comet deploy that refreshed
 * only "its own" list would price every premium rung from KIE's BAKED table forever — the operator's
 * promoted rung prices silently ignored, with nothing throwing and the credit total moving in
 * whichever direction the stale numbers happen to point.
 *
 * `Anthropic` contributes nothing of its own (its rates are first-party, in `MODEL_RATES`), so it
 * yields just KIE. A marketplace provider yields itself plus KIE, de-duplicated.
 *
 * Takes a plain string rather than `PlatformProviderName` to keep this module free of the
 * `config -> rates -> market-price-store` import cycle.
 */
export function marketPriceProvidersFor(platformProvider: string): MarketPriceProvider[] {
  const own = MARKET_PRICE_PROVIDERS.find((name) => name === platformProvider);

  return own && own !== 'KIE' ? [own, 'KIE'] : ['KIE'];
}

/** The immutable-versions prefix for a provider. */
function versionPrefix(provider: MarketPriceProvider): string {
  return `pricing/${STORE_SLUG[provider]}-market/versions`;
}

/** The "which version is live" pointer for a provider. */
function pointerKey(provider: MarketPriceProvider): string {
  return `pricing/${STORE_SLUG[provider]}-market/active.json`;
}

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

export function versionKey(provider: MarketPriceProvider, versionId: string): string {
  return `${versionPrefix(provider)}/${versionId.replace(/[^a-zA-Z0-9._-]/g, '__')}.json`;
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

/**
 * One cache slot PER PROVIDER.
 *
 * 🔴 It was a single module-level `cache`, which is the same object whichever provider asked. With
 * two marketplaces that is a silent cross-pricing bug: a media lookup on one provider would settle
 * against whichever list the last `ensureMarketPrices` happened to load — and both lists price
 * `claude-sonnet-5`, at DIFFERENT rates, so the wrong answer looks exactly like the right one.
 */
const caches = new Map<MarketPriceProvider, CacheState>();

/**
 * The active price list for a provider, synchronously. Baked until `ensureMarketPrices` has loaded a
 * promotion for that provider.
 *
 * This is THE read every synchronous money-path consumer uses (`billing/rates.ts`). It can never
 * throw and never return a partial list — a cache slot only ever holds a list that passed validation.
 *
 * ⚠️ **`provider` is REQUIRED and deliberately has no default.** An implicit "the configured
 * provider's list" would make the answer depend on `LLM_PROVIDER` at the moment of the call, so a
 * MEDIA lookup would silently price against the LLM provider's list the day the two are configured
 * apart (which T7's `MEDIA_PROVIDER` makes an ordinary state). Same rule, same reason, as
 * `ratesFor`'s required `provider` argument.
 */
export function activeMarketPrices(provider: MarketPriceProvider): MarketPriceList {
  return caches.get(provider)?.list ?? BAKED_BY_PROVIDER[provider];
}

/** Which version is live — null means the baked fallback. Surfaced in the admin panel, never guessed. */
export function activeMarketPriceVersionId(provider: MarketPriceProvider): string | null {
  return caches.get(provider)?.versionId ?? null;
}

/** Tests + promotion use this; nothing else should. Omit the provider to clear every slot. */
export function invalidateMarketPricesCache(provider?: MarketPriceProvider): void {
  if (provider) {
    caches.delete(provider);
  } else {
    caches.clear();
  }
}

/**
 * Refresh a provider's cache from storage if it is stale. Called at async entry points (agent proxy,
 * admin routes, /api/me); everything downstream reads synchronously.
 *
 * ⚠️ The provider is REQUIRED, exactly as `activeMarketPrices`' is. It briefly carried a `= 'KIE'`
 * default, which is the implicit-provider shape this layer exists to forbid: a caller that forgets
 * warms one gateway's list and then reads another's, so the first synchronous price lookup after it
 * answers from a stale or baked table with nothing thrown. `context` stays optional and therefore
 * second, so every call site has to state the provider by position.
 */
export async function ensureMarketPrices(provider: MarketPriceProvider, context?: unknown): Promise<MarketPriceList> {
  const cached = caches.get(provider);

  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.list;
  }

  try {
    const store = getObjectStore(context);
    const loaded = await readActiveList(store, provider);

    caches.set(provider, { ...loaded, loadedAt: Date.now() });
  } catch (error) {
    logger.warn(
      `Could not load the promoted ${provider} price list; the baked list stands: ${(error as Error).message}`,
    );

    // Cache the fallback too — a broken store must not be re-probed on every generation.
    caches.set(provider, { list: BAKED_BY_PROVIDER[provider], versionId: null, loadedAt: Date.now() });
  }

  return caches.get(provider)!.list;
}

async function readActiveList(
  store: ObjectStore,
  provider: MarketPriceProvider,
): Promise<{ list: MarketPriceList; versionId: string | null }> {
  const pointer = await readPointer(store, provider);

  if (!pointer) {
    return { list: BAKED_BY_PROVIDER[provider], versionId: null };
  }

  const list = await loadVersion(store, provider, pointer.versionId);

  if (!list) {
    /*
     * A pointer at a missing/corrupt version behaves like the template pin's missing snapshot: serve
     * the fallback for now, but do NOT delete or repoint anything — that is the admin's call to make
     * with the version history in front of them.
     */
    logger.error(
      `Active ${provider} price pointer names ${pointer.versionId}, which is missing or invalid; baked list stands.`,
    );

    return { list: BAKED_BY_PROVIDER[provider], versionId: null };
  }

  return { list, versionId: pointer.versionId };
}

/*
 * ------------------------------------------------------------------------------------------------ *
 * Pointer + versions
 * ------------------------------------------------------------------------------------------------
 */

export async function readPointer(
  store: ObjectStore,
  provider: MarketPriceProvider,
): Promise<MarketPricePointer | null> {
  const bytes = await store.get(pointerKey(provider));

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
export async function loadVersion(
  store: ObjectStore,
  provider: MarketPriceProvider,
  versionId: string,
): Promise<MarketPriceList | null> {
  const bytes = await store.get(versionKey(provider, versionId));

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
export async function listVersions(
  store: ObjectStore,
  provider: MarketPriceProvider,
): Promise<MarketPriceVersionListing[]> {
  const objects = await store.list(`${versionPrefix(provider)}/`);

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
  provider: MarketPriceProvider,
  candidate: unknown,
  options?: { note?: string },
): Promise<PromoteResult> {
  const checked = validateMarketPriceList(candidate);

  if (!checked.ok) {
    return { ok: false, errors: checked.errors };
  }

  const versionId = mintVersionId(new Date());
  await store.put(
    versionKey(provider, versionId),
    new TextEncoder().encode(JSON.stringify(checked.list, null, 2)),
    'application/json',
  );

  const pointer: MarketPricePointer = {
    versionId,
    activatedAt: new Date().toISOString(),
    activatedBy: 'promote',
    note: options?.note?.trim() || undefined,
  };
  await writePointer(store, provider, pointer);

  caches.set(provider, { list: checked.list, versionId, loadedAt: Date.now() });
  logger.info(
    `Promoted ${provider} marketplace price list ${versionId} (${Object.keys(checked.list.llm).length} llm rows, ${Object.keys(checked.list.media).length} media models)`,
  );

  return { ok: true, pointer };
}

export type RollbackResult = { ok: true; pointer: MarketPricePointer } | { ok: false; message: string };

/**
 * Re-point at a version still in the store. Rolling back to bytes we no longer have (or that no
 * longer validate) is refused — the pointer must never name a list that cannot serve.
 */
export async function rollbackMarketPrices(
  store: ObjectStore,
  provider: MarketPriceProvider,
  versionId: string,
): Promise<RollbackResult> {
  const list = await loadVersion(store, provider, versionId);

  if (!list) {
    return { ok: false, message: `No valid stored ${provider} price list named ${versionId}.` };
  }

  const pointer: MarketPricePointer = {
    versionId,
    activatedAt: new Date().toISOString(),
    activatedBy: 'rollback',
  };
  await writePointer(store, provider, pointer);

  caches.set(provider, { list, versionId, loadedAt: Date.now() });
  logger.warn(`Rolled ${provider} marketplace prices back to ${versionId}`);

  return { ok: true, pointer };
}

async function writePointer(
  store: ObjectStore,
  provider: MarketPriceProvider,
  pointer: MarketPricePointer,
): Promise<void> {
  await store.put(pointerKey(provider), new TextEncoder().encode(JSON.stringify(pointer, null, 2)), 'application/json');
}
