/**
 * Comet's baked price list — the static fallback beneath the operator's promoted list (SPEC §4.6).
 *
 * The same role `baked-market-prices.ts` plays for KIE: real, current-at-build pricing, so a storage
 * outage costs price DRIFT since the last bake and never a dead billing path or a zero rate. The
 * operator's promoted list (Settings → Admin → Marketplace prices) overrides it at runtime.
 *
 * ## 🔴 THE CHARGED RATE IS `pricing × ratio`, AND THE RATIO IS PER ROW
 *
 * Comet's `GET /api/models` publishes `pricing.input`/`pricing.output` as the **OFFICIAL VENDOR**
 * rates — Anthropic's own $5/$25 for Opus 5, OpenAI's own $1.25/$10 for gpt-5 — with a separate
 * `pricing.ratio` that is the discount. **What Comet actually charges is the product.** Reading
 * `pricing.*` as the charged rate was got wrong on the first pass of the investigation that produced
 * this file and reported as "no discount on Opus 5", which is why it is the first thing stated here.
 *
 * ⚠️ **`ratio` is NOT globally 0.8.** Measured across the feed on 2026-08-10: 273 of 276 rows carry
 * `0.8`; three carry **1.0** (`minimax-h3`, `seedance-2-5`, `seedream-5-0-pro-260628` — all
 * newest-generation media). A hardcoded 0.8 would under-charge exactly the newest and most expensive
 * models, silently, with the credit total going DOWN so it reads as a cheaper turn. Every row below
 * therefore records its official rate and its own ratio, and the stored number is the product.
 *
 * ## Why the rows carry NO cache rates
 *
 * Comet quotes no cached-token rate for any model. Per `spec/model-families.md`'s standing family
 * rule that means the `claude` family **derives** its cache rates (0.1x read / 2.0x the 1h write, off
 * each row's own charged input rate) and the price list REFUSES an explicit pair for those rows —
 * so a half-priced row is inexpressible. The counters are genuinely returned on this provider
 * (live-probed: a 5,420-token 1h-tier write and a matching read), so derivation prices something real.
 *
 * ## Provenance
 *
 * Every number below comes from the live probe recorded in `_specs/cometapi-provider_spec.md`, not
 * from Comet's marketing pages — their published table and their docs were both demonstrably
 * incomplete (the docs name one Claude id where the API serves 45). Two independent anchors settle
 * the semantics: `gpt-5` at `pricing 1.25/10` is OpenAI's exact official rate, and `claude-opus-5` at
 * `pricing 5/25` is Anthropic's exact official rate; both carry `ratio 0.8`, and the resulting $4/$20
 * matches Comet's own published "-20%" table to the cent.
 *
 * ⚠️ **This is roughly 2x KIE's Claude prices** and roughly 20% under Anthropic-direct. Both halves
 * are true and only the pair is honest. Margin is unaffected — credits are cost-proportional, so
 * `CREDIT_MARGIN` holds at any provider price — but a credit BUYS about half as much here as on KIE.
 * That is a §4.6 positioning consequence, and it is NOT to be answered by lowering `CREDIT_MARGIN`,
 * which would trade the platform's margin for the user's reach and bury a provider cost increase
 * inside the pricing model where nothing could ever attribute it back.
 */
import type { MarketPriceList } from './market-prices';

/**
 * A row's OFFICIAL vendor rate and the discount Comet applies to it — the arithmetic behind every
 * number in `BAKED_COMET_PRICES`, kept as data rather than as prose.
 *
 * It is a SIBLING constant and deliberately not part of `LlmMarketRate`: the price-list validator
 * refuses unknown keys, so a promoted list carrying provenance fields would be rejected outright.
 * Keeping it here means `comet-prices.spec.ts` can assert `charged === official x ratio` per row —
 * which a comment cannot do, and which is the only thing that makes a hardcoded 0.8 fail a test.
 *
 * Captured from `GET /api/models`, 2026-08-10. The three `ratio: 1` rows are MEDIA models this list
 * does not price yet (media lands in T8); they are recorded anyway, because they are the whole
 * reason the ratio must be read per row and a test with only `0.8` rows in it cannot prove that.
 */
export interface CometPriceProvenance {
  officialInputPerMTok: number | null;
  officialOutputPerMTok: number | null;
  ratio: number;
}

export const COMET_PRICE_PROVENANCE: Record<string, CometPriceProvenance> = {
  'claude-sonnet-5': { officialInputPerMTok: 2.0, officialOutputPerMTok: 10.0, ratio: 0.8 },
  'claude-opus-5': { officialInputPerMTok: 5.0, officialOutputPerMTok: 25.0, ratio: 0.8 },
  'claude-opus-4-8': { officialInputPerMTok: 5.0, officialOutputPerMTok: 25.0, ratio: 0.8 },
  'claude-fable-5': { officialInputPerMTok: 10.0, officialOutputPerMTok: 50.0, ratio: 0.8 },
  'grok-4.5': { officialInputPerMTok: 2.0, officialOutputPerMTok: 6.0, ratio: 0.8 },
  'kimi-k3': { officialInputPerMTok: 3.0, officialOutputPerMTok: 15.0, ratio: 0.8 },
  'qwen3-coder': { officialInputPerMTok: 0.3, officialOutputPerMTok: 1.2, ratio: 0.8 },

  /*
   * 🔴 NOT PRICED BY THIS LIST — recorded as the counter-example that makes the rule testable.
   *
   * All three are newest-generation MEDIA models and all three carry `ratio: 1`, i.e. NO discount.
   * 273 of the feed's 276 rows carry 0.8 and these three do not, so a capture that hardcoded 0.8
   * would under-charge exactly the newest and most expensive models — silently, with the credit
   * total moving DOWN, which reads as a cheaper turn. `per-second`/`per-request` media pricing has
   * no per-MTok rate at all, hence the nulls.
   */
  'minimax-h3': { officialInputPerMTok: null, officialOutputPerMTok: null, ratio: 1 },
  'seedance-2-5': { officialInputPerMTok: null, officialOutputPerMTok: null, ratio: 1 },
  'seedream-5-0-pro-260628': { officialInputPerMTok: null, officialOutputPerMTok: null, ratio: 1 },
};

/**
 * What Comet charges for a row: the official vendor rate times THAT ROW'S ratio.
 *
 * A function rather than four hand-multiplied literals, so the capture and the assertion cannot
 * disagree about the arithmetic — and so the ratio is visibly an input rather than a constant
 * somebody once folded in.
 */
export function cometChargedRate(officialPerMTok: number, ratio: number): number {
  /* Two decimals: rates are USD per million tokens and 0.3 x 0.8 is 0.24000000000000002 in binary. */
  return Math.round(officialPerMTok * ratio * 100) / 100;
}

export const BAKED_COMET_PRICES: MarketPriceList = {
  schemaVersion: 1,
  capturedAt: '2026-08-10',
  source: 'Comet GET /api/models, captured + per-id probed 2026-08-10 — charged = pricing x ratio, per row',

  llm: {
    /*
     * THE PLATFORM DEFAULT (`DEFAULT_MODEL`, the §4.6.1a Standard rung). Probed 200.
     * official 2.00 / 10.00 x ratio 0.80 -> 1.60 / 8.00
     *
     * ⚠️ Comet's feed reports Sonnet 5's official rate as $2/$10, which is Anthropic's INTRODUCTORY
     * price (expires 2026-08-31). Our own Anthropic table deliberately bills the STANDARD $3/$15 for
     * that reason (`rates.ts` — seeding the intro rate would compress margin below target the day it
     * lapses, with nothing failing). Here the intro rate is the right input because it is what Comet
     * actually charges us today; when their feed moves to the standard rate this row moves with it.
     * The two tables disagreeing is correct, not a defect — they price two different vendors.
     */
    'claude-sonnet-5': { inputPerMTok: 1.6, outputPerMTok: 8.0 },

    /* The §4.6.1a PREMIUM rung. Probed 200. official 5.00 / 25.00 x 0.80 -> 4.00 / 20.00 */
    'claude-opus-5': { inputPerMTok: 4.0, outputPerMTok: 20.0 },

    /*
     * The standing revert target for the Standard rung. Probed 200; the feed prices it, which is why
     * it is here now and was deliberately absent from this file's first draft — its charged rate had
     * not been measured then, and inferring one from Anthropic's list price would have been the guess
     * this header forbids. official 5.00 / 25.00 x 0.80 -> 4.00 / 20.00
     */
    'claude-opus-4-8': { inputPerMTok: 4.0, outputPerMTok: 20.0 },

    /* What `PREMIUM_MODEL` names on the owner's deploy. Probed 200. official 10/50 x 0.80 -> 8/40 */
    'claude-fable-5': { inputPerMTok: 8.0, outputPerMTok: 40.0 },

    /*
     * ------------------------------------------------------------------------------------------ *
     * The `chat` family (FR3) — probed 200 on `POST /v1/chat/completions`, 2026-08-10.
     *
     * Priced but NOT wired to any rung: they exist so the cheap fixed utilities have somewhere to go
     * (`ENHANCE_PROMPT_MODEL` is the obvious one — `qwen3-coder` is a FORTIETH of Opus 5's input rate
     * for a task that rewrites ≤10k characters of English). Every one of them is refused by
     * `getPlatformModel` unless an operator names it, so listing them costs nothing and makes the
     * OQ7 "push cheap models into the volume paths" lever real rather than theoretical.
     *
     * ⚠️ Cache rates are ABSENT and must stay absent: `cacheProfile: 'none'` for this family, so
     * cached tokens bill at the FULL input rate. Comet quotes no cached rate and these wires report
     * no cached-token counter — never a discount we cannot verify.
     * ------------------------------------------------------------------------------------------ *
     */
    'grok-4.5': { inputPerMTok: 1.6, outputPerMTok: 4.8 },
    'kimi-k3': { inputPerMTok: 2.4, outputPerMTok: 12.0 },
    'qwen3-coder': { inputPerMTok: 0.24, outputPerMTok: 0.96 },

    /*
     * 🔴 `claude-haiku-4-5` IS ABSENT BECAUSE IT DOES NOT EXIST HERE — see `comet-wire.ts`.
     *
     * The spec listed it as live-probed; the re-probe returned a hard 400 ("has not been priced by
     * the administrator yet"). Comet serves the DATED `claude-haiku-4-5-20251001` instead, at an
     * output cap the feed reports as 8K rather than the 64K this platform uses for Haiku. Pricing a
     * model that 400s would have made "unpriced" and "unserveable" two different states with one
     * spelling between them, which is the priced-but-not-listed trap from the other side.
     */
  },

  /*
   * ------------------------------------------------------------------------------------------- *
   * MEDIA (§4.16) — every row live-probed 2026-08-10
   * ------------------------------------------------------------------------------------------- *
   *
   * 🔴 **COMET'S FLAT-PRICED IMAGE MODELS DO NOT SERVE, AND THE FEED SAYS THEY DO.** `GET /api/models`
   * lists `doubao-seedream-5` at `per_request 0.035` and `seedream-5-0-pro` at `0.045` — clean flat
   * prices, exactly the shape this table wants. Both answer **HTTP 503 `no available channel for
   * group default`**, and `flux-2-pro` answers 400 (it is only reachable on `/flux/v1/{model}`, not
   * the OpenAI route). None of them is here. That is FR4 for the third time in this plan: a feed row
   * is not a probe, in either direction.
   *
   * 🔴 **SO EVERY SERVEABLE IMAGE MODEL IS TOKEN-PRICED, AND THESE ROWS ARE DERIVED, NOT QUOTED.**
   * `gpt-image-1.5` bills $6.40 in / $25.60 out per MTok (official $8/$32 x ratio 0.8);
   * `gemini-3-pro-image` bills $1.60/$9.60. A media debit is taken BEFORE the render from an EXACT
   * price, so a per-token rate cannot be used directly — it has to become a flat number per priced
   * variant. That is expressible with no type change because the platform CONTROLS the two fields
   * that decide the token count, and `MediaPriceVariant.options` is a subset match.
   *
   * ⚠️ **`image_tokens` is deterministic; `text_tokens` is NOT.** Measured across six renders:
   *
   *   | quality | size      | image_tok | text_tok | in | true cost |
   *   |---------|-----------|-----------|----------|----|-----------|
   *   | low     | 1024x1024 |       272 |      114 | 14 | $0.00997  |
   *   | medium  | 1024x1024 |      1056 |      162 | 14 | $0.03127  |
   *   | high    | 1024x1024 |      4160 |      180 | 14 | $0.11121  |
   *   | low     | 1536x1024 |       400 |       61 | 14 | $0.01189  |
   *   | medium  | 1536x1024 |      1568 |      430 | 12 | $0.05123  |
   *   | high    | 1536x1024 |      6208 |      425 | 14 | $0.16989  |
   *
   * `image_tokens` matches OpenAI's published table exactly and never moved. `text_tokens` ranged
   * **61 to 430** — a 7x spread worth up to $0.011, which is 35% of a `medium` render.
   *
   * **So each row is priced GENEROUSLY (owner decision, 2026-08-10): image tokens + 600 text tokens
   * (above the worst observed 430) + 1000 input tokens (the platform writes long art prompts; probes
   * measured 12-14).** The user pays a stable, knowable number and the platform never under-quotes
   * itself into absorbing a render. The alternative considered and rejected was debit-worst-case-then-
   * refund-the-difference: exact to the cent, but it appends a ledger row per image and a price
   * adjustment wearing the `refund` reason would make the §5A refund-rate alert fire on healthy
   * traffic — a metric encoding the shape of a failure that is not happening.
   *
   * ⚠️ Only the six probed cells exist. An unlisted `(quality, aspectRatio)` pair has NO row, so
   * `lookupMediaPrice` returns null and the request is REFUSED — never priced off a neighbouring
   * cell. That is the rule that makes an unmeasured variant safe to omit rather than dangerous.
   */
  media: {
    'gpt-image-1.5': {
      kind: 'image',
      label: 'GPT Image 1.5',
      vendor: 'OpenAI',
      unit: 'per_image',

      /*
       * The ONLY transparency capability on this gateway (`media/image-capabilities.ts`): probed with
       * `background: "transparent"` and verified by decoding every pixel's alpha byte — 74.31% fully
       * transparent, 6.69% semi. `gpt-image-1` and `gpt-image-2` refuse the parameter, which is why
       * the capability is a per-model table and not a provider flag.
       *
       * Transparency costs NOTHING EXTRA here: alpha comes out of the same single call, so these are
       * the prices whether or not the background is transparent. On KIE the same request is two
       * priced stages (render + `recraft/remove-background`).
       */
      variants: [
        { options: { quality: 'low', aspectRatio: '1:1' }, usd: 0.029 },
        { options: { quality: 'medium', aspectRatio: '1:1' }, usd: 0.049 },
        { options: { quality: 'high', aspectRatio: '1:1' }, usd: 0.129 },
        { options: { quality: 'low', aspectRatio: '16:9' }, usd: 0.032 },
        { options: { quality: 'medium', aspectRatio: '16:9' }, usd: 0.062 },
        { options: { quality: 'high', aspectRatio: '16:9' }, usd: 0.181 },
      ],
    },

    'gemini-3-pro-image': {
      kind: 'image',
      label: 'Nano Banana Pro (Gemini 3 Pro Image)',
      vendor: 'Google',
      unit: 'per_image',

      /*
       * The cheap opaque workhorse — measured $0.0113 (9 prompt + 1179 candidate tokens, 1120 of them
       * IMAGE) at $1.60/$9.60. Priced at 1000 in + 1600 out for the same headroom reason as above.
       *
       * ⚠️ It has NO alpha and returns **image/jpeg** inline whatever is asked for, so it is never the
       * model a transparent request resolves to. It also takes no size/quality knobs on this wire,
       * which is why it has ONE variant rather than a grid.
       */
      variants: [{ options: {}, usd: 0.017 }],
    },

    /*
     * Video is the one media surface that needed no derivation: Comet bills it `per_second`, which is
     * the platform's own unit, and the route is genuinely async (create returns a task id in ~1.3s;
     * a 4s veo3-fast render completed in 56s with a presigned `video_url`).
     *
     * Official $0.10/s x ratio 0.8. Probed end to end.
     */
    'veo3-fast': {
      kind: 'video',
      label: 'Veo 3 Fast',
      vendor: 'Google',
      unit: 'per_second',
      variants: [{ options: {}, usd: 0.08 }],
    },

    /* Official $0.40/s x ratio 0.8. Listed alongside veo3-fast; same route, same shapes. */
    veo3: {
      kind: 'video',
      label: 'Veo 3',
      vendor: 'Google',
      unit: 'per_second',
      variants: [{ options: {}, usd: 0.32 }],
    },
  },
};
