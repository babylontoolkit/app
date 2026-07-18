/**
 * The marketplace price list core (SPEC §4.6, spec/billing.md) — money-path tests.
 *
 * Validation is the wall every admin promotion passes through, and lookup is what media billing will
 * debit from (§4.16) — both fail SILENTLY when wrong: a lax validator lets a half-priced list bill
 * real money, and a wrong lookup either refuses priced work or (far worse) prices it from the wrong
 * variant.
 */
import { describe, expect, it } from 'vitest';
import { findMediaModel, lookupMediaPrice, validateMarketPriceList, type MarketPriceList } from './market-prices';
import { BAKED_MARKET_PRICES } from './baked-market-prices';

/** A minimal valid list to mutate per test. */
function validList(): MarketPriceList {
  return {
    schemaVersion: 1,
    capturedAt: '2026-07-18',
    source: 'test',
    llm: { 'claude-opus-4-8': { inputPerMTok: 2, outputPerMTok: 10 } },
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
      list.llm['claude-opus-4-8'] = { inputPerMTok: bad as number, outputPerMTok: 10 };
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
    (list.llm['claude-opus-4-8'] as unknown as Record<string, number>).cacheReadPerMTok = 0.2;
    expect(errorsOf(list).join()).toMatch(/cache rates derive/i);
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
    list.llm['claude-opus-4-8'] = { inputPerMTok: 0, outputPerMTok: 0 };
    list.media['nano-banana-2'].variants[0].usd = -1;
    expect(errorsOf(list).length).toBeGreaterThanOrEqual(3);
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

  it('the worked example: a 2K nano-banana-2 image costs $0.06 → 21 credits at the default margin', () => {
    const price = lookupMediaPrice(list, { model: 'nano-banana-2', options: { resolution: '2K' } });

    // ceil(0.06 / 0.01 × 3.34) = ceil(20.04) = 21 — the number quoted to the owner (2026-07-18).
    expect(Math.ceil((price!.usd / 0.01) * 3.34)).toBe(21);
  });
});
