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
 * ⚠️ **EVERY ROW IS LOOKED UP, NEVER DERIVED FROM A RATIO.** `claude-opus-4-8` happens to be a uniform
 * 0.4x of Anthropic list ($2 vs $5 in, $10 vs $25 out), and it is tempting to read that as "KIE is 0.4x".
 * It is not a rule: 4.7 is ~0.285x and fable-5 is 2x Anthropic's Opus list — KIE resells many vendors at
 * prices only their console shows. A ratio that holds for one row is a coincidence, and the moment it is
 * treated as a formula the next model is mispriced silently. The cache multipliers ARE shared (0.1x read,
 * 2.0x the 1-hour write, applied to each row's own discounted base) and that one IS measured — see the
 * note below the table.
 *
 * ⚠️ **These are the rates we ACTUALLY PAY, and that is the entire contract of this file** — "the
 * honest number, before any margin". Credits are cost-proportional (`creditsForUsage`), so leaving the
 * Anthropic numbers here while spending at KIE's would not be a rounding error: it would charge every
 * user ~2.5x the credits their generation actually cost us. That is a pricing decision, and it belongs
 * in `CREDIT_MARGIN` where it is visible and asserted — never smuggled in as a wrong cost.
 *
 * The operator's choice was to PASS THE DISCOUNT THROUGH: margin stays 3.34, so profit per pack is
 * unchanged and the same $50 buys ~2.5x more work.
 *
 * ⚠️ **Do not re-derive the edits-per-plan figure from this table alone — it is dominated by the CACHE,
 * not by these rates.** An earlier version of this comment quoted "~13 edits/month at Anthropic, ~32 at
 * KIE" and both numbers are dead: they were measured while per-message block routing churned the cached
 * prefix, so every edit paid a ~110k cache WRITE at 2x. With sticky routing (`selectStickyBlocks`) a warm
 * edit on this row measures ~11 credits — a $50/6,000-credit pack is **~545 edits**, not 32. A stale
 * number here reads as "the plan is unviable" and invites a reprice that fixes nothing.
 */
export const KIE_MODEL_RATES: Record<string, ModelRates> = {
  /**
   * NOT the platform default — priced and listed so `LLM_MODEL`/`KIE_DEFAULT_MODEL` can select it, and
   * because an unpriced model bills at the provider's most expensive row (`ratesFor`).
   *
   * Rates from the operator's KIE console, 2026-07-17: $1.425 in / $7.15 out — ~0.285x of Anthropic's
   * Opus list, a harder discount than 4.8's 0.4x. It is a release behind, hence cheaper.
   *
   * It is the only Opus on KIE that returns THINKING TEXT (266 chars measured, against 4.8's 0 in every
   * shape tried) — but that did not win it the default. KIE's accounting for this row is BROKEN: it
   * reports `cache_creation_input_tokens: 0` while charging 2x for the write, so its usage numbers cannot
   * be settled against. `claude-opus-4-8` is the only KIE row that accounts honestly (10,004 reported =
   * 8.02 credits charged, exact), and being able to bill correctly outranks a visible reasoning panel.
   */
  'claude-opus-4-7': {
    inputPerMTok: 1.425,
    outputPerMTok: 7.15,
    cacheReadPerMTok: 0.1425, // 0.1x — the multiplier is MEASURED on KIE, see the note below
    cacheWritePerMTok: 2.85, // 2x — the 1h tier, matching `proxy.ts`
  },

  /**
   * **THE PLATFORM DEFAULT** (`DEFAULT_MODEL` in `app/utils/constants.ts`, with `LLM_PROVIDER=KIE`).
   *
   * It wins on ACCOUNTING, not on price — 4.7 is cheaper. This is the only KIE row whose usage numbers
   * can be settled against: a probe reporting 10,004 write tokens was charged 8.02 credits, exact to the
   * published $2/$10. Both other rows report `cache_creation_input_tokens: 0` while charging 2x for the
   * write, which would make every generation on them bill from numbers we know to be wrong.
   *
   * Caching verified on this row against the live vendor, 2026-07-17 (30 byte-identical requests, then 15
   * more): KIE warms per backend — misses cluster in the first ~13 requests to a NEW prefix (4/29, at
   * 2/4/7/13) and then hold at 0/14 once warm, against an Anthropic control of 0/29. So the warmup is
   * per distinct prefix, and our largest cached block (the base prompt) is byte-identical for every user
   * and project — it warms once and stays warm on any real traffic. ⚠️ An earlier reading of a SIX-request
   * sample called this "KIE randomly drops ~1/3 of cache entries" and nearly bought a 2.5x provider switch
   * on it; that sample sat entirely inside the warmup window. Steady-state miss rate is ~0.
   *
   * KNOWN VENDOR BUG: returns 0 chars of thinking text on this row in every shape tried (4.7 gives 266,
   * fable-5 ~224). It thinks — it just will not show it, so the `ThinkingPanel` stays empty on KIE.
   */
  'claude-opus-4-8': {
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
    cacheReadPerMTok: 0.2, // 0.1x of the $2 base
    cacheWritePerMTok: 4.0, // 2x of the $2 base — the 1h tier, matching `proxy.ts`
  },

  /**
   * MEASURED against KIE's own `credits_consumed`, 2026-07-17 — not published, not guessed.
   *
   * A four-point input sweep (2,126 -> 25,227 tokens) converges $4.069 -> $4.011 -> **$4.006**, and an
   * output-dominated probe returns **$19.99**. Both land on round numbers, and the same method with
   * `claude-opus-4-8` as a CONTROL reproduces its published $2.00 / $10.00 exactly — which is the only
   * reason these two numbers are in a rate table rather than in a comment.
   *
   * ⚠️ **Fable 5 is 2x Opus 4.8 on KIE, not cheaper.** It is here because it is the strongest model KIE
   * serves whose thinking text their adapter actually returns (`kie-wire.ts`: 224/223 chars with
   * `thinkingFlag`, against 4-8's 0/0/0). That is the trade — visible reasoning at double the price.
   */
  'claude-fable-5': {
    inputPerMTok: 4.0,
    outputPerMTok: 20.0,
    cacheReadPerMTok: 0.4, // 0.1x — the multiplier is CONFIRMED on KIE, see below
    cacheWritePerMTok: 8.0, // 2x of the $4 base — the 1h tier, matching `proxy.ts`
  },
};

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
 * ## Model and price are ONE fact — the invariant this whole file rests on
 *
 * `PREMIUM_MODEL` names it; `PREMIUM_INPUT_DOLLARS`/`PREMIUM_OUTPUT_DOLLARS` price it (via `envMoney`, so
 * a typo throws rather than silently billing at another model's rate); cache re-derives from the final
 * input rate (`ratesFromBase`). The defaults bake **Fable 5 at $4/$20 — 2x Opus 4.8 on KIE** — so the
 * tier works with no env at all, and on the default provider (KIE) that price is EXACT (the baked
 * `KIE_MODEL_RATES['claude-fable-5']` is byte-identical, so injecting it changes nothing there).
 *
 * ⚠️ **ONE premium price for whichever provider is active** — deliberately not a second per-provider env
 * group. The operator sets `PREMIUM_*_DOLLARS` to the premium model's real cost on the provider they run.
 * On Anthropic, `claude-fable-5` has no baked row at all (`MODEL_RATES` stays fable-5-free, so the "0.4x
 * uniform" and "no Anthropic row" invariants in `billing.spec.ts` are untouched) — this injection is the
 * ONLY thing that prices it there, at the operator-stated premium price.
 *
 * ⚠️ `PREMIUM_MINIMUM_CREDITS` is `envNumber`, NOT `envMoney`: it is a credit THRESHOLD, not dollars per
 * million tokens, so a fallback is correct (unlike a price, where a fallback is catastrophic).
 */
export const DEFAULT_PREMIUM_MODEL = 'claude-fable-5';
export const DEFAULT_PREMIUM_INPUT_DOLLARS = 4;
export const DEFAULT_PREMIUM_OUTPUT_DOLLARS = 20;
export const DEFAULT_PREMIUM_MINIMUM_CREDITS = 1000;

export interface PremiumTier {
  /** The model id, e.g. `claude-fable-5`. Reachable on any provider via the `providerRates` injection. */
  model: string;

  /** Its full rate row, priced from `PREMIUM_*_DOLLARS` (cache derived). */
  rates: ModelRates;

  /** Credits a user must HOLD before premium unlocks — protects the free signup grant (§4.6.1). */
  minimumCredits: number;
}

export function getPremiumTier(context?: unknown): PremiumTier {
  const model = env(context, 'PREMIUM_MODEL')?.trim() || DEFAULT_PREMIUM_MODEL;
  const input = envMoney(context, 'PREMIUM_INPUT_DOLLARS') ?? DEFAULT_PREMIUM_INPUT_DOLLARS;
  const output = envMoney(context, 'PREMIUM_OUTPUT_DOLLARS') ?? DEFAULT_PREMIUM_OUTPUT_DOLLARS;
  const minimumCredits = envNumber(context, 'PREMIUM_MINIMUM_CREDITS', DEFAULT_PREMIUM_MINIMUM_CREDITS);

  return { model, rates: ratesFromBase(input, output), minimumCredits };
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
  const premium = getPremiumTier(context);
  const withPremium = (table: Record<string, ModelRates>): Record<string, ModelRates> => ({
    ...table,
    [premium.model]: premium.rates,
  });

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
