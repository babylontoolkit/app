/**
 * ANTHROPIC'S BUILT-IN PRICES — the starting point of the Anthropic price list, NOT the only place a
 * price can come from (owner, 2026-09-29).
 *
 * 🔴 **Adding a model must never need a code change.** Until 2026-09-29 this table lived in `rates.ts`
 * and was the ONLY source of Anthropic prices, so pointing `LLM_MODEL` / `PREMIUM_MODEL` /
 * `PLATINUM_MODEL` at a newly released model on Anthropic meant editing source and redeploying —
 * while the very same model on a gateway was one row in Settings → Admin → Marketplace prices.
 * Owner: *"what happens when i deploy app and six month later i wanna use the new model… do i have do
 * thru all this"*. Now Anthropic has a promotable list exactly like the gateways
 * (`market-price-store.ts`), and this file is its BAKED fallback, the same role
 * `baked-market-prices.ts` plays for KIE.
 *
 * Why this lives in its own file: `market-price-store.ts` needs the baked Anthropic list at module
 * load, and `rates.ts` imports the store — putting the table here keeps the import graph acyclic.
 * `rates.ts` re-exports `MODEL_RATES`, so every existing reader is unchanged.
 *
 * ⚠️ The rows here carry EXACT cache rates. A promoted list row cannot (claude rows derive 0.1x read /
 * 2x write — `validateLlmCachePolicy`), so `anthropicRates` keeps these exact numbers whenever the
 * active list prices a model at the SAME input/output as this table, and derives otherwise. A new
 * model added only in the Admin panel therefore bills its cache reads at 0.1x input — correct for most
 * models, and an over-charge (never an under-charge) for the few that discount deeper.
 */
import type { MarketPriceList } from './market-prices';
import type { ModelRates } from './rates';

/**
 * Published list prices, USD per million tokens. Verified against Anthropic's model pricing table
 * (2026-08-12).
 *
 * ## What belongs in here, and why the table is deliberately not the whole price list
 *
 * A row here is an assertion that this platform may be asked to SERVE that model on Anthropic — the
 * `MODEL_RATES` lookup is what `getPlatformModel` and the tier ladder validate a selector against, so
 * **adding a row widens what a deploy can select.** Anthropic publishes rows for Opus 4.5/4.6/4.7,
 * Sonnet 4.5/4.6 and Mythos 5 that are deliberately ABSENT: nothing selects them, and an absent row
 * makes `LLM_MODEL=claude-opus-4-7` on Anthropic a loud config refusal rather than a live model whose
 * rates nobody checked. Do not paste the vendor's table in wholesale — add the row when a selector
 * needs it, which is the same "model and price are ONE fact" rule the marketplace list follows.
 *
 * ## 🔴 SONNET 5 IS $2/$10 AND THE INTRO-PRICING CARVE-OUT IS DEAD (2026-08-12)
 *
 * This row was deliberately held at the STANDARD **$3/$15** for weeks because $2/$10 was announced as
 * introductory pricing expiring 2026-08-31, and seeding a rate that was about to rise would have
 * compressed margin the day it lapsed. **Anthropic has now made $2/$10 the standard price and
 * cancelled the scheduled increase**, so the premise is gone and the carve-out inverted from prudent
 * to wrong: we were pricing the platform's most common turn at **1.5x what it costs us**.
 *
 * That is not a margin windfall, it is a **user over-charge**, and it is worth being precise about the
 * direction because this file's other fallbacks lean the opposite way. Credits are cost-proportional
 * (`creditsForUsage`), so an OVERSTATED cost in this table is billed straight through to the customer:
 * every Anthropic-served Sonnet 5 turn charged 1.5x the credits it should have. It also fed
 * `savings.ts`, whose reference table IS this one — so the "you saved N" figure shown next to a money
 * number claimed a ~47% discount on a (since removed) gateway where the honest number was 20%.
 *
 * ⚠️ **The generalisable rule: a rate held deliberately off a vendor's current price is a DATED
 * decision that needs an expiry review, not a comment.** Three documents plus a spec assertion all
 * faithfully recorded *why* $3/$15 was right, and every one of them kept reading as correct after the
 * fact underneath it changed — the same "cite config as DATED evidence" failure this repo has now
 * recorded four times. A price that is intentionally not the vendor's price should be the rarest thing
 * in this file.
 */
export const MODEL_RATES: Record<string, ModelRates> = {
  /*
   * THE PLATFORM DEFAULT (`DEFAULT_MODEL`, the §4.6.1a Standard rung). $2/$10 is the STANDARD price as
   * of 2026-08-12 — the introductory-rate carve-out is retired; see the header.
   */
  'claude-sonnet-5': {
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
    cacheReadPerMTok: 0.2, // 0.1x
    cacheWritePerMTok: 4.0, // 2x — the 1h tier
  },
  'claude-haiku-4-5': {
    inputPerMTok: 1.0,
    outputPerMTok: 5.0,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 2.0,
  },
  'claude-opus-4-8': {
    inputPerMTok: 5.0,
    outputPerMTok: 25.0,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 10.0,
  },

  // The §4.6.1a PREMIUM rung. Anthropic prices Opus 5 as a drop-in at Opus 4.8's exact rates.
  'claude-opus-5': {
    inputPerMTok: 5.0,
    outputPerMTok: 25.0,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 10.0,
  },

  /*
   * 🔴 THE §4.6.1a PLATINUM RUNG — AND ANTHROPIC SELLS IT, WHICH THIS FILE USED TO DENY (2026-08-12).
   *
   * `PLATINUM_MODEL=claude-fable-5` is live in the owner's deploy and `Anthropic` is the last rung of
   * `LLM_PROVIDER_CHAIN`, so this row is load-bearing rather than documentation. Until now there was
   * NO fable-5 row here and three comments in this file asserted the reason was that "Anthropic does
   * not sell it" — false, and expensive: `providerRates`' gap-fill therefore priced the Platinum rung
   * on Anthropic from the KIE-shaped marketplace list at **$4/$20 against a true $10/$50**, so we ate
   * ~60% of the cost of every Anthropic-served Platinum turn, silently, with the credit count going
   * DOWN so it read as a cheaper turn. That is the exact mirror of the 231-vs-576 defect recorded on
   * `providerRates` — same mechanism, opposite direction, and the direction that loses money.
   *
   * ⚠️ It also retro-corrects a MEASUREMENT this repo reasoned from: "on Anthropic the fable-5 rung
   * settled 814 credits against Opus 5's 1,017" was quoted in four places as evidence that the ladder
   * is not cost-monotonic on Anthropic. 814/1017 is exactly 4/5 — it is the gap-filled $4/$20 rate,
   * i.e. the mis-bill, not a fact about Anthropic's prices. At the real $10/$50 the same turn is ~2,035
   * credits and Anthropic IS cost-monotonic. The ladder still orders CAPABILITY, not price (do not
   * reorder it), but that rule no longer has a live counterexample to point at.
   *
   * ⚠️ Adding this row also raises `mostExpensive(MODEL_RATES)` from Opus 5's $25 output to $50, so an
   * UNPRICED model on Anthropic now falls back to twice what it used to. That is the direction this
   * file's fallbacks are documented to err in (our own favour, recoverable) — noted because it is a
   * real behaviour change and not a side effect anyone would look for.
   */
  'claude-fable-5': {
    inputPerMTok: 10.0,
    outputPerMTok: 50.0,
    cacheReadPerMTok: 1.0,
    cacheWritePerMTok: 20.0,
  },

  /*
   * 🔴 THE 5.5 / 5.1 GENERATION (added 2026-09-29, owner). Anthropic's published rates, verified
   * against the current model table the same day. ⚠️ Their CACHE READS are not the family's 0.1x:
   * Opus 5.5 reads at $0.20 (0.05x) and Fable 5.1 at $0.25 (0.025x), so these rows state them
   * explicitly. The 1h cache write is the usual 2x input.
   */
  'claude-sonnet-5-5': {
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 4.0,
  },
  'claude-opus-5-5': {
    inputPerMTok: 4.0,
    outputPerMTok: 20.0,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 8.0,
  },
  'claude-fable-5-1': {
    inputPerMTok: 10.0,
    outputPerMTok: 50.0,
    cacheReadPerMTok: 0.25,
    cacheWritePerMTok: 20.0,
  },
};

/**
 * The baked Anthropic PRICE LIST — the same rows as `MODEL_RATES`, in the promotable list's shape
 * (input/output only; cache rates are derived or taken exact from `MODEL_RATES`, see above).
 */
export const BAKED_ANTHROPIC_PRICES: MarketPriceList = {
  schemaVersion: 1,
  capturedAt: '2026-09-29',
  source: "Anthropic's published model pricing (first-party list prices), verified 2026-09-29",
  llm: Object.fromEntries(
    Object.entries(MODEL_RATES).map(([model, rates]) => [
      model,
      { inputPerMTok: rates.inputPerMTok, outputPerMTok: rates.outputPerMTok },
    ]),
  ),
  media: {},
};
