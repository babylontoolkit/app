/**
 * The MODEL TIER LADDER (SPEC §4.6.1a) — the vocabulary of model classes a credits user may choose.
 *
 * Three rungs, ordered by cost: **Standard** (the operator's platform model), **Premium**, and
 * **SuperMax**. Each paid rung names an operator-configured model through an env SELECTOR and unlocks
 * at a credit THRESHOLD the user must hold.
 *
 * ## Why this is a table and not three code paths
 *
 * This replaced a boolean (`PREMIUM_MODEL` or nothing). A boolean generalises to a third option in
 * exactly one honest way — an ordered list — and the alternative, copying the premium machinery into a
 * `SUPERMAX_*` twin, means every rule gets written twice and the two copies drift. The rules here are
 * money rules: the threshold that protects the free signup grant, the first-build lock, the
 * refuse-an-unpriced-selector check. A drifted copy of any of them fails silently.
 *
 * ## This module holds DATA ONLY, and that is structural
 *
 * Resolution — reading the env, pricing the selector against the active Marketplace price list —
 * lives in `rates.ts`, because `rates.ts` owns `ratesFromBase` and `activeMarketPrices`. Putting the
 * table here instead of there keeps `rates.ts` free of a second concern, and it means this file can be
 * imported by anything (including the tier DECISION in `premium.ts`, which is pure and imports
 * nothing else) without dragging the pricing layer along.
 *
 * ⚠️ It must never import `rates.ts` — that would be a cycle, since `rates.ts` imports this. And
 * `rates.ts` must never import `agent/config.ts`, which is why the STANDARD rung's model is not
 * resolved anywhere in this layer: the platform model is `getPlatformModel`'s to state (the cycle
 * documented at `rates.ts` `mostExpensive`). Callers that need the whole ladder pass it in.
 *
 * ## Model and price are ONE fact (2026-07-18)
 *
 * A tier's env var names a model; the ACTIVE price list prices it. `PREMIUM_INPUT_DOLLARS` and friends
 * are RETIRED and refused — a price var nothing reads is a mis-bill waiting to be believed. So a
 * selector the active list cannot price is REFUSED, never guessed: "is this tier configured?" and "do
 * we know what it costs?" are the same question.
 *
 * ⚠️ The THRESHOLDS stay env numbers with in-code fallbacks (`envNumber`), and that asymmetry is
 * deliberate: a fallback for a credit threshold is correct, a fallback for a PRICE is catastrophic.
 */

/** The rungs, cheapest first. Order is meaningful — it is the ladder. */
export const MODEL_TIER_IDS = ['standard', 'premium', 'supermax'] as const;

export type ModelTierId = (typeof MODEL_TIER_IDS)[number];

/**
 * A rung the user PAYS extra for. `standard` is excluded by type, not by a runtime check: it has no
 * selector, no threshold and no lock, so a function that resolves a paid tier cannot be handed it.
 */
export type PaidModelTierId = Exclude<ModelTierId, 'standard'>;

/**
 * The in-code defaults — what a deploy with NO environment at all gets.
 *
 * They must stay a monotonic ladder (standard ≤ premium ≤ supermax in both price and threshold), or a
 * bare deploy offers a rung that is cheaper than the one below it. The signup grant
 * (`SIGNUP_GRANT_CREDITS`, 1000) sits below every paid threshold, which is the whole point of the
 * thresholds: a brand-new account cannot burn its grant on the expensive models out the gate.
 */
export const DEFAULT_PREMIUM_MODEL = 'claude-opus-5';
export const DEFAULT_PREMIUM_MINIMUM_CREDITS = 1200;
export const DEFAULT_SUPERMAX_MODEL = 'claude-fable-5';
export const DEFAULT_SUPERMAX_MINIMUM_CREDITS = 1500;

/** The static definition of a paid rung: where its config comes from and what it falls back to. */
export interface ModelTierDefinition {
  id: PaidModelTierId;

  /** User-facing name. The ONE source for it — the pill, the picker and any notice all read this. */
  label: string;

  /** The env var naming this tier's model. A SELECTOR, never a price. */
  modelEnvKey: string;

  /** The env var holding this tier's credit threshold (`envNumber` — a threshold, not a price). */
  minimumEnvKey: string;

  /** Used when `modelEnvKey` is unset. Must be priced by the baked list or the tier is dead on arrival. */
  defaultModel: string;

  /** Used when `minimumEnvKey` is unset or unparseable. */
  defaultMinimumCredits: number;

  /**
   * Locked on the FIRST BUILD turn (§4.4a).
   *
   * 🔴 **FALSE for every rung since 2026-08-03 (owner: "remove the first-premium-build-always-runs-
   * default-model rule — we can choose our model as long as we have enough credits and the additional
   * models are enabled").** A user who has paid for a rung and can afford it gets it on every turn,
   * including the biggest one.
   *
   * ⚠️ **The reason it was introduced is RETIRED, not merely overruled.** The 2026-07-18 rationale was
   * that Fable 5 on KIE serves a BUFFERED answer which a build-sized artifact may not flush before
   * their gateway timeout — read at the time as a property of that MODEL. It is not: KIE buffers every
   * answer on every model, which is why `agent/delivery.ts` keys `deliveryMode` on the PROVIDER and
   * says so in its own doc ("the buffering lives in the adapter, so a `LLM_MODEL` swap must not
   * silently flip it to streamed"), and why the panel has an expectation bar telling the user to wait.
   * So the lock was singling out one rung for something all three do — it never bought what it was
   * charging for.
   *
   * The residual risk is the gateway TIMEOUT on a very long generation, which is real for any rung and
   * is handled where it belongs: a death there is a hard failure, so it refunds and retries
   * (`MAX_PROVIDER_RETRY_ATTEMPTS`, whose last attempt drops thinking).
   *
   * The flag and its branch in `decideModelTier` STAY, so re-locking a single rung is one line and a
   * test — not surgery on the decision function — the next time a provider misbehaves.
   */
  firstBuildLocked: boolean;
}

/** Every paid rung, cheapest first. `standard` is absent by design — see `PaidModelTierId`. */
export const PAID_MODEL_TIERS: readonly ModelTierDefinition[] = [
  {
    id: 'premium',
    label: 'Premium',
    modelEnvKey: 'PREMIUM_MODEL',
    minimumEnvKey: 'PREMIUM_MINIMUM_CREDITS',
    defaultModel: DEFAULT_PREMIUM_MODEL,
    defaultMinimumCredits: DEFAULT_PREMIUM_MINIMUM_CREDITS,
    firstBuildLocked: false,
  },
  {
    id: 'supermax',
    label: 'SuperMax',
    modelEnvKey: 'SUPERMAX_MODEL',
    minimumEnvKey: 'SUPERMAX_MINIMUM_CREDITS',
    defaultModel: DEFAULT_SUPERMAX_MODEL,
    defaultMinimumCredits: DEFAULT_SUPERMAX_MINIMUM_CREDITS,
    firstBuildLocked: false,
  },
];

/** The user-facing name of the free rung. Standard has no definition row — it has nothing to configure. */
export const STANDARD_TIER_LABEL = 'Standard';

/** The definition for a paid rung. Total over `PaidModelTierId`, so callers need no null check. */
export function paidModelTierDefinition(id: PaidModelTierId): ModelTierDefinition {
  const definition = PAID_MODEL_TIERS.find((tier) => tier.id === id);

  if (!definition) {
    // Unreachable while the type and the table agree; a loud throw is better than a silent undefined.
    throw new Error(`No model tier definition for "${id}"`);
  }

  return definition;
}
