/**
 * WHAT THE GATEWAY DISCOUNT IS WORTH TO THE USER (SPEC §4.6, §4.2a).
 *
 * ## Why this exists
 *
 * Credits are cost-proportional — `credits = ceil(raw_usd / CREDIT_UNIT_COST_USD * CREDIT_MARGIN)` —
 * so a cheaper gateway does not widen our margin, it makes the user's pack go further. That is the
 * owner's whole reason for the `AUTO_MODEL_SELECT` ladder ("any discount on the model shows up in the
 * user's amount of credit power"), and until now it was completely invisible: the same turn quietly
 * cost 1,017 credits on Anthropic and ~407 at KIE-shaped rates with nothing on screen saying why.
 *
 * A benefit the user cannot see is a benefit they do not have. This module turns the difference into
 * one number, in credits — the only unit they actually spend.
 *
 * ## PURE, and that is a safety property rather than a style
 *
 * No env, no price store, no billing config, no `context`. Every input is a recorded fact about one
 * finished turn. Three separate defects were designed out by getting here, all found by adversarial
 * review before this shipped, and all of them printing a *flattering* number:
 *
 * 🔴 **1. It cannot throw, so it cannot take a read path down.** The first draft called `rawCostUsd`,
 * which reaches `providerRates`, which REFUSES loudly when a retired price variable is still set. That
 * put a 503 on `/api/credits` — the page a user opens to find out where their credits went — for a
 * stale env var. Same shape as the `modelTiersSessionHint` lesson, and this module now has no way to
 * express it: the reference table is a module constant.
 *
 * 🔴 **2. The reference is `MODEL_RATES`, NOT `providerRates().Anthropic`.** They are not the same
 * table: `providerRates` INJECTS every paid rung's model into the Anthropic table at MARKETPLACE
 * (KIE-shaped) rates to keep settlement working for a rung Anthropic does not sell. Priced through
 * that, a model Anthropic never listed would still resolve — so "Anthropic list" would be a KIE price
 * wearing an Anthropic label, and a gateway would be compared against its own price, which is a
 * guaranteed "you saved 0%" for a turn that may have saved plenty. The baked table is the only thing
 * that actually means "what Anthropic charges".
 *
 * ⚠️ This rule was illustrated with `claude-fable-5` — "which KIE prices at ~2x Anthropic's Opus row,
 * so it would invent a discount out of a premium". The example was wrong in both halves and the rule is
 * right anyway, which is why it is worth recording: KIE prices fable-5 at $4/$20, **below** Anthropic's
 * Opus row, and Anthropic sells fable-5 itself at $10/$50 (`MODEL_RATES`, 2026-08-12) so the injection
 * does not fire for it at all. The mechanism the rule guards against is real; the model chosen to
 * demonstrate it was the one the platform was actively mis-pricing.
 *
 * 🔴 **3. It compares a RATIO, never two absolute credit figures.** The turn's credits were computed
 * at whatever `CREDIT_MARGIN` was in force when it ran; a reference recomputed at today's margin is a
 * different yardstick, so any margin change (3.34 -> 4.0 happened on 2026-07-18) would retroactively
 * paint every older full-price turn as discounted. Measured on that exact history: an Anthropic-served
 * turn charged 59 credits reported "saved 11 (16%)". The margin appears on both sides of a ratio and
 * cancels, which is why this takes `actualCostUsd` — the raw USD recorded WITH the turn — rather than
 * re-deriving anything.
 *
 * ## What it declines to answer, and why
 *
 * - **Anthropic has no baked row for the model** — no reference exists, so there is nothing to say.
 *   `ratesFor`'s most-expensive-row fallback is deliberately not reachable from here: run through it,
 *   an unpriced model would "compare" against the priciest thing Anthropic sells.
 * - **Nothing was charged** (BYOK, unmetered, a turn refunded to zero). "You saved 300 credits" beside
 *   a 0-credit row invites the reading that we charged and refunded, which is a different and much
 *   more alarming story.
 * - **No recorded cost** — an older `generations` row with no `raw_cost_usd`. Without it there is no
 *   ratio, and guessing one is exactly the thing this module exists not to do.
 *
 * A savings figure is a marketing claim printed next to a money number. The only safe failure mode is
 * silence, and every branch above returns `null` to take it.
 */
import { MODEL_RATES, costForRates, type TokenUsage } from '~/lib/.server/billing/rates';

/** The table every comparison is made against: Anthropic's own list price, baked, never injected. */
export const REFERENCE_RATES = MODEL_RATES;

export interface SavingsInput {
  usage: TokenUsage;
  model: string;

  /**
   * The raw USD this turn actually cost us, as RECORDED — `settlement.rawCostUsd` live, or the
   * `generations` row's `raw_cost_usd` for history.
   *
   * ⚠️ Recorded, never re-derived. Re-pricing the turn today would use today's marketplace list and
   * today's gateway, which is not what the user was billed against.
   */
  actualCostUsd: number;

  /** Credits actually debited — the LEDGER's number. Zero means nothing to compare. */
  creditsCharged: number;
}

export interface Savings {
  /** `saved` — the gateway was cheaper. `full_price` — it was not, or it WAS Anthropic. */
  basis: 'saved' | 'full_price';

  /** What this exact turn would have cost in credits at Anthropic list. */
  referenceCredits: number;

  /** `referenceCredits - creditsCharged`, floored at 0. Never negative — see below. */
  savedCredits: number;

  /** 0-100, rounded. The share of the full price the user did NOT pay. */
  percent: number;
}

/**
 * What this turn's gateway saved the user against Anthropic list, or `null` to say nothing.
 *
 * ⚠️ **`savedCredits` is floored at zero, and that is not cosmetic.** Rendering a negative "saving"
 * would tell a user we overcharged them relative to an option they were never offered, on a turn that
 * was billed exactly right. `basis: 'full_price'` is the honest report for that case: no discount.
 *
 * ⚠️ **The floor has NO measured case behind it as of 2026-08-12, and it stays anyway.** It used to cite
 * "the fable-5 rung settled 814 credits on Anthropic against Opus 5's 1,017" as proof a gateway can be
 * dearer than Anthropic. That comparison was between two different MODELS (which says nothing about a
 * gateway), and the 814 was itself the gap-fill mis-bill — fable-5 priced at KIE's $4/$20 instead of
 * Anthropic's $10/$50, i.e. 814/1017 = exactly 4/5. With the real rates in, every Claude row on both
 * marketplaces is CHEAPER than Anthropic list, so no shipped configuration can produce a negative here.
 *
 * Keep the floor. It costs one `Math.max` and it defends a user-facing money claim against a promoted
 * price list — which an operator can change from the Admin panel, with no deploy, at any time. A
 * defence removed because today's numbers happen not to need it is a defence removed at exactly the
 * moment nothing is watching, and the failure mode here is a negative discount rendered to a customer.
 */
export function describeSavings(input: SavingsInput): Savings | null {
  if (input.creditsCharged <= 0 || !(input.actualCostUsd > 0)) {
    return null;
  }

  const referenceRates = REFERENCE_RATES[input.model];

  if (!referenceRates) {
    return null;
  }

  const referenceCostUsd = costForRates(input.usage, referenceRates);

  if (!(referenceCostUsd > 0)) {
    return null;
  }

  /*
   * The margin cancels here. `creditsCharged` already embodies the margin in force when the turn ran,
   * so scaling it by a pure USD ratio expresses the reference in the SAME currency as the number the
   * user is looking at, without this module ever knowing what the margin is.
   */
  const referenceCredits = Math.round(input.creditsCharged * (referenceCostUsd / input.actualCostUsd));
  const savedCredits = Math.max(0, referenceCredits - input.creditsCharged);

  return {
    basis: savedCredits > 0 ? 'saved' : 'full_price',
    referenceCredits,
    savedCredits,
    percent: referenceCredits > 0 ? Math.round((savedCredits / referenceCredits) * 100) : 0,
  };
}
