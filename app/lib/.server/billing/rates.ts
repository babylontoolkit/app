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
import { extendedModelsEnabled } from './extended-models';
import type { MarketPriceList } from './market-prices';
import { BAKED_MARKET_PRICES } from './baked-market-prices';
import { activeMarketPrices } from './market-price-store';
import { FAMILY_POLICY, familyOf } from '~/lib/modules/llm/model-families';
import {
  PAID_MODEL_TIERS,
  STANDARD_TIER_LABEL,
  paidModelTierDefinition,
  type ModelTierId,
  type PaidModelTierId,
} from './model-tiers';

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

/**
 * A full `ModelRates` table from a price list's llm rows, with cache resolved by FAMILY POLICY.
 *
 * The three profiles (`model-families.ts`, validated into the list by `market-prices.ts`):
 *
 *  - `derived` (claude-*) — the historical behavior, byte-identical: 0.1x read / 2.0x 1h write off
 *    each row's own input rate, measured on this vendor.
 *  - `explicit-pair` (gpt-*) — KIE publishes both prices and neither is a multiple of input, so the
 *    row's quotes are used verbatim. Validation guarantees both halves are present.
 *  - `none` (gemini-*) — KIE quotes no cached rate and reports no cached-token counter, so cached
 *    tokens bill at the FULL INPUT rate (read = write = input). Deliberately NOT a discount: we do
 *    not grant one we cannot verify, and we do not add a surcharge we cannot observe. This is why the
 *    admin margin report may show a Gemini warm edit costing what a cold one costs — by design, not a
 *    caching regression (spec edge case).
 *
 * ⚠️ An UNKNOWN family falls back to `derived`. Validation refuses such a row on the way in, so this
 * is only reachable for a baked/stored row that predates the family rules — deriving is the same
 * answer the function has always given, which keeps this fallback a no-op rather than a new opinion.
 */
export function llmRatesFromList(list: MarketPriceList): Record<string, ModelRates> {
  return Object.fromEntries(
    Object.entries(list.llm).map(([model, rate]) => {
      const profile = familyOf(model) ? FAMILY_POLICY[familyOf(model)!].cacheProfile : 'derived';

      /*
       * ⚠️ The `explicit-pair` branch passes `number | undefined`, and `ratesFromBase` treats
       * `undefined` as "derive". Validation is the ONLY thing guaranteeing both halves are present —
       * a gpt row that reached this table without passing `validateMarketPriceList` would silently
       * fall back to claude's 0.1x/2.0x. That is why the pair is enforced atomically at the wall
       * rather than defended here: there is no honest default for a price the vendor publishes.
       */
      const cache =
        profile === 'explicit-pair'
          ? { cacheReadPerMTok: rate.cachedInputPerMTok, cacheWritePerMTok: rate.cacheWritePerMTok }
          : profile === 'none'
            ? { cacheReadPerMTok: rate.inputPerMTok, cacheWritePerMTok: rate.inputPerMTok }
            : undefined;

      return [model, ratesFromBase(rate.inputPerMTok, rate.outputPerMTok, cache)];
    }),
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
 * The MODEL TIER LADDER (SPEC §4.6.1a) — the paid rungs above the platform model, resolved and priced.
 *
 * The ladder's shape lives in `model-tiers.ts` (data only, no imports); this is where a rung meets the
 * environment and the ACTIVE Marketplace price list. A user may choose a paid rung ONCE they hold
 * enough credits to afford it, which is what stops a fresh signup grant being burned on the expensive
 * models out the gate.
 *
 * ## How this is different from the platform model, and why it is allowed to be a user choice
 *
 * The platform model is an OPERATOR config, never a user choice (§4.2a) — and that rule stands. The
 * ladder does not break it: it is a choice among a FIXED set of operator-configured, operator-priced
 * models, not BYOK and not a free-form model string. The client sends a tier ID; the server maps it to
 * THAT rung's model at THAT rung's price. A client can never name an arbitrary (unpriced, expensive)
 * model — the only reachable models are the platform default and the configured rungs.
 *
 * ## Model and price are ONE fact — and the price lives in the marketplace list (2026-07-18)
 *
 * A rung's env var names its model; the ACTIVE price list prices it (`PREMIUM_*_DOLLARS` are RETIRED —
 * setting them is refused with directions to the Admin panel). The baked list carries every default
 * rung, so the ladder works with no env and no promotion at all. A selector the active list does not
 * price is refused — the same "selector without a row" rule as `kieDefaultModel`.
 *
 * ⚠️ **ONE price per rung for whichever provider is active** — the list row states what that model
 * costs on the provider the platform runs. On Anthropic, `claude-fable-5` has no `MODEL_RATES` row at
 * all, so the `providerRates` injection is the ONLY thing that prices it there. ⚠️ That injection
 * FILLS A GAP and never overwrites: a rung may now name a model Anthropic prices natively.
 *
 * ⚠️ The thresholds stay env (`envNumber`): a credit THRESHOLD may have a fallback — unlike a price,
 * where a fallback is catastrophic.
 */
export {
  DEFAULT_PREMIUM_MINIMUM_CREDITS,
  DEFAULT_PREMIUM_MODEL,
  DEFAULT_SUPERMAX_MINIMUM_CREDITS,
  DEFAULT_SUPERMAX_MODEL,
} from './model-tiers';

/** A paid rung, fully resolved: which model it runs, what that costs, and what it takes to unlock. */
export interface ModelTier {
  id: PaidModelTierId;

  /** The user-facing name (`Premium`, `SuperMax`) — from the tier table, never re-typed. */
  label: string;

  /** The model id, e.g. `claude-fable-5`. Reachable on any provider via the `providerRates` injection. */
  model: string;

  /** Its full rate row, from the active price list (cache derived). */
  rates: ModelRates;

  /** Credits a user must HOLD before this rung unlocks — protects the free signup grant (§4.6.1). */
  minimumCredits: number;

  /** Never runs on the first build turn — see `firstBuildLocked` in `model-tiers.ts` for the evidence. */
  firstBuildLocked: boolean;
}

/**
 * Resolve one paid rung against the environment and the ACTIVE price list.
 *
 * Throws `NotConfiguredError` when the tier's selector names a model the list cannot price. That is
 * the correct behaviour at a DECISION point (a loud config error before any spend) and the wrong one
 * where a read must degrade — `/api/me` and `providerRates` both catch it, and `getModelTiers` below
 * exists so a caller that must not throw does not have to write that try/catch itself.
 */
export function getModelTier(id: PaidModelTierId, context?: unknown): ModelTier {
  refuseRetiredPriceEnv(context);

  const definition = paidModelTierDefinition(id);
  const model = env(context, definition.modelEnvKey)?.trim() || definition.defaultModel;
  const minimumCredits = envNumber(context, definition.minimumEnvKey, definition.defaultMinimumCredits);
  const row = activeMarketPrices().llm[model];

  if (!row) {
    const priced = Object.keys(activeMarketPrices().llm).join(', ') || '(none)';

    throw new NotConfiguredError(
      `${definition.modelEnvKey}="${model}"`,
      'The Marketplace price list has no row for it, so we cannot bill it — and an unpriced model does not ' +
        'bill as free, it bills at the most expensive model we know of. Add its row (input + output USD per ' +
        `million tokens) in Settings → Admin → Marketplace prices, then promote — or unset ${definition.modelEnvKey} ` +
        `to use the default (${definition.defaultModel}). Priced models: ${priced}.`,
    );
  }

  return {
    id: definition.id,
    label: definition.label,
    model,
    rates: ratesFromBase(row.inputPerMTok, row.outputPerMTok),
    minimumCredits,
    firstBuildLocked: definition.firstBuildLocked,
  };
}

/** One rung as reported to a caller that may not throw — the whole ladder, misconfiguration included. */
export interface ModelTierStatus {
  id: ModelTierId;
  label: string;

  /** The model this rung would run. On a misconfigured rung this is the in-code DEFAULT, not the selector. */
  model: string;

  /** Zero for `standard` — the free rung has no threshold. */
  minimumCredits: number;

  firstBuildLocked: boolean;

  /**
   * Can this rung actually be served right now? False when its selector cannot be priced.
   *
   * 🔴 A misconfigured rung reports `false`, never `true` on the baked default's behalf. Reporting a
   * capability as available when `getModelTier` would refuse it renders an enabled control that
   * hard-fails on use — the 2026-07-25 `premiumSessionHint` lesson. Degrading to "off" is honest.
   */
  serveable: boolean;

  /** Operator-facing reason, present iff `!serveable`. Never shown to an end user. */
  reason?: string;
}

/**
 * The whole ladder, resolved, NEVER throwing.
 *
 * `standardModel` is a parameter rather than something this function resolves, and that is structural:
 * the platform model is `getPlatformModel`'s to state (`agent/config.ts`), and this file must not
 * import that module — the cycle documented at `mostExpensive` below. Its callers already hold the
 * standard model, guarded, for exactly this reason.
 */
export function getModelTiers(standardModel: string, context?: unknown): ModelTierStatus[] {
  const standard: ModelTierStatus = {
    id: 'standard',
    label: STANDARD_TIER_LABEL,
    model: standardModel,
    minimumCredits: 0,
    firstBuildLocked: false,
    serveable: true,
  };

  /*
   * 🔴 `ENABLE_EXTENDED_MODELS=false` → the ladder IS the standard rung, and every downstream rule
   * follows from that single fact rather than from a second code path (see `extended-models.ts`).
   * `decideModelTier` already resolves a rung it cannot find DOWN to standard, `/api/me` reports one
   * option so the picker has nothing to open, and `getTierModel` refuses independently.
   *
   * Returning them as `serveable: false` instead would be wrong in a way that matters: that state means
   * "misconfigured — an operator must fix something", and it renders a LOCKED row, i.e. the UI keeps
   * advertising classes this deploy has deliberately withdrawn.
   */
  if (!extendedModelsEnabled(context)) {
    return [standard];
  }

  const paid = PAID_MODEL_TIERS.map((definition): ModelTierStatus => {
    try {
      const tier = getModelTier(definition.id, context);

      return {
        id: tier.id,
        label: tier.label,
        model: tier.model,
        minimumCredits: tier.minimumCredits,
        firstBuildLocked: tier.firstBuildLocked,
        serveable: true,
      };
    } catch (error) {
      /*
       * The threshold is still readable — `envNumber` cannot throw — so the locked rung can still
       * state what it WOULD cost to unlock. Only the model half is in doubt, and that reports as the
       * in-code default rather than the unpriceable selector: naming a model we refuse to bill would
       * put a model the platform will not run in front of the user.
       */
      return {
        id: definition.id,
        label: definition.label,
        model: definition.defaultModel,
        minimumCredits: envNumber(context, definition.minimumEnvKey, definition.defaultMinimumCredits),
        firstBuildLocked: definition.firstBuildLocked,
        serveable: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });

  return [standard, ...paid];
}

/** @deprecated Use `ModelTier`. Kept so existing premium-only callers keep their type name. */
export type PremiumTier = ModelTier;

/** The premium rung, by its old name. One implementation, so premium and SuperMax cannot drift. */
export function getPremiumTier(context?: unknown): ModelTier {
  return getModelTier('premium', context);
}

/**
 * Every provider the PLATFORM can bill for. BYOK is charged zero, so it never reaches this table.
 *
 * A FUNCTION, not a constant, since 2026-07-17: KIE's row is the operator's to state (`kieRates`), and
 * a module-level constant would freeze whatever the environment held at import time.
 *
 * EVERY paid rung of the model tier ladder is injected into EVERY provider's table so it is priceable
 * no matter who serves it (§4.6.1a). This is what makes `claude-fable-5` billable on Anthropic, which
 * bakes no row for it — and it is idempotent on KIE, whose table derives from the same price list.
 */
export function providerRates(context?: unknown): Record<string, Record<string, ModelRates>> {
  /*
   * The ladder injection must not be able to take SETTLEMENT down. `getModelTier` throws when the
   * active list has no row for a rung's selector — correct at the tier DECISION (a loud config error
   * before any spend), and wrong here, where this table also prices in-flight settlement, which can
   * never refuse (§4.6). An unpriceable rung therefore skips ITS OWN injection and leaves the others
   * standing: a generation on it mid-flight settles through `ratesFor`'s most-expensive fallback —
   * over-charging ourselves, the safe direction — while new requests for it are refused loudly by
   * `getTierModel`.
   */
  const tiers = PAID_MODEL_TIERS.flatMap((definition) => {
    try {
      return [getModelTier(definition.id, context)];
    } catch {
      return [];
    }
  });

  /**
   * 🔴 **FILL A GAP, NEVER OVERWRITE A PROVIDER'S OWN ROW** (found 2026-07-30 while re-pricing the
   * platform model). This shipped as `{ ...table, [premium.model]: premium.rates }` — an unconditional
   * overwrite — and a rung's rates come from the active MARKETPLACE list, which is KIE-shaped. So the
   * moment a rung names a model Anthropic also prices natively, Anthropic's row was replaced by KIE's:
   *
   *     PREMIUM_MODEL=claude-opus-5 → Anthropic claude-opus-5 billed at $2/$10 (KIE) instead of $5/$25
   *
   * A cold build turn measured **231 credits instead of 576** — we would eat 60% of the cost of every
   * premium generation, silently, with the credit count going DOWN so it reads as a cheaper turn.
   *
   * ⚠️ It was invisible only while the default `PREMIUM_MODEL` was `claude-fable-5`, which Anthropic
   * bakes NO row for — the case where filling and overwriting are the same thing. **That safe case is
   * over**: the premium rung now defaults to `claude-opus-5`, which Anthropic prices natively at
   * $5/$25, so the guard below is the ONLY thing standing between this table and the 231-vs-576
   * regression. SuperMax (`claude-fable-5`) is still gap-filled on Anthropic and idempotent on KIE.
   * A provider that prices a model itself is the authority on what it charges.
   */
  const withTiers = (table: Record<string, ModelRates>): Record<string, ModelRates> =>
    tiers.reduce(
      (acc, tier) => (acc[tier.model] ? acc : { ...acc, [tier.model]: tier.rates }),
      table as Record<string, ModelRates>,
    );

  return {
    Anthropic: withTiers(MODEL_RATES),
    KIE: withTiers(kieRates(context)),
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

  /**
   * ⚠️ RETIRED 2026-07-29 (§4.4a) — always `0`, and `CREATION_FLAT_CREDITS` is REFUSED if set.
   *
   * Kept as a field rather than deleted so the retirement is visible where the price used to be read.
   * Under the project-first flow the creation turn does not exist: creating a project runs no generation
   * (it clones the starter, installs and serves it) and carries its own flat charge at registration
   * (`projectCreateCredits`, ledger reason `project_create`, migration 0015), while the first BUILD turn
   * bills cost-derived like any other. A price variable nothing reads is a mis-bill waiting to be
   * believed, which is why setting the old one now throws rather than being ignored.
   *
   * The historical rationale, preserved because it still explains the shape of the replacement:
   *
   * FLAT credit price for a project-creation turn; `0` disables (cost-proportional, the old behavior).
   *
   * Exists because creation cost is dominated by prompt-cache luck the user can neither see nor
   * influence: the same creation measured **54 credits warm vs 430–633 cold** (cache writes bill 2x,
   * reads 0.1x, and KIE warms per backend — `spec/context-budget.md`). A 12x spread on the product's
   * headline action is unsellable ("why did mine cost 10x his?"), so the creation turn charges ONE
   * predictable number and the platform absorbs the variance — that is what the margin is for, and
   * `generations.raw_cost_usd` still records the true cost so the Admin report watches realized margin.
   *
   * 500 sits mid-band of the measured COLD range (430–633): comfortably profitable on every warm
   * creation, roughly break-even on the coldest. Owner decision 2026-07-28.
   */
  creationFlatCredits: number;

  /**
   * FLAT credit price for CREATING a project; `0` disables (creation is free).
   *
   * Distinct from `creationFlatCredits`, and the distinction is the point (§4.4a, 2026-07-29): under the
   * project-first flow, New Project runs NO generation at all — it clones the pinned starter, installs it
   * and serves it. That work has a real cost (a VM, a template fetch, storage) and a completely
   * predictable one, so it carries its own flat charge under its own ledger reason (`project_create`,
   * migration 0015), debited at registration BEFORE anything is provisioned. The build turn the user
   * sends afterwards is an ORDINARY turn billed cost-derived.
   *
   * Owner decision 2026-07-29: 100–200 credits; 150 is the mid-band default.
   */
  projectCreateCredits: number;

  /** Kill-switch: set false to stop issuing new grants without a deploy (§4.6). */
  grantsEnabled: boolean;

  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  stripePublishableKey?: string;
}

/**
 * ⚠️ RETIRED (§4.4a, 2026-07-29). Was the flat price of a creation TURN; the flat price now attaches to
 * project CREATION (`DEFAULT_PROJECT_CREATE_CREDITS`) and the first build turn bills cost-derived.
 * Exported still, as the documented predecessor — nothing reads it to price anything.
 */
export const DEFAULT_CREATION_FLAT_CREDITS = 500;

/**
 * `CREATION_FLAT_CREDITS` is REFUSED, not ignored.
 *
 * The same posture as the retired KIE price vars: an operator who leaves this set is expressing a
 * pricing intent that nothing honours any more, and silently ignoring it means they believe creations
 * cost 500 credits while they are billed by tokens. Fail loudly, name the replacement.
 */
function refuseRetiredCreationPriceEnv(context?: unknown): void {
  if (env(context, 'CREATION_FLAT_CREDITS')?.trim()) {
    throw new NotConfiguredError(
      'CREATION_FLAT_CREDITS (set, but retired)',
      'Creating a project no longer runs a generation, so there is no creation turn to flat-price ' +
        '(§4.4a). The flat charge is now taken at project registration — set PROJECT_CREATE_CREDITS ' +
        'instead (default 150, 0 disables). The first BUILD turn bills cost-derived like any other turn.',
    );
  }
}

/**
 * See `BillingConfig.projectCreateCredits`. Env-tunable (`PROJECT_CREATE_CREDITS`), no deploy needed.
 *
 * **100 since 2026-07-30 (owner decision), down from 150.** It prices the clone/install/serve work of
 * standing a project up — no model is contacted (§4.4a) — and it is charged identically however the
 * project arrives, because every door goes through the same `POST /api/projects`: a typed prompt
 * (`Chat.client.tsx`) and an import (`registry/import-project.ts`) both call `createProject`, so
 * "prompt or import" is one code path, not two prices that have to be kept in step.
 *
 * ⚠️ **`/api/remix` is the one project-creating door this does NOT price** — it calls `projects.create`
 * directly, with no quote and no debit, so a remix stands up a project and a VM for free. That is
 * either a growth loop worth paying for or an arbitrage; it is flagged rather than silently changed,
 * because charging strangers to remix a public game is a funnel decision (§4.8), not a billing bug.
 */
export const DEFAULT_PROJECT_CREATE_CREDITS = 100;

/**
 * `PROJECT_CREATE_CREDITS`, validated with the same posture as `creationFlatCredits` above: `0` is a real
 * value (project creation is free), while a negative or non-finite override is IGNORED in favor of the
 * default. Obeying a negative would CREDIT a user for creating a project — i.e. hand out free credits to
 * anyone who clicks New Project in a loop.
 */
function projectCreateCredits(context?: unknown): number {
  const configured = envNumber(context, 'PROJECT_CREATE_CREDITS', DEFAULT_PROJECT_CREATE_CREDITS);

  return Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : DEFAULT_PROJECT_CREATE_CREDITS;
}

export function getBillingConfig(context?: unknown): BillingConfig {
  refuseRetiredCreationPriceEnv(context);

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
     * ⚠️ **THIS NUMBER IS COUPLED TO THE PLATFORM MODEL AND PROVIDER — one decision in three files.**
     * Credits are cost-proportional, so the grant's real purchasing power moves with what we pay per
     * token. `grantHeadroom()` is the guard and `billing.spec.ts` asserts `MIN_GRANT_HEADROOM` — never
     * tune one without re-running it (margin, provider, model AND grant move together).
     *
     * **1000 since 2026-07-30 (owner decision), up from 800**, taken together with the model moving to
     * `claude-sonnet-5` and `PROJECT_CREATE_CREDITS` dropping to 100. Headroom at margin 4.0, computed
     * through `grantHeadroom` rather than asserted here:
     *
     * | provider  | model    | cold build | headroom (1000 − 100) |
     * |-----------|----------|------------|-----------------------|
     * | KIE       | sonnet-5 | ~98 cr     | **9.18x**             |
     * | KIE       | opus-5   | ~231 cr    | 3.90x                 |
     * | Anthropic | sonnet-5 | ~346 cr    | 2.60x                 |
     * | Anthropic | opus-5   | ~576 cr    | 1.56x                 |
     *
     * Every combination now clears the 1.5x floor — including Anthropic + Opus 5, which the previous
     * 800/150 pairing did not survive at the model prices in force. That is the point of raising the
     * grant while lowering the creation charge: the failure this guard exists to prevent is a new user
     * whose first free prompt plus one edit exhausts the grant and lands them negative (the gate runs
     * ONCE, before the model; settlement can never refuse, §4.2.1), silently killing the exact moment
     * the funnel is built on.
     *
     * ⚠️ The grant is PURE COST — it buys real model spend on our key with no revenue behind it — so
     * raising it is only affordable because the model move made a build turn ~2.7x cheaper. Do not
     * carry the 1000 forward onto a more expensive default without re-running the table above.
     */
    signupGrantCredits: envNumber(context, 'SIGNUP_GRANT_CREDITS', 1000),
    grantsEnabled: envFlag(context, 'GRANTS_ENABLED', true),

    /* Retired — see the field's doc comment. Always 0; the env var that set it is refused above. */
    creationFlatCredits: 0,
    projectCreateCredits: projectCreateCredits(context),

    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
  };
}

/**
 * `getBillingConfig` for a READ path — returns `null` rather than throwing.
 *
 * 🔴 **A misconfigured price variable must not take a rendering surface down.** `getBillingConfig`
 * gained a throw when `CREATION_FLAT_CREDITS` was retired (§4.4a), and every caller inherited it —
 * including `/api/me` (the session endpoint on EVERY page load), `/api/credits`, and the provider
 * balance the Admin usage dashboard reads. So a single leftover line in an operator's env took the
 * whole app down for every user, and took down the one panel they would use to diagnose it.
 *
 * This is the `premiumSessionHint` precedent (2026-07-25) restated for money CONFIG rather than for a
 * capability hint: a degraded read reports honestly ("we could not read the billing configuration")
 * instead of inventing an answer, while the paths that SPEND — the gate, settlement, project-create,
 * the Stripe webhook — keep calling `getBillingConfig` and keep throwing. Charging money on a
 * configuration we could not read is the one direction that is never safe.
 *
 * Same shape as `isStripeConfigured`'s try/catch, one level up: there the degraded value is `false`
 * (payments unavailable), here it is `null` (nothing is known, so the caller must say so).
 */
export function getBillingConfigSafe(context?: unknown): BillingConfig | null {
  try {
    return getBillingConfig(context);
  } catch {
    return null;
  }
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
 * so `SIGNUP_GRANT_CREDITS = 1000` at margin 4.0 is comfortable on KIE (~231 credits a build turn, ~3.7x
 * headroom — ⚠️ that build-turn figure is an OPUS-era measurement and has not been re-derived for the
 * `claude-sonnet-5` default, which is ~2.35x cheaper on KIE, so the real headroom is UNDERSTATED here) and BROKEN on Anthropic (~576, i.e. ~1.4x: below the 1.5x floor — the first prompt plus an
 * edit exhausts the grant and lands the user negative, with nothing left to iterate).
 *
 * That failure would be silent and would land on the ONE moment the funnel depends on — a new user's
 * first prototype. `billing.spec.ts` asserts this floor so the two numbers cannot drift apart.
 *
 * 🔴 **THE CREATION CHARGE COMES OFF THE TOP (2026-07-29, §4.4a).** Since creation and the build became
 * two steps, a new user pays `projectCreateCredits` before their first build turn has begun — so the
 * grant that reaches the model is `grant - projectCreateCredits`, and a headroom computed from the raw
 * grant overstates it by exactly that much. This is the `packMargin()` shape a third time: a number that
 * is only correct RELATIVE to another number, with nothing relating them. Left unrelated, raising the
 * creation price would silently eat the free grant's iteration room while every assertion stayed green.
 */
export function grantHeadroom(config: BillingConfig, model: string, provider: string, context?: unknown): number {
  const forBuilding = Math.max(0, config.signupGrantCredits - config.projectCreateCredits);
  return forBuilding / creditsForUsage(COLD_CREATION_USAGE, model, provider, config, context);
}

/**
 * The grant must buy the hook, plus room to iterate.
 *
 * Not 1.0: a grant that exactly covers a creation buys a prototype and then a dead end, and the point
 * of the free grant is a user who likes what they made and edits it. 1.5x is one cold build plus a few
 * warm edit turns — deliberately modest, because every credit here is pure operator cost (§4.6).
 */
export const MIN_GRANT_HEADROOM = 1.5;
