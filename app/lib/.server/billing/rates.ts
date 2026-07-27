/**
 * Credit rates and billing config (SPEC §4.6, spec/billing.md).
 *
 * **Everything here is CONFIG, never a hardcoded business rule.** Retail pricing is a launch decision
 * and the ledger records raw token usage, so pricing can be re-tuned without a schema change or a
 * backfill (§4.6).
 *
 * The four token classes are NOT interchangeable, and conflating any two of them is a silent revenue
 * bug — the kind that throws nothing and fails no test:
 *
 * | Class          | Multiple of base input | Why                                                    |
 * |----------------|------------------------|--------------------------------------------------------|
 * | input          | 1x                     | uncached prompt                                        |
 * | cache read     | 0.1x                   | the margin lever (§4.3.5)                              |
 * | cache write    | **2x**                 | we use the 1-HOUR tier (§4.2.8), not the 1.25x default |
 * | output         | 5x (model-specific)    | what the model writes                                  |
 */
import { env, envFlag, envNumber, NotConfiguredError } from '~/lib/.server/env';
import type { MarketPriceList } from './market-prices';
import { BAKED_MARKET_PRICES } from './baked-market-prices';
import { activeMarketPrices } from './market-price-store';

/** USD per million tokens, per model. Verified against Anthropic's published pricing (2026-07). */
export interface ModelRates {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;

  /**
   * The 1-HOUR cache tier: 2x base input, not the 1.25x of the 5-minute default.
   *
   * `proxy.ts` writes every cache entry with `ttl: '1h'` because the 5-minute default expires while
   * the user is playing the game we just built. Billing MUST agree with that choice — assuming 1.25x
   * here would under-charge every single generation (§4.2.8).
   */
  cacheWritePerMTok: number;
}

/**
 * The two cache classes are DERIVED from base input, not independently quoted.
 *
 * Both Anthropic and KIE price caching as a multiple of the model's own input rate, and every row in
 * every table below satisfies it exactly (`billing.spec.ts` pins that as an invariant). That is what
 * makes `KIE_INPUT_DOLLARS` safe to expose on its own: an operator who reprices input WITHOUT these
 * would otherwise leave the cache numbers quoted against the OLD input rate — a row half-priced from
 * each, which is the `packMargin()` bug in miniature (two numbers, each locally sensible, disagreeing
 * about what one thing costs). So cache always re-derives from the FINAL input rate unless the
 * operator quotes it explicitly.
 *
 * ⚠️ The write multiple is **2x** because `proxy.ts` writes every entry at the 1-HOUR tier — NOT the
 * 1.25x of the 5-minute default (§4.2.8). Billing must agree with that choice or every generation
 * under-charges, silently.
 */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 2.0;

/**
 * A full rate row from the two numbers a vendor actually publishes, with optional explicit cache
 * quotes for a vendor whose multipliers ever diverge from the pair above.
 */
export function ratesFromBase(
  inputPerMTok: number,
  outputPerMTok: number,
  cache?: { cacheReadPerMTok?: number; cacheWritePerMTok?: number },
): ModelRates {
  return {
    inputPerMTok,
    outputPerMTok,
    cacheReadPerMTok: cache?.cacheReadPerMTok ?? inputPerMTok * CACHE_READ_MULTIPLIER,
    cacheWritePerMTok: cache?.cacheWritePerMTok ?? inputPerMTok * CACHE_WRITE_MULTIPLIER,
  };
}

/**
 * Published list prices, USD per million tokens.
 *
 * ⚠️ Sonnet 5 currently carries INTRODUCTORY pricing of $2/$10 per MTok, which expires 2026-08-31.
 * We deliberately bill against the STANDARD $3/$15. Seeding the intro rate would silently compress
 * our margin to below target the day it lapses — and nothing would fail; the invoices would just get
 * bigger. Under-charging ourselves for a few weeks is the correct direction to be wrong in.
 */
export const MODEL_RATES: Record<string, ModelRates> = {
  'claude-sonnet-5': {
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
    cacheReadPerMTok: 0.3, // 0.1x
    cacheWritePerMTok: 6.0, // 2x — the 1h tier
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

  // Anthropic prices Opus 5 as a drop-in at Opus 4.8's exact rates (launch announcement, 2026-07).
  'claude-opus-5': {
    inputPerMTok: 5.0,
    outputPerMTok: 25.0,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 10.0,
  },
};

/**
 * KIE.ai's rates (`providers/kie.ts`), USD per million tokens — DERIVED from the marketplace price
 * list, never hand-written here (2026-07-18).
 *
 * The numbers live in ONE document: the baked `BAKED_MARKET_PRICES.llm` table
 * (`baked-market-prices.ts`, where each row keeps its measurement history), overridden at runtime by
 * whatever list the operator has PROMOTED from the Admin panel ("Marketplace prices"). This constant
 * is the baked table only — the static fallback and the thing `billing.spec.ts` pins absolute prices
 * against. Runtime billing goes through `kieRates()`, which reads the ACTIVE list.
 *
 * ⚠️ **EVERY ROW IS LOOKED UP, NEVER DERIVED FROM A RATIO.** `claude-opus-4-8` happens to be a uniform
 * 0.4x of Anthropic list; 4.7 is ~0.285x and fable-5 is 2x Anthropic's Opus list — KIE resells many
 * vendors at its own prices. A ratio that holds for one row is a coincidence. The cache multipliers
 * ARE shared (0.1x read, 2.0x the 1-hour write, applied to each row's own base) and that one IS
 * measured — see the note below the table.
 *
 * ⚠️ **These are the rates we ACTUALLY PAY, and that is the entire contract of this file** — "the
 * honest number, before any margin". Credits are cost-proportional (`creditsForUsage`), so a wrong
 * cost here mis-bills every user silently. The margin lever is `CREDIT_MARGIN`, never a fudged cost.
 *
 * ⚠️ **Do not re-derive the edits-per-plan figure from this table alone — it is dominated by the CACHE,
 * not by these rates.** With sticky routing (`selectStickyBlocks`) a warm edit measures ~11 credits at
 * margin 3.34 (~13 at the current 4.0) — a $90/9,500-credit Pro pack is **~730 warm edits**. (The old
 * "~13/~32 edits" figures predate the sticky-routing fix.)
 */
export const KIE_MODEL_RATES: Record<string, ModelRates> = llmRatesFromList(BAKED_MARKET_PRICES);

/** A full `ModelRates` table from a price list's llm rows — cache always derives from each row's base. */
export function llmRatesFromList(list: MarketPriceList): Record<string, ModelRates> {
  return Object.fromEntries(
    Object.entries(list.llm).map(([model, rate]) => [model, ratesFromBase(rate.inputPerMTok, rate.outputPerMTok)]),
  );
}

/*
 * 🔴 HOW THE CACHE MULTIPLIERS STOPPED BEING AN ASSUMPTION (2026-07-17).
 *
 * The sweep above accidentally proved the 0.1x read multiplier on KIE. Early probes showed opus-4-8
 * missing its published price by a CONSTANT 0.79 credits on every request, which read exactly like a
 * flat per-request fee — a plausible, wrong, and expensive conclusion. It was `cache_read_input_tokens`:
 * KIE was serving 19,787 cached tokens of the repeated probe prefix, and 19,787 x $0.20/Mtok is
 * $0.0039574 = 0.79 credits, to four significant figures. Not a fee — a token class left out of the
 * equation. $0.20 is 0.1 x $2, so `CACHE_READ_MULTIPLIER` is now measured on this vendor rather than
 * inherited from Anthropic's docs.
 *
 * The lesson is the method, not the number: the CONTROL is what caught it. Fable's rates fitted their
 * probes beautifully while the control silently disagreed with a price we already knew — and without
 * the control, "it fits" would have shipped $4/$20 for the right reason and $2.36/$13.27 for the wrong
 * one, indistinguishably.
 */

/**
 * The RETIRED env price vars (2026-07-18) — set means STOP, never "quietly ignore".
 *
 * Prices moved out of the environment into the marketplace price list (baked +
 * admin-promoted, `market-price-store.ts`). The env keeps only MODEL SELECTORS
 * (`KIE_DEFAULT_MODEL`, `PREMIUM_MODEL`) and thresholds (`PREMIUM_MINIMUM_CREDITS`).
 *
 * A deploy still carrying one of these vars believes it is stating a price that nothing reads — the
 * exact "rates set but silently ignored" trap the old `kieModelOverride` refused, now one level up.
 * So they are refused loudly at config time, with directions to the panel that replaced them.
 */
const RETIRED_PRICE_ENV = [
  'KIE_INPUT_DOLLARS',
  'KIE_OUTPUT_DOLLARS',
  'KIE_CACHED_INPUT',
  'KIE_CACHED_WRITES',
  'PREMIUM_INPUT_DOLLARS',
  'PREMIUM_OUTPUT_DOLLARS',
] as const;

function refuseRetiredPriceEnv(context?: unknown): void {
  const set = RETIRED_PRICE_ENV.filter((key) => env(context, key)?.trim());

  if (set.length) {
    throw new NotConfiguredError(
      `${set.join(', ')} (set, but retired)`,
      'Prices no longer live in the environment — they are rows in the Marketplace price list, updated from ' +
        'the Admin panel (Settings → Admin → Marketplace prices) and versioned with rollback. Remove these ' +
        'variables; if you were repricing a model, promote a price list with its row instead.',
    );
  }

  return undefined;
}

/**
 * The operator's `KIE_DEFAULT_MODEL`, validated against the ACTIVE price list (2026-07-18).
 *
 * The model and its price used to be one env-var group (`KIE_INPUT_DOLLARS` et al); now the price
 * side lives in the marketplace price list, so this var is a pure SELECTOR — and it is only accepted
 * if the active list prices it. `ratesFor` falls back to the provider's most expensive row for an
 * unknown model, so an unpriced selection would not fail, it would bill at Opus 4.8's price forever.
 * "Is this model configured?" and "do we know what it costs?" remain the same question; the answer
 * just moved to the admin panel.
 */
export function kieDefaultModel(context?: unknown): string | undefined {
  refuseRetiredPriceEnv(context);

  const model = env(context, 'KIE_DEFAULT_MODEL')?.trim();

  if (!model) {
    return undefined;
  }

  const priced = activeMarketPrices().llm;

  if (!priced[model]) {
    throw new NotConfiguredError(
      `KIE_DEFAULT_MODEL="${model}"`,
      'The Marketplace price list has no row for it, so we cannot bill it — and an unpriced model does not ' +
        'bill as free, it bills at the most expensive model we know of. Add its row (input + output USD per ' +
        `million tokens) in Settings → Admin → Marketplace prices, then promote. Priced models: ${
          Object.keys(priced).join(', ') || '(none)'
        }.`,
    );
  }

  return model;
}

/**
 * KIE's rate table — the ACTIVE marketplace price list, as `ModelRates` (cache derived per row).
 *
 * Before any promotion this is exactly the baked table (`KIE_MODEL_RATES`); after one, it is whatever
 * the operator promoted. Callers hold no fallback of their own — a list that failed to load already
 * fell back to baked inside `activeMarketPrices()`.
 */
export function kieRates(context?: unknown): Record<string, ModelRates> {
  refuseRetiredPriceEnv(context);

  return llmRatesFromList(activeMarketPrices());
}

/**
 * The PREMIUM model tier (SPEC §4.6.1) — an opt-in, higher-cost model a user may choose ONCE they hold
 * enough credits to afford it, gated so a fresh signup grant cannot be burned on it out the gate.
 *
 * ## How this is different from the platform model, and why it is allowed to be a user choice
 *
 * The platform model is an OPERATOR config, never a user choice (§4.2a) — and that rule stands. The
 * premium tier does not break it: it is a choice between exactly TWO operator-configured, operator-priced
 * models, not BYOK and not a free-form model string. The client sends a BOOLEAN; the server maps it to
 * THIS model at THIS price. A client can never name an arbitrary (unpriced, expensive) model — the only
 * two reachable models are the platform default and this one.
 *
 * ## Model and price are ONE fact — and the price now lives in the marketplace list (2026-07-18)
 *
 * `PREMIUM_MODEL` names it; the ACTIVE price list prices it (`PREMIUM_*_DOLLARS` are RETIRED — setting
 * them is refused with directions to the Admin panel). The baked list carries Fable 5 at the measured
 * $4/$20, so the tier works with no env and no promotion at all. A `PREMIUM_MODEL` the active list does
 * not price is refused — the same "selector without a row" rule as `kieDefaultModel`.
 *
 * ⚠️ **ONE premium price for whichever provider is active** — the list row states what the premium model
 * costs on the provider the platform runs. On Anthropic, `claude-fable-5` has no `MODEL_RATES` row at
 * all — the `providerRates` injection is the ONLY thing that prices it there.
 *
 * ⚠️ `PREMIUM_MINIMUM_CREDITS` stays env (`envNumber`): it is a credit THRESHOLD, not a price, so a
 * fallback is correct — unlike a price, where a fallback is catastrophic.
 */
export const DEFAULT_PREMIUM_MODEL = 'claude-fable-5';
export const DEFAULT_PREMIUM_MINIMUM_CREDITS = 1200;

export interface PremiumTier {
  /** The model id, e.g. `claude-fable-5`. Reachable on any provider via the `providerRates` injection. */
  model: string;

  /** Its full rate row, from the active price list (cache derived). */
  rates: ModelRates;

  /** Credits a user must HOLD before premium unlocks — protects the free signup grant (§4.6.1). */
  minimumCredits: number;
}

export function getPremiumTier(context?: unknown): PremiumTier {
  refuseRetiredPriceEnv(context);

  const model = env(context, 'PREMIUM_MODEL')?.trim() || DEFAULT_PREMIUM_MODEL;
  const minimumCredits = envNumber(context, 'PREMIUM_MINIMUM_CREDITS', DEFAULT_PREMIUM_MINIMUM_CREDITS);
  const row = activeMarketPrices().llm[model];

  if (!row) {
    throw new NotConfiguredError(
      `PREMIUM_MODEL="${model}"`,
      'The Marketplace price list has no row for it, so we cannot bill it. Add its row (input + output USD ' +
        'per million tokens) in Settings → Admin → Marketplace prices, then promote — or unset PREMIUM_MODEL ' +
        `to use the default (${DEFAULT_PREMIUM_MODEL}).`,
    );
  }

  return { model, rates: ratesFromBase(row.inputPerMTok, row.outputPerMTok), minimumCredits };
}

/**
 * Every provider the PLATFORM can bill for. BYOK is charged zero, so it never reaches this table.
 *
 * A FUNCTION, not a constant, since 2026-07-17: KIE's row is the operator's to state (`kieRates`), and
 * a module-level constant would freeze whatever the environment held at import time.
 *
 * The premium model is injected into EVERY provider's table so it is priceable no matter who serves it
 * (§4.6.1). This is what makes `claude-fable-5` billable on Anthropic, which bakes no row for it — and
 * it is idempotent on KIE, where the default premium price matches the baked row exactly.
 */
export function providerRates(context?: unknown): Record<string, Record<string, ModelRates>> {
  /*
   * The premium injection must not be able to take SETTLEMENT down. `getPremiumTier` throws when the
   * active list has no row for `PREMIUM_MODEL` — correct at the premium DECISION (a loud config error
   * before any spend), and wrong here, where this table also prices in-flight settlement, which can
   * never refuse (§4.6). An unpriceable premium tier therefore skips injection: a premium generation
   * mid-flight settles through `ratesFor`'s most-expensive fallback — over-charging ourselves, the
   * safe direction — while new premium requests are refused loudly by `getPremiumModel`.
   */
  let premium: PremiumTier | undefined;

  try {
    premium = getPremiumTier(context);
  } catch {
    premium = undefined;
  }

  const withPremium = (table: Record<string, ModelRates>): Record<string, ModelRates> =>
    premium ? { ...table, [premium.model]: premium.rates } : table;

  return {
    Anthropic: withPremium(MODEL_RATES),
    KIE: withPremium(kieRates(context)),
  };
}

/**
 * Rates for a model on a given provider.
 *
 * ⚠️ **`provider` is REQUIRED, and deliberately has no default.** The same model id costs different
 * money depending on who served it, so "which provider was this?" is a question every call site must
 * answer — exactly as `restoreFiles` requires `protect`. A default of `'Anthropic'` would be the
 * cheapest possible way to over-bill every user by 2.5x the day the platform starts spending at KIE:
 * nothing would throw, no test would fail, and the invoices would just be wrong.
 *
 * An unknown model or provider must never bill as FREE. A missing entry silently zero-rating a
 * generation is exactly the revenue leak this file exists to prevent, so we fall back to the platform
 * model's rates on that provider, then to that provider's most expensive tier, and finally to
 * Anthropic Opus — the most expensive thing we know of. Every fallback is in the safe direction.
 */
export function ratesFor(model: string, provider: string, context?: unknown): ModelRates {
  const table = providerRates(context)[provider] ?? MODEL_RATES;

  return table[model] ?? mostExpensive(table) ?? MODEL_RATES['claude-opus-5'];
}

/**
 * The priciest row we know of, as the fallback for an unpriced model.
 *
 * This used to fall back to the PLATFORM model's rates, which was wrong twice over. It made this file
 * import `PLATFORM_MODEL` from the agent config — the cycle that stopped the config from validating a
 * model against these tables at all — and, worse, it meant an unpriced model billed at whatever the
 * platform model happened to cost, which is arbitrary: cheaper than reality if the platform model is
 * cheap, and silently under-charging us. Fall back to the most expensive thing instead. Every fallback
 * in this file errs in the same direction, because the alternative is a revenue leak with a friendly
 * face. Being wrong in our own favour is recoverable; being wrong the other way is invisible.
 */
function mostExpensive(table: Record<string, ModelRates>): ModelRates | undefined {
  return Object.values(table).sort((a, b) => b.outputPerMTok - a.outputPerMTok)[0];
}

export interface BillingConfig {
  /**
   * OFF by default (§4.6). Beta mode: grants are issued, usage is fully recorded, and NOBODY is
   * blocked. On: a zero balance stops a generation. The system is credit-native from day one; this
   * flag only controls ENFORCEMENT — never whether the ledger is written.
   */
  enforced: boolean;

  /** USD of underlying model cost that one credit is worth. */
  creditUnitCostUsd: number;

  /**
   * Retail multiple over raw cost. **4.0 ≈ 75% gross-margin target** (§4.6) — chosen for a specialty
   * game-dev platform, where COGS-shock resilience matters (we resell a discount provider's tokens) and
   * willingness-to-pay is Unity-anchored, not website-builder-anchored. Realized GM lands ~72–75% since
   * packs sell at ~$0.009–0.01/credit (`packMargin()` = `margin × pack$/credit ÷ CREDIT_UNIT_COST_USD`).
   */
  margin: number;

  /** The free signup grant, in credits. Gated on email verification (§4.5.4). */
  signupGrantCredits: number;

  /** Kill-switch: set false to stop issuing new grants without a deploy (§4.6). */
  grantsEnabled: boolean;

  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  stripePublishableKey?: string;
}

export function getBillingConfig(context?: unknown): BillingConfig {
  return {
    enforced: envFlag(context, 'BILLING_ENFORCED'),
    creditUnitCostUsd: envNumber(context, 'CREDIT_UNIT_COST_USD', 0.01),
    margin: envNumber(context, 'CREDIT_MARGIN', 4.0),

    /*
     * The free signup grant is PURE COST to the operator — it buys real model spend on our key with
     * no revenue behind it — so it is sized against a concrete intent, not a round number, and is
     * env-tunable (`SIGNUP_GRANT_CREDITS`) so the giveaway can be dialled without a deploy.
     *
     * COST OF ONE CREATION ON OPUS 4.8 — measured, not scaled. The optimized creation ("make me a
     * kart racer", `spec/context-budget.md`) is 12,862 output + 111,659 input tokens (the vector in
     * `COLD_CREATION_USAGE`). On Opus rates the credit cost turns entirely on cache warmth:
     *   - WARM prefix (the normal production state — the base prompt is byte-identical across every
     *     user on our one key, 1h TTL, so traffic keeps it primed): ~$0.42 raw ≈ **~140 credits**.
     *   - COLD prefix (first creation in an hour — pays the cache WRITE, which the user's own later
     *     edits then read back at 0.1x): ~$1.44 raw ≈ **~480 credits**; a live creation on a bigger
     *     game measured **513**.
     * ⚠️ An EDIT turn is **NOT** the "~41 credits" this comment used to claim. Live-measured edit
     * turns: 393 / 831 / 65 / 574 — the 65 is the warm-prefix FLOOR, the rest paid ~110–160k of cache
     * WRITES that nothing read back, because `selectOnDemandBlocks` re-routes per message and churns
     * the prefix. See CLAUDE.md "THE BIGGEST OPEN NUMBER". Budget ~466, not ~41.
     *
     * ⚠️ **THIS NUMBER IS COUPLED TO THE PLATFORM PROVIDER — they are one decision in two files.**
     * Credits are cost-proportional, so the grant's real purchasing power moves with what we pay per
     * token. The default is 800 at `CREDIT_MARGIN = 4.0`: generous on KIE, still broken on Anthropic.
     * `grantHeadroom()` is the guard and `billing.spec.ts` asserts `MIN_GRANT_HEADROOM` — never tune one
     * without re-running it (margin, provider, AND grant are one decision in three places):
     *   - **KIE (the default, ~0.4x rates): 800** ≈ 3.5x a cold creation at margin 4.0 (~231 credits;
     *     live creations at margin 3.34 measured 211–248, ~1.2x more under 4.0). 800 buys the prototype
     *     plus real room to iterate — the whole funnel: hook them on the first prompt, then convert.
     *   - **Anthropic: would need ~1,200+.** A cold creation there is ~576 credits at margin 4.0, so an
     *     800 grant is only ~1.4x — under the 1.5x floor: the first free prompt plus one edit exhausts
     *     it and lands the user negative (the gate runs ONCE, before the model, settlement can never
     *     refuse, §4.2.1), killing the exact moment the funnel is built on, silently.
     */
    signupGrantCredits: envNumber(context, 'SIGNUP_GRANT_CREDITS', 800),
    grantsEnabled: envFlag(context, 'GRANTS_ENABLED', true),

    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
  };
}

export interface TokenUsage {
  /** UNCACHED input only — Anthropic reports cached input separately (§4.2.8). */
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Raw model cost of a generation, in USD. The honest number, before any margin. */
export function rawCostUsd(usage: TokenUsage, model: string, provider: string, context?: unknown): number {
  const rates = ratesFor(model, provider, context);

  return (
    (usage.promptTokens * rates.inputPerMTok +
      usage.completionTokens * rates.outputPerMTok +
      usage.cacheReadTokens * rates.cacheReadPerMTok +
      usage.cacheCreationTokens * rates.cacheWritePerMTok) /
    1_000_000
  );
}

/**
 * `credits_charged = ceil(rawCost / CREDIT_UNIT_COST * MARGIN)` (§4.6).
 *
 * Always at least 1 credit for a generation that produced ANY tokens: rounding a real generation down
 * to zero would let a user with an empty balance keep generating forever, one cheap turn at a time.
 * A generation that produced nothing at all (an immediate abort) is genuinely free.
 */
export function creditsForUsage(
  usage: TokenUsage,
  model: string,
  provider: string,
  config: BillingConfig,
  context?: unknown,
): number {
  return creditsForRawCost(rawCostUsd(usage, model, provider, context), config);
}

/**
 * The same retail formula on a flat USD cost — what §4.16 media debits use, where the raw cost is a
 * known per-task price (`lookupMediaPrice`) rather than a token vector. ONE formula for both kinds
 * of spend, so the margin lever moves them together.
 */
export function creditsForRawCost(cost: number, config: BillingConfig): number {
  if (cost <= 0) {
    return 0;
  }

  return Math.max(1, Math.ceil((cost / config.creditUnitCostUsd) * config.margin));
}

/**
 * A COLD project creation, as a token vector — the single most important generation in the product.
 *
 * Expressed in TOKENS rather than dollars on purpose: a raw-USD constant would be an Anthropic number
 * wearing no label, and would quietly become a lie the moment the platform bills a different provider.
 * As tokens it re-prices itself correctly through `ratesFor` under any provider, forever.
 *
 * Measured (`spec/context-budget.md`, `rates.ts` grant sizing): the optimized creation is ~111,659
 * input / ~12,862 output tokens, and COLD means the prefix is not yet primed, so the input is paid at
 * the 1-hour cache WRITE rate — the expensive case, and the one a new user's very first prompt hits.
 * On Anthropic Opus that prices to ~$1.44 / ~481 credits, which reproduces the figure this file has
 * always quoted. Live creations have measured as high as 513 credits on a bigger game, so treat this
 * as the LOW end of cold — which is exactly why the headroom floor below is not 1.0.
 */
export const COLD_CREATION_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 12_862,
  cacheReadTokens: 0,
  cacheCreationTokens: 111_659,
};

/**
 * How many cold creations the free signup grant buys.
 *
 * ⚠️ **The grant size and the provider are ONE number split across two files** — the same shape of bug
 * as `packMargin()` (a pack's price and `CREDIT_MARGIN` disagreeing, silently, at ~19% a generation).
 * A grant is denominated in credits, credits are cost-proportional, and cost depends on the provider —
 * so `SIGNUP_GRANT_CREDITS = 800` at margin 4.0 is comfortable on KIE (~231 credits a creation, ~3.5x
 * headroom) and BROKEN on Anthropic (~576, i.e. ~1.4x: below the 1.5x floor — the first prompt plus an
 * edit exhausts the grant and lands the user negative, with nothing left to iterate).
 *
 * That failure would be silent and would land on the ONE moment the funnel depends on — a new user's
 * first prototype. `billing.spec.ts` asserts this floor so the two numbers cannot drift apart.
 */
export function grantHeadroom(config: BillingConfig, model: string, provider: string, context?: unknown): number {
  return config.signupGrantCredits / creditsForUsage(COLD_CREATION_USAGE, model, provider, config, context);
}

/**
 * The grant must buy the hook, plus room to iterate.
 *
 * Not 1.0: a grant that exactly covers a creation buys a prototype and then a dead end, and the point
 * of the free grant is a user who likes what they made and edits it. 1.5x is one cold build plus a few
 * warm edit turns — deliberately modest, because every credit here is pure operator cost (§4.6).
 */
export const MIN_GRANT_HEADROOM = 1.5;
