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
};

/**
 * KIE.ai's rates for the same models (`providers/kie.ts`), USD per million tokens.
 *
 * A uniform **0.4x** of Anthropic list across all four token classes — input $2 vs $5, output $10 vs
 * $25 — and the cache multipliers are Anthropic's own (0.1x read, 2.0x the 1-hour write), applied to
 * the discounted base. That uniformity is why the switch has no mix effects; `billing.spec.ts` pins it
 * so a future vendor reprice that breaks it cannot pass silently.
 *
 * ⚠️ **These are the rates we ACTUALLY PAY, and that is the entire contract of this file** — "the
 * honest number, before any margin". Credits are cost-proportional (`creditsForUsage`), so leaving the
 * Anthropic numbers here while spending at KIE's would not be a rounding error: it would charge every
 * user ~2.5x the credits their generation actually cost us. That is a pricing decision, and it belongs
 * in `CREDIT_MARGIN` where it is visible and asserted — never smuggled in as a wrong cost.
 *
 * The operator's choice here was to PASS THE DISCOUNT THROUGH: margin stays 3.34, so profit per pack is
 * unchanged and the same $50 buys ~2.5x more work. That is not charity — `CREDIT_MARGIN x pack $/credit`
 * math (see `stripe.ts`) put a $50/6,000-credit plan at ~13 edits/month against measured edit turns,
 * which is not a viable product. At KIE rates the same pack is ~32 edits.
 */
export const KIE_MODEL_RATES: Record<string, ModelRates> = {
  'claude-opus-4-8': {
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
    cacheReadPerMTok: 0.2, // 0.1x of the $2 base
    cacheWritePerMTok: 4.0, // 2x of the $2 base — the 1h tier, matching `proxy.ts`
  },
};

/**
 * A price, from the environment. **Not `envNumber` — a typo here is not survivable.**
 *
 * `envNumber` returns its fallback for an unparseable value, which is right for a turn cap and wrong
 * for money: `KIE_INPUT_DOLLARS=$2` would silently price every generation at some other model's rate
 * and throw nothing. A price the operator tried and failed to state is a config error, never a default.
 * Zero is refused for the same reason — a free model does not exist, so `=0` is a mistake, and it would
 * zero-rate every generation on it (the exact revenue leak `ratesFor`'s fallbacks exist to prevent).
 */
function envMoney(context: unknown, key: string): number | undefined {
  const raw = env(context, key)?.trim();

  if (!raw) {
    return undefined;
  }

  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new NotConfiguredError(`${key}="${raw}"`, 'It must be a positive number of US dollars per million tokens.');
  }

  return parsed;
}

/** The KIE rate vars, as one list — so a "you set rates but no model" check cannot miss one. */
const KIE_RATE_ENV = ['KIE_INPUT_DOLLARS', 'KIE_OUTPUT_DOLLARS', 'KIE_CACHED_INPUT', 'KIE_CACHED_WRITES'] as const;

/**
 * The operator's KIE model + its price, from the environment (2026-07-17).
 *
 * ## Why the model and its rates are ONE variable group, and not two
 *
 * KIE resells many vendors' models and reprices them independently of anyone's list. So unlike
 * Anthropic — whose prices we can look up and bake — "which KIE model" and "what does it cost" are a
 * single fact that only the operator holds, and splitting them across a config knob and a code table
 * is what guarantees they drift. `KIE_INPUT_DOLLARS` therefore prices exactly `KIE_DEFAULT_MODEL`:
 * they are one ROW, entered together, or neither is accepted.
 *
 * ## The rules, each of which exists because its absence is a SILENT mis-bill
 *
 *  - **Rates with no model are refused.** They would price nothing, so they are a typo — and a typo
 *    that reads as configured. The operator would see their numbers in `.env` and believe them.
 *  - **A model we have no baked row for REQUIRES input+output.** This is the whole point. `ratesFor`
 *    falls back to the provider's most expensive row for an unknown model, so `KIE_DEFAULT_MODEL=x`
 *    alone would bill every generation at Opus 4.8's price, forever, and throw nothing. "Is this model
 *    configured?" and "do we know what it costs?" are the same question (see `agent/config.ts`).
 *  - **Cache re-derives from the FINAL input rate** unless quoted — see `CACHE_READ_MULTIPLIER`. For
 *    `KIE_DEFAULT_MODEL=claude-opus-4-8` with nothing else set, the derivation reproduces the baked
 *    row byte-for-byte ($2 -> $0.2 read / $4 write), which is why this is a safe default rather than
 *    a second opinion about a known price.
 *  - **A baked row supplies input/output only, never cache.** Overriding input alone must not leave
 *    cache quoted against the old base.
 *
 * Returns `undefined` when nothing is set — the baked table stands, unchanged.
 */
export interface KieModelOverride {
  model: string;
  rates: ModelRates;
}

export function kieModelOverride(context?: unknown): KieModelOverride | undefined {
  const model = env(context, 'KIE_DEFAULT_MODEL')?.trim();

  const input = envMoney(context, 'KIE_INPUT_DOLLARS');
  const output = envMoney(context, 'KIE_OUTPUT_DOLLARS');
  const cacheReadPerMTok = envMoney(context, 'KIE_CACHED_INPUT');
  const cacheWritePerMTok = envMoney(context, 'KIE_CACHED_WRITES');

  if (!model) {
    const quoted = KIE_RATE_ENV.filter((key) => env(context, key)?.trim());

    if (quoted.length) {
      throw new NotConfiguredError(
        `${quoted.join(', ')} (set) but KIE_DEFAULT_MODEL`,
        'Those rates price KIE_DEFAULT_MODEL, so on their own they price nothing and are silently ignored. Set KIE_DEFAULT_MODEL, or remove them.',
      );
    }

    return undefined;
  }

  const baked = KIE_MODEL_RATES[model];
  const finalInput = input ?? baked?.inputPerMTok;
  const finalOutput = output ?? baked?.outputPerMTok;

  if (finalInput === undefined || finalOutput === undefined) {
    throw new NotConfiguredError(
      `KIE_DEFAULT_MODEL="${model}"`,
      'We have no rates baked in for it, so KIE_INPUT_DOLLARS and KIE_OUTPUT_DOLLARS are both required — a model we cannot price is a model we cannot bill, and an unpriced model does not bill as free, it bills at the most expensive model we know of. Get the numbers from the KIE console. ' +
        `Models priced without them: ${Object.keys(KIE_MODEL_RATES).join(', ')}.`,
    );
  }

  return { model, rates: ratesFromBase(finalInput, finalOutput, { cacheReadPerMTok, cacheWritePerMTok }) };
}

/** KIE's rate table: the baked rows, with the operator's `KIE_DEFAULT_MODEL` row added or overriding. */
export function kieRates(context?: unknown): Record<string, ModelRates> {
  const override = kieModelOverride(context);

  return override ? { ...KIE_MODEL_RATES, [override.model]: override.rates } : KIE_MODEL_RATES;
}

/**
 * Every provider the PLATFORM can bill for. BYOK is charged zero, so it never reaches this table.
 *
 * A FUNCTION, not a constant, since 2026-07-17: KIE's row is the operator's to state (`kieRates`), and
 * a module-level constant would freeze whatever the environment held at import time.
 */
export function providerRates(context?: unknown): Record<string, Record<string, ModelRates>> {
  return {
    Anthropic: MODEL_RATES,
    KIE: kieRates(context),
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

  return table[model] ?? mostExpensive(table) ?? MODEL_RATES['claude-opus-4-8'];
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

  /** Retail multiple over raw cost. 3.34 ≈ 70% gross margin, the §4.6 target. */
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
    margin: envNumber(context, 'CREDIT_MARGIN', 3.34),

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
     * token. A grant of 500 is generous on KIE and broken on Anthropic. `grantHeadroom()` is the guard
     * and `billing.spec.ts` asserts `MIN_GRANT_HEADROOM` — never tune one without re-running it:
     *   - **KIE (the default, ~0.4x rates): 500** ≈ 2.0–2.6x a cold creation. MEASURED live: creations
     *     cost 248 and 211 credits, so 500 buys the prototype plus real room to iterate — which is the
     *     entire funnel: hook them on the first prompt, then convert to a subscription.
     *   - **Anthropic: 1,000** ≈ 2.1x. 500 there is **0.86–1.04x** — MEASURED: a real creation cost 579
     *     credits against a 500 grant, so the user's FIRST free prompt exhausts it and lands them
     *     negative (the gate runs ONCE, before the model, and settlement can never refuse, §4.2.1),
     *     with nothing left to iterate. That kills the exact moment the funnel is built on, silently.
     */
    signupGrantCredits: envNumber(context, 'SIGNUP_GRANT_CREDITS', 500),
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
  const cost = rawCostUsd(usage, model, provider, context);

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
 * so `SIGNUP_GRANT_CREDITS = 500` is comfortable on KIE (~192 credits a creation, ~2.6x headroom) and
 * BROKEN on Anthropic (~481–513, i.e. 0.97–1.04x: the first free prompt exhausts the grant and lands
 * the user negative, with nothing left to iterate).
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
