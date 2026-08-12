/**
 * Comet's baked price list — the money-path tests for `baked-comet-prices.ts` (T5, AC7/AC8).
 *
 * Everything asserted here fails SILENTLY in production. A price list cannot throw: a row that is
 * wrong by 20% settles a generation for the wrong number of credits, the ledger records it faithfully,
 * and the only symptom is a margin report nobody reads until the invoice arrives. So the assertions
 * are absolute pins plus an ARITHMETIC proof, and each one states which failure it stands in front of.
 *
 * ## 🔴 What this file exists for: `ratio` is PER ROW, and a constant would under-charge the newest models
 *
 * Comet's `GET /api/models` publishes `pricing.input`/`pricing.output` as the OFFICIAL VENDOR rate
 * (Anthropic's own $5/$25 for Opus 5) with a separate `pricing.ratio` that is the discount. **What
 * Comet charges is the product.** Measured on the live feed 2026-08-10: 276 rows, ratio distribution
 * `{0.8: 273, 1: 3}`. Folding a constant `0.8` into the capture would therefore be right 273 times and
 * wrong on exactly the three newest and most expensive models — silently, with the credit total moving
 * DOWN, which reads as a cheaper turn rather than as a defect.
 *
 * That is why `COMET_PRICE_PROVENANCE` records the three `ratio: 1` rows even though the price list
 * does not price them: **a test whose fixtures all carry 0.8 cannot fail when the ratio is replaced by
 * 0.8.** The AC8 mutation is precisely that edit, and `applies a ratio of 1 as no discount` is the
 * assertion that catches it. Do not "simplify" this file by dropping the ratio-1 cases — that is the
 * one change that makes the whole describe block vacuous while leaving it green.
 *
 * ## Two assertions per row, on purpose
 *
 * Every shipped row is checked TWICE: against `official x ratio` (does the arithmetic hold?) and
 * against a literal (was the capture right?). Neither alone is enough — a test that only recomputes the
 * production formula cannot notice the formula being wrong, and a test that only pins literals cannot
 * notice the ratio being dropped from a row added tomorrow.
 *
 * ⚠️ Env scrub is mandatory and is not theoretical here: this machine's `.env.local` carries a live
 * `COMET_API_KEY`, `LLM_MODEL=gpt-5-6-terra` and `PREMIUM_MODEL=gpt-5-6-sol`, and `env()` falls back to
 * `process.env` — the `oauth.spec.ts` trap, which has now fired four times in this repo.
 *
 * ⚠️ A price spec must never reach the network. `fetchCometMarketFeed` takes an API key and calls
 * global `fetch`; `beforeEach` installs a fetch that THROWS, so a test that forgets to stub fails
 * loudly instead of quietly POSTing a real credential to a real vendor from CI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL } from '~/utils/constants';
import { FAMILY_POLICY, familyOf } from '~/lib/modules/llm/model-families';
import { COMET_MODELS } from '~/lib/modules/llm/providers/comet-wire';
import { BAKED_COMET_PRICES, COMET_PRICE_PROVENANCE, cometChargedRate } from './baked-comet-prices';
import { BAKED_MARKET_PRICES } from './baked-market-prices';
import { fetchCometMarketFeed } from './market-feed';
import { findMediaModel, lookupMediaPrice, validateMarketPriceList, type MarketPriceList } from './market-prices';
import { invalidateMarketPricesCache } from './market-price-store';
import { cometRates, KIE_MODEL_RATES, MODEL_RATES } from './rates';

/**
 * Every variable a module in this file's import graph reads, scrubbed to `undefined`.
 *
 * ⚠️ The list covers the whole PRECEDENCE CHAIN, not just the variable under test — `billing.spec.ts`
 * records `KIE_ENV` scrubbing `KIE_DEFAULT_MODEL` but not the `LLM_MODEL` that outranks it, so a money
 * assertion failed on one developer's machine only, with CI green, blaming code they had not touched.
 *
 * The six retired price vars are here because `cometRates` calls `refuseRetiredPriceEnv` on every
 * invocation: a developer with one of them left in `.env.local` would see this file throw
 * `NotConfiguredError` and reasonably blame T5.
 */
const SCRUBBED_ENV = [
  'COMET_API_KEY',
  'COMET_BASE_URL',
  'LLM_PROVIDER',
  'LLM_MODEL',
  'PREMIUM_MODEL',
  'KIE_DEFAULT_MODEL',
  'KIE_INPUT_DOLLARS',
  'KIE_OUTPUT_DOLLARS',
  'KIE_CACHED_INPUT',
  'KIE_CACHED_WRITES',
  'PREMIUM_INPUT_DOLLARS',
  'PREMIUM_OUTPUT_DOLLARS',
] as const;

/** Any unstubbed `fetch` is a bug in the test, not a slow test. Fail loudly rather than dial out. */
const NO_NETWORK: typeof fetch = async (input) => {
  throw new Error(`a spec reached the network: ${typeof input === 'string' ? input : String(input)}`);
};

beforeEach(() => {
  for (const key of SCRUBBED_ENV) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  /*
   * The active-list cache is module state shared with any other spec in this worker. Clearing it means
   * `cometRates()` below reads the BAKED list — the thing this file is about — rather than whatever a
   * neighbouring test happened to promote. No ObjectStore is touched: `activeMarketPrices` is a pure
   * map read, and `ensureMarketPrices` (the one that reaches storage) is never called here.
   */
  invalidateMarketPricesCache();
  vi.stubGlobal('fetch', NO_NETWORK);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  invalidateMarketPricesCache();
});

/*
 * ------------------------------------------------------------------------------------------------ *
 * AC8 — the charged rate is `official x ratio`, and the ratio is read PER ROW
 * ------------------------------------------------------------------------------------------------
 */

describe('the charged rate is official x ratio, per row (AC8)', () => {
  /*
   * 🔴 Iterated over the PRICE LIST'S OWN KEYS, never over the provenance table's.
   *
   * Looping the other way round would pass for a row that was priced with no recorded provenance — the
   * failure mode is "someone added a row from Comet's marketing page", which is exactly what the
   * provenance table exists to make impossible. This way a row with no provenance FAILS rather than
   * being skipped, and the provenance table is allowed to carry extra rows (it deliberately does).
   */
  it('derives every shipped rate from its own recorded official rate and ratio', () => {
    const rows = Object.entries(BAKED_COMET_PRICES.llm);

    /* A `for` loop over an empty object asserts nothing at all — pin that there is something to check. */
    expect(rows.length, 'the price list must actually price something').toBe(8);

    for (const [model, rate] of rows) {
      const provenance = COMET_PRICE_PROVENANCE[model];

      expect(
        provenance,
        `${model} is priced with no recorded provenance — every row must state the official rate and ` +
          'the ratio it was captured from, or nothing can tell a probe from a guess',
      ).toBeDefined();

      expect(provenance.officialInputPerMTok, `${model} has no official input rate`).not.toBeNull();
      expect(provenance.officialOutputPerMTok, `${model} has no official output rate`).not.toBeNull();

      expect(rate.inputPerMTok, `${model} input: ${provenance.officialInputPerMTok} x ${provenance.ratio}`).toBe(
        cometChargedRate(provenance.officialInputPerMTok!, provenance.ratio),
      );
      expect(rate.outputPerMTok, `${model} output: ${provenance.officialOutputPerMTok} x ${provenance.ratio}`).toBe(
        cometChargedRate(provenance.officialOutputPerMTok!, provenance.ratio),
      );
    }
  });

  /*
   * 🔴 THE AC8 MUTATION TARGET. Replace `ratio` with a constant `0.8` inside `cometChargedRate` and
   * THIS is the test that fails — every shipped row carries 0.8, so the assertion above stays green.
   *
   * The three `ratio: 1` rows are real feed rows (`minimax-h3`, `seedance-2-5`,
   * `seedream-5-0-pro-260628`, captured 2026-08-10) and they are the newest, most expensive models
   * Comet resells. Under a constant 0.8 they would be billed at 80% of what we are actually charged:
   * a 20% loss on the priciest work, with no error, no failing test, and the credit total moving DOWN.
   *
   * Both directions are pinned — 0.8 must still discount — because a mutation the other way (a constant
   * `1`) would over-charge every ordinary generation by 25% and is just as silent.
   */
  it('applies a ratio of 1 as no discount — the rows a constant 0.8 would under-charge', () => {
    const undiscounted = Object.entries(COMET_PRICE_PROVENANCE).filter(([, p]) => p.ratio === 1);

    expect(
      undiscounted.map(([id]) => id),
      'the ratio-1 counter-examples must exist, or every assertion in this describe is vacuous',
    ).toEqual(['minimax-h3', 'seedance-2-5', 'seedream-5-0-pro-260628']);

    for (const [model, provenance] of undiscounted) {
      expect(cometChargedRate(25, provenance.ratio), `${model} carries no discount`).toBe(25);
      expect(cometChargedRate(0.42, provenance.ratio), `${model} carries no discount`).toBe(0.42);
    }

    /* CONTROL, the other direction: a 0.8 row must still be discounted, or a constant `1` passes. */
    const discounted = COMET_PRICE_PROVENANCE[DEFAULT_MODEL];

    expect(discounted.ratio).toBe(0.8);
    expect(cometChargedRate(25, discounted.ratio)).toBe(20);
  });

  /*
   * The provenance table is only EVIDENCE if it disagrees with itself somewhere. A table where every
   * row carried the same ratio would be indistinguishable from a constant, and the test above would be
   * measuring nothing while looking thorough.
   */
  it('records more than one ratio — a single-valued table is a constant wearing a data structure', () => {
    const ratios = new Set(Object.values(COMET_PRICE_PROVENANCE).map((p) => p.ratio));

    expect([...ratios].sort()).toEqual([0.8, 1]);

    for (const [model, p] of Object.entries(COMET_PRICE_PROVENANCE)) {
      expect(Number.isFinite(p.ratio) && p.ratio > 0, `${model} has an unusable ratio`).toBe(true);
    }
  });

  /*
   * Two decimals, and the reason is not cosmetic: `0.3 * 0.8` is `0.24000000000000002` in binary
   * floating point, so an unrounded capture would put a 17-significant-figure number in a price list
   * that an admin can read, edit and promote — and the row's own literal would never compare equal to
   * the arithmetic that produced it, which is the pairing this whole file rests on.
   */
  it('rounds to two decimals, so the arithmetic and the shipped literal can be compared at all', () => {
    expect(cometChargedRate(0.3, 0.8)).toBe(0.24);
    expect(BAKED_COMET_PRICES.llm['qwen3-coder'].inputPerMTok).toBe(0.24);
    expect(cometChargedRate(1.425, 0.8)).toBe(1.14);
  });

  /*
   * The capture itself, pinned as literals.
   *
   * ⚠️ This is the half the arithmetic test CANNOT give you: `official x ratio` holds for any pair of
   * numbers, so a row captured from the wrong feed entry would satisfy it perfectly. These are the
   * rates every Comet generation settles at, from the live probe recorded in
   * `_specs/cometapi-provider_spec.md`, and two of them are independently anchored — `claude-opus-5`
   * at official $5/$25 is Anthropic's exact list price, and $4/$20 matches Comet's own published
   * "-20%" table to the cent.
   */
  it('pins every shipped rate absolutely — the arithmetic cannot tell a wrong row from a right one', () => {
    expect(BAKED_COMET_PRICES.llm).toEqual({
      'claude-sonnet-5': { inputPerMTok: 1.6, outputPerMTok: 8.0 },
      'claude-opus-5': { inputPerMTok: 4.0, outputPerMTok: 20.0 },
      'claude-opus-4-8': { inputPerMTok: 4.0, outputPerMTok: 20.0 },
      'claude-fable-5': { inputPerMTok: 8.0, outputPerMTok: 40.0 },
      'grok-4.5': { inputPerMTok: 1.6, outputPerMTok: 4.8 },
      'kimi-k3': { inputPerMTok: 2.4, outputPerMTok: 12.0 },
      'qwen3-coder': { inputPerMTok: 0.24, outputPerMTok: 0.96 },

      /*
       * The DATED haiku, and the only spelling of Haiku 4.5 this gateway can bill (2026-08-11). The bare
       * `claude-haiku-4-5` is a hard 400 here and stays unpriced; `COMET_ENHANCE_PROMPT_MODEL` exists
       * precisely because `getEnhancerModel` REFUSES a model this table cannot price, so the row and the
       * per-gateway env key ship together — one without the other is a 503 on the ✨ button.
       */
      'claude-haiku-4-5-20251001': { inputPerMTok: 0.8, outputPerMTok: 4.0 },
    });
  });
});

/*
 * ------------------------------------------------------------------------------------------------ *
 * The promotion wall, applied to the second marketplace's fallback
 * ------------------------------------------------------------------------------------------------
 */

describe('validation — the baked list is served without ever passing the wall', () => {
  /*
   * A baked list its own validator refuses is a uniquely bad state: `promoteMarketPrices` validates
   * before writing and `loadVersion` re-validates on read, but the BAKED table is what is served when
   * neither of those ran. An invalid one does not fail loudly — it becomes the prices charged forever.
   */
  it('accepts BAKED_COMET_PRICES and prices the platform default', () => {
    const result = validateMarketPriceList(BAKED_COMET_PRICES);

    expect(result.ok, result.ok ? '' : (result as { errors: string[] }).errors.join('; ')).toBe(true);

    /*
     * `ratesFor` bills an unpriced model at the MOST EXPENSIVE row, which on this list is fable-5 at
     * 5x the default's input rate. A list missing the default row would therefore not fail — it would
     * quietly bill every ordinary generation at the priciest rung on this provider only.
     */
    expect(BAKED_COMET_PRICES.llm[DEFAULT_MODEL], `${DEFAULT_MODEL} is unpriced on Comet`).toBeDefined();
    expect(BAKED_COMET_PRICES.llm[DEFAULT_MODEL].inputPerMTok).toBeGreaterThan(0);
    expect(BAKED_COMET_PRICES.llm[DEFAULT_MODEL].outputPerMTok).toBeGreaterThan(0);
  });

  /*
   * The family rule is a property of the MODEL ID, not of the marketplace: Comet quotes no cached rate
   * for anything, so a `claude-*` row derives (0.1x read / 2.0x the 1h write) and the pair is refused
   * on the way in. A quoted number would be a second opinion about a derived one, and the two WILL
   * drift — the `packMargin()` shape, two locally-sensible numbers disagreeing about one cost.
   */
  it('refuses a cache key on a Comet claude row', () => {
    const list: MarketPriceList = {
      ...BAKED_COMET_PRICES,
      llm: {
        ...BAKED_COMET_PRICES.llm,
        [DEFAULT_MODEL]: { ...BAKED_COMET_PRICES.llm[DEFAULT_MODEL], cachedInputPerMTok: 0.16 },
      },
    };

    const result = validateMarketPriceList(list);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.errors.join()).toMatch(/cache rates derive/i);

    /* CONTROL: the same list WITHOUT the quote is accepted, so the refusal is about the cache key. */
    expect(validateMarketPriceList(BAKED_COMET_PRICES).ok).toBe(true);
  });

  /*
   * The `chat` family (FR3) is the row shape T5 introduced, and it is accepted with the BASE PAIR ONLY.
   *
   * `cacheProfile: 'none'` — no vendor quotes a cached rate for grok/kimi/qwen and their wires report
   * no cached-token counter, so cached tokens bill at the FULL input rate. Deliberately not a discount:
   * we do not grant one we cannot verify. The trap this guards is the neighbouring `codex` family,
   * which shares the same WIRE on this provider but REQUIRES both cache keys — collapsing the two
   * would price a Grok row on GPT's cache economics.
   */
  it('accepts a chat-family row carrying only the base pair, and refuses one carrying a cache key', () => {
    expect(familyOf('grok-4.5'), 'the row this test is about must be a chat row').toBe('chat');
    expect(FAMILY_POLICY.chat.cacheProfile).toBe('none');

    /* The shipped list already contains three such rows and validates — that is the accept case. */
    expect(validateMarketPriceList(BAKED_COMET_PRICES).ok).toBe(true);
    expect(BAKED_COMET_PRICES.llm['grok-4.5']).toEqual({ inputPerMTok: 1.6, outputPerMTok: 4.8 });

    const quoted = validateMarketPriceList({
      ...BAKED_COMET_PRICES,
      llm: {
        ...BAKED_COMET_PRICES.llm,
        'grok-4.5': { inputPerMTok: 1.6, outputPerMTok: 4.8, cacheWritePerMTok: 3.2 },
      },
    });

    expect(quoted.ok).toBe(false);
    expect(quoted.ok ? '' : quoted.errors.join()).toMatch(/no vendor quotes a cached rate/i);
  });

  /*
   * An EMPTY media table is valid and is the correct state today (Comet media lands in T8).
   * `lookupMediaPrice` has NO most-expensive fallback — media debits run BEFORE spend — so an unpriced
   * media model is REFUSED rather than guessed, and a speculative row is the one shape that would turn
   * that refusal into a wrong charge on a render nobody asked for.
   */
  it('accepts an empty media table, and does not ship one', () => {
    /*
     * T8 filled this table, so the property under test moved: what still matters is that an EMPTY
     * media table validates — an operator promoting a list with no media rows must get a refusal at
     * generation time (`lookupMediaPrice` has no fallback), never a rejected promotion.
     */
    expect(validateMarketPriceList({ ...BAKED_COMET_PRICES, media: {} }).ok).toBe(true);

    // ...and the shipped list DOES carry rows now, so the assertion above is not passing by vacuity.
    expect(Object.keys(BAKED_COMET_PRICES.media).length).toBeGreaterThan(0);
  });
});

/*
 * ------------------------------------------------------------------------------------------------ *
 * MEDIA (§4.16, T8) — the rows a debit is taken from BEFORE anything renders
 * ------------------------------------------------------------------------------------------------
 */

/**
 * Comet's media rows are DERIVED, not quoted: every serveable image model on this gateway is
 * token-priced, and a media debit runs before the spend from an EXACT number, so a per-token rate has
 * to become a flat number per priced variant. That is only safe because the platform controls the two
 * fields that decide the token count — and only for the six cells that were actually measured.
 *
 * 🔴 The rule that makes omitting an unmeasured cell SAFE rather than dangerous is that
 * `lookupMediaPrice` has **no most-expensive fallback**: an unlisted `(quality, aspectRatio)` pair
 * returns null and the request is refused. Assert both halves, or "we only priced six cells" turns
 * into "everything else is billed off a neighbouring cell", silently.
 */
describe('the media rows (§4.16)', () => {
  const IMAGE_CELLS: Array<[Record<string, string>, number]> = [
    [{ quality: 'low', aspectRatio: '1:1' }, 0.029],
    [{ quality: 'medium', aspectRatio: '1:1' }, 0.049],
    [{ quality: 'high', aspectRatio: '1:1' }, 0.129],
    [{ quality: 'low', aspectRatio: '16:9' }, 0.032],
    [{ quality: 'medium', aspectRatio: '16:9' }, 0.062],
    [{ quality: 'high', aspectRatio: '16:9' }, 0.181],
  ];

  it('validates with the media table populated', () => {
    // A baked list its own validator refuses becomes the prices charged forever, silently.
    const result = validateMarketPriceList(BAKED_COMET_PRICES);

    expect(result.ok, result.ok ? '' : (result as { errors: string[] }).errors.join('; ')).toBe(true);
  });

  it.each(IMAGE_CELLS)('prices gpt-image-1.5 %j at $%s', (options, usd) => {
    expect(lookupMediaPrice(BAKED_COMET_PRICES, { model: 'gpt-image-1.5', options })).toMatchObject({
      model: 'gpt-image-1.5',
      usd,
    });
  });

  it('prices every cell DIFFERENTLY across quality (control)', () => {
    /*
     * ⚠️ Without this the block above passes for a lookup that returns the same row for everything —
     * the subset match makes that a genuinely reachable bug, since `{}` matches every query.
     */
    const prices = IMAGE_CELLS.map(
      ([options]) => lookupMediaPrice(BAKED_COMET_PRICES, { model: 'gpt-image-1.5', options })?.usd,
    );

    expect(new Set(prices).size).toBe(IMAGE_CELLS.length);
  });

  it.each([
    [{ quality: 'ultra', aspectRatio: '16:9' }],
    [{ quality: 'medium', aspectRatio: '9:16' }],
    [{ quality: 'medium', aspectRatio: '4:3' }],
    [{}],
  ])('REFUSES the unmeasured cell %j rather than pricing it off a neighbour', (options) => {
    /*
     * The `{}` case is the interesting one: `gpt-image-1.5` has no catch-all variant, so a request that
     * reached the lookup without normalised options is refused rather than silently billed at the
     * cheapest cell. `providerImageOptions` is what supplies the defaults, and this is what happens if
     * it ever stops.
     */
    expect(lookupMediaPrice(BAKED_COMET_PRICES, { model: 'gpt-image-1.5', options })).toBeNull();
  });

  it('prices the cheap opaque workhorse with a single catch-all variant', () => {
    /*
     * `gemini-3-pro-image` takes no size/quality knobs on this wire, so one row is correct — and it has
     * NO alpha and returns image/jpeg whatever is asked for, which is why a transparent request never
     * resolves to it (`media/image-capabilities.ts`).
     */
    expect(lookupMediaPrice(BAKED_COMET_PRICES, { model: 'gemini-3-pro-image', options: {} })?.usd).toBe(0.017);
    expect(
      lookupMediaPrice(BAKED_COMET_PRICES, { model: 'gemini-3-pro-image', options: { quality: 'high' } })?.usd,
    ).toBe(0.017);
  });

  it.each([
    ['veo3-fast', 4, 0.32],
    ['veo3-fast', 8, 0.64],
    ['veo3', 4, 1.28],
  ])('prices %s per second: %is = $%s', (model, durationSeconds, usd) => {
    const price = lookupMediaPrice(BAKED_COMET_PRICES, { model, options: {}, durationSeconds });

    expect(price?.usd).toBeCloseTo(usd, 9);
  });

  it('refuses a per-second row with NO duration — that is not a price', () => {
    // Assuming a duration would bill a number nobody quoted, on a row whose whole unit is time.
    expect(lookupMediaPrice(BAKED_COMET_PRICES, { model: 'veo3-fast', options: {} })).toBeNull();
  });

  it('has NO cut-out row, which is why transparency here is a native-model decision', () => {
    /*
     * KIE's entire transparency capability is `recraft/remove-background`. Comet has none, and gets
     * alpha from `gpt-image-1.5` in one call instead — so a row appearing here would make the service
     * offer a two-stage chain the gateway cannot run.
     */
    expect(BAKED_COMET_PRICES.media['recraft/remove-background']).toBeUndefined();

    /* CONTROL: the incumbent list DOES carry it, so the assertion is about Comet, not about the key. */
    expect(BAKED_MARKET_PRICES.media['recraft/remove-background']).toBeDefined();
  });

  it('never leaves an image model unpriced-but-listed, in either direction', () => {
    /*
     * Every media row must be reachable by `findMediaModel` under its own id — a row keyed one way and
     * looked up another is priced-but-not-listed wearing media clothes, and media has no fallback to
     * catch it.
     */
    for (const id of Object.keys(BAKED_COMET_PRICES.media)) {
      expect(findMediaModel(BAKED_COMET_PRICES, id), `${id} is not findable by its own id`).not.toBeNull();
    }
  });
});

/*
 * ------------------------------------------------------------------------------------------------ *
 * FR4 — what ships, and the one id that does not
 * ------------------------------------------------------------------------------------------------
 */

describe('the shipped ids (FR4)', () => {
  /*
   * 🔴 `claude-haiku-4-5` IS ABSENT FROM BOTH THE MODEL LIST AND THE PRICE LIST, AND THAT IS A FINDING,
   * NOT AN OVERSIGHT.
   *
   * `_specs/cometapi-provider_spec.md` listed it among the five live-probed ids. The T5 re-probe
   * (`POST /v1/messages`, `max_tokens: 1`, 2026-08-10) returned a hard **400**:
   *
   *     {"error":{"type":"comet_api_error",
   *               "message":"model claude-haiku-4-5 has not been priced by the administrator yet…"}}
   *
   * while `claude-haiku-4-5-20251001` — the DATED id, which SPEC §4.2a's model table forbids on
   * Anthropic because the dated-snapshot scheme 404s there — answered 200. Comet's feed also reports
   * its output cap as 8K against the 64K this platform uses for Haiku elsewhere, and overshooting an
   * output cap is itself a hard 400. So adopting the id would mean adopting two unverified numbers.
   *
   * This is pinned as an ABSENCE precisely because the absence looks like an omission: the obvious
   * "helpful" edit is to add the row back from the spec's own table, and that edit ships a model that
   * 400s on its first generation while the operator believes it is configured. Re-adding it requires
   * probing the dated id AND its real output cap, in the same edit — not this test being deleted.
   */
  it('ships no claude-haiku-4-5 row — it is a hard 400 on this provider', () => {
    expect(COMET_MODELS.map((m) => m.name)).not.toContain('claude-haiku-4-5');
    expect(BAKED_COMET_PRICES.llm['claude-haiku-4-5'], 'a 400ing model must not be priced').toBeUndefined();
    expect(COMET_PRICE_PROVENANCE['claude-haiku-4-5']).toBeUndefined();

    /*
     * CONTROL — without this, "haiku is absent" passes just as well for an EMPTY model list, i.e. for
     * the far worse regression of shipping no models at all. The four ids that DID answer 200 must be
     * present, and the dated id must not have been quietly substituted for the bare one.
     */
    expect(COMET_MODELS.map((m) => m.name)).toEqual([
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-fable-5',
    ]);
    expect(COMET_MODELS.map((m) => m.name)).not.toContain('claude-haiku-4-5-20251001');
  });

  /*
   * 🔴 Every model the provider OFFERS must be priced by the provider's own list — the KIE analogue
   * (`kie.spec.ts`, "prices every model it offers"), which was explicitly deferred to T5 and is now due.
   *
   * `ratesFor` falls back to the MOST EXPENSIVE row for an unknown model, so an offered-but-unpriced id
   * does not fail: it bills at fable-5's $8/$40 forever. That is 5x the default's input rate, charged to
   * the user, with nothing throwing.
   */
  it('prices every model it offers — an unpriced offered model bills at the most expensive row', () => {
    expect(COMET_MODELS.length, 'an empty model list would satisfy this loop trivially').toBeGreaterThan(0);

    for (const model of COMET_MODELS) {
      expect(BAKED_COMET_PRICES.llm[model.name], `${model.name} is offered on Comet but has no rate row`).toBeDefined();
    }
  });

  /*
   * The CONVERSE is deliberately NOT true, and saying so here stops the next reader "fixing" it.
   *
   * The three `chat` rows are priced and NOT listed: they exist so the cheap fixed utilities have
   * somewhere to go (`ENHANCE_PROMPT_MODEL` — qwen3-coder is a fortieth of Opus 5's input rate for a
   * task that rewrites ≤10k characters of English). `getPlatformModel` refuses a model the active list
   * cannot price, so pricing one an operator has not selected costs nothing; LISTING one we have not
   * probed as a serving id is what ships a 404. Priced-and-unlisted is safe in exactly the direction
   * that listed-and-unpriced is not.
   */
  it('prices three chat models it does not offer — the safe direction of the same asymmetry', () => {
    const listed = COMET_MODELS.map((m) => m.name);

    for (const id of ['grok-4.5', 'kimi-k3', 'qwen3-coder']) {
      expect(BAKED_COMET_PRICES.llm[id], `${id} must be priceable`).toBeDefined();
      expect(listed, `${id} must NOT be advertised as a serving id`).not.toContain(id);
      expect(familyOf(id)).toBe('chat');
    }
  });
});

/*
 * ------------------------------------------------------------------------------------------------ *
 * `cometRates` — the family cache rule meeting the new list
 * ------------------------------------------------------------------------------------------------
 */

describe('cometRates — cache rates by FAMILY, off the Comet list', () => {
  /*
   * 🔴 Getting these two backwards is a silent mis-bill in both directions at once.
   *
   * A `claude-*` row DERIVES its cache rates (0.1x read / 2.0x the 1-hour write, off its own charged
   * input rate) — measured on Comet's Messages wire, which returns real cached-token counters. A
   * `chat` row derives NOTHING: read = write = full input, because Comet quotes no cached rate for
   * grok/kimi/qwen and those wires report no cached-token counter. Swap them and a warm Claude edit
   * bills 10x what it should while every Grok turn bills a discount we cannot observe — neither throws.
   */
  it('derives 0.1x / 2.0x for a claude row and bills a chat row at full input', () => {
    const rates = cometRates();

    const sonnet = rates[DEFAULT_MODEL];
    expect(sonnet, 'the platform default must be priced on Comet').toBeDefined();
    expect(sonnet.inputPerMTok).toBe(1.6);
    expect(sonnet.outputPerMTok).toBe(8.0);
    expect(sonnet.cacheReadPerMTok).toBeCloseTo(0.16, 10);
    expect(sonnet.cacheWritePerMTok).toBe(3.2);

    /* The read must be a real discount and the write a real surcharge — not merely "some number". */
    expect(sonnet.cacheReadPerMTok).toBeLessThan(sonnet.inputPerMTok);
    expect(sonnet.cacheWritePerMTok).toBeGreaterThan(sonnet.inputPerMTok);

    const grok = rates['grok-4.5'];
    expect(grok, 'the chat rows must be priceable through the Comet list').toBeDefined();
    expect(grok.inputPerMTok).toBe(1.6);
    expect(grok.outputPerMTok).toBe(4.8);
    expect(grok.cacheReadPerMTok, 'cacheProfile none: cached tokens bill at the full input rate').toBe(1.6);
    expect(grok.cacheWritePerMTok, 'cacheProfile none: a write is not a surcharge either').toBe(1.6);
  });

  /* Every row on the list reaches the rate table — a dropped row bills at the most expensive one. */
  it('turns every list row into a rate row', () => {
    const rates = cometRates();

    expect(Object.keys(rates).sort()).toEqual(Object.keys(BAKED_COMET_PRICES.llm).sort());
  });
});

/*
 * ------------------------------------------------------------------------------------------------ *
 * AC7 — the control: nothing else moved
 * ------------------------------------------------------------------------------------------------
 */

describe('AC7 control — the existing rate tables are untouched', () => {
  /*
   * 🔴 OQ1, resolved: `MODEL_RATES['claude-sonnet-5']` stays at the STANDARD $3/$15 even though Comet's
   * feed reports Anthropic's official rate as $2/$10.
   *
   * That $2/$10 is INTRODUCTORY pricing expiring 2026-08-31 (`rates.ts`), and seeding it would compress
   * margin below target the day it lapses with nothing failing — the invoices would just get bigger.
   * Comet's feed agreeing with the intro rate is evidence that comment is CORRECT, not evidence this
   * row is stale, and the two tables disagreeing is right because they price two different vendors.
   * Pinned here so the T5 capture cannot be mistaken for a licence to "align" them.
   */
  it('leaves the Anthropic table alone — the intro-vs-standard decision is deliberate', () => {
    expect(MODEL_RATES['claude-sonnet-5']).toEqual({
      inputPerMTok: 3.0,
      outputPerMTok: 15.0,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 6.0,
    });
    expect(MODEL_RATES['claude-opus-5'].inputPerMTok).toBe(5.0);
    expect(MODEL_RATES['claude-opus-5'].outputPerMTok).toBe(25.0);

    /* Anthropic is not a marketplace: the Comet capture must not have leaked a row into it. */
    expect(MODEL_RATES['grok-4.5']).toBeUndefined();
  });

  /*
   * KIE's baked table is what every existing deployment settles against. The Comet rows are ~2x KIE's
   * for the same model ids, so a leak in either direction produces a plausible number rather than an
   * error — the exact failure `activeMarketPrices(provider)` was made to take a required argument for.
   */
  it('leaves the KIE table alone, and shares no row with the Comet capture', () => {
    expect(KIE_MODEL_RATES['claude-sonnet-5'].inputPerMTok).toBe(0.85);
    expect(KIE_MODEL_RATES['claude-sonnet-5'].outputPerMTok).toBe(4.275);
    expect(KIE_MODEL_RATES['claude-opus-5'].inputPerMTok).toBe(2.0);
    expect(KIE_MODEL_RATES['claude-fable-5'].inputPerMTok).toBe(4.0);

    /* The chat rows are a Comet capture and must not have been written into KIE's list. */
    for (const id of ['grok-4.5', 'kimi-k3', 'qwen3-coder']) {
      expect(BAKED_MARKET_PRICES.llm[id], `${id} must not have leaked into the KIE list`).toBeUndefined();
    }

    /* CONTROL: the two lists really do price the same ids, so "different" above is a price, not a gap. */
    expect(BAKED_MARKET_PRICES.llm['claude-sonnet-5'].inputPerMTok).not.toBe(
      BAKED_COMET_PRICES.llm['claude-sonnet-5'].inputPerMTok,
    );
  });
});

/*
 * ------------------------------------------------------------------------------------------------ *
 * `fetchCometMarketFeed` — the operator's comparison view, never machine-applied
 * ------------------------------------------------------------------------------------------------
 */

/** One raw feed record, shaped exactly as Comet returns it (`pricing` is the OFFICIAL rate). */
function feedRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'claude-opus-5',
    code: 'claude-opus-5',
    name: 'Claude Opus 5',
    model_type: 'claude',
    pricing: { input: 5, output: 25, ratio: 0.8 },
    context_length: 1000000,
    max_completion_tokens: 128000,
    ...overrides,
  };
}

/**
 * Stub the feed with an ALREADY-PARSED body, bypassing JSON serialization.
 *
 * ⚠️ This exists for exactly one reason and it is not convenience: `JSON.stringify(NaN)` is `"null"`,
 * so a `ratio: NaN` fixture pushed through `stubFeed` arrives at the production code as `null` — which
 * the `typeof === 'number'` guard rejects long before `charged()` is reached. The NaN test would then
 * pass just as happily against a `charged()` that never finite-checks anything, i.e. it would be a
 * test of the wrong thing that goes green on the regression it is named for.
 *
 * Only `ok`, `status` and `json()` are read by `fetchCometMarketFeed`, so a minimal double is honest
 * here rather than a mock of a shape the code never touches.
 */
function stubParsedFeed(json: unknown) {
  const spy = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => json,
    }) as unknown as Response) as unknown as typeof fetch;

  vi.stubGlobal('fetch', spy);
}

/** Stub the feed endpoint and capture what was sent. The `NO_NETWORK` guard is replaced per test. */
function stubFeed(body: unknown, init?: ResponseInit) {
  const seen: { url?: string; headers?: Record<string, string> } = {};

  const spy: typeof fetch = async (input, requestInit) => {
    seen.url = typeof input === 'string' ? input : String(input);
    seen.headers = Object.fromEntries(new Headers(requestInit?.headers ?? {}).entries());

    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
      ...init,
    });
  };

  vi.stubGlobal('fetch', spy);

  return seen;
}

describe('fetchCometMarketFeed', () => {
  /*
   * The whole point of the row shape: an operator comparing the promoted list against the feed must see
   * the CHARGED number, because that is what the price list stores. Reading `pricing.input` as the
   * charged rate is the mistake that produced "no discount on Opus 5" on the first pass of this
   * investigation — with all three fields present, the panel can show the arithmetic instead of a
   * number whose meaning has to be remembered.
   */
  it('computes charged = official x ratio for every row, keeping all three numbers', async () => {
    const seen = stubFeed({
      data: [
        feedRecord(),
        feedRecord({ id: 'seedance-2-5', pricing: { input: 12, output: 60, ratio: 1 } }),
        feedRecord({ id: 'qwen3-coder', pricing: { input: 0.3, output: 1.2, ratio: 0.8 } }),
      ],
    });

    const result = await fetchCometMarketFeed('comet-test-key');

    expect(result.rows.map((r) => [r.id, r.chargedInputPerMTok, r.chargedOutputPerMTok])).toEqual([
      ['claude-opus-5', 4, 20],

      /* ratio 1 — undiscounted, the same per-row rule the baked capture rests on. */
      ['seedance-2-5', 12, 60],

      /* rounded: 0.3 x 0.8 is 0.24000000000000002 in binary. */
      ['qwen3-coder', 0.24, 0.96],
    ]);

    /* The official rates survive alongside, or the panel cannot show why the charged number is what it is. */
    expect(result.rows[0].officialInputPerMTok).toBe(5);
    expect(result.rows[0].officialOutputPerMTok).toBe(25);
    expect(result.rows[0].ratio).toBe(0.8);

    /* It really did go through the stub — and to Comet, with the caller's key as a Bearer token. */
    expect(seen.url).toBe('https://api.cometapi.com/api/models');
    expect(seen.headers?.authorization).toBe('Bearer comet-test-key');
  });

  /*
   * Comet prices media per-second and per-request, so plenty of rows carry no per-MTok number at all —
   * and a missing `pricing` object is an ordinary state, not an outage. `null` must survive as `null`:
   * a `0` here would be a PRICE (and `isPrice` refuses zero for exactly that reason), and a `NaN` would
   * render as a blank cell that looks like a free model.
   */
  it('tolerates unpriced rows — null stays null, and never becomes zero or NaN', async () => {
    stubFeed({
      data: [
        feedRecord({ id: 'no-pricing-at-all', pricing: undefined }),
        feedRecord({ id: 'ratio-only', pricing: { ratio: 0.8 } }),
        feedRecord({ id: 'no-ratio', pricing: { input: 5, output: 25 } }),
      ],
    });

    const [none, ratioOnly, noRatio] = (await fetchCometMarketFeed('k')).rows;

    expect([none.officialInputPerMTok, none.ratio, none.chargedInputPerMTok]).toEqual([null, null, null]);
    expect([ratioOnly.officialInputPerMTok, ratioOnly.chargedInputPerMTok]).toEqual([null, null]);
    expect([noRatio.officialInputPerMTok, noRatio.ratio, noRatio.chargedInputPerMTok]).toEqual([5, null, null]);
  });

  /*
   * 🔴 A row whose `pricing` numbers are non-finite must come back as `null`, NOT as `NaN`.
   *
   * `NaN` is `typeof 'number'`, so it walks straight past the `typeof r.pricing?.ratio === 'number'`
   * guard and into the arithmetic, and `NaN` renders as a BLANK CELL — indistinguishable from a free
   * model, on the screen an operator uses to decide what to charge. Nothing throws; the row simply
   * stops having a price and starts looking like it never had one.
   *
   * ⚠️ BOTH operands are asserted, and the asymmetric case is the load-bearing half: a `charged()` that
   * finite-checks only `official` passes the ratio-NaN case by accident on every row where the official
   * rate is ALSO missing, so the fixture below pairs a NaN input with a perfectly good output — the
   * output must still compute while the input goes null, which a single-operand check cannot produce.
   *
   * The Infinity case is the wire-reachable one: `JSON.parse('{"input":1e999}')` yields `Infinity`, so
   * an overflowing number in a third party's feed reaches this function without anyone doing anything
   * unusual. `Number.isFinite` is the check that covers both, which is why it is the check.
   */
  it('turns a non-finite rate or ratio into null, never NaN — a blank cell reads as a free model', async () => {
    stubParsedFeed({
      data: [
        feedRecord({ id: 'nan-ratio', pricing: { input: 5, output: 25, ratio: NaN } }),
        feedRecord({ id: 'nan-input', pricing: { input: NaN, output: 25, ratio: 0.8 } }),
        feedRecord({ id: 'infinite-ratio', pricing: { input: 5, output: 25, ratio: Infinity } }),
      ],
    });

    const [nanRatio, nanInput, infiniteRatio] = (await fetchCometMarketFeed('k')).rows;

    /* A NaN ratio poisons BOTH charged rates, and the official numbers survive so the panel can say why. */
    expect([nanRatio.chargedInputPerMTok, nanRatio.chargedOutputPerMTok]).toEqual([null, null]);
    expect(nanRatio.officialInputPerMTok, 'the official rate is still known — only the product is not').toBe(5);

    /*
     * 🔴 The asymmetric row. A finite-check on `official` alone yields `[null, 20]` here too, so this
     * pair alone is not enough — it is the ratio row above PLUS this one that pins both operands.
     */
    expect(nanInput.chargedInputPerMTok, 'a NaN official rate is unpriceable').toBeNull();
    expect(nanInput.chargedOutputPerMTok, 'a good output rate must still compute: 25 x 0.8').toBe(20);

    expect([infiniteRatio.chargedInputPerMTok, infiniteRatio.chargedOutputPerMTok]).toEqual([null, null]);

    /*
     * CONTROL: an ordinary row through this same stub still prices. Without it, every assertion above
     * passes for a `charged()` that returns `null` unconditionally — the silent way to make a NaN bug
     * go green while un-pricing the entire catalogue.
     */
    stubParsedFeed({ data: [feedRecord()] });
    expect((await fetchCometMarketFeed('k')).rows[0].chargedInputPerMTok).toBe(4);
  });

  /*
   * The filter is the operator's search box. Case-insensitive because Comet's own ids and display codes
   * mix cases, and matched against `id` — the string the price list is keyed by.
   *
   * ⚠️ `reportedTotal` counts what the feed RETURNED, not what survived the filter, so the panel can
   * honestly say "3 of 276". Collapsing the two would make a narrow filter look like a short read.
   */
  it('filters on id, case-insensitively, without changing the reported total', async () => {
    stubFeed({
      data: [feedRecord(), feedRecord({ id: 'grok-4.5' }), feedRecord({ id: 'kimi-k3' })],
    });

    const result = await fetchCometMarketFeed('k', { filter: 'GROK' });

    expect(result.rows.map((r) => r.id)).toEqual(['grok-4.5']);
    expect(result.reportedTotal, 'the total is what the feed returned, not what matched').toBe(3);
    expect(result.fetchedAt, 'staleness is shown in the panel and must always be stated').toBeTruthy();
  });

  /*
   * 🔴 THE FILTER MATCHES `id` OR `code`, AND THE TEST ABOVE CANNOT SEE THE SECOND HALF — its fixture's
   * `code` equals its `id`, so it is green against an `id`-only filter.
   *
   * Comet's feed carries rows where the two DISAGREE: `grok-4.5` is published under the display code
   * `grok-4-5`, which is the string Comet shows in its own UI and therefore the string an operator
   * copies into this box. Matched on `id` alone that search returns zero rows out of 276 — and a zero
   * on this panel does not read as "you spelled it their other way", it reads as **"Comet does not sell
   * it"**, on the one screen whose entire job is telling those two states apart. Nothing throws; the
   * operator simply concludes a model is unavailable and prices the list without it.
   */
  it('filters on the display CODE too, which disagrees with the id on real rows', async () => {
    stubFeed({
      data: [
        feedRecord({ id: 'grok-4.5', code: 'grok-4-5' }),
        feedRecord({ id: 'kimi-k3', code: 'kimi-k3' }),
        feedRecord(),
      ],
    });

    /* The code Comet prints, which is NOT a substring of the id — an id-only filter returns nothing. */
    const byCode = await fetchCometMarketFeed('k', { filter: 'grok-4-5' });

    expect(
      byCode.rows.map((r) => r.id),
      'the operator typed the code Comet shows them',
    ).toEqual(['grok-4.5']);
    expect(byCode.rows[0].code, 'the code must survive onto the row so the panel can show both').toBe('grok-4-5');
    expect(byCode.reportedTotal, 'a narrow filter is not a short read').toBe(3);

    /* The id still matches, so widening the predicate did not trade one half for the other. */
    const byId = await fetchCometMarketFeed('k', { filter: 'grok-4.5' });
    expect(byId.rows.map((r) => r.id)).toEqual(['grok-4.5']);

    /*
     * CONTROL: a filter matching NEITHER field returns nothing. Without it every assertion here passes
     * for a filter that is simply ignored — which would show the operator all 276 rows and let them
     * conclude, just as wrongly, that their search matched everything.
     */
    const byNeither = await fetchCometMarketFeed('k', { filter: 'not-a-model-anywhere' });
    expect(byNeither.rows).toEqual([]);
    expect(byNeither.reportedTotal, 'and a no-match filter still reports the real catalogue size').toBe(3);
  });

  /*
   * A failed comparison view must SAY it failed. A silent empty list reads as "Comet prices nothing",
   * which is the state an operator would act on by promoting a list they have not actually compared.
   */
  it('throws on a non-OK status, naming it', async () => {
    stubFeed({ data: [] }, { status: 401 });

    await expect(fetchCometMarketFeed('bad-key')).rejects.toThrow(/HTTP 401/);
  });

  it('throws when the payload carries no data array, rather than reporting an empty catalogue', async () => {
    stubFeed({ error: { message: 'nope' } });
    await expect(fetchCometMarketFeed('k')).rejects.toThrow(/no data array/i);

    stubFeed({ data: { records: [] } });
    await expect(fetchCometMarketFeed('k')).rejects.toThrow(/no data array/i);
  });

  /*
   * 🔴 A body of literal `null` — which is VALID JSON, parses without complaint, and is what a gateway
   * returns when it decides it has nothing to say.
   *
   * The two payloads above are objects, so a null-check removed from the guard would still be caught by
   * `Array.isArray(json.data)`. `null` is the one shape that reaches property access first: read
   * `json.data` off it and the operator gets `TypeError: Cannot read properties of null (reading 'data')`
   * in a toast — a message that names no vendor, no endpoint and no cause, on a panel whose failure is
   * indistinguishable from "the network is fine and Comet prices nothing".
   *
   * The assertion is on the MESSAGE, not merely on rejecting, because both versions reject. What is
   * being pinned is that the failure says what was wrong with the payload.
   */
  it('throws the descriptive error on a literal null body, not a bare TypeError', async () => {
    stubFeed(null);

    await expect(fetchCometMarketFeed('k')).rejects.toThrow(/no data array/i);
    await expect(fetchCometMarketFeed('k')).rejects.not.toThrow(TypeError);
  });

  /*
   * CONTROL for the whole describe: the `NO_NETWORK` guard is real. If a test above forgot to stub,
   * it would dial api.cometapi.com with whatever key `.env.local` holds — so prove the guard fires.
   */
  it('the no-network guard is armed (control)', async () => {
    await expect(fetchCometMarketFeed('k')).rejects.toThrow(/reached the network/);
  });
});
