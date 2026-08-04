/**
 * Which of KIE's three text APIs a model id belongs to, and what policy that family carries.
 *
 * ## Why the FAMILY comes from the model id and not from the provider
 *
 * KIE serves three completely different wires behind one API key — Anthropic Messages
 * (`claude/v1/messages`), OpenAI **Responses** (`codex/v1/responses`) and native Gemini
 * (`gemini/v1/models/<id>:streamGenerateContent`). They are one PROVIDER (`KIE`, one key, one
 * account, one bill) and three PROTOCOLS, so the provider name cannot answer "which wire".
 *
 * It also cannot come from `LLM_PROVIDER`: the three tier rungs (§4.6.1a) may point at models from
 * different families **simultaneously**, while the provider is one value per deploy. The model id is
 * the only thing that varies per rung, so the family derives from it.
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

export const MODEL_FAMILIES = ['claude', 'codex', 'gemini'] as const;

export type ModelFamily = (typeof MODEL_FAMILIES)[number];

/**
 * How the platform prices cached tokens for a family (`spec/billing.md` §"The Marketplace price list").
 *
 *  - `derived`       — Claude: read = 0.1x input, write = 2.0x input (the 1h tier). The price list
 *                      REFUSES an explicit pair for these rows, so a half-repriced row is inexpressible.
 *  - `explicit-pair` — GPT: KIE publishes Cached Input AND Cache Writes prices, so the row must quote
 *                      BOTH or neither. Deriving them would be inventing a discount we cannot verify.
 *  - `none`          — Gemini: KIE quotes no cached rate and returns no cached-token counter, so cached
 *                      tokens bill at FULL input rate. Flagged and accepted by the owner (2026-08-04):
 *                      never a discount we cannot verify, never a surcharge we cannot observe.
 */
export type CacheProfile = 'derived' | 'explicit-pair' | 'none';

/** The `providerMetadata` namespace each family's usage counters arrive under (see `usage-metadata.ts`). */
export type UsageNamespace = 'anthropic' | 'openai' | 'google';

export interface FamilyPolicy {
  cacheProfile: CacheProfile;
  usageNamespace: UsageNamespace;
  maxTokenAllowed: number;
  maxCompletionTokens: number;
}

export const FAMILY_POLICY: Record<ModelFamily, FamilyPolicy> = {
  claude: {
    cacheProfile: 'derived',
    usageNamespace: 'anthropic',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,
  },
  codex: {
    cacheProfile: 'explicit-pair',
    usageNamespace: 'openai',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,
  },
  gemini: {
    cacheProfile: 'none',
    usageNamespace: 'google',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,
  },
};

/** The id prefixes that select a family, in the order they are tested. */
export const FAMILY_PREFIXES: ReadonlyArray<readonly [prefix: string, family: ModelFamily]> = [
  ['claude-', 'claude'],
  ['gpt-', 'codex'],
  ['gemini-', 'gemini'],
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
      `Unknown model family for "${modelId}". The KIE provider serves three families, selected by ` +
        `model-id prefix: ${FAMILY_PREFIXES.map(([prefix, name]) => `${prefix}* (${name})`).join(', ')}. ` +
        `Add the id to KIE_MODELS and the Marketplace price list, or fix the configured model.`,
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
