/**
 * The versioned marketplace price store (SPEC §4.6, spec/billing.md).
 *
 * The template-pin properties, applied to money: versions are immutable, the pointer only ever names
 * bytes that validate, a refused promotion leaves the active list untouched, and rollback only
 * re-points at bytes still in the store. Plus the property the pin does not have: an in-process
 * cache that synchronous billing reads, which must fall back to BAKED — never to nothing — when
 * storage misbehaves.
 *
 * ## The provider dimension (2026-08-10, `_specs/cometapi-provider_plan.md` T4)
 *
 * There are several marketplaces (`MARKET_PRICE_PROVIDERS` — KIE, Anthropic and FAL since Comet was
 * removed on 2026-10-03, `_specs/anthropic-only_plan.md`), each with its own key prefix, its own baked
 * fallback and its own cache slot. Every failure that split introduces is silent in the same specific
 * way, and it is the reason half this file exists: **KIE's and Anthropic's lists both price
 * `claude-sonnet-5`, at different rates** ($0.85/$4.275 on KIE, $2/$10 on Anthropic), so reading the
 * wrong list does not throw, does not return `undefined`, and does not fail a type check — it returns
 * a plausible number and mis-bills every generation by ~2x in whichever direction the mistake points.
 * (KIE's `llm` rows price nothing any more, which makes a wrong read onto them MORE dangerous, not less.)
 *
 * ⚠️ **The single most important test in this file is the no-migration one.** KIE's storage keys are
 * byte-identical to what they were before the split, and a deployed store already holds an operator's
 * promoted versions and pointer under them. Rename the slug and nothing breaks loudly: the pointer
 * read misses, the baked list quietly takes over, and the prices actually charged stop being the ones
 * the operator promoted — with the credit totals moving in whichever direction the baked table
 * happens to sit. So that test writes the OLD keys as string LITERALS and never through `versionKey`,
 * because a helper-written key follows a rename and proves nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObjectStore } from '~/lib/.server/storage';
import { setObjectStore } from '~/lib/.server/storage';
import { BAKED_MARKET_PRICES } from './baked-market-prices';
import { BAKED_ANTHROPIC_PRICES } from './baked-anthropic-prices';
import { BAKED_FAL_PRICES } from './baked-fal-prices';
import { DEFAULT_MODEL } from '~/utils/constants';
import {
  activeMarketPrices,
  activeMarketPriceVersionId,
  ensureMarketPrices,
  invalidateMarketPricesCache,
  listVersions,
  loadVersion,
  marketPriceProvidersFor,
  versionKey,
  promoteMarketPrices,
  readPointer,
  rollbackMarketPrices,
  MARKET_PRICE_PROVIDERS,
  LLM_PRICE_PROVIDERS,
} from './market-price-store';
import { MEDIA_ONLY_PRICE_PROVIDERS } from './market-prices';

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

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, null, 2));

/**
 * 🔴 THE STORE SCRUB — this file must never be able to reach the developer's real `.data/`.
 *
 * `ensureMarketPrices` takes a CONTEXT, not a store: it resolves one through `getObjectStore`, which
 * falls back to an `FsObjectStore` rooted at `platformDataDir()`. A test that only stubs the stores it
 * passes explicitly still lets that seam resolve to the real thing — the `chat-index.spec.ts` failure
 * that deposited ~200 real rows, and the `oauth.spec.ts` env fallback, are the same shape. Setting the
 * module store for EVERY test (not only the ones that call `ensureMarketPrices`) is what makes the
 * guarantee structural rather than per-test vigilance.
 *
 * The env scrub is the other half: `promoteMarketPrices` itself reads no env, but the store selection
 * it would otherwise perform does (`S3_*`), and this repo's rule is that a spec near `env()` scrubs the
 * whole precedence chain rather than the variable it happens to be thinking about.
 */
const ENV_SCRUB = ['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'LLM_MODEL'] as const;

let contextStore: ObjectStore;

beforeEach(() => {
  for (const key of ENV_SCRUB) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  contextStore = memoryStore();
  setObjectStore(contextStore);
  invalidateMarketPricesCache();
});

afterEach(() => {
  invalidateMarketPricesCache();
  setObjectStore(undefined);
  vi.unstubAllEnvs();
});

describe('the active list', () => {
  it('is the BAKED list before anything is promoted — billing can never find nothing', () => {
    expect(activeMarketPrices('KIE')).toBe(BAKED_MARKET_PRICES);
    expect(activeMarketPriceVersionId('KIE')).toBeNull();
  });

  it('is the promoted list immediately after a promotion (no TTL wait)', async () => {
    const store = memoryStore();
    const result = await promoteMarketPrices(store, 'KIE', listWithOpusInput(3));

    expect(result.ok).toBe(true);
    expect(activeMarketPrices('KIE').llm['claude-opus-4-8'].inputPerMTok).toBe(3);
    expect(activeMarketPriceVersionId('KIE')).toBe(result.ok ? result.pointer.versionId : null);
  });
});

describe('promotion', () => {
  it('validates BEFORE writing — a refused list changes nothing, and every error is reported', async () => {
    const store = memoryStore();
    const bad = { ...BAKED_MARKET_PRICES, llm: {}, schemaVersion: 9 };

    const result = await promoteMarketPrices(store, 'KIE', bad);

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors.length).toBeGreaterThanOrEqual(2);

    // NOTHING was written: no version, no pointer, and the active list is untouched.
    expect(await listVersions(store, 'KIE')).toEqual([]);
    expect(await readPointer(store, 'KIE')).toBeNull();
    expect(activeMarketPrices('KIE')).toBe(BAKED_MARKET_PRICES);
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

    const result = await promoteMarketPrices(store, 'KIE', missingDefault);

    expect(result.ok).toBe(false);

    /*
     * Asserted against DEFAULT_MODEL, not a literal: the property is "the refusal names the model we
     * would otherwise mis-bill", and hard-coding today's default made this fail the day the platform
     * moved rungs (Opus 5 → Sonnet 5, 2026-07-31) for a reason that had nothing to do with the wall.
     */
    expect(result.ok ? '' : result.errors.join('; ')).toContain(DEFAULT_MODEL);
    expect(activeMarketPrices('KIE')).toBe(BAKED_MARKET_PRICES);
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
    await store.put(versionKey('KIE', 'mp_legacy'), new TextEncoder().encode(JSON.stringify(legacy)));

    expect(await loadVersion(store, 'KIE', 'mp_legacy')).toBeNull();
  });

  it('stores an immutable version and points at it', async () => {
    const store = memoryStore();
    const result = await promoteMarketPrices(store, 'KIE', listWithOpusInput(3), { note: 'reprice test' });

    expect(result.ok).toBe(true);

    const pointer = await readPointer(store, 'KIE');
    expect(pointer?.versionId).toBe(result.ok ? result.pointer.versionId : '');
    expect(pointer?.activatedBy).toBe('promote');
    expect(pointer?.note).toBe('reprice test');

    const stored = await loadVersion(store, 'KIE', pointer!.versionId);
    expect(stored?.llm['claude-opus-4-8'].inputPerMTok).toBe(3);
  });
});

describe('rollback', () => {
  it('re-points at a stored version and the cache follows', async () => {
    const store = memoryStore();
    const first = await promoteMarketPrices(store, 'KIE', listWithOpusInput(3));

    // Version ids are second-granularity; the promotions in this test need distinct ids.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const second = await promoteMarketPrices(store, 'KIE', listWithOpusInput(4));

    expect(first.ok && second.ok).toBe(true);
    expect(activeMarketPrices('KIE').llm['claude-opus-4-8'].inputPerMTok).toBe(4);

    const firstId = first.ok ? first.pointer.versionId : '';
    const rolled = await rollbackMarketPrices(store, 'KIE', firstId);

    expect(rolled.ok).toBe(true);
    expect(activeMarketPrices('KIE').llm['claude-opus-4-8'].inputPerMTok).toBe(3);
    expect((await readPointer(store, 'KIE'))?.activatedBy).toBe('rollback');
  });

  it('refuses to roll back to a version that is not in the store', async () => {
    const store = memoryStore();
    const result = await rollbackMarketPrices(store, 'KIE', 'mp_19990101000000');

    expect(result.ok).toBe(false);
    expect(activeMarketPrices('KIE')).toBe(BAKED_MARKET_PRICES);
  });

  /* Bytes at rest are revalidated: a corrupted stored version must not become the active list. */
  it('refuses to roll back to stored bytes that no longer validate', async () => {
    const store = memoryStore();
    const result = await promoteMarketPrices(store, 'KIE', listWithOpusInput(3));
    const versionId = result.ok ? result.pointer.versionId : '';

    const versions = await store.list('pricing/kie-market/versions/');
    await store.put(versions[0].key, new TextEncoder().encode('{"not": "a price list"}'));

    const rolled = await rollbackMarketPrices(store, 'KIE', versionId);
    expect(rolled.ok).toBe(false);
  });
});

describe('version listing', () => {
  it('lists stored versions with the newest first', async () => {
    const store = memoryStore();
    await promoteMarketPrices(store, 'KIE', listWithOpusInput(3));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await promoteMarketPrices(store, 'KIE', listWithOpusInput(4));

    const versions = await listVersions(store, 'KIE');
    expect(versions).toHaveLength(2);
    expect(versions[0].versionId > versions[1].versionId).toBe(true);
  });
});

/*
 * ------------------------------------------------------------------------------------------------ *
 * The provider dimension (T4)
 * ------------------------------------------------------------------------------------------------
 */

describe("KIE's existing storage keys — the no-migration guarantee", () => {
  /**
   * The exact keys a deployed store already holds, written as LITERALS.
   *
   * 🔴 Writing them through `versionKey('KIE', id)` would make this test track a rename instead of
   * refusing one — the helper and the reader would move together and the assertion would stay green
   * while every operator's promoted prices silently stopped being served. These two strings are the
   * contract with production data, so they are spelled out here and nowhere else.
   */
  const LEGACY_VERSION_KEY = 'pricing/kie-market/versions/mp_20260718120000.json';
  const LEGACY_POINTER_KEY = 'pricing/kie-market/active.json';

  async function seedLegacyPromotion(store: ObjectStore) {
    await store.put(LEGACY_VERSION_KEY, encode(listWithOpusInput(3)), 'application/json');
    await store.put(
      LEGACY_POINTER_KEY,
      encode({
        versionId: 'mp_20260718120000',
        activatedAt: '2026-07-18T12:00:00.000Z',
        activatedBy: 'promote',
        note: 'promoted before the price store became per-provider',
      }),
      'application/json',
    );
  }

  it('serves a version promoted BEFORE the split, with no rewrite of any kind', async () => {
    await seedLegacyPromotion(contextStore);

    const loaded = await ensureMarketPrices('KIE', {});

    /* The operator's number, not the baked one — the whole point. */
    expect(loaded.llm['claude-opus-4-8'].inputPerMTok).toBe(3);
    expect(activeMarketPrices('KIE').llm['claude-opus-4-8'].inputPerMTok).toBe(3);
    expect(activeMarketPriceVersionId('KIE')).toBe('mp_20260718120000');

    /*
     * CONTROL: the baked table really does state a DIFFERENT number, so the assertion above cannot be
     * satisfied by a read that quietly fell back. Without this, a store that returned nothing at all
     * would pass if the baked row happened to agree.
     */
    expect(BAKED_MARKET_PRICES.llm['claude-opus-4-8'].inputPerMTok).not.toBe(3);
  });

  it('reads those same legacy keys through the pointer/version helpers', async () => {
    await seedLegacyPromotion(contextStore);

    expect(versionKey('KIE', 'mp_20260718120000')).toBe(LEGACY_VERSION_KEY);
    expect((await readPointer(contextStore, 'KIE'))?.versionId).toBe('mp_20260718120000');
    expect((await listVersions(contextStore, 'KIE')).map((v) => v.versionId)).toEqual(['mp_20260718120000']);
  });

  /*
   * The other half of "keyed, not blanket": Anthropic must not adopt bytes that belong to KIE. If both
   * providers read one prefix, the no-migration guarantee above would hold and every Anthropic
   * generation would settle at KIE's rates.
   */
  it('does not let Anthropic adopt a KIE-keyed promotion', async () => {
    await seedLegacyPromotion(contextStore);

    expect(await ensureMarketPrices('Anthropic', {})).toBe(BAKED_ANTHROPIC_PRICES);
    expect(activeMarketPriceVersionId('Anthropic')).toBeNull();
  });
});

describe('the two baked lists are distinct', () => {
  /*
   * 🔴 THE FAILURE THIS PAIR EXISTS FOR: both marketplaces price `claude-sonnet-5` — the platform
   * default — and they price it differently. A read against the wrong list therefore returns a number,
   * not an error, and mis-bills roughly 2x with nothing throwing and no test failing anywhere else.
   */
  it('serves each provider its OWN baked table', () => {
    expect(activeMarketPrices('KIE')).toBe(BAKED_MARKET_PRICES);
    expect(activeMarketPrices('Anthropic')).toBe(BAKED_ANTHROPIC_PRICES);
  });

  it('prices the same model at genuinely different rates, so a wrong read looks like a right answer', () => {
    const kie = activeMarketPrices('KIE').llm['claude-sonnet-5'];
    const anthropic = activeMarketPrices('Anthropic').llm['claude-sonnet-5'];

    /* Control: both lists really do price it — the difference below is a price, not an absence. */
    expect(kie, 'KIE must price the platform default').toBeDefined();
    expect(anthropic, 'Anthropic must price the platform default').toBeDefined();

    expect(anthropic.inputPerMTok).not.toBe(kie.inputPerMTok);
    expect(anthropic.outputPerMTok).not.toBe(kie.outputPerMTok);

    /* Pinned absolutely, so "different" cannot be satisfied by either row drifting to anything. */
    expect(kie.inputPerMTok).toBe(0.85);
    expect(anthropic.inputPerMTok).toBe(2);
  });
});

describe('promotion is scoped to ONE provider', () => {
  it('leaves the other provider’s pointer, cache and active list untouched', async () => {
    const store = memoryStore();

    const promoted = await promoteMarketPrices(store, 'Anthropic', {
      ...BAKED_ANTHROPIC_PRICES,
      llm: { ...BAKED_ANTHROPIC_PRICES.llm, 'claude-sonnet-5': { inputPerMTok: 9, outputPerMTok: 45 } },
    });

    expect(promoted.ok).toBe(true);
    expect(activeMarketPrices('Anthropic').llm['claude-sonnet-5'].inputPerMTok).toBe(9);

    /* KIE saw none of it: no pointer, no versions, no cache slot, baked list by identity. */
    expect(await readPointer(store, 'KIE')).toBeNull();
    expect(await listVersions(store, 'KIE')).toEqual([]);
    expect(activeMarketPriceVersionId('KIE')).toBeNull();
    expect(activeMarketPrices('KIE')).toBe(BAKED_MARKET_PRICES);
  });

  it('is symmetric — a KIE promotion does not move Anthropic', async () => {
    const store = memoryStore();
    const promoted = await promoteMarketPrices(store, 'KIE', listWithOpusInput(3));

    expect(promoted.ok).toBe(true);
    expect(activeMarketPrices('KIE').llm['claude-opus-4-8'].inputPerMTok).toBe(3);

    expect(await readPointer(store, 'Anthropic')).toBeNull();
    expect(activeMarketPriceVersionId('Anthropic')).toBeNull();
    expect(activeMarketPrices('Anthropic')).toBe(BAKED_ANTHROPIC_PRICES);
  });

  it('writes each provider under its own prefix, and never the other’s', async () => {
    const store = memoryStore();
    await promoteMarketPrices(store, 'KIE', listWithOpusInput(3));
    await promoteMarketPrices(store, 'Anthropic', BAKED_ANTHROPIC_PRICES);

    expect((await store.list('pricing/kie-market/')).length).toBe(2);
    expect((await store.list('pricing/anthropic-market/')).length).toBe(2);
  });

  /*
   * The validate-before-write wall is a property of the STORE, not of KIE. A refusal on the new
   * provider must be just as total: no version object, no pointer, and the baked list still serving.
   */
  it('writes nothing at all when an Anthropic promotion is refused', async () => {
    const store = memoryStore();
    const bad = { ...BAKED_ANTHROPIC_PRICES, llm: {}, schemaVersion: 9 };

    const result = await promoteMarketPrices(store, 'Anthropic', bad);

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors.length).toBeGreaterThanOrEqual(2);
    expect(await listVersions(store, 'Anthropic')).toEqual([]);
    expect(await readPointer(store, 'Anthropic')).toBeNull();
    expect(activeMarketPrices('Anthropic')).toBe(BAKED_ANTHROPIC_PRICES);
  });

  it('invalidates one slot or all of them, as asked', async () => {
    const store = memoryStore();
    await promoteMarketPrices(store, 'KIE', listWithOpusInput(3));
    await promoteMarketPrices(store, 'Anthropic', {
      ...BAKED_ANTHROPIC_PRICES,
      llm: { ...BAKED_ANTHROPIC_PRICES.llm, 'claude-sonnet-5': { inputPerMTok: 9, outputPerMTok: 45 } },
    });

    invalidateMarketPricesCache('KIE');
    expect(activeMarketPrices('KIE'), 'the named slot is cleared').toBe(BAKED_MARKET_PRICES);
    expect(activeMarketPrices('Anthropic').llm['claude-sonnet-5'].inputPerMTok, 'the other survives').toBe(9);

    invalidateMarketPricesCache();
    expect(activeMarketPrices('Anthropic')).toBe(BAKED_ANTHROPIC_PRICES);
  });
});

describe('ensureMarketPrices', () => {
  /*
   * The provider is REQUIRED (it briefly defaulted to KIE). Loading one slot must fill that slot only:
   * a call that warmed a neighbour as a side effect would hide the day a caller names the wrong list.
   */
  it('loads the named provider’s slot and no other', async () => {
    await contextStore.put(
      'pricing/kie-market/versions/mp_20260718120000.json',
      encode(listWithOpusInput(3)),
      'application/json',
    );
    await contextStore.put(
      'pricing/kie-market/active.json',
      encode({ versionId: 'mp_20260718120000', activatedAt: '2026-07-18T12:00:00.000Z', activatedBy: 'promote' }),
      'application/json',
    );

    const loaded = await ensureMarketPrices('KIE', {});

    expect(loaded.llm['claude-opus-4-8'].inputPerMTok).toBe(3);
    expect(activeMarketPriceVersionId('KIE')).toBe('mp_20260718120000');

    /* Control: the Anthropic slot was not filled as a side effect of the call. */
    expect(activeMarketPriceVersionId('Anthropic')).toBeNull();
  });

  /*
   * A pointer naming bytes that are gone serves BAKED and repoints nothing (the template-pin rule).
   * Per provider, so one broken pointer cannot decide the other marketplace's prices.
   */
  it('falls back to that provider’s baked list when the pointer names a missing version', async () => {
    await contextStore.put(
      'pricing/anthropic-market/active.json',
      encode({ versionId: 'mp_gone', activatedAt: '2026-08-10T00:00:00.000Z', activatedBy: 'promote' }),
      'application/json',
    );

    expect(await ensureMarketPrices('Anthropic', {})).toBe(BAKED_ANTHROPIC_PRICES);
    expect(activeMarketPriceVersionId('Anthropic')).toBeNull();
  });

  /* A store that throws is an ops alert, never a dead billing path (§4.6). */
  it('never throws when the store is unreadable — the baked list stands', async () => {
    setObjectStore({
      ...memoryStore(),
      get: async () => {
        throw new Error('storage down');
      },
    });

    await expect(ensureMarketPrices('Anthropic', {})).resolves.toBe(BAKED_ANTHROPIC_PRICES);
    await expect(ensureMarketPrices('KIE', {})).resolves.toBe(BAKED_MARKET_PRICES);
  });
});

describe('marketPriceProvidersFor', () => {
  /*
   * 🔴 ANTHROPIC ONLY, ON EVERY INPUT (2026-10-03, `_specs/anthropic-only_plan.md` D4).
   *
   * These are the lists an LLM turn is priced from, and `getModelTier` prices the paid rungs from the
   * same set. KIE used to be in every answer (the rungs were priced from its list), and Comet was an
   * LLM gateway of its own; both are gone. A KIE list in this answer would let a promoted KIE `llm` row
   * — which prices nothing by contract — reach the ladder again, silently.
   */
  it('answers Anthropic alone, whatever provider is named — including a stale KIE or Comet', () => {
    for (const platform of ['Anthropic', 'KIE', 'Comet', 'FAL', 'not-a-provider', '']) {
      expect(marketPriceProvidersFor(platform), platform).toEqual(['Anthropic']);
    }
  });

  it('never duplicates a list', () => {
    for (const platform of [...MARKET_PRICE_PROVIDERS, 'nonsense']) {
      const lists = marketPriceProvidersFor(platform);
      expect(new Set(lists).size, platform).toBe(lists.length);
    }
  });

  /*
   * The argument is a plain `string` (to keep this module out of the `config -> rates ->
   * market-price-store` import cycle), so an unrecognised value is REACHABLE — a typo'd `LLM_PROVIDER`,
   * or a stale deploy naming a provider that has since been removed. It must degrade to EVERY LLM list,
   * never to an empty one: refreshing nothing means every list serves baked with nothing said about it.
   */
  it('degrades an unknown provider name to every LLM list rather than to nothing', () => {
    expect(marketPriceProvidersFor('Bedrock')).toEqual([...LLM_PRICE_PROVIDERS]);
    expect(marketPriceProvidersFor('')).toEqual([...LLM_PRICE_PROVIDERS]);
    expect(marketPriceProvidersFor('anthropic'), 'match is exact, not case-folded').toEqual([...LLM_PRICE_PROVIDERS]);
    expect(LLM_PRICE_PROVIDERS.length, 'control: the LLM set is not empty').toBeGreaterThan(0);
  });

  /*
   * 🔴 A media-only list prices no LLM turn, so it never joins the LLM set — and neither does KIE, whose
   * list now prices MEDIA only. Both are loaded at the MEDIA doorways.
   */
  it('never puts a media list (KIE, FAL) in the LLM set', () => {
    for (const platform of [...MARKET_PRICE_PROVIDERS, 'nonsense']) {
      expect(marketPriceProvidersFor(platform), platform).not.toContain('FAL');
      expect(marketPriceProvidersFor(platform), platform).not.toContain('KIE');
    }

    expect(LLM_PRICE_PROVIDERS).toEqual(['Anthropic']);

    /* CONTROL: KIE and FAL ARE market price providers — the exclusion is deliberate, not a missing entry. */
    expect(MARKET_PRICE_PROVIDERS).toContain('FAL');
    expect(MARKET_PRICE_PROVIDERS).toContain('KIE');

    for (const mediaOnly of MEDIA_ONLY_PRICE_PROVIDERS) {
      expect(MARKET_PRICE_PROVIDERS as readonly string[], mediaOnly).toContain(mediaOnly);
    }
  });

  /* Comet was removed outright (D5): no store slot, no baked list, nothing to price from. */
  it('has no Comet list at all', () => {
    expect([...MARKET_PRICE_PROVIDERS]).toEqual(['KIE', 'Anthropic', 'FAL']);
    expect(MARKET_PRICE_PROVIDERS as readonly string[]).not.toContain('Comet');
  });

  it('only ever names providers the store can actually serve', () => {
    for (const platform of [...MARKET_PRICE_PROVIDERS, 'Comet', 'nonsense']) {
      for (const resolved of marketPriceProvidersFor(platform)) {
        expect(MARKET_PRICE_PROVIDERS).toContain(resolved);
      }
    }
  });
});

/*
 * ------------------------------------------------------------------------------------------------ *
 * The fal list (media-gateways T2) — media-only, its own key, never adopting another provider's bytes
 * ------------------------------------------------------------------------------------------------
 */

describe('the FAL price list', () => {
  it('serves the baked FAL list when nothing is promoted', async () => {
    expect(activeMarketPrices('FAL')).toBe(BAKED_FAL_PRICES);
    expect(await ensureMarketPrices('FAL', {})).toBe(BAKED_FAL_PRICES);
    expect(activeMarketPriceVersionId('FAL')).toBeNull();
  });

  it('promotes and loads a FAL list under its own key', async () => {
    const candidate = {
      ...BAKED_FAL_PRICES,
      media: {
        ...BAKED_FAL_PRICES.media,
        'fal-ai/minimax-music/v2.6': {
          ...BAKED_FAL_PRICES.media['fal-ai/minimax-music/v2.6'],
          variants: [{ options: {}, usd: 0.2 }],
        },
      },
    };

    const result = await promoteMarketPrices(contextStore, 'FAL', candidate);

    expect(result.ok, result.ok ? '' : (result as { errors: string[] }).errors.join('; ')).toBe(true);

    const versionId = result.ok ? result.pointer.versionId : '';

    /* Stored at `pricing/fal-market/...` — asserted as a literal, never through the helper. */
    expect(await contextStore.get(`pricing/fal-market/versions/${versionId}.json`)).not.toBeNull();
    expect(await contextStore.get('pricing/fal-market/active.json')).not.toBeNull();

    /* Loaded back through the validating read, with the FAL rule (an empty llm table is required). */
    const loaded = await loadVersion(contextStore, 'FAL', versionId);
    expect(loaded?.media['fal-ai/minimax-music/v2.6'].variants[0].usd).toBe(0.2);
    expect(activeMarketPrices('FAL').media['fal-ai/minimax-music/v2.6'].variants[0].usd).toBe(0.2);

    /* KIE and Anthropic are untouched: no pointer written, still their own baked tables. */
    expect(await readPointer(contextStore, 'KIE')).toBeNull();
    expect(await readPointer(contextStore, 'Anthropic')).toBeNull();
    expect(activeMarketPrices('KIE')).toBe(BAKED_MARKET_PRICES);
    expect(activeMarketPrices('Anthropic')).toBe(BAKED_ANTHROPIC_PRICES);
  });

  it('refuses to promote a FAL list carrying llm rows, and writes nothing', async () => {
    const result = await promoteMarketPrices(contextStore, 'FAL', {
      ...BAKED_FAL_PRICES,
      llm: { [DEFAULT_MODEL]: { inputPerMTok: 2, outputPerMTok: 10 } },
    });

    expect(result.ok).toBe(false);
    expect(await readPointer(contextStore, 'FAL')).toBeNull();
    expect(activeMarketPrices('FAL')).toBe(BAKED_FAL_PRICES);
  });

  it('does not let FAL adopt a KIE list, nor KIE adopt the FAL list (control)', async () => {
    /* An LLM list is refused under FAL (it carries llm rows) ... */
    expect((await promoteMarketPrices(contextStore, 'FAL', BAKED_MARKET_PRICES)).ok).toBe(false);

    /* ... and the media-only list is refused under KIE (no llm rows, no default). */
    expect((await promoteMarketPrices(contextStore, 'KIE', BAKED_FAL_PRICES)).ok).toBe(false);
  });
});
