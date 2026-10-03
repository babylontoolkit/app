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
  isMediaOnlyPriceProvider,
  lookupMediaPrice,
  MEDIA_ONLY_PRICE_PROVIDERS,
  searchCreditsFor,
  validateMarketPriceList,
  type MarketPriceList,
} from './market-prices';
import { BAKED_MARKET_PRICES } from './baked-market-prices';
import { BAKED_ANTHROPIC_PRICES } from './baked-anthropic-prices';
import { BAKED_FAL_PRICES } from './baked-fal-prices';
import { FAMILY_PREFIXES } from '~/lib/modules/llm/model-families';

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
  const result = validateMarketPriceList(value, 'KIE');
  return result.ok ? [] : result.errors;
}

describe('validation — the promotion wall', () => {
  it('accepts the baked list — the fallback must never be refused by its own validator', () => {
    const result = validateMarketPriceList(BAKED_MARKET_PRICES, 'KIE');
    expect(result.ok, result.ok ? '' : (result as { errors: string[] }).errors.join('; ')).toBe(true);
  });

  /*
   * The SAME wall for the Anthropic fallback — the list that prices EVERY LLM turn since 2026-10-03
   * (`_specs/anthropic-only_plan.md` D4).
   *
   * A baked list its own validator refuses is a uniquely bad state: `loadVersion` re-validates on read
   * and `promoteMarketPrices` validates before writing, but the baked table is served WITHOUT passing
   * either — it is the thing served when validation has nothing to say. So an invalid one does not
   * fail loudly, it silently becomes the prices charged forever.
   *
   * (This block pinned the Comet list until Comet was removed, 2026-10-03.)
   */
  it('accepts the baked Anthropic list — its fallback is served without ever passing validation', () => {
    const result = validateMarketPriceList(BAKED_ANTHROPIC_PRICES, 'Anthropic');
    expect(result.ok, result.ok ? '' : (result as { errors: string[] }).errors.join('; ')).toBe(true);
  });

  /*
   * 🔴 The platform default has to be priced on the list that bills it. `ratesFor` bills an unpriced
   * model at the most expensive row, so an Anthropic list missing this row would bill every ordinary
   * generation at the priciest Claude rung — silently.
   */
  it('prices the platform default on the Anthropic list', () => {
    expect(BAKED_ANTHROPIC_PRICES.llm[DEFAULT_MODEL], `${DEFAULT_MODEL} is unpriced on Anthropic`).toBeDefined();
    expect(BAKED_ANTHROPIC_PRICES.llm[DEFAULT_MODEL].inputPerMTok).toBeGreaterThan(0);
    expect(BAKED_ANTHROPIC_PRICES.llm[DEFAULT_MODEL].outputPerMTok).toBeGreaterThan(0);
  });

  /*
   * The family rule is a property of the LIST, not of a vendor: a promoted claude row derives its cache
   * rates (0.1x read / 2.0x the 1h write) and the pair is REFUSED on the way in. Asserted against an
   * Anthropic row rather than assumed from the KIE tests, because "the rule follows the model family,
   * not the marketplace" is exactly the thing a per-provider store makes it easy to get wrong.
   */
  it('refuses quoted cache rates on an Anthropic claude row, exactly as on KIE', () => {
    const list: MarketPriceList = {
      ...BAKED_ANTHROPIC_PRICES,
      llm: {
        ...BAKED_ANTHROPIC_PRICES.llm,
        [DEFAULT_MODEL]: { ...BAKED_ANTHROPIC_PRICES.llm[DEFAULT_MODEL], cachedInputPerMTok: 0.16 },
      },
    };

    expect((validateMarketPriceList(list, 'Anthropic') as { errors?: string[] }).errors?.join() ?? '').toMatch(
      /cache rates derive/i,
    );

    /* Control: the same list without the quote is accepted, so the refusal is about the cache key. */
    expect(validateMarketPriceList(BAKED_ANTHROPIC_PRICES, 'Anthropic').ok).toBe(true);
  });

  /*
   * An EMPTY media table is valid and is the correct state for Anthropic (it renders no media).
   * `lookupMediaPrice` has no most-expensive fallback — media debits run BEFORE spend — so an unpriced
   * media model is REFUSED rather than guessed, and a speculative row is the one shape that would turn
   * that refusal into a wrong charge.
   */
  it('accepts an empty media table — no media rows is a refusal, never a guess', () => {
    expect(BAKED_ANTHROPIC_PRICES.media).toEqual({});
    expect(validateMarketPriceList(BAKED_ANTHROPIC_PRICES, 'Anthropic').ok).toBe(true);

    // CONTROL: the media table is not what makes the list valid — the LLM rows are really there.
    expect(Object.keys(BAKED_ANTHROPIC_PRICES.llm).length).toBeGreaterThan(0);
  });

  /*
   * WHICH models the Anthropic list can bill. Adding or removing a row must stay a deliberate act: a row
   * here is what makes a selector (`LLM_MODEL`, `PREMIUM_MODEL`, `PLATINUM_MODEL`) serveable at all.
   */
  it('pins which models the Anthropic list prices', () => {
    expect(Object.keys(BAKED_ANTHROPIC_PRICES.llm).sort()).toEqual([
      'claude-fable-5',
      'claude-fable-5-1',
      'claude-haiku-4-5',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-opus-5-5',
      'claude-sonnet-5',
      'claude-sonnet-5-5',
    ]);

    /* Every row must be a family the validator recognises, or the list cannot be promoted at all. */
    for (const model of Object.keys(BAKED_ANTHROPIC_PRICES.llm)) {
      expect(
        FAMILY_PREFIXES.some(([prefix]) => model.startsWith(prefix)),
        `${model} names no family`,
      ).toBe(true);
    }
  });

  it('accepts a minimal valid list', () => {
    expect(validateMarketPriceList(validList(), 'KIE').ok).toBe(true);
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
    expect(validateMarketPriceList(bad, 'KIE').ok).toBe(false);
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

    expect(validateMarketPriceList(list, 'KIE').ok).toBe(true);
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
   * The `chat` family (added for Comet 2026-08-10; no gateway serves it since Comet's removal on
   * 2026-10-03, but it stays in the family table — `_specs/anthropic-only_plan.md` D7) carries the SAME `none` profile as gemini and for the same
   * reason — no vendor among Grok/Kimi/Qwen/GLM/DeepSeek/MiniMax publishes a cached rate — so a row
   * quoting only the base pair is the complete, correct row. Accepting it is what makes the family
   * priceable at all; the ACCEPT case is easy to lose while tightening the refusals around it.
   */
  it.each([['grok-4.5'], ['kimi-k2-thinking'], ['qwen3-max'], ['glm-4.6'], ['deepseek-v3.2'], ['minimax-m2']])(
    'accepts a chat row quoting only the base pair: %s',
    (id) => {
      const list = validList();
      list.llm[id] = { inputPerMTok: 3, outputPerMTok: 15 };

      const result = validateMarketPriceList(list, 'KIE');
      expect(result.ok, result.ok ? '' : (result as { errors: string[] }).errors.join('; ')).toBe(true);
    },
  );

  /*
   * 🔴 And a chat row quoting a cache rate is REFUSED, explaining that cached tokens bill at the full
   * input rate. Quoting one here would be inventing an economics no vendor publishes and our own usage
   * reader cannot observe — a discount granted against a counter that does not arrive. Both cache keys
   * are covered because a validator that refuses one and ignores the other is half a wall.
   */
  it.each([['cachedInputPerMTok'], ['cacheWritePerMTok']])('refuses a chat row quoting %s', (key) => {
    const list = validList();
    list.llm['grok-4.5'] = { inputPerMTok: 3, outputPerMTok: 15, [key]: 0.3 };

    const joined = errorsOf(list).join();
    expect(joined).toMatch(/full input rate/i);
    expect(joined).toContain(key);
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
   * The refusal must name EVERY accepted prefix, derived from `FAMILY_PREFIXES` rather than typed out.
   * It used to enumerate three in prose; the day a fourth family landed, an admin pasting a perfectly
   * valid `grok-4.5` row into an older build would have been told the accepted set was three things it
   * was not — sending them to fix an id that was already right.
   */
  it('names every accepted prefix, so an admin is not told a shorter list than the truth', () => {
    const list = validList();
    list.llm['llama-3'] = { inputPerMTok: 2, outputPerMTok: 10 };

    const joined = errorsOf(list).join();

    for (const [prefix] of FAMILY_PREFIXES) {
      expect(joined, `the refusal must name ${prefix}`).toContain(prefix);
    }
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
    expect(validateMarketPriceList(validList(), 'KIE').ok).toBe(true); // validList() has no `search`
  });

  it('accepts a well-formed search rate, including 0 (do-not-bill)', () => {
    expect(validateMarketPriceList({ ...validList(), search: { creditsPerSearch: 10 } }, 'KIE').ok).toBe(true);
    expect(validateMarketPriceList({ ...validList(), search: { creditsPerSearch: 0 } }, 'KIE').ok).toBe(true);
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

/**
 * Sound (§4.16 `generate_sound`) — the `audio` kind and its two units.
 *
 * `per_1k_chars` is the one unit whose price is a RATE: speech is billed on the characters KIE will
 * speak, so a lookup with no character count is the same non-price `per_second` refuses, and the
 * refusal is what stops a one-line voice clip being billed as a full thousand characters.
 */
describe('audio pricing — Suno effects/music and ElevenLabs speech', () => {
  const list = BAKED_MARKET_PRICES;

  it('the baked KIE list still validates with the audio rows in it', () => {
    expect(validateMarketPriceList(BAKED_MARKET_PRICES, 'KIE').ok).toBe(true);
  });

  it('accepts an audio row priced per 1,000 characters', () => {
    const value = validList();
    value.media['elevenlabs/text-to-speech-turbo-2-5'] = {
      kind: 'audio',
      label: 'Turbo',
      vendor: 'ElevenLabs',
      unit: 'per_1k_chars',
      variants: [{ options: {}, usd: 0.03 }],
    };
    expect(validateMarketPriceList(value, 'KIE').ok).toBe(true);
  });

  /* CONTROL: widening the unions must not have turned the checks into "anything goes". */
  it('still rejects an unknown kind and an unknown unit', () => {
    const badKind = validList();
    badKind.media['nano-banana-2'].kind = 'hologram' as never;
    expect(errorsOf(badKind).join()).toMatch(/kind must be one of/);

    const badUnit = validList();
    badUnit.media['nano-banana-2'].unit = 'per_minute' as never;
    expect(errorsOf(badUnit).join()).toMatch(/unit must be one of/);
  });

  it('prices a Suno sound effect per request', () => {
    expect(lookupMediaPrice(list, { model: 'suno/generate-sounds', options: {} })).toMatchObject({
      model: 'suno/generate-sounds',
      usd: 0.0125,
      unit: 'per_request',
    });
  });

  it('prices a Suno music track per request', () => {
    expect(lookupMediaPrice(list, { model: 'suno/generate-music', options: {} })?.usd).toBe(0.06);
  });

  it('scales speech with the character count', () => {
    const price = lookupMediaPrice(list, {
      model: 'elevenlabs/text-to-speech-multilingual-v2',
      options: {},
      textChars: 500,
    });
    expect(price?.usd).toBeCloseTo(0.03, 9); // $0.06 per 1,000 × 500
    expect(price?.unit).toBe('per_1k_chars');

    const turbo = lookupMediaPrice(list, {
      model: 'elevenlabs/text-to-speech-turbo-2-5',
      options: {},
      textChars: 1000,
    });
    expect(turbo?.usd).toBeCloseTo(0.03, 9);
  });

  it('refuses speech with no character count — the per_second rule', () => {
    expect(lookupMediaPrice(list, { model: 'elevenlabs/text-to-speech-multilingual-v2', options: {} })).toBeNull();
    expect(
      lookupMediaPrice(list, { model: 'elevenlabs/text-to-speech-multilingual-v2', options: {}, textChars: 0 }),
    ).toBeNull();
  });

  it('a short speech line costs a credit or two, not a full thousand characters worth', () => {
    const price = lookupMediaPrice(list, {
      model: 'elevenlabs/text-to-speech-multilingual-v2',
      options: {},
      textChars: 40,
    });

    expect(Math.ceil((price!.usd / 0.01) * 4.0)).toBe(1);
  });
});

/*
 * ------------------------------------------------------------------------------------------------ *
 * Media-only lists (media-gateways T2) — fal sells no LLM
 * ------------------------------------------------------------------------------------------------
 */

describe('media-only price lists (FAL)', () => {
  it('accepts a media-only FAL list with an empty llm table', () => {
    const result = validateMarketPriceList(BAKED_FAL_PRICES, 'FAL');

    expect(result.ok, result.ok ? '' : (result as { errors: string[] }).errors.join('; ')).toBe(true);
    expect(BAKED_FAL_PRICES.llm).toEqual({});
  });

  it('refuses a FAL list that carries llm rows', () => {
    const result = validateMarketPriceList(
      { ...BAKED_FAL_PRICES, llm: { [DEFAULT_MODEL]: { inputPerMTok: 2, outputPerMTok: 10 } } },
      'FAL',
    );

    expect(result.ok).toBe(false);
    expect((result as { errors: string[] }).errors.join(' ')).toMatch(/FAL is a media-only gateway/);
  });

  it('refuses a FAL list whose llm is not an object, naming it media-only', () => {
    const result = validateMarketPriceList({ ...BAKED_FAL_PRICES, llm: null }, 'FAL');

    expect((result as { errors: string[] }).errors.join(' ')).toMatch(/media-only/);
  });

  it('still refuses a KIE list with no llm rows (control)', () => {
    /*
     * The relaxation is per PROVIDER, never per list shape: the same empty-llm list that FAL accepts
     * must still be refused for an LLM gateway, with the existing errors, or a promotion could drop
     * every LLM row and refuse every generation the moment it went live.
     */
    const errors = errorsOf({ ...BAKED_MARKET_PRICES, llm: {} });

    expect(errors.join(' ')).toMatch(/llm must price at least one model/);
    expect(errors.join(' ')).toMatch(/must price the platform default model/);
  });

  it('does not treat the FAL list as valid for an LLM provider (control the other way)', () => {
    expect(validateMarketPriceList(BAKED_FAL_PRICES, 'Anthropic').ok).toBe(false);
  });

  it('declares exactly FAL as media-only, matched exactly', () => {
    expect([...MEDIA_ONLY_PRICE_PROVIDERS]).toEqual(['FAL']);
    expect(isMediaOnlyPriceProvider('FAL')).toBe(true);
    expect(isMediaOnlyPriceProvider('fal')).toBe(false);
    expect(isMediaOnlyPriceProvider('KIE')).toBe(false);
  });
});
