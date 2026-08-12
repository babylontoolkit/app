/**
 * Comet — ONE provider, FOUR model families, dispatched on the model id (SPEC §4.2a).
 *
 * ## Why this provider exists, and why the Claude wire is the whole argument
 *
 * Comet serves **Anthropic's native Messages API** at `api.cometapi.com/v1/messages` — not an
 * OpenAI-compatible shim. That is not a detail, it is the entire viability test for a gateway on this
 * platform: **prompt caching does not exist in OpenAI-compatibility mode.** A `/v1/chat/completions`
 * endpoint cannot carry `cache_control`, so routing Claude traffic there would silently disable every
 * breakpoint in `spec/context-budget.md` and cost ~3x on every edit turn — with identical bytes
 * returned and nothing thrown. Live-probed 2026-08-10: a real 1h-tier cache write (5,420 tokens) and a
 * matching read, with `cache_creation.ephemeral_1h_input_tokens` populated and the tiered split intact.
 *
 * It was adopted for RELIABILITY, not for the discount (the discount is real but shallow — see
 * `_specs/cometapi-provider_spec.md`, which is honest in both directions: Comet is roughly 2x KIE's
 * Claude prices and roughly 20% under Anthropic-direct). The measured failures it answers are KIE's:
 * fully BATCHED delivery on the Claude adapter (`agent/delivery.ts`), EMPTY thinking text while the
 * thinking tokens still bill (`spec/anthropic-models.md` §3.4a), and a gateway that kills any step
 * emitting no bytes for ~30s (`retry-policy.ts` exists solely to mitigate that). Comet passed all
 * three: 388 text deltas with 4% of characters in the final second, and 386 chars of thinking text
 * with a valid signature.
 *
 * ## The dispatcher
 *
 * 🔴 **A family names a DIALECT; THIS PROVIDER chooses the WIRE** (FR2). The map is data, in
 * `comet-wire.ts`'s `COMET_WIRES`, and it is not the same map KIE has: `gpt-*` is OpenAI-dialect on
 * both gateways but takes **Responses** on KIE and **chat-completions** here, so KIE's
 * `createOpenAI().responses()` binding does not port. See `model-families.ts` for why the family
 * cannot instead be derived from `LLM_PROVIDER` (the tier rungs may name different families at once,
 * while the provider is one value per deploy).
 *
 * 🔴 **The Claude wrappers below wrap the CLAUDE branch ONLY** (FR1/FR3). `thinkingFetch`,
 * `stripSamplingParams` and `dropOrphanReasoningSignatures` all encode Anthropic wire facts; applying
 * any of them to another family puts an Anthropic `thinking` block and an `output_config` into a
 * foreign request body, which is a hard 400 before a token. The branch STRUCTURE is what makes that
 * impossible rather than merely unlikely, and `cometapi-dispatch.spec.ts` pins it with a default-deny
 * source scan plus controls.
 *
 * ## What is deliberately NOT wired here (yet)
 *
 *  - **`kieFetch`** — it sets `thinkingFlag`, a field private to KIE's Claude adapter. Comet is a
 *    native passthrough and has no such field; `scripts/stream-probe.mjs`'s Comet block omits it for
 *    the same reason.
 *  - **`refusalFallbackFetch` / `tapStopReasons`** — `anthropic.ts` wraps both; `kie.ts` wraps
 *    neither, and this file follows KIE. Whether Comet forwards `fallbacks` and the
 *    `server-side-fallback-2026-07-01` beta header is UNPROBED (spec OQ2/OQ3). A beta header a gateway
 *    rejects is a hard 400 on every request; a `fallbacks` field it silently drops is a Fable 5
 *    refusal surfacing as today's error, which is survivable. Wire them only once probed — the
 *    asymmetry of those two failures is why the default is "not wired".
 */
import { BaseProvider } from '~/lib/modules/llm/base-provider';
import {
  DEFAULT_EFFORT,
  dropOrphanReasoningSignatures,
  parseEffort,
  stripSamplingParams,
  supportsSamplingParams,
  thinkingFetch,
  type EffortLevel,
  type ThinkingMode,
} from '~/lib/modules/llm/capabilities';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { LanguageModelV1 } from 'ai';
import type { IProviderSetting } from '~/types/model';
import { envConfiguredModels } from './env-models';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { cometEnvModel, cometGeminiBaseUrl, COMET_DEFAULT_BASE_URL, COMET_MODELS, COMET_WIRES } from './comet-wire';
import { requireFamily } from '~/lib/modules/llm/model-families';
import { rateLimitFetch } from '~/lib/modules/llm/rate-limit';

export default class CometApiProvider extends BaseProvider {
  name = 'Comet';
  getApiKeyLink = 'https://api.cometapi.com/console/token';

  config = {
    baseUrlKey: 'COMET_BASE_URL',
    apiTokenKey: 'COMET_API_KEY',
  };

  staticModels: ModelInfo[] = COMET_MODELS;

  /**
   * The operator's configured model, if it is not already a static row — see `cometEnvModel`.
   *
   * "Dynamic" means "from config", not "from the vendor's API". Comet DOES publish a model list
   * (`GET /api/models`, which the Admin panel can fetch for the operator's eyes), but a list endpoint
   * is not a probe: its `code` and `id` fields already disagree, so populating the provider's models
   * from it would ship ids that 404. This is upstream's seam for a configured model, and using it is
   * what keeps `stream-text.ts` from silently running a different model than the one we bill for.
   */
  async getDynamicModels(
    _apiKeys?: Record<string, string>,
    _settings?: IProviderSetting,
    serverEnv?: Record<string, string>,
  ): Promise<ModelInfo[]> {
    /*
     * The platform model AND the enhancer's — see `env-models.ts`. Listing only the platform model is
     * what let a configured `COMET_ENHANCE_PROMPT_MODEL` miss this list and get silently swapped for
     * `modelsList[0]` by `stream-text.ts`, running Sonnet 5 while settling at Haiku's rates.
     */
    return envConfiguredModels('Comet', COMET_MODELS, cometEnvModel(serverEnv), serverEnv);
  }

  getModelInstance: (options: {
    model: string;
    serverEnv: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
    effort?: EffortLevel;

    /** Force thinking off for THIS request — the proxy's last-resort retry (`retry-policy.ts`). */
    thinkingMode?: ThinkingMode;
  }) => LanguageModelV1 = (options) => {
    const { apiKeys, providerSettings, serverEnv, model } = options;

    /*
     * 🔴 FIRST, BEFORE ANYTHING ELSE — before the key lookup, before any wire is built.
     *
     * An id we cannot place has no correct protocol, and the alternative to refusing is guessing one.
     * `capabilities.ts`'s tables default to modern-Claude, so a `grok-*` id would otherwise be handed
     * an Anthropic `thinking` block inside a chat-completions body — a hard 400 before a token, on a
     * model the operator believes is configured. Refusing here turns that into one loud, immediate,
     * free error naming the id and every accepted prefix.
     */
    const family = requireFamily(model);

    const { apiKey, baseUrl } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings,
      serverEnv: serverEnv as any,
      defaultBaseUrlKey: 'COMET_BASE_URL',
      defaultApiTokenKey: 'COMET_API_KEY',
    });

    if (!apiKey) {
      throw `Missing Api Key configuration for ${this.name} provider`;
    }

    // Identical policy to `anthropic.ts` and `kie.ts` — same models, same reasons. See those files.
    const thinkingMode: ThinkingMode =
      options.thinkingMode ?? ((serverEnv as any)?.THINKING_MODE === 'disabled' ? 'disabled' : 'adaptive');
    const effort: EffortLevel = options.effort ?? parseEffort((serverEnv as any)?.THINKING_EFFORT) ?? DEFAULT_EFFORT;

    /*
     * ⚠️ Unlike `KIE_BASE_URL`, this override is NOT scoped to one family — Comet serves every family
     * from one origin, so an operator who points it at a proxy means all of it. Do not carry KIE's
     * Claude-scoping rule across; there it exists because KIE hosts three adapters under three paths.
     */
    const base = baseUrl || COMET_DEFAULT_BASE_URL;
    const headers = { Authorization: `Bearer ${apiKey}` };
    const wire = COMET_WIRES[family];

    if (wire === 'chat') {
      /*
       * The OpenAI chat-completions surface — `gpt-*` (`codex`) and the `chat` family together.
       *
       * `.chat(model)`, NOT `.responses(model)`: Comet's model list marks `gpt-5*` as `openai` and only
       * `o3-pro` carries `openai-response`, so KIE's Responses binding has no endpoint here.
       *
       * NONE of the Claude wrappers appear in this branch, and that is the FR3 guarantee rather than an
       * omission: `thinkingFetch` would write an Anthropic `thinking` block and an `output_config` into
       * this body, and `dropOrphanReasoningSignatures` filters a stream shape this wire does not
       * produce. `stripSamplingParams` is absent for the same structural reason.
       *
       * ⚠️ Grok and Kimi are reported to return reasoning on a non-standard `reasoning_content` field
       * that `@ai-sdk/openai` does not map, so thinking text may be silently dropped for this family.
       * UNPROBED (T10). If it is real, the wrapper that surfaces it MUST route it to the reasoning
       * channel and never into text — the text channel feeds the artifact parser, so leaked reasoning
       * is written into the user's source file.
       */
      const openai = createOpenAI({
        apiKey,
        baseURL: base,
        headers,
        fetch: rateLimitFetch({ provider: this.name }),
      });

      return openai.chat(model);
    }

    if (wire === 'gemini') {
      /* Native Gemini on `/v1beta`. Same FR3 guarantee — no Claude wrapper touches it. */
      const gemini = createGoogleGenerativeAI({
        apiKey,
        baseURL: cometGeminiBaseUrl(base),
        headers,
        fetch: rateLimitFetch({ provider: this.name }),
      });

      return gemini(model);
    }

    if (wire !== 'messages') {
      /*
       * Unreachable while `COMET_WIRES` is an exhaustive Record — and present because "unreachable"
       * is a property of today's table, not of this function. A wire added to `CometWire` without a
       * branch here would otherwise fall into the Anthropic client below, which is the exact
       * fallthrough hazard `kie.ts` shipped for a week (its Claude branch was an `else`).
       */
      const exhaustive: never = wire;
      void exhaustive;

      throw new Error(`Comet has no wire binding for family "${family}" (model "${model}").`);
    }

    /*
     * The CLAUDE family — Anthropic's native Messages API, so every piece of §4.2a's hardening applies
     * unchanged. `thinkingFetch` only rewrites the request BODY (it never looks at the URL), which is
     * why a passthrough gateway composes with it exactly as the direct provider does.
     *
     * The chain reads outside-in: thinkingFetch -> rateLimitFetch. `rateLimitFetch` sits closest to
     * the network because it is the only one that decides whether to send the finished body AGAIN — it
     * must see the request exactly as the vendor will.
     */
    const comet = createAnthropic({
      apiKey,
      baseURL: base,

      /*
       * `createAnthropic({apiKey})` only ever sends `x-api-key`. Comet accepts that too, but every
       * branch here sends Bearer so there is ONE header shape to check when auth fails.
       */
      headers,

      fetch: thinkingFetch(thinkingMode, effort, model, rateLimitFetch({ provider: this.name })),
    });

    const instance = supportsSamplingParams(model) ? comet(model) : stripSamplingParams(comet(model));

    return dropOrphanReasoningSignatures(instance);
  };
}
