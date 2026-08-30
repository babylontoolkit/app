/**
 * Sandbox VM time as an input to the margin math (§4.6, `spec/billing.md`, CREDITS.md §"Sandbox
 * compute").
 *
 * 🔴 **"User project compute ≈ $0" is RETIRED.** It was true for WebContainer — the project ran in the
 * user's own browser and the only real cost was a fixed monthly StackBlitz fee, which a per-credit
 * margin cannot see and does not need to. A CodeSandbox microVM is billed by WALL CLOCK, and the clock
 * runs while the user THINKS, not only while the model runs. That cost currently comes straight out of
 * generation margin, silently: no ledger reason, no meter, nothing that throws.
 *
 * Owner decision (2026-07-27): **bake it into the margin at launch, measure first, meter later** (T12
 * builds the VM-hours report). This module is the "bake it in" half made explicit and TESTED, because
 * the failure mode of leaving it implicit is a pack that looks profitable and is not — which is
 * exactly the `packMargin()` lesson one layer down (`CREDIT_MARGIN` earns its multiple only if a credit
 * actually retails at `CREDIT_UNIT_COST_USD`; the packs shipped at 0.84× and nothing threw).
 *
 * Two inputs, deliberately separate, because one is a MEASUREMENT and the other is an ESTIMATE:
 *
 *   - `SANDBOX_VM_USD_PER_HOUR` — the provider's list price. MEASURED: $0.074/hr Pico (the default
 *     tier), $0.149/hr Nano. A fact, and it changes only when the vendor or the tier changes.
 *   - `SANDBOX_EST_VM_HOURS_PER_KCREDIT` — how many VM-hours a thousand billed credits drags along.
 *     An operator ESTIMATE, and the one number here that is genuinely unknown until T12's report
 *     exists. CREDITS.md's placeholder says an active build-hour bills ~120 credits, i.e. ~8.33
 *     hours per 1,000 credits — the inverse, and the two documents must keep agreeing.
 *
 * ⚠️ **Never "fix" a failing floor by lowering a cost input or raising `CREDIT_MARGIN` to hide it.**
 * `rates.ts` states the rule for LLM cost and it is the same rule here: these numbers are what we
 * PAY. If the floor fails, the pack price is wrong, or the estimate is, and both are answers — a
 * fudged input is not.
 */
import { envNumber } from '~/lib/.server/env';
import { DEFAULT_SANDBOX_VM_TIER, SANDBOX_VM_TIERS, sandboxVmTier } from '~/lib/.server/sandbox/config';
import { CREDIT_PACKS, MIN_PACK_MARGIN, packMargin, type CreditPack } from './stripe';

/**
 * MEASURED list price per tier, $/hour.
 *
 * 🔴 **This table exists because "raise it with the tier" was a COMMENT, and a comment is not a
 * mechanism.** Both this file and `.env.example` told the operator to move the price when they moved
 * the tier; on 2026-07-28 the owner set `CODESANDBOX_VM_TIER=Nano` and — exactly as the instruction
 * invites — did not also set `SANDBOX_VM_USD_PER_HOUR`. The result was a Nano VM priced at Pico's rate:
 * the margin floor kept passing while asserting against HALF the real compute cost, silently, which is
 * the precise belief this module was written to retire.
 *
 * It is the same rule this codebase already learned about `DEFAULT_PROJECT_SOURCE_MAX_MB`: *a number
 * that is only correct RELATIVE to another number must be derived from it or asserted against it,
 * because nothing else will ever notice.* The tier is now the single input; the price follows it.
 */
export const MEASURED_VM_TIER_USD_PER_HOUR: Readonly<Record<string, number>> = {
  Pico: 0.074,
  Nano: 0.149,
};

/**
 * CPU cores per tier, from the provider's published tier list.
 *
 * Deliberately a local literal rather than an import of `@codesandbox/sdk`'s `VMTier`: the SDK is
 * importable only from the provider modules (`sandbox-seam.spec.ts` is a default-deny scan), and a
 * billing module reaching for the vendor package to price a VM is exactly the coupling that scan
 * exists to refuse.
 *
 * ⚠️ Keyed by the CANONICAL spellings in `SANDBOX_VM_TIERS`, and `sandboxVmTier` normalises to those
 * before this is consulted — the two must stay in step. `tierCoverage` below asserts it, because a tier
 * present in one list and missing from the other prices as "unknown", which is silent.
 */
const TIER_CPU_CORES: Readonly<Record<string, number>> = {
  Pico: 1,
  Nano: 2,
  Micro: 4,
  Small: 8,
  Medium: 16,
  Large: 32,
  XLarge: 64,
};

/** Implied by the two measured anchors: $0.074/1 CPU and $0.149/2 CPU both give ~$0.0745 per CPU-hour. */
const MEASURED_USD_PER_CPU_HOUR = 0.0745;

/**
 * Which canonical tiers this module can price, and which it would treat as unknown.
 *
 * Exists to be ASSERTED against `SANDBOX_VM_TIERS`. A tier the provider accepts but this module has
 * never heard of falls through to the unknown-tier fallback, and that fallback is only conservative
 * while the real tier is cheaper than the dearest measured one — above it, it under-states silently.
 */
export function tierCoverage(): { priced: string[]; unpriced: string[] } {
  const priced: string[] = [];
  const unpriced: string[] = [];

  for (const tier of SANDBOX_VM_TIERS) {
    (MEASURED_VM_TIER_USD_PER_HOUR[tier] !== undefined || TIER_CPU_CORES[tier] !== undefined ? priced : unpriced).push(
      tier,
    );
  }

  return { priced, unpriced };
}

/**
 * What a tier costs per hour, before any operator override.
 *
 * A tier we have MEASURED returns its measurement. A tier we have not is DERIVED from the per-CPU rate
 * the two measured anchors agree on to within 1% — and an unrecognised name falls through to the most
 * expensive tier we know of, never the cheapest.
 *
 * ⚠️ The fallback direction is the whole point and must not be "helpfully" inverted. Over-stating VM
 * cost makes a pack look WORSE than it is, which gets noticed and corrected; under-stating it makes a
 * pack look profitable when it is not, which is invisible until the bank balance says otherwise. Same
 * asymmetry as `ratesFor`'s unpriced-model fallback billing at the most expensive row.
 */
/**
 * MEASURED list price of the DEFAULT tier, $/hour — currently Nano, $0.149.
 *
 * 🔴 **DERIVED from `DEFAULT_SANDBOX_VM_TIER`, never written down twice.** This constant used to be the
 * literal `0.074` beside a doc comment saying "Pico is the default tier"; the moment the default tier
 * moved, that sentence became false and the number under-priced every VM by half. Deriving it means
 * changing the tier is a ONE-LINE change that cannot leave a stale price behind it — the whole point of
 * the table above, applied to the default itself.
 *
 * ⚠️ Kept as an exported constant (rather than inlined) because it is the answer to "what does a VM cost
 * if nobody configured anything?" — which is what a fresh deploy, and every test that does not stub the
 * environment, actually gets.
 */
export const DEFAULT_SANDBOX_VM_USD_PER_HOUR = MEASURED_VM_TIER_USD_PER_HOUR[DEFAULT_SANDBOX_VM_TIER];

export function vmUsdPerHourForTier(tier: string): number {
  const measured = MEASURED_VM_TIER_USD_PER_HOUR[tier];

  if (measured !== undefined) {
    return measured;
  }

  const cores = TIER_CPU_CORES[tier];

  if (cores !== undefined) {
    return Number((cores * MEASURED_USD_PER_CPU_HOUR).toFixed(4));
  }

  return Math.max(...Object.values(MEASURED_VM_TIER_USD_PER_HOUR));
}

/**
 * How many VM-hours ride along with 1,000 billed credits — the operator's estimate.
 *
 * 8.33 is CREDITS.md's placeholder inverted (~120 credits per active build-hour). It is the weakest
 * number in this file BY DESIGN: it is a guess about human behaviour, it is the thing T12's report
 * replaces with a measurement, and stating it as its own variable is what stops it from hiding inside
 * a margin nobody can decompose.
 */
export const DEFAULT_SANDBOX_EST_VM_HOURS_PER_KCREDIT = 8.33;

export interface VmCostConfig {
  usdPerHour: number;
  estHoursPerKCredit: number;
}

export function getVmCostConfig(context?: unknown): VmCostConfig {
  /*
   * The DEFAULT now follows the configured tier (`vmUsdPerHourForTier`), so an operator who raises the
   * tier is priced correctly having set one variable. `SANDBOX_VM_USD_PER_HOUR` remains an override for
   * the case this cannot know about — a negotiated rate, or a vendor price change between releases —
   * but it is no longer something you must remember to keep in sync to avoid under-charging.
   */
  const tierDefault = vmUsdPerHourForTier(sandboxVmTier(context));
  const usdPerHour = envNumber(context, 'SANDBOX_VM_USD_PER_HOUR', tierDefault);
  const estHoursPerKCredit = envNumber(
    context,
    'SANDBOX_EST_VM_HOURS_PER_KCREDIT',
    DEFAULT_SANDBOX_EST_VM_HOURS_PER_KCREDIT,
  );

  /*
   * A nonsensical override falls back rather than being obeyed — the same rule as
   * `sandboxHibernationSeconds`. Obeying `0` or a NaN here would silently
   * report that VM time is free, which is the exact belief this module exists to end.
   *
   * ⚠️ The predicate is `> 0`, NOT `>= 0`. It shipped as `>= 0`, which OBEYED a literal `0` — so
   * `SANDBOX_VM_USD_PER_HOUR=0` set the overhead to nothing, `effectivePackMargin` collapsed back onto
   * `packMargin`, and the floor below passed while asserting nothing. That is this module's whole
   * failure mode wearing a valid-looking config value, and it contradicted both this comment and
   * `spec/billing.md` ("obeying `0` would silently restore the belief this retires"). Pinned by
   * `billing.spec.ts` — a zero is a typo or a leftover, never a measurement.
   *
   * ⚠️ The fallback is the TIER-derived rate, never the flat `DEFAULT_SANDBOX_VM_USD_PER_HOUR`: an
   * operator running Nano who fat-fingers the override must not be quietly re-priced at Pico's rate —
   * that is the same under-statement the tier table was added to end, arriving through the error path
   * instead of the default one.
   */
  return {
    usdPerHour: Number.isFinite(usdPerHour) && usdPerHour > 0 ? usdPerHour : tierDefault,
    estHoursPerKCredit:
      Number.isFinite(estHoursPerKCredit) && estHoursPerKCredit > 0
        ? estHoursPerKCredit
        : DEFAULT_SANDBOX_EST_VM_HOURS_PER_KCREDIT,
  };
}

/** What one billed credit drags along in sandbox compute, in dollars. Pure. */
export function vmOverheadUsdPerCredit(config: VmCostConfig): number {
  return (config.usdPerHour * config.estHoursPerKCredit) / 1000;
}

/**
 * What a pack earns once sandbox compute is paid for out of it.
 *
 * `packMargin` answers "how many times raw LLM+media cost does this pack recover?"; this answers the
 * question that decides whether the business works: the same multiple with the VM-hours those credits
 * imply added to the cost side. Both are needed — a pack can clear the LLM floor and lose money on
 * compute, which is precisely the state this plan's cutover creates.
 *
 * 🔴 Genuinely DERIVED from `packMargin`, not merely "consistent with" it. `packMargin` is
 * `pricePerCredit / rawCostPerCredit`, so scaling it by `raw / (raw + vm)` is the same multiple with
 * compute added to the cost side — and the pack price arithmetic appears exactly once, in
 * `packMargin`. An earlier draft re-derived `priceCents / credits` here and claimed in this very
 * comment to be derived; it was true only because a test happened to pin it, which is how a false
 * claim in a comment survives review (the shell-strip lesson).
 */
export function effectivePackMargin(
  pack: CreditPack,
  config: { creditUnitCostUsd: number; margin: number; vmOverheadUsdPerCredit: number },
): number {
  const rawCostPerCredit = config.creditUnitCostUsd / config.margin;
  const totalCostPerCredit = rawCostPerCredit + config.vmOverheadUsdPerCredit;

  if (totalCostPerCredit <= 0) {
    return packMargin(pack, config);
  }

  return packMargin(pack, config) * (rawCostPerCredit / totalCostPerCredit);
}

/** Every ACTIVE pack whose effective margin is under the floor, with the number, for an error message. */
export function packsUnderVmAdjustedFloor(
  config: { creditUnitCostUsd: number; margin: number; vmOverheadUsdPerCredit: number },
  floor: number = MIN_PACK_MARGIN,
  packs: CreditPack[] = CREDIT_PACKS,
): Array<{ pack: CreditPack; effectiveMargin: number }> {
  return packs
    .filter((pack) => pack.isActive)
    .map((pack) => ({ pack, effectiveMargin: effectivePackMargin(pack, config) }))
    .filter(({ effectiveMargin }) => effectiveMargin < floor);
}
