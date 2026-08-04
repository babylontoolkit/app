/**
 * The marketplace price list core (SPEC §4.6, spec/billing.md) — money-path tests.
 *
 * Validation is the wall every admin promotion passes through, and lookup is what media billing will
 * debit from (§4.16) — both fail SILENTLY when wrong: a lax validator lets a half-priced list bill
 * real money, and a wrong lookup either refuses priced work or (far worse) prices it from the wrong
 * variant.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL } from '~/utils/constants';
import {
  findMediaModel,
  lookupMediaPrice,
  searchCreditsFor,
  validateMarketPriceList,
  type MarketPriceList,
} from './market-prices';
import { BAKED_MARKET_PRICES } from './baked-market-prices';

/** A minimal valid list to mutate per test. */
function validList(): MarketPriceList {
  return {
    schemaVersion: 1,
    capturedAt: '2026-07-18',
    source: 'test',

    /*
     * Keyed off DEFAULT_MODEL, not a literal: the wall under test is "the list must price the
     * PLATFORM DEFAULT", so hardcoding a model id here makes every one of these tests fail the day
     * the default moves — which is exactly what happened on 2026-07-30. The fixture should track the
     * rule, not a snapshot of it.
     */
    llm: { [DEFAULT_MODEL]: { inputPerMTok: 2, outputPerMTok: 10 } },
    media: {
      'nano-banana-2': {
        kind: 'image',
        label: 'Nano Banana 2',
        vendor: 'Google',
        unit: 'per_image',
        variants: [
          { options: { resolution: '1K' }, usd: 0.04 },
          { options: { resolution: '2K' }, usd: 0.06 },
        ],
      },
    },
  };
}

function errorsOf(value: unknown): string[] {
  const result = validateMarketPriceList(value);
  return result.ok ? [] : result.errors;
}

describe('validation — the promotion wall', () => {
  it('accepts the baked list — the fallback must never be refused by its own validator', () => {
    const result = validateMarketPriceList(BAKED_MARKET_PRICES);
    expect(result.ok, result.ok ? '' : (result as { errors: string[] }).errors.join('; ')).toBe(true);
  });

  it('accepts a minimal valid list', () => {
    expect(validateMarketPriceList(validList()).ok).toBe(true);
  });

  /*
   * 🔴 THE PLATFORM DEFAULT MUST ALWAYS BE PRICED (owner rule, 2026-07-27). An unpriced model bills
   * at the most-expensive row — the PREMIUM tier's rates, 2x the default's — so a list omitting the
   * default row would silently double-bill every ordinary generation the moment it went live. This
   * one wall guards BOTH doors: promotion (`promoteMarketPrices` validates before writing) and load
   * (`loadVersion` re-validates stored bytes, so a legacy list missing the row fails to load and the
   * platform serves the BAKED list, which always prices the default). The premium tier can never
   * become the default's effective price through any path.
   *
   * ⚠️ This used to pin the default's id LITERALLY, on the theory that changing `DEFAULT_MODEL` should
   * fail here and force the pins to move with it. Reversed 2026-07-31: the property under test is "the
   * refusal NAMES the model we would otherwise mis-bill", and the literal made this test fail for a
   * reason that had nothing to do with the wall the moment the platform changed rungs. The wall itself
   * is still guarded — mutation-verified, neutering it empties the error array and the `toContain`
   * fails on `''`. Which model is the default is pinned in `model-tiers.spec.ts`, where it belongs.
   */
  it('refuses a list that does not price the platform default — the premium tier must never fall through', () => {
    const list = validList();
    list.llm = { 'claude-opus-4-8': { inputPerMTok: 2, outputPerMTok: 10 } }; // priced, but NOT the default

    // Against the constant, never a literal — see the sibling note in `market-price-store.spec.ts`.
    expect(errorsOf(list).join()).toContain(DEFAULT_MODEL);
  });

  it.each([[null], ['a string'], [42], [[]]])('rejects a non-object list: %s', (bad) => {
    expect(validateMarketPriceList(bad).ok).toBe(false);
  });

  it('rejects a wrong schemaVersion', () => {
    expect(errorsOf({ ...validList(), schemaVersion: 2 }).join()).toMatch(/schemaVersion/);
  });

  /*
   * Zero and negative prices are refused everywhere: a free model does not exist, so `0` is a typo
   * that would zero-rate real spend forever (the envMoney rule, carried into the list).
   */
  it.each([[0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY], ['2' as unknown as number]])(
    'rejects an LLM price it cannot trust: %s',
    (bad) => {
      const list = validList();
      list.llm[DEFAULT_MODEL] = { inputPerMTok: bad as number, outputPerMTok: 10 };
      expect(errorsOf(list).join()).toMatch(/inputPerMTok/);
    },
  );

  it('rejects an EMPTY llm table — it would refuse every generation the moment it went live', () => {
    expect(errorsOf({ ...validList(), llm: {} }).join()).toMatch(/at least one/);
  });

  /*
   * Cache rates DERIVE (0.1x / 2.0x, measured on KIE). A list quoting them is a second opinion about
   * a derived number — refused rather than ignored, because ignored config is how the old
   * KIE_CACHED_* half-reprice bugs were born.
   */
  it('rejects quoted cache rates on an llm row', () => {
    const list = validList();
    (list.llm[DEFAULT_MODEL] as unknown as Record<string, number>).cacheReadPerMTok = 0.2;
    expect(errorsOf(list).join()).toMatch(/cache rates derive/i);
  });

  /*
   * THE PAIR IS FAMILY POLICY, NOT A FLAT REFUSAL (2026-08-04, `model-families.ts`).
   *
   * The refusal above stays exactly right for `claude-*`, where the multipliers are MEASURED on KIE and
   * a quoted number would be a second opinion about a derived one. It is wrong for `gpt-*`, where KIE
   * PUBLISHES Cached Input and Cache Writes prices that are not multiples of input — deriving those
   * would invent a discount we cannot verify, and nothing would fail; the invoices would just be wrong.
   */
  it('accepts a gpt row quoting BOTH cache rates — KIE publishes them and they do not derive', () => {
    const list = validList();
    list.llm['gpt-5-6-sol'] = {
      inputPerMTok: 1.25,
      outputPerMTok: 10,
      cachedInputPerMTok: 0.125,
      cacheWritePerMTok: 1.5625,
    };

    expect(validateMarketPriceList(list).ok).toBe(true);
  });

  /*
   * 🔴 BOTH HALVES OR NEITHER. A row quoting only Cached Input leaves the write rate derived at 2.0x an
   * input rate KIE does not use for writes — a row half-priced from each source, which is the
   * `packMargin()` shape (two numbers, each locally sensible, disagreeing about what one thing costs).
   * The error must name the MISSING half, or the admin fixing a pasted list is told a row is wrong
   * without being told which number to type.
   */
  it.each([
    ['cachedInputPerMTok', 'cacheWritePerMTok'],
    ['cacheWritePerMTok', 'cachedInputPerMTok'],
  ])('refuses a gpt row quoting only %s, naming the missing %s', (present, missing) => {
    const list = validList();
    list.llm['gpt-5-6-sol'] = { inputPerMTok: 1.25, outputPerMTok: 10, [present]: 0.125 };

    const joined = errorsOf(list).join();
    expect(joined).toMatch(/must quote both cache rates/i);
    expect(joined).toContain(missing);
  });

  /* Neither half is the same bug with both halves derived, and is refused for the same reason. */
  it('refuses a gpt row quoting NEITHER cache rate — deriving both is the bug, not the fallback', () => {
    const list = validList();
    list.llm['gpt-5-6-sol'] = { inputPerMTok: 1.25, outputPerMTok: 10 };

    expect(errorsOf(list).join()).toMatch(/must quote both cache rates/i);
  });

  /*
   * Gemini quotes no cached rate on KIE and their wire returns no cached-token counter, so there is no
   * discount to grant and no surcharge to observe — cached tokens bill at the FULL input rate. A row
   * quoting a pair would be inventing an economics we cannot verify, so the refusal must SAY that
   * rather than repeating claude's "cache rates derive" wording, which would send an operator looking
   * for a multiplier that does not exist for this family.
   */
  it('refuses a gemini row quoting the pair, explaining that cached tokens bill at full input rate', () => {
    const list = validList();
    list.llm['gemini-3-pro'] = {
      inputPerMTok: 2,
      outputPerMTok: 12,
      cachedInputPerMTok: 0.2,
      cacheWritePerMTok: 4,
    };

    expect(errorsOf(list).join()).toMatch(/full input rate/i);
  });

  /*
   * An id no prefix claims is REFUSED rather than defaulted — the other side of `requireFamily`'s
   * throw: we would be pricing a model whose wire, and therefore whose cache economics, we cannot name.
   *
   * ⚠️ KIE's pricing FEED display name `gpt-5.6-sol` is NOT this case — it starts with `gpt-`, so it is
   * a known family and is caught by the atomic-pair rule above instead. The dots matter at the wire
   * (the API id is `gpt-5-6-sol`), not here.
   */
  it.each([['llama-3'], ['o3-mini'], ['sonnet-5']])('refuses an llm row of no known family: %s', (id) => {
    const list = validList();
    list.llm[id] = { inputPerMTok: 2, outputPerMTok: 10 };

    expect(errorsOf(list).join()).toMatch(/known model family/i);
  });

  /*
   * Every cache error is PUSHED, never thrown. An admin fixing a pasted list needs the whole picture:
   * a half-paired gpt row AND a quoted claude pair must both be reported on the SAME pass, or fixing
   * one just reveals the other one refresh later.
   */
  it('reports a half-paired gpt row AND a quoted claude pair in ONE pass', () => {
    const list = validList();
    list.llm['gpt-5-6-sol'] = { inputPerMTok: 1.25, outputPerMTok: 10, cachedInputPerMTok: 0.125 };
    (list.llm[DEFAULT_MODEL] as unknown as Record<string, number>).cacheReadPerMTok = 0.2;

    const joined = errorsOf(list).join();
    expect(joined, 'the gpt half-pair').toMatch(/must quote both cache rates/i);
    expect(joined, 'the claude quote').toMatch(/cache rates derive/i);
  });

  it('rejects a media model with no variants — unpriced means it cannot run', () => {
    const list = validList();
    list.media['nano-banana-2'].variants = [];
    expect(errorsOf(list).join()).toMatch(/non-empty/);
  });

  it('rejects a media variant with a bad price', () => {
    const list = validList();
    list.media['nano-banana-2'].variants[0].usd = 0;
    expect(errorsOf(list).join()).toMatch(/usd/);
  });

  /* Two variants with identical options would price one request two ways, decided by array order. */
  it('rejects duplicate variant option sets — ambiguous pricing', () => {
    const list = validList();
    list.media['nano-banana-2'].variants.push({ options: { resolution: '1K' }, usd: 0.05 });
    expect(errorsOf(list).join()).toMatch(/identical options/);
  });

  /* Aliases share the model-id namespace — a duplicate would make lookup ambiguous. */
  it('rejects an alias that collides with another model', () => {
    const list = validList();
    list.media['other-model'] = {
      kind: 'image',
      label: 'Other',
      vendor: 'X',
      unit: 'per_image',
      aliases: ['nano-banana-2'],
      variants: [{ options: {}, usd: 0.01 }],
    };
    expect(errorsOf(list).join()).toMatch(/claimed by both/);
  });

  it('collects EVERY error at once, not just the first', () => {
    const list = validList();
    list.llm[DEFAULT_MODEL] = { inputPerMTok: 0, outputPerMTok: 0 };
    list.media['nano-banana-2'].variants[0].usd = -1;
    expect(errorsOf(list).length).toBeGreaterThanOrEqual(3);
  });
});

describe('search rate — the flat web_search toll (§4.2)', () => {
  it('is optional — a list promoted before search billing (no search field) is valid', () => {
    expect(validateMarketPriceList(validList()).ok).toBe(true); // validList() has no `search`
  });

  it('accepts a well-formed search rate, including 0 (do-not-bill)', () => {
    expect(validateMarketPriceList({ ...validList(), search: { creditsPerSearch: 10 } }).ok).toBe(true);
    expect(validateMarketPriceList({ ...validList(), search: { creditsPerSearch: 0 } }).ok).toBe(true);
  });

  it('rejects a non-integer, negative, or non-object search rate, and extra keys', () => {
    expect(errorsOf({ ...validList(), search: { creditsPerSearch: 1.5 } }).join()).toMatch(/creditsPerSearch/);
    expect(errorsOf({ ...validList(), search: { creditsPerSearch: -5 } }).join()).toMatch(/creditsPerSearch/);
    expect(errorsOf({ ...validList(), search: 10 }).join()).toMatch(/search must be an object/);
    expect(errorsOf({ ...validList(), search: { creditsPerSearch: 10, usd: 1 } }).join()).toMatch(/unsupported keys/);
  });

  it('baked list carries a search rate', () => {
    expect(BAKED_MARKET_PRICES.search?.creditsPerSearch).toBeGreaterThan(0);
  });

  it('searchCreditsFor uses the list rate, or falls back to baked when absent', () => {
    expect(searchCreditsFor({ ...validList(), search: { creditsPerSearch: 25 } }, { creditsPerSearch: 10 })).toBe(25);
    expect(searchCreditsFor(validList(), { creditsPerSearch: 10 })).toBe(10); // no search field → fallback
  });
});

describe('media price lookup — what the up-front debit is computed from', () => {
  const list = BAKED_MARKET_PRICES;

  it('prices a flat per-image request', () => {
    const price = lookupMediaPrice(list, { model: 'nano-banana-2', options: { resolution: '2K' } });
    expect(price).toMatchObject({ model: 'nano-banana-2', usd: 0.06, unit: 'per_image' });
  });

  /* KIE's own docs mix 4K/4k and 720P/720p — a case miss must not become a refusal. */
  it('matches string options case-insensitively', () => {
    const price = lookupMediaPrice(list, { model: 'nano-banana-2', options: { resolution: '4k' } });
    expect(price?.usd).toBe(0.09);
  });

  it('multiplies per-second prices by the duration', () => {
    const price = lookupMediaPrice(list, {
      model: 'kling-3.0/video',
      options: { mode: 'pro', sound: true },
      durationSeconds: 5,
    });
    expect(price?.usd).toBeCloseTo(0.675, 9); // 0.135/s × 5s
  });

  it('REFUSES a per-second request with no duration — a per-second price without one is not a price', () => {
    expect(lookupMediaPrice(list, { model: 'kling-3.0/video', options: { mode: 'pro', sound: true } })).toBeNull();
  });

  it('prices a flat per-video request (Veo)', () => {
    const price = lookupMediaPrice(list, { model: 'veo3_fast', options: { resolution: '1080p' } });
    expect(price).toMatchObject({ usd: 0.325, unit: 'per_video' });
  });

  /* Kling 3.0's 4K row omits `sound` (KIE prices both identically) — the subset match covers both. */
  it('lets a variant that omits an option price every value of it', () => {
    for (const sound of [true, false]) {
      const price = lookupMediaPrice(list, {
        model: 'kling-3.0/video',
        options: { mode: '4K', sound },
        durationSeconds: 10,
      });
      expect(price?.usd, `sound=${sound}`).toBeCloseTo(3.35, 9);
    }
  });

  it('resolves aliases to the canonical row (kling-2.6 slugs)', () => {
    const price = lookupMediaPrice(list, {
      model: 'kling-2.6/image-to-video',
      options: { durationSeconds: 5, sound: false },
    });
    expect(price).toMatchObject({ model: 'kling-2.6', usd: 0.275 });
    expect(findMediaModel(list, 'kling-2.6/text-to-video')?.id).toBe('kling-2.6');
  });

  /*
   * 🔴 NO most-expensive fallback, unlike `ratesFor`: LLM settlement runs AFTER spend where
   * over-charging ourselves is safe; media debits run BEFORE spend where the safe direction is to
   * not spend at all. An unknown model or unmatched options mean REFUSE.
   */
  it('returns null for an unknown model — refuse, never guess', () => {
    expect(lookupMediaPrice(list, { model: 'some-model', options: {} })).toBeNull();
  });

  it('returns null for options no variant prices', () => {
    expect(lookupMediaPrice(list, { model: 'nano-banana-2', options: { resolution: '8K' } })).toBeNull();
  });

  it('the worked example: a 2K nano-banana-2 image costs $0.06 → 24 credits at the default margin', () => {
    const price = lookupMediaPrice(list, { model: 'nano-banana-2', options: { resolution: '2K' } });

    // ceil(0.06 / 0.01 × 4.0) = ceil(24) = 24 credits at CREDIT_MARGIN=4.0 (raised from 3.34, 2026-07-18).
    expect(Math.ceil((price!.usd / 0.01) * 4.0)).toBe(24);
  });
});
