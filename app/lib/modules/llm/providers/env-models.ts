/**
 * EVERY MODEL AN OPERATOR HAS CONFIGURED FOR A GATEWAY — so `stream-text.ts` can find all of them.
 *
 * ## The defect this exists to close, observed live 2026-08-11
 *
 * `stream-text.ts` (upstream, the enhancer's path) looks the requested model up in the provider's
 * model list and, on a miss, **falls back to `modelsList[0]` behind a `logger.warn`**. So a model that
 * is PRICED but not LISTED is billed as itself and RUN as something else. Measured, verbatim:
 *
 *     WARN stream-text  MODEL [claude-haiku-4-5-20251001] not found in provider [Comet].
 *                       Falling back to first model. claude-sonnet-5
 *
 * That enhancement ran on Sonnet 5 and settled at Haiku's rates. Wrong model, wrong price, no error —
 * the failure `kieEnvModel`'s doc comment has warned about since it was written, arriving through the
 * one door nobody had widened: the ENHANCER's model.
 *
 * ⚠️ **`kie-wire.ts` already records this exact bug happening once before** ("`claude-opus-4-6` and
 * `claude-haiku-4-5` had been PRICED but NOT LISTED"), and the fix that time was to add the ids to a
 * static list. That fixes the instance, not the class: any model reachable only through an env var can
 * miss the list, and the enhancer now has its own per-gateway env var (`<PROVIDER>_ENHANCE_PROMPT_MODEL`).
 *
 * ## Why this is one shared module and not a lambda in each provider
 *
 * `isSecretPath`'s rule: a rule that must not diverge lives in ONE place. The two gateways had two
 * private `*EnvModel` functions that had already drifted once — `kieEnvModel` read only
 * `KIE_DEFAULT_MODEL` while billing preferred `LLM_MODEL`, which reopened the mis-bill "one variable to
 * the left". Adding the enhancer's variables to two more private copies is the same wager taken twice.
 *
 * ## Client-safe, and that constrains how it reads the environment
 *
 * The provider registry is imported by the BROWSER bundle, so this cannot touch `~/lib/.server/env`.
 * `serverEnv ?? process.env` mirrors `base-provider.ts`'s own key lookup exactly — the same "one
 * variable, two doors" arrangement `kieEnvModel` documents, and the doors must never disagree about a
 * value.
 *
 * ## What it does NOT do
 *
 * It does not validate or price anything. This answers *"what will the gateway be asked to serve"*;
 * `agent/config.ts` answers *"may we bill it"* and refuses an unpriced model before a request is ever
 * made. So a name listed here without rates is UNREACHABLE rather than mis-billed — which is the right
 * asymmetry, and the reason listing a name generously is safe.
 */
import { FAMILY_POLICY, familyOf } from '~/lib/modules/llm/model-families';
import type { ModelInfo } from '~/lib/modules/llm/types';

/** Read one variable through both doors, in the order `base-provider.ts` uses. */
function readEnv(key: string, serverEnv?: Record<string, string>): string | undefined {
  return (serverEnv?.[key] || process?.env?.[key])?.trim() || undefined;
}

/**
 * The enhancer model names configured for a gateway, most specific first.
 *
 * ⚠️ The SAME precedence as `getEnhancerModel` — `<PROVIDER>_ENHANCE_PROMPT_MODEL` then
 * `ENHANCE_PROMPT_MODEL` — and BOTH are returned rather than just the winner. Listing a name the
 * resolver would not pick costs nothing (an unpriced one is refused before it can be requested), while
 * listing too few is precisely the silent fallback this module exists to prevent.
 */
export function enhancerModelNames(provider: string, serverEnv?: Record<string, string>): string[] {
  const names = [
    readEnv(`${provider.toUpperCase()}_ENHANCE_PROMPT_MODEL`, serverEnv),
    readEnv('ENHANCE_PROMPT_MODEL', serverEnv),
  ];

  return names.filter((name): name is string => Boolean(name));
}

/**
 * Synthesise a `ModelInfo` for a configured id, or `undefined` if it is already accounted for.
 *
 * Caps come from the model's FAMILY, never from a pair of literals — otherwise a `grok-*` or
 * `gemini-*` override silently inherits Claude's 1M context window. An UNKNOWN family still gets a
 * `ModelInfo` on purpose: refusing here would surface the operator's error as "your model silently is
 * not in the list", which is the `modelsList[0]` mis-bill this module exists to prevent.
 * `getModelInstance` refuses an unplaceable id LOUDLY at the moment of use, naming it — one refusal,
 * at the point where it can be explained.
 */
export function envModelInfo(
  name: string,
  provider: string,
  staticModels: readonly ModelInfo[],
  alreadyAdded: readonly ModelInfo[] = [],
): ModelInfo | undefined {
  if (staticModels.some((m) => m.name === name) || alreadyAdded.some((m) => m.name === name)) {
    return undefined;
  }

  const policy = FAMILY_POLICY[familyOf(name) ?? 'claude'];

  return {
    name,
    label: `${name} (${provider})`,
    provider,
    maxTokenAllowed: policy.maxTokenAllowed,
    maxCompletionTokens: policy.maxCompletionTokens,
  };
}

/**
 * Every operator-configured model for a gateway: the platform model this caller resolved, plus the
 * enhancer's — de-duplicated against the static list and against each other.
 *
 * `platform` is passed in rather than read here because the two gateways disagree about its
 * precedence (KIE also honours `KIE_DEFAULT_MODEL`), and that difference is genuinely theirs. What
 * must NOT differ is everything after it, which is why the rest lives here.
 */
export function envConfiguredModels(
  provider: string,
  staticModels: readonly ModelInfo[],
  platform: ModelInfo | undefined,
  serverEnv?: Record<string, string>,
): ModelInfo[] {
  const models: ModelInfo[] = platform ? [platform] : [];

  for (const name of enhancerModelNames(provider, serverEnv)) {
    const info = envModelInfo(name, provider, staticModels, models);

    if (info) {
      models.push(info);
    }
  }

  return models;
}
