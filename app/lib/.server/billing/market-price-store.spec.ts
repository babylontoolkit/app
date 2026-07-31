/**
 * The versioned marketplace price store (SPEC §4.6, spec/billing.md).
 *
 * The template-pin properties, applied to money: versions are immutable, the pointer only ever names
 * bytes that validate, a refused promotion leaves the active list untouched, and rollback only
 * re-points at bytes still in the store. Plus the property the pin does not have: an in-process
 * cache that synchronous billing reads, which must fall back to BAKED — never to nothing — when
 * storage misbehaves.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ObjectStore } from '~/lib/.server/storage';
import { BAKED_MARKET_PRICES } from './baked-market-prices';
import { DEFAULT_MODEL } from '~/utils/constants';
import {
  activeMarketPrices,
  activeMarketPriceVersionId,
  invalidateMarketPricesCache,
  listVersions,
  loadVersion,
  versionKey,
  promoteMarketPrices,
  readPointer,
  rollbackMarketPrices,
} from './market-price-store';

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

function listWithOpusInput(inputPerMTok: number) {
  return {
    ...BAKED_MARKET_PRICES,
    llm: { ...BAKED_MARKET_PRICES.llm, 'claude-opus-4-8': { inputPerMTok, outputPerMTok: 10 } },
  };
}

beforeEach(() => invalidateMarketPricesCache());
afterEach(() => invalidateMarketPricesCache());

describe('the active list', () => {
  it('is the BAKED list before anything is promoted — billing can never find nothing', () => {
    expect(activeMarketPrices()).toBe(BAKED_MARKET_PRICES);
    expect(activeMarketPriceVersionId()).toBeNull();
  });

  it('is the promoted list immediately after a promotion (no TTL wait)', async () => {
    const store = memoryStore();
    const result = await promoteMarketPrices(store, listWithOpusInput(3));

    expect(result.ok).toBe(true);
    expect(activeMarketPrices().llm['claude-opus-4-8'].inputPerMTok).toBe(3);
    expect(activeMarketPriceVersionId()).toBe(result.ok ? result.pointer.versionId : null);
  });
});

describe('promotion', () => {
  it('validates BEFORE writing — a refused list changes nothing, and every error is reported', async () => {
    const store = memoryStore();
    const bad = { ...BAKED_MARKET_PRICES, llm: {}, schemaVersion: 9 };

    const result = await promoteMarketPrices(store, bad);

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors.length).toBeGreaterThanOrEqual(2);

    // NOTHING was written: no version, no pointer, and the active list is untouched.
    expect(await listVersions(store)).toEqual([]);
    expect(await readPointer(store)).toBeNull();
    expect(activeMarketPrices()).toBe(BAKED_MARKET_PRICES);
  });

  /*
   * 🔴 THE PREMIUM TIER MUST NEVER BECOME THE DEFAULT'S PRICE (owner rule, 2026-07-27). A list that
   * does not price the platform default cannot be PROMOTED — and, below, cannot even be LOADED —
   * because `ratesFor` bills an unpriced model at the most-expensive row (the premium tier's, 2x).
   */
  it('refuses to promote a list that does not price the platform default', async () => {
    const store = memoryStore();
    const missingDefault = {
      ...BAKED_MARKET_PRICES,
      llm: { 'claude-opus-4-8': { inputPerMTok: 2, outputPerMTok: 10 } },
    };

    const result = await promoteMarketPrices(store, missingDefault);

    expect(result.ok).toBe(false);

    /*
     * Asserted against DEFAULT_MODEL, not a literal: the property is "the refusal names the model we
     * would otherwise mis-bill", and hard-coding today's default made this fail the day the platform
     * moved rungs (Opus 5 → Sonnet 5, 2026-07-31) for a reason that had nothing to do with the wall.
     */
    expect(result.ok ? '' : result.errors.join('; ')).toContain(DEFAULT_MODEL);
    expect(activeMarketPrices()).toBe(BAKED_MARKET_PRICES);
  });

  /*
   * The LOAD half of the same wall: stored bytes are re-validated on read, so a legacy list promoted
   * before the default-row rule existed (or bytes edited at rest) fails to load, `ensureMarketPrices`
   * serves the BAKED list, and the default is priced at its own rate — never the premium fallback.
   */
  it('refuses to LOAD stored bytes that do not price the platform default — baked serves instead', async () => {
    const store = memoryStore();
    const legacy = {
      ...BAKED_MARKET_PRICES,
      llm: { 'claude-opus-4-8': { inputPerMTok: 2, outputPerMTok: 10 } },
    };
    await store.put(versionKey('mp_legacy'), new TextEncoder().encode(JSON.stringify(legacy)));

    expect(await loadVersion(store, 'mp_legacy')).toBeNull();
  });

  it('stores an immutable version and points at it', async () => {
    const store = memoryStore();
    const result = await promoteMarketPrices(store, listWithOpusInput(3), { note: 'reprice test' });

    expect(result.ok).toBe(true);

    const pointer = await readPointer(store);
    expect(pointer?.versionId).toBe(result.ok ? result.pointer.versionId : '');
    expect(pointer?.activatedBy).toBe('promote');
    expect(pointer?.note).toBe('reprice test');

    const stored = await loadVersion(store, pointer!.versionId);
    expect(stored?.llm['claude-opus-4-8'].inputPerMTok).toBe(3);
  });
});

describe('rollback', () => {
  it('re-points at a stored version and the cache follows', async () => {
    const store = memoryStore();
    const first = await promoteMarketPrices(store, listWithOpusInput(3));

    // Version ids are second-granularity; the promotions in this test need distinct ids.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const second = await promoteMarketPrices(store, listWithOpusInput(4));

    expect(first.ok && second.ok).toBe(true);
    expect(activeMarketPrices().llm['claude-opus-4-8'].inputPerMTok).toBe(4);

    const firstId = first.ok ? first.pointer.versionId : '';
    const rolled = await rollbackMarketPrices(store, firstId);

    expect(rolled.ok).toBe(true);
    expect(activeMarketPrices().llm['claude-opus-4-8'].inputPerMTok).toBe(3);
    expect((await readPointer(store))?.activatedBy).toBe('rollback');
  });

  it('refuses to roll back to a version that is not in the store', async () => {
    const store = memoryStore();
    const result = await rollbackMarketPrices(store, 'mp_19990101000000');

    expect(result.ok).toBe(false);
    expect(activeMarketPrices()).toBe(BAKED_MARKET_PRICES);
  });

  /* Bytes at rest are revalidated: a corrupted stored version must not become the active list. */
  it('refuses to roll back to stored bytes that no longer validate', async () => {
    const store = memoryStore();
    const result = await promoteMarketPrices(store, listWithOpusInput(3));
    const versionId = result.ok ? result.pointer.versionId : '';

    const versions = await store.list('pricing/kie-market/versions/');
    await store.put(versions[0].key, new TextEncoder().encode('{"not": "a price list"}'));

    const rolled = await rollbackMarketPrices(store, versionId);
    expect(rolled.ok).toBe(false);
  });
});

describe('version listing', () => {
  it('lists stored versions with the newest first', async () => {
    const store = memoryStore();
    await promoteMarketPrices(store, listWithOpusInput(3));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await promoteMarketPrices(store, listWithOpusInput(4));

    const versions = await listVersions(store);
    expect(versions).toHaveLength(2);
    expect(versions[0].versionId > versions[1].versionId).toBe(true);
  });
});
