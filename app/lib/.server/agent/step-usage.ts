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

/** What one generation cost, in the four token classes Anthropic bills separately (§4.6). */
export interface GenerationUsage {
  /** UNCACHED input. `@ai-sdk/anthropic` maps only `input_tokens` here — cache classes are separate. */
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
  providerMetadata?: {
    anthropic?: {
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    };
  };
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
export function accumulateStepUsage(totals: GenerationUsage, steps: readonly UsageStep[] | undefined): GenerationUsage {
  for (const step of steps ?? []) {
    totals.promptTokens += n(step.usage?.promptTokens);
    totals.completionTokens += n(step.usage?.completionTokens);
    totals.totalTokens += n(step.usage?.totalTokens);

    const anthropic = step.providerMetadata?.anthropic;
    totals.cacheReadTokens += n(anthropic?.cacheReadInputTokens);
    totals.cacheCreationTokens += n(anthropic?.cacheCreationInputTokens);
  }

  return totals;
}
