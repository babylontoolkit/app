/**
 * Which protocol DIALECT a model id speaks, and what policy that family carries.
 *
 * ## Why the FAMILY comes from the model id and not from the provider
 *
 * A gateway provider serves several completely different wires behind one API key. KIE serves three —
 * Anthropic Messages (`claude/v1/messages`), OpenAI **Responses** (`codex/v1/responses`) and native
 * Gemini (`gemini/v1/models/<id>:streamGenerateContent`). They are one PROVIDER (one key, one
 * account, one bill) and three PROTOCOLS, so the provider name cannot answer "which wire".
 *
 * It also cannot come from `LLM_PROVIDER`: the tier rungs (§4.6.1a) may point at models from
 * different families **simultaneously**, while the provider is one value per deploy. The model id is
 * the only thing that varies per rung, so the family derives from it.
 *
 * ## 🔴 A family names a DIALECT; the PROVIDER chooses the WIRE (2026-08-10)
 *
 * The family used to imply an endpoint because only one provider existed. It cannot any more:
 * `gpt-5` is OpenAI-dialect on both gateways but rides **Responses** on KIE and **chat-completions**
 * on Comet (Comet marks `gpt-5*` as `openai`; only `o3-pro` carries `openai-response`). So this
 * module holds the DIALECT and each provider file holds its own family -> wire map.
 *
 * **Do not "fix" that by making the family depend on the provider.** The rungs-vs-deploy argument
 * above is exactly why it cannot: the family is a property of the model, the wire is a property of
 * the (provider, family) pair, and collapsing them loses the ability to serve two families at once.
 *
 * ## Why an unknown id must REFUSE rather than default
 *
 * Before this module existed, `capabilities.ts`'s tables were Claude-shaped deny-lists with a
 * default-to-modern-Claude fallthrough — correct for a Claude-only provider and actively wrong once
 * other families exist. A `gpt-*` id fell through `supportsSamplingParams` → false (temperature
 * stripped, harmless) and `supportsAdaptiveThinking` → true, which injects an **Anthropic
 * `thinking` block into an OpenAI request body**: a hard 400 before a token, on a model the operator
 * believes is configured. Guessing a wire is strictly worse than refusing one, so `requireFamily`
 * throws at model-resolution time — before any key lookup, before any request.
 *
 * This module is CLIENT-SAFE (it sits beside `capabilities.ts`, outside `~/lib/.server/**`) because
 * both the provider registry (imported by the browser bundle) and `.server` billing need it. It
 * deliberately holds **no wire builders and no delivery mode**: a fetch builder here would recreate
 * the `base-provider -> manager -> registry -> providers` import cycle that `kie-wire.ts` exists to
 * avoid, and delivery mode is `.server` policy that lives in `agent/delivery.ts`.
 */
import type { EffortLevel, ThinkingMode } from '~/lib/modules/llm/capabilities';

export const MODEL_FAMILIES = ['claude', 'codex', 'gemini', 'chat'] as const;

export type ModelFamily = (typeof MODEL_FAMILIES)[number];

/**
 * How the platform prices cached tokens for a family (`spec/billing.md` §"The Marketplace price list").
 *
 *  - `derived`       — Claude: read = 0.1x input, write = 2.0x input (the 1h tier). The price list
 *                      REFUSES an explicit pair for these rows, so a half-repriced row is inexpressible.
 *  - `explicit-pair` — GPT: KIE publishes Cached Input AND Cache Writes prices, so the row must quote
 *                      BOTH or neither. Deriving them would be inventing a discount we cannot verify.
 *  - `none`          — Gemini and `chat`: the vendor quotes no cached rate and returns no cached-token
 *                      counter, so cached tokens bill at FULL input rate. Flagged and accepted by the
 *                      owner (2026-08-04): never a discount we cannot verify, never a surcharge we
 *                      cannot observe.
 */
export type CacheProfile = 'derived' | 'explicit-pair' | 'none';

/** The `providerMetadata` namespace each family's usage counters arrive under (see `usage-metadata.ts`). */
export type UsageNamespace = 'anthropic' | 'openai' | 'google';

export interface FamilyPolicy {
  cacheProfile: CacheProfile;
  usageNamespace: UsageNamespace;
  maxTokenAllowed: number;
  maxCompletionTokens: number;

  /**
   * 🔴 Does this vendor's `usage.promptTokens` COUNT the cached tokens as well? (A MONEY PATH.)
   *
   * `costForRates` bills `promptTokens` at the full input rate and `cacheReadTokens` at the cache
   * rate, ADDING them — which is only correct when the two do not overlap. Whether they overlap is a
   * property of each vendor's wire, and the two conventions are opposites:
   *
   * - **Anthropic** reports `input_tokens` EXCLUSIVE of `cache_read_input_tokens` /
   *   `cache_creation_input_tokens`, which arrive as sibling top-level fields. No overlap.
   * - **OpenAI** (both Responses and chat-completions) reports `input_tokens` / `prompt_tokens` as
   *   the TOTAL, with the cached count nested inside `input_tokens_details.cached_tokens` — i.e. a
   *   BREAKDOWN OF it. Total overlap.
   * - **Google** reports `promptTokenCount` inclusive of `cachedContentTokenCount`, same shape as
   *   OpenAI's.
   *
   * `step-usage.ts` subtracts the cache read from the step's prompt tokens wherever this is `true`,
   * so settlement always sees the UNCACHED figure its arithmetic assumes.
   *
   * ⚠️ **This was a live over-charge, found by T12's control pass on 2026-08-11.** A real
   * `gpt-5-6-terra` turn billed **$0.021434 against a true cost of $0.011498 — 1.86×** — because the
   * cached 17,742 tokens were charged once at the full input rate inside `promptTokens` and again at
   * the cache-read rate. `step-usage.ts`'s field comment declared `promptTokens` to be "UNCACHED
   * input" and justified it with a sentence about `@ai-sdk/anthropic`: true when written, silently
   * false from the moment a second family shipped (2026-08-04). Another false claim in a comment,
   * which is what a reviewer reads instead of the SDK.
   *
   * 🔴 **The error SCALES WITH CACHE WARMTH** (`cacheReadTokens x inputPerMTok`), so it was worst on
   * exactly the warm-prefix turns the whole context-budget program exists to make cheap — and it
   * inverted `gate.ts`'s stated rule that "the customer is never billed for the state of our cache",
   * billing them EXTRA for a warm one.
   *
   * ⚠️ Declared per family as a fact about the WIRE, never inferred from `cacheProfile` or from a
   * family name. `gemini` is `true` even though its counter is never populated today (the SDK maps
   * no `cachedContentTokenCount`, so its cache read is structurally zero and the subtraction is a
   * no-op): the entry states what Google's API actually does, so the day an adapter starts reporting
   * it, the arithmetic is already right. Inferring it would tie a billing question to a pricing
   * enum — two different questions that happen to agree today.
   */
  promptTokensIncludeCacheRead: boolean;
}

export const FAMILY_POLICY: Record<ModelFamily, FamilyPolicy> = {
  claude: {
    cacheProfile: 'derived',
    usageNamespace: 'anthropic',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,

    // Anthropic's `input_tokens` excludes both cache classes; they arrive as sibling fields.
    promptTokensIncludeCacheRead: false,
  },
  codex: {
    cacheProfile: 'explicit-pair',
    usageNamespace: 'openai',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,

    // `input_tokens_details.cached_tokens` is a breakdown OF `input_tokens`. The live 1.86x turn.
    promptTokensIncludeCacheRead: true,
  },
  gemini: {
    cacheProfile: 'none',
    usageNamespace: 'google',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,

    // `promptTokenCount` includes `cachedContentTokenCount`. A no-op today — the SDK maps no counter.
    promptTokensIncludeCacheRead: true,
  },

  /*
   * The OpenAI chat-completions dialect as spoken by everything that is not OpenAI itself — Grok,
   * Kimi, Qwen, GLM, DeepSeek, MiniMax (Comet, 2026-08-10). It is a separate family from `codex`
   * rather than a widening of it because the two differ in the one thing a family exists to answer:
   * `codex` rows quote KIE's published cache pair (`explicit-pair`), and NO vendor quotes a cached
   * rate for these, so cached tokens bill at the full input rate.
   *
   * ⚠️ The caps are FLOORS, not measurements. The feed publishes `context_length` and
   * `max_completion_tokens` per row and they vary widely across these vendors; until a shipped id
   * carries its own probed numbers, undershooting the context window costs a refusal (loud) while
   * overshooting the completion cap costs a hard 400 (also loud, but mid-generation). Both are the
   * safe direction — see `getDynamicModels`' asymmetric-fallback note in SPEC §4.2a.
   */
  chat: {
    cacheProfile: 'none',
    usageNamespace: 'openai',
    maxTokenAllowed: 128_000,
    maxCompletionTokens: 32_000,

    /*
     * The same chat-completions mapping as `codex`, and the WORSE exposure of the two: with
     * `cacheProfile: 'none'` the cache-read rate EQUALS the input rate, so an un-subtracted cached
     * token was billed at the full input rate twice over. Nothing has measured whether these
     * gateways populate `prompt_tokens_details` — which is exactly why this is declared from the
     * dialect rather than from an assumption that the counter stays absent.
     */
    promptTokensIncludeCacheRead: true,
  },
};

/**
 * The id prefixes that select a family, in the order they are tested.
 *
 * ⚠️ `qwen` and `deepseek` are deliberately NOT dash-terminated where every neighbour is: the vendors
 * ship both `qwen3-coder` and `qwen-max` spellings, so a `qwen-` prefix would match half the family
 * and silently drop the other half into `requireFamily`'s refusal. It reads like a typo; it is not.
 *
 * Order matters. `claude-`/`gpt-`/`gemini-` stay first so nothing already shipped can re-route.
 */
export const FAMILY_PREFIXES: ReadonlyArray<readonly [prefix: string, family: ModelFamily]> = [
  ['claude-', 'claude'],
  ['gpt-', 'codex'],
  ['gemini-', 'gemini'],
  ['grok-', 'chat'],
  ['kimi-', 'chat'],
  ['qwen', 'chat'],
  ['glm-', 'chat'],
  ['deepseek', 'chat'],
  ['minimax-', 'chat'],
];

/**
 * Bedrock-style ids arrive as `anthropic.claude-...`; the prefix is not part of the family signal.
 * Mirrors `capabilities.ts`'s own `bareModelId`, which is private to that module.
 */
function bareModelId(modelId: string): string {
  return modelId.startsWith('anthropic.') ? modelId.slice('anthropic.'.length) : modelId;
}

/** The family a model id belongs to, or `undefined` when nothing claims it. */
export function familyOf(modelId: string | undefined | null): ModelFamily | undefined {
  if (typeof modelId !== 'string') {
    return undefined;
  }

  const id = bareModelId(modelId.trim());

  return FAMILY_PREFIXES.find(([prefix]) => id.startsWith(prefix))?.[1];
}

/**
 * The family a model id belongs to, or a loud throw naming the id and every accepted prefix (FR1).
 *
 * Called FIRST in `getModelInstance` — before the key lookup, before any wire is built — so an
 * unknown id can never reach a guessed protocol.
 */
export function requireFamily(modelId: string | undefined | null): ModelFamily {
  const family = familyOf(modelId);

  if (!family) {
    throw new Error(
      `Unknown model family for "${modelId}". A model's family is selected by id prefix: ` +
        `${FAMILY_PREFIXES.map(([prefix, name]) => `${prefix}* (${name})`).join(', ')}. ` +
        `Add the id to the provider's model list and the Marketplace price list, or fix the configured model.`,
    );
  }

  return family;
}

/** What the OpenAI Responses wire accepts for `reasoning.effort`. */
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;

export type CodexEffort = (typeof CODEX_EFFORTS)[number];

/** What the Gemini wire accepts for `generationConfig.thinkingConfig.thinkingLevel`. */
export const GEMINI_THINKING_LEVELS = ['low', 'high'] as const;

export type GeminiThinkingLevel = (typeof GEMINI_THINKING_LEVELS)[number];

/**
 * Our `EffortLevel` mapped onto the Responses wire's `reasoning.effort`.
 *
 * `mode: 'disabled'` (the proxy's last-resort retry, `proxy.ts` ~L1802) maps to the LOWEST effort
 * rather than to an off switch: the Responses wire has no "no reasoning" value, and the retry's
 * purpose is to get bytes on the wire fast enough that KIE's gateway cannot time the step out. `low`
 * achieves that; a 400 for an unsupported value would land on the attempt that already failed twice.
 *
 * `max` clamps DOWN to `xhigh` — the wire's ceiling. Clamping up would spend more than asked.
 */
export function codexEffort(mode: ThinkingMode, effort: EffortLevel): CodexEffort {
  if (mode === 'disabled') {
    return 'low';
  }

  switch (effort) {
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
    case 'max':
      return 'xhigh';
    default: {
      const exhaustive: never = effort;
      void exhaustive;

      return 'medium';
    }
  }
}

/**
 * Our `EffortLevel` mapped onto Gemini's two-valued `thinkingLevel`.
 *
 * Two levels, four efforts: `medium` (our default, the ordinary turn) takes `low`, and everything the
 * escalation ladder buys on evidence (`high`/`xhigh`/`max`) takes `high`. `disabled` takes `low` for
 * the same reason as codex — the wire has no off switch and the retry must never 400.
 */
export function geminiThinkingLevel(mode: ThinkingMode, effort: EffortLevel): GeminiThinkingLevel {
  if (mode === 'disabled') {
    return 'low';
  }

  switch (effort) {
    case 'medium':
      return 'low';
    case 'high':
    case 'xhigh':
    case 'max':
      return 'high';
    default: {
      const exhaustive: never = effort;
      void exhaustive;

      return 'low';
    }
  }
}
