/**
 * The BAKED KIE marketplace price list (SPEC §4.6, spec/billing.md).
 *
 * This is the platform's fallback copy of "what does KIE charge us" — the honest cost side of every
 * credit charge, for BOTH kinds of spend: LLM tokens (the `llm` table, USD per million tokens) and
 * media generation (the `media` table, USD per image / per second / per video). The ACTIVE list an
 * operator has promoted from the Admin panel ("Marketplace prices") outranks this file; this file is
 * what prices everything until a promotion exists, and what the platform falls back to if the stored
 * list is ever unreadable. It can never be absent and never half-loaded.
 *
 * ## Where these numbers come from, and how to update them
 *
 * Captured from KIE's own public pricing feed (`POST https://api.kie.ai/client/v1/model-pricing/page`,
 * 372 rows) on 2026-07-18 — the same feed the Admin panel's "Fetch kie.ai feed" button reads. The LLM
 * rows independently CONFIRM the rates measured against KIE's `credits_consumed` on 2026-07-17
 * (rates.ts history): Opus 4.8 $2/$10, Opus 4.7 $1.425/$7.15, Fable 5 $4/$20 — feed and measurement
 * agree to the cent, which is the only reason both are trusted.
 *
 * Re-fetched 2026-07-31 (filter `modelDescription: "claude"`, 20 rows = 10 models x input/output).
 * Every one of the seven rows already baked came back IDENTICAL to the cent, which is what makes the
 * three rows added that day trustworthy on the feed's word alone. KIE serves ten Claude models; the
 * list now carries all ten, so an operator can point `LLM_MODEL` at any of them without an admin
 * promotion first.
 *
 * Ordinary price maintenance is NOT an edit to this file: the operator updates the ACTIVE list from
 * the Admin panel (fetch feed → adjust → promote), versioned with rollback, no deploy. Re-bake this
 * file only when the baked fallback itself has drifted far enough to matter (a new default model, a
 * repriced default row).
 *
 * ## Rules that keep this from silently mis-billing
 *
 *  - **Cache prices are NOT quoted here.** KIE's feed carries no cache rows for Claude models; the
 *    0.1x read / 2.0x 1-HOUR write multipliers are MEASURED on KIE (rates.ts, 2026-07-17) and applied
 *    by `ratesFromBase` to each row's own input rate. Quoting cache here would be a second opinion on
 *    a derived number — the `packMargin()` shape of bug.
 *  - **A media model with no row here (or in the active list) CANNOT RUN.** Media debits are taken
 *    up-front at a known price, so there is no "bill at the most expensive row" fallback like
 *    `ratesFor`'s — an unpriced media request is REFUSED, never guessed at (spec/billing.md).
 *  - **Variant options mirror the request we send to KIE's API** (`temp/kie-image-mcp` is the wire
 *    reference), so the price lookup and the createTask payload can never disagree about what was
 *    asked for.
 */
import type { MarketPriceList } from './market-prices';

export const BAKED_MARKET_PRICES: MarketPriceList = {
  schemaVersion: 1,

  /** When the feed was captured. The ACTIVE list carries its own capturedAt. */
  capturedAt: '2026-07-31',
  source: 'api.kie.ai/client/v1/model-pricing (public feed), cross-checked against measured rates',

  /**
   * USD per million tokens, input/output. Cache derives (0.1x / 2.0x — the 1h tier, measured on KIE).
   *
   * Every Claude model KIE serves that the operator may select as `KIE_DEFAULT_MODEL` or
   * `PREMIUM_MODEL`. A model absent here is REFUSED by `getPlatformModel`/`getPremiumTier` until the
   * operator adds its row via the Admin panel — never billed at a guessed rate.
   */
  llm: {
    /*
     * The PREMIUM rung (`DEFAULT_PREMIUM_MODEL`) since 2026-07-31; the PLATFORM DEFAULT from
     * 2026-07-27 until then (superseding claude-opus-4-8 below), and still the config-only revert
     * target for the Standard rung. KIE serves it at
     * exactly 4-8's rates — owner-confirmed and probe-verified 2026-07-27 against KIE's own usage
     * numbers: the cold request reported a 5,419-token 1h cache WRITE and warm ones a 5,419-token
     * cache READ, so it settles like 4-8, not like the 4-7/fable rows (which report 0 write tokens
     * while being charged the 2x). Same known vendor bug as every KIE Claude model since 2026-07-24:
     * returns no thinking text (see kie-wire.ts; the §4.2a heartbeat carries the UX).
     */
    'claude-opus-5': { inputPerMTok: 2.0, outputPerMTok: 10.0 },

    /*
     * The platform default until 2026-07-27 (see rates.ts for the full history). Won on ACCOUNTING:
     * the first KIE row whose usage numbers settle exactly against its published price (10,004 write
     * tokens = 8.02 credits, exact). Known vendor bug: returns no thinking text on KIE.
     */
    'claude-opus-4-8': { inputPerMTok: 2.0, outputPerMTok: 10.0 },

    /*
     * A release behind, hence cheaper (~0.285x of Anthropic's Opus list — NOT the 0.4x of 4-8; KIE
     * ratios are per-row coincidences, never a rule). The only KIE Opus that returns thinking text,
     * but its cache accounting is broken (reports 0 write tokens while charging 2x), so it lost the
     * default to 4-8.
     */
    'claude-opus-4-7': { inputPerMTok: 1.425, outputPerMTok: 7.15 },

    /* Same price as 4-7 on KIE's feed. Slowest TTFT of the three measured (see agent/config.ts). */
    'claude-opus-4-6': { inputPerMTok: 1.425, outputPerMTok: 7.15 },

    /*
     * The most expensive Claude row KIE serves — 2x Opus 4.8, not cheaper. It was the SuperMax rung's
     * in-code default until that rung was retired (2026-08-08) and the PREMIUM default before that;
     * it earns its place by being the strongest model KIE serves whose thinking text their adapter
     * returns. Which rung (if any) names it is `PREMIUM_MODEL`'s answer, not this file's. MEASURED against
     * KIE's own `credits_consumed` (2026-07-17): a four-point input sweep converges on $4.006 and an
     * output probe on $19.99, with Opus 4.8 as the control reproducing its published $2/$10 exactly.
     */
    'claude-fable-5': { inputPerMTok: 4.0, outputPerMTok: 20.0 },

    /*
     * THE PLATFORM DEFAULT (`DEFAULT_MODEL`) — the Standard rung — since 2026-07-31. Row captured from
     * the feed 2026-07-18, ~0.283x of Anthropic's list. Every promoted price list MUST carry a row for
     * whatever `DEFAULT_MODEL` names (`validateMarketPriceList`), because an unpriced default bills at
     * the most-expensive row instead — which is `claude-fable-5`, 4.7x this.
     */
    'claude-sonnet-5': { inputPerMTok: 0.85, outputPerMTok: 4.275 },

    /* A feed row (2026-07-18) — priced and selectable, but no rung uses it. */
    'claude-haiku-4-5': { inputPerMTok: 0.275, outputPerMTok: 1.425 },

    /*
     * The rest of KIE's Claude catalogue, re-fetched 2026-07-31. Added because the operator could set
     * `LLM_MODEL` to a model KIE genuinely serves and have every generation REFUSED at config time
     * (`claude-sonnet-4-6` did exactly that) — the var was honoured, the price row simply did not
     * exist, and the refusal named the Admin panel rather than the real problem. A selector for a
     * model our own provider sells should not require an admin promotion first.
     *
     * With these, the baked list covers all TEN Claude models on KIE's feed. Sonnet 4-6 and 4-5 price
     * identically to Sonnet 5; Opus 4-5 matches 4-6/4-7. ⚠️ Priced but NOT measured against
     * `credits_consumed` the way 4-8/4-7/fable-5 were — the feed is one source, and it is trustworthy
     * here only because the same fetch reproduced all seven pre-existing rows to the cent. Before
     * making any of these a default rung, measure its cache accounting: 4-7 and fable-5 report ZERO
     * cache-write tokens while being charged 2x, which is what disqualified them (rates.ts).
     */
    'claude-sonnet-4-6': { inputPerMTok: 0.85, outputPerMTok: 4.275 },
    'claude-sonnet-4-5': { inputPerMTok: 0.85, outputPerMTok: 4.275 },
    'claude-opus-4-5': { inputPerMTok: 1.425, outputPerMTok: 7.15 },

    /*
     * 🔴 THE GPT FAMILY — the ONLY rows that quote their cache prices, and the reason that became
     * possible (2026-08-04, feed-captured the same day; keys are the API ids with DASHES, never the
     * feed's display names `gpt-5.6-sol`, which price nothing real).
     *
     * KIE publishes four numbers for each of these, and one of them is NOT a multiple our derivation
     * produces:
     *
     *   | model        | Input  | Output | Cached Input     | Cache Writes      |
     *   |--------------|--------|--------|------------------|-------------------|
     *   | gpt-5-6-sol  | $1.4   | $8.4   | $0.14  = 0.1x    | $1.75 = **1.25x** |
     *   | gpt-5-6-luna | $0.056 | $0.336 | $0.0056 = 0.1x   | $0.07 = **1.25x** |
     *
     * The read multiplier coincides with Claude's 0.1x; the WRITE is **1.25x, not the 2.0x** every
     * Claude row derives. That 1.25x is the FIVE-MINUTE cache tier — KIE does not resell the 1-hour
     * tier on this surface — so deriving these would have over-charged the write class by 60% on every
     * cold turn, silently, with nothing throwing. This single divergence is the whole justification for
     * the `explicit-pair` cache profile (`market-prices.ts`): a rule that holds for one family is not a
     * rule, and the only way to find that out was to read the vendor's own numbers.
     *
     * ✅ **RECONCILED AGAINST KIE'S OWN BILLING, 2026-08-04** — not feed-only, unlike the late Claude
     * rows above. Method: read the account credit balance, run a real generation, read it again, and
     * compare the delta against what these rates compute from the reported usage. KIE prices every
     * CHAT/TOKEN row at exactly $0.005/credit (`creditPrice` 280 = `usdPrice` 1.40 on sol input; 70 of
     * 71 feed rows checked are exact to 8 decimals), which is what makes a balance delta convertible
     * to USD. ⚠️ Not universal — the one outlier found was a MEDIA row (veo 3.1 4K, 380cr/$1.85 =
     * 0.004868), so do not carry this conversion over to §4.16 pricing without re-deriving it.
     *
     *     gpt-5-6-sol      0 input / 546 output tokens → KIE $0.004600 · ours $0.004586 · ratio 0.997
     *
     * 🔴 **That run confirms the OUTPUT rate ONLY, and the reason is worth stating so nobody reads it
     * as more:** KIE reported ZERO input tokens, so the input rate is multiplied by zero and ANY input
     * price reproduces $0.004586 to the digit. The input and cache rates are untested by it. (Gemini's
     * run below does weakly constrain its input rate — 385 prompt tokens are ~1.2% of that charge, so
     * a 0.1% match bounds it to roughly ±8%.)
     *
     * It is still the second source `claude-opus-4-7` and `claude-fable-5` never got, and that check is
     * what disqualified them (both report ZERO cache-write tokens while being charged the 2x). Measure
     * a row's CACHE accounting before making it a default rung — the run above cached nothing.
     *
     * ✅ `gpt-5-6-terra` was held back pending a probe (FR9) and PROBED CLEAN on 2026-08-04 — HTTP
     * 200, streamed, usage captured — so it ships priced AND listed, in the same edit, which is the
     * only way the two can never drift into the priced-but-unlisted silent mis-bill.
     *
     * 🔴 Note the shape of all three rows: the READ is 0.1x input on every one (coinciding with
     * Claude's derived multiplier) while the WRITE is 1.25x on every one. If a future row breaks that
     * pattern, quote it — do not infer it. That is the whole point of `explicit-pair`.
     */
    'gpt-5-6-sol': {
      inputPerMTok: 1.4,
      outputPerMTok: 8.4,
      cachedInputPerMTok: 0.14,
      cacheWritePerMTok: 1.75,
    },
    'gpt-5-6-luna': {
      inputPerMTok: 0.056,
      outputPerMTok: 0.336,
      cachedInputPerMTok: 0.0056,
      cacheWritePerMTok: 0.07,
    },
    'gpt-5-6-terra': {
      inputPerMTok: 0.56,
      outputPerMTok: 3.36,
      cachedInputPerMTok: 0.056,
      cacheWritePerMTok: 0.7,
    },

    /*
     * 🔴 THE GEMINI FAMILY — priced with NO cache row, because KIE publishes none.
     *
     * Verified against the live feed 2026-08-04: filtering it returns EXACTLY TWO rows, "Gemini 3.5
     * Flash, chat, input" ($0.45) and "…, output" ($2.7). No Cached Input, no Cache Writes — unlike
     * every gpt-5.6 row, which carries all four. Their wire reports no cached-token counter either
     * (`usageMetadata` is `{promptTokenCount, candidatesTokenCount, thinkingTokenCount,
     * totalTokenCount}`), so there is nothing to discount and nothing to observe.
     *
     * Hence `cacheProfile: 'none'`: cached tokens bill at the FULL input rate. Never a discount we
     * cannot verify KIE grants, never a surcharge we cannot observe. **The consequence is real and
     * intended — a warm Gemini edit costs what a cold one costs**, so the Admin margin report must not
     * read this family as a caching regression (owner decision, flagged and accepted 2026-08-04).
     *
     * ✅ **RECONCILED AGAINST KIE'S OWN BILLING, 2026-08-04 — and it exposed a token-class subtlety
     * worth more than the row itself.** Three generations, 385 prompt / 5,349 candidates / 3,639
     * thinking tokens, KIE charged **$0.014600**:
     *
     *     counting candidates + thinking as output   → $0.024441   ratio 1.674  ❌
     *     counting CANDIDATES ONLY as output          → $0.014616   ratio **1.001** ✅
     *
     * **KIE does not bill Gemini thinking tokens.** We match to 0.1% — but only because
     * `@ai-sdk/google@1.2.22` maps `completionTokens` from `candidatesTokenCount` alone (dist L562,
     * L621) and drops `thinkingTokenCount` on the floor. Our correctness here is INHERITED from that
     * choice, not asserted by us.
     *
     * 🔴 **TRIPWIRE: if a future `@ai-sdk/google` bump starts folding thinking into `completionTokens`
     * — which is the natural thing for it to do, since Google reports the counter — every Gemini
     * generation would immediately over-charge the user by ~1.67x, silently, with nothing throwing.**
     * That is the wrong direction to be wrong in (`rates.ts`: every fallback errs in OUR disfavour).
     * Re-run this reconciliation on any bump of that SDK.
     */
    'gemini-3-5-flash': { inputPerMTok: 0.45, outputPerMTok: 2.7 },
  },

  /**
   * Media generation — the models the App Builder SURFACES (`generate_image` / `generate_video` /
   * `generate_google_video`, SPEC §4.16). Deliberately curated, not the whole 372-row feed: a model
   * gets a row when we actually offer it, because an offered-but-unpriced model cannot run and a
   * priced-but-unoffered row is dead weight the admin panel has to explain.
   *
   * `unit` semantics: `per_image` and `per_video` are flat; `per_second` multiplies by the requested
   * duration. Variant `options` are matched against the generation request — see
   * `lookupMediaPrice` in market-prices.ts.
   */
  media: {
    /* ---- images (jobs endpoint, `/api/v1/jobs/createTask`) ---- */

    /** THE DEFAULT IMAGE MODEL. Google, via KIE. */
    'nano-banana-2': {
      kind: 'image',
      label: 'Nano Banana 2',
      vendor: 'Google',
      unit: 'per_image',
      variants: [
        { options: { resolution: '1K' }, usd: 0.04 },
        { options: { resolution: '2K' }, usd: 0.06 },
        { options: { resolution: '4K' }, usd: 0.09 },
      ],
    },

    'nano-banana-2-lite': {
      kind: 'image',
      label: 'Nano Banana 2 Lite',
      vendor: 'Google',
      unit: 'per_image',
      variants: [{ options: { resolution: '1K' }, usd: 0.02 }],
    },

    /* Feed prices 1K and 2K identically ("1/2K" $0.09). */
    'nano-banana-pro': {
      kind: 'image',
      label: 'Nano Banana Pro',
      vendor: 'Google',
      unit: 'per_image',
      variants: [
        { options: { resolution: '1K' }, usd: 0.09 },
        { options: { resolution: '2K' }, usd: 0.09 },
        { options: { resolution: '4K' }, usd: 0.12 },
      ],
    },

    /* Text-to-image and image-to-image price identically on the feed for all rows below. */
    'seedream/5-pro': {
      kind: 'image',
      label: 'Seedream 5 Pro',
      vendor: 'ByteDance',
      unit: 'per_image',
      variants: [
        { options: { resolution: '1K' }, usd: 0.035 },
        { options: { resolution: '2K' }, usd: 0.07 },
      ],
    },

    'flux-2/pro': {
      kind: 'image',
      label: 'Flux 2 Pro',
      vendor: 'Black Forest Labs',
      unit: 'per_image',
      variants: [
        { options: { resolution: '1K' }, usd: 0.025 },
        { options: { resolution: '2K' }, usd: 0.035 },
      ],
    },

    'flux-2/flex': {
      kind: 'image',
      label: 'Flux 2 Flex',
      vendor: 'Black Forest Labs',
      unit: 'per_image',
      variants: [
        { options: { resolution: '1K' }, usd: 0.07 },
        { options: { resolution: '2K' }, usd: 0.12 },
      ],
    },

    /**
     * THE CUT-OUT PASS (§4.16) — the second stage of a transparent image, never a model a user picks.
     *
     * No image model on KIE emits an alpha channel (measured across every render 2026-07-19 →
     * 2026-07-23: not one transparent pixel, `output_format: "png"` or not — see
     * `lib/media/output-format.ts`). This is the ONE transparency capability in KIE's entire catalog:
     * a search of their pricing feed for background / remove / matting / cutout / sticker / transparent
     * returns exactly this row. So a request for transparent art is priced as generate + cut out, and
     * without this row that request is REFUSED rather than silently delivered opaque.
     *
     * $0.005/image on KIE's feed (2026-07-23), flat — no resolution variants, hence the catch-all
     * `{}` options. ~2 credits at the current margin.
     */
    'recraft/remove-background': {
      kind: 'image',
      label: 'Recraft Remove Background (cut-out pass)',
      vendor: 'Recraft',
      unit: 'per_image',
      variants: [{ options: {}, usd: 0.005 }],
    },

    /* ---- video (jobs endpoint) ---- */

    /**
     * THE DEFAULT VIDEO MODEL. Per second; `mode` is the request field KIE's kling-3.0 input takes
     * (std→720P, pro→1080P, 4k→4K on the feed's resolution rows). 4K prices identically with or
     * without audio, so its variants omit `sound` — subset matching prices both.
     */
    'kling-3.0/video': {
      kind: 'video',
      label: 'Kling 3.0',
      vendor: 'Kling',
      unit: 'per_second',
      variants: [
        { options: { mode: 'std', sound: false }, usd: 0.07 },
        { options: { mode: 'std', sound: true }, usd: 0.1 },
        { options: { mode: 'pro', sound: false }, usd: 0.09 },
        { options: { mode: 'pro', sound: true }, usd: 0.135 },
        { options: { mode: '4K' }, usd: 0.335 },
      ],
    },

    /* Per video, not per second. Text-to-video and image-to-video slugs price identically. */
    'kling-2.6': {
      kind: 'video',
      label: 'Kling 2.6',
      vendor: 'Kling',
      unit: 'per_video',
      aliases: ['kling-2.6/text-to-video', 'kling-2.6/image-to-video'],
      variants: [
        { options: { durationSeconds: 5, sound: false }, usd: 0.275 },
        { options: { durationSeconds: 5, sound: true }, usd: 0.55 },
        { options: { durationSeconds: 10, sound: false }, usd: 0.55 },
        { options: { durationSeconds: 10, sound: true }, usd: 1.1 },
      ],
    },

    /*
     * `imageInput` distinguishes the feed's "no video input" (text-to-video) and "with video input"
     * (first-frame image supplied) rows — with-input is the CHEAPER of each pair on every row.
     */
    'bytedance/seedance-2': {
      kind: 'video',
      label: 'Seedance 2',
      vendor: 'ByteDance',
      unit: 'per_second',
      variants: [
        { options: { resolution: '480p', imageInput: false }, usd: 0.095 },
        { options: { resolution: '480p', imageInput: true }, usd: 0.057 },
        { options: { resolution: '720p', imageInput: false }, usd: 0.205 },
        { options: { resolution: '720p', imageInput: true }, usd: 0.125 },
        { options: { resolution: '1080p', imageInput: false }, usd: 0.51 },
        { options: { resolution: '1080p', imageInput: true }, usd: 0.31 },
        { options: { resolution: '4K', imageInput: false }, usd: 1.04 },
        { options: { resolution: '4K', imageInput: true }, usd: 0.64 },
      ],
    },

    'bytedance/seedance-2-fast': {
      kind: 'video',
      label: 'Seedance 2 Fast',
      vendor: 'ByteDance',
      unit: 'per_second',
      variants: [
        { options: { resolution: '480p', imageInput: false }, usd: 0.0775 },
        { options: { resolution: '480p', imageInput: true }, usd: 0.045 },
        { options: { resolution: '720p', imageInput: false }, usd: 0.165 },
        { options: { resolution: '720p', imageInput: true }, usd: 0.1 },
      ],
    },

    'bytedance/seedance-1.5-pro': {
      kind: 'video',
      label: 'Seedance 1.5 Pro',
      vendor: 'ByteDance',
      unit: 'per_second',
      variants: [
        { options: { resolution: '480p', sound: false }, usd: 0.00875 },
        { options: { resolution: '480p', sound: true }, usd: 0.0175 },
        { options: { resolution: '720p', sound: false }, usd: 0.0175 },
        { options: { resolution: '720p', sound: true }, usd: 0.035 },
        { options: { resolution: '1080p', sound: false }, usd: 0.0375 },
        { options: { resolution: '1080p', sound: true }, usd: 0.075 },
      ],
    },

    'grok-imagine-video-1-5-preview': {
      kind: 'video',
      label: 'Grok Imagine Video 1.5',
      vendor: 'Grok',
      unit: 'per_second',
      variants: [
        { options: { resolution: '480p' }, usd: 0.008 },
        { options: { resolution: '720p' }, usd: 0.015 },
      ],
    },

    /* ---- Google Veo 3.1 (dedicated `/api/v1/veo/generate` endpoint; per video, 4/6/8s) ---- */

    /*
     * The feed's Fast-1080p text-to-video row reads "0,325" (comma typo); the image-to-video row and
     * the reference-to-video row both read 0.325, so 0.325 it is. Text/image/reference generation
     * price identically per tier+resolution, which is why the variants carry no generationType.
     */
    veo3: {
      kind: 'video',
      label: 'Veo 3.1 Quality',
      vendor: 'Google',
      unit: 'per_video',
      variants: [
        { options: { resolution: '720p' }, usd: 1.25 },
        { options: { resolution: '1080p' }, usd: 1.275 },
        { options: { resolution: '4k' }, usd: 1.85 },
      ],
    },

    veo3_fast: {
      kind: 'video',
      label: 'Veo 3.1 Fast',
      vendor: 'Google',
      unit: 'per_video',
      variants: [
        { options: { resolution: '720p' }, usd: 0.3 },
        { options: { resolution: '1080p' }, usd: 0.325 },
        { options: { resolution: '4k' }, usd: 0.9 },
      ],
    },

    veo3_lite: {
      kind: 'video',
      label: 'Veo 3.1 Lite',
      vendor: 'Google',
      unit: 'per_video',
      variants: [
        { options: { resolution: '720p' }, usd: 0.15 },
        { options: { resolution: '1080p' }, usd: 0.175 },
        { options: { resolution: '4k' }, usd: 0.75 },
      ],
    },
  },

  /*
   * Web search (§4.2): a FLAT 10 credits per billable `web_search` call. A paid search runs ~$0.01–0.015
   * on SerpApi/Brave; at CREDIT_UNIT_COST_USD $0.01 / CREDIT_MARGIN 4.0 the cost-recovery figure is ~6
   * credits, so 10 is a round, margin-positive flat toll. Admin-adjustable in Settings → Admin →
   * Marketplace prices. Free providers (DuckDuckGo/SearXNG) never bill regardless of this number.
   */
  search: { creditsPerSearch: 10 },
};
