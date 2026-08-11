/**
 * Token accounting across a tool loop (SPEC §4.2, §4.6 — a MONEY PATH).
 *
 * This exists because `streamText`'s two usage surfaces have DIFFERENT scopes, and the difference is
 * invisible until you reconcile a bill:
 *
 *   result.usage            — combined across every step (ai@4 folds each step in via `addLanguageModelUsage`)
 *   result.providerMetadata — "Additional provider-specific metadata from the LAST step" (its own JSDoc)
 *
 * Anthropic reports cache reads/writes ONLY in provider metadata. So reading cache tokens off the
 * top-level result records round 6 of a 6-round generation and silently discards rounds 1-5, while
 * `promptTokens` alongside it sums all six. Billing then divides one denominator by another. We
 * measured a real creation at 133,565 cache-read tokens — suspiciously close to exactly ONE read of a
 * 133K prefix, which is what tipped this off.
 *
 * `result.steps` is the only surface with per-step scope for BOTH numbers, so it is the one we bill
 * from. Nothing here throws on a malformed step: a missing usage field costs us accuracy, and killing
 * a user's finished generation over our own bookkeeping would cost us the generation.
 */

import { extractStepCacheTokens } from './usage-metadata';
import { FAMILY_POLICY, type ModelFamily } from '~/lib/modules/llm/model-families';

/** What one generation cost, in the four token classes Anthropic bills separately (§4.6). */
export interface GenerationUsage {
  /**
   * UNCACHED input — a guarantee this module MAKES, not one the SDK hands it.
   *
   * ⚠️ This said "`@ai-sdk/anthropic` maps only `input_tokens` here — cache classes are separate",
   * which was a claim about ONE vendor standing in for a contract on a vendor-neutral field. It went
   * silently false when the gpt/gemini families shipped (2026-08-04) — every OpenAI- and
   * Google-shaped wire reports the cached count as a BREAKDOWN of the prompt total — and settlement,
   * which adds the two, then billed the cached portion twice. `accumulateStepUsage` now subtracts,
   * per `FamilyPolicy.promptTokensIncludeCacheRead`, so the field is uncached by construction on
   * every family rather than by luck on one.
   */
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;

  /** Input served from the prompt cache — billed at 0.1x. */
  cacheReadTokens: number;

  /** Input written INTO the cache — billed at 2x on the 1h tier we use (§4.2.8). */
  cacheCreationTokens: number;
}

/**
 * The parts of an ai@4 `StepResult` that billing reads.
 *
 * Structural, not the SDK's type: it keeps this module (and its test) free of the provider registry,
 * and it is the honest contract — these five numbers are all we take.
 */
export interface UsageStep {
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };

  /**
   * Deliberately OPAQUE since 2026-08-04: the cache counters live under a family-specific namespace
   * (`anthropic` / `openai` / `google`) and are read by `usage-metadata.ts`, which owns the mapping.
   * Naming one vendor's shape here is what let two call sites hardcode `anthropic` independently.
   */
  providerMetadata?: unknown;
}

export function emptyUsage(): GenerationUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

/** Coerce anything the provider hands us into a billable number. `undefined`/`NaN` bill as zero. */
function n(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Fold EVERY step of a tool loop into the running totals.
 *
 * Mutates and returns `totals` so a generation that streams more than once (the forced-answer
 * continuation when the tool cap is hit) accumulates across both drains rather than clobbering.
 */
export function accumulateStepUsage(
  totals: GenerationUsage,
  steps: readonly UsageStep[] | undefined,
  family?: ModelFamily,
): GenerationUsage {
  /*
   * Does this family's wire count cached tokens INSIDE `promptTokens`? See `FamilyPolicy`
   * .promptTokensIncludeCacheRead — a fact about the vendor's API, not about our pricing.
   *
   * ⚠️ An omitted family resolves to `false`, matching the `anthropic`-namespace fallback below:
   * both halves of the no-family case must describe the SAME vendor, or a caller that cannot name
   * the family gets Anthropic's cache counters and somebody else's arithmetic.
   */
  const cacheInsidePrompt = family ? FAMILY_POLICY[family].promptTokensIncludeCacheRead : false;

  for (const step of steps ?? []) {
    totals.completionTokens += n(step.usage?.completionTokens);

    /*
     * ⚠️ `family` is OPTIONAL and an omitted one reads the `anthropic` namespace — byte-identical to
     * what this function did before families existed. A required parameter would have been the
     * stricter design and the wrong one here: this is settlement, which can never refuse (§4.6), so a
     * caller that cannot name the family must still bill SOMETHING correct for the common case rather
     * than throw. `proxy.ts` passes `familyOf(config.model)` and is the only production caller.
     */
    const cache = extractStepCacheTokens(step.providerMetadata, family);
    totals.cacheReadTokens += cache.cacheReadTokens;
    totals.cacheCreationTokens += cache.cacheCreationTokens;

    /*
     * 🔴 THE SUBTRACTION THAT MAKES `promptTokens` MEAN WHAT SETTLEMENT ASSUMES IT MEANS.
     *
     * `costForRates` ADDS `promptTokens * input` and `cacheReadTokens * cacheRead`, which is only
     * correct when the two do not overlap. On every OpenAI- and Google-shaped wire they overlap
     * completely, so without this the cached portion was billed twice — measured live at **1.86x**
     * on a real `gpt-5-6-terra` turn (T12, 2026-08-11).
     *
     * PER STEP, never on the totals: the floor has to apply to each step's own pair. Summing first
     * lets one step's surplus prompt tokens silently absorb another step's over-report, which is the
     * kind of cancellation that makes a bill look right for the wrong reason.
     *
     * ⚠️ FLOORED AT ZERO. A provider that reports more cached tokens than prompt tokens is
     * malformed, and this is settlement — it can never refuse (§4.6) — so the only safe reading is
     * "all of it was cached". A negative would flow straight into `costForRates` and CREDIT the user
     * at the input rate, turning a provider's bad number into a way to bill less than nothing.
     */
    const stepPrompt = n(step.usage?.promptTokens);
    const uncachedPrompt = cacheInsidePrompt ? Math.max(0, stepPrompt - cache.cacheReadTokens) : stepPrompt;
    totals.promptTokens += uncachedPrompt;

    /*
     * ⚠️ `totalTokens` MOVES WITH `promptTokens`, or one generation ends up with two totals.
     *
     * The provider's own `totalTokens` is `promptTokens + completionTokens` in ITS units, so on an
     * inclusive family it counts the cached tokens that the line above just removed. Left alone, the
     * FS record persisted the wire's number (`proxy.ts`) while `gate.ts` and the Supabase read both
     * DERIVE it as `promptTokens + completionTokens` — the same field, two values, differing by
     * exactly the cache read. Caught by T12's verifier on the real record: `gen_msopyq5f` was
     * 17,464 + 78 yet stored 35,431.
     *
     * Diagnostic-only today (nothing bills from it), which is precisely why it would have sat there:
     * this repo's own history is full of metrics that quietly stopped meaning what their name says.
     * Subtracting the SAME amount keeps all three derivations in agreement by construction.
     */
    totals.totalTokens += Math.max(0, n(step.usage?.totalTokens) - (stepPrompt - uncachedPrompt));
  }

  return totals;
}
