/**
 * Where each model family reports its CACHE token counters (SPEC §4.6 — a MONEY PATH).
 *
 * ## Why this is one function and not two inline reads
 *
 * The cache counters are the only part of a generation's usage that the `ai` SDK does NOT normalise:
 * `usage.promptTokens`/`completionTokens` are vendor-neutral, while cache reads and writes arrive
 * under a vendor-specific key inside `providerMetadata`. Until 2026-08-04 the platform served one
 * family, so `providerMetadata.anthropic.cacheReadInputTokens` was hardcoded in exactly two places —
 * `step-usage.ts` (what settlement bills from) and `proxy.ts` (the persisted step log the Admin
 * dashboard diagnoses from). Adding a second family to two independent literals is how those two
 * numbers start disagreeing about one generation, so they now share this reader.
 *
 * ## Failing silently vs failing loudly, and why they are different questions
 *
 * A MISSING INDIVIDUAL VALUE bills as zero and says nothing — that is the honest reading ("this step
 * cached nothing") and it is the overwhelmingly common case. A WHOLLY MISSING NAMESPACE on a family
 * whose cache we PRICE is different: it means the counter we bill from disappeared, so every
 * generation on that family silently bills as if the cache did not exist. Nothing throws, no test
 * fails, and the credit total goes DOWN — which reads as a cheaper turn. That is the §4.2.8 silent
 * failure shape, so `sawNamespace` exists to let the proxy warn about it once per generation.
 *
 * "Nothing was cached" and "the counter disappeared" must never render as the same log line.
 */
import { FAMILY_POLICY, type ModelFamily, type UsageNamespace } from '~/lib/modules/llm/model-families';

/**
 * The cache-token keys each namespace uses.
 *
 * ✅ **THE `openai` KEY IS CONFIRMED FROM A LIVE KIE CAPTURE (2026-08-04, T11)** — it was provisional
 * until then, per FR5's verified-ids rule applied to a field name. A real `gpt-5-6-sol` generation
 * returned, verbatim:
 *
 *     "input_tokens_details": { "cache_write_tokens": 0, "cached_tokens": 0 }
 *
 * and `@ai-sdk/openai@1.3.24` maps `input_tokens_details.cached_tokens` → `providerMetadata.openai
 * .cachedPromptTokens`. Measured field, measured mapping.
 *
 * 🔴 **AND THE CAPTURE FOUND SOMETHING THE SDK DROPS: KIE reports `cache_write_tokens`, and
 * `@ai-sdk/openai` does not map it.** There is no `providerMetadata` key for it at any version we
 * pin, so `cacheCreationTokens` is ALWAYS ZERO on this family — meaning the explicit Cache Writes
 * price the gpt rows quote (`baked-market-prices.ts`, $1.75/MTok on sol) is never actually applied.
 *
 * That is an UNDER-charge, i.e. the safe direction (`rates.ts`: every fallback errs in our own
 * disfavour rather than the user's), which is why it is recorded rather than worked around. Do NOT
 * "fix" it by reading the raw field here — this module receives the SDK's normalized
 * `providerMetadata`, not KIE's response body, so the number is genuinely not in scope at this layer.
 * Closing it means either an SDK that maps it or a fetch-level capture, and neither is worth doing
 * until a real generation reports a NON-ZERO `cache_write_tokens`; both captured values were 0.
 *
 * 🔴 **Gemini reports NO cached-token counter on KIE.** The probed `usageMetadata` carries
 * `{promptTokenCount, candidatesTokenCount, thinkingTokenCount, totalTokenCount}` and nothing else,
 * which is exactly why `FAMILY_POLICY.gemini.cacheProfile` is `'none'` (cached tokens bill at the full
 * input rate). `cachedContentTokenCount` is Google's own name for it and is read here so that a KIE
 * adapter which starts reporting it is picked up automatically — expected zeros, never assumed zeros.
 */
const NAMESPACE_KEYS: Record<UsageNamespace, { read: string; write?: string }> = {
  anthropic: { read: 'cacheReadInputTokens', write: 'cacheCreationInputTokens' },
  openai: { read: 'cachedPromptTokens' },
  google: { read: 'cachedContentTokenCount' },
};

export interface StepCacheTokens {
  /** Input served from the prompt cache. Billed at the family's cache-READ rate. */
  cacheReadTokens: number;

  /** Input written INTO the cache. Billed at the family's cache-WRITE rate. */
  cacheCreationTokens: number;

  /**
   * Was the family's namespace present on this step at all?
   *
   * `false` means the object was absent — NOT that its numbers were zero. Only the proxy acts on it,
   * and only for a family whose cache we price; see `shouldWarnMissingUsageNamespace`.
   */
  sawNamespace: boolean;
}

/** Anything the provider hands us, coerced into a billable number. `undefined`/`NaN` bill as zero. */
function n(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Read one step's cache counters for a model family.
 *
 * An unknown/absent family reads the `anthropic` namespace — the historical behavior, byte-identical
 * for every Claude generation ever billed. That is deliberate: the fallback must be the answer this
 * code has always given, not a new opinion, so a caller that cannot name the family degrades to
 * today's numbers rather than to zeros.
 */
export function extractStepCacheTokens(providerMetadata: unknown, family: ModelFamily | undefined): StepCacheTokens {
  const namespace: UsageNamespace = family ? FAMILY_POLICY[family].usageNamespace : 'anthropic';
  const keys = NAMESPACE_KEYS[namespace];

  const meta =
    typeof providerMetadata === 'object' && providerMetadata !== null
      ? (providerMetadata as Record<string, unknown>)[namespace]
      : undefined;

  if (typeof meta !== 'object' || meta === null) {
    return { cacheReadTokens: 0, cacheCreationTokens: 0, sawNamespace: false };
  }

  const values = meta as Record<string, unknown>;

  return {
    cacheReadTokens: n(values[keys.read]),
    cacheCreationTokens: keys.write ? n(values[keys.write]) : 0,
    sawNamespace: true,
  };
}

/**
 * Should a missing namespace be reported?
 *
 * Only for a family whose cache we actually PRICE. On Gemini (`cacheProfile: 'none'`) the namespace is
 * expected to be absent — warning there would train the operator to ignore the warning on the two
 * families where it means real money is being mis-measured.
 */
export function shouldWarnMissingUsageNamespace(family: ModelFamily | undefined): boolean {
  return family !== undefined && FAMILY_POLICY[family].cacheProfile !== 'none';
}

/** The namespace a family's counters are expected under — for the warning's text, so it names a key. */
export function usageNamespaceFor(family: ModelFamily | undefined): UsageNamespace {
  return family ? FAMILY_POLICY[family].usageNamespace : 'anthropic';
}
