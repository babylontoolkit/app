/**
 * KIE.ai — ONE provider, THREE model families, dispatched on the model id (SPEC §4.2a).
 *
 * ## The dispatcher (2026-08-04)
 *
 * KIE fronts three completely different text APIs behind one key: Anthropic Messages
 * (`claude/v1/messages`), OpenAI **Responses** (`codex/v1/responses`) and native Gemini
 * (`gemini/v1/models/<id>:streamGenerateContent`). They are one PROVIDER and three PROTOCOLS, so
 * `getModelInstance` picks the wire from the family of `model` — see `model-families.ts` for why the
 * family cannot come from `LLM_PROVIDER` (the three tier rungs may point at different families at
 * once, while the provider is one value per deploy).
 *
 * 🔴 **The Claude wrappers below wrap the CLAUDE branch ONLY** (FR3). `thinkingFetch`, `kieFetch`,
 * `stripSamplingParams` and `dropOrphanReasoningSignatures` all encode Anthropic wire facts; applying
 * any of them to another family puts Anthropic-shaped fields in a foreign request body, which is a
 * hard 400 before a token. The branch structure is what makes that impossible rather than merely
 * unlikely, and `kie-dispatch.spec.ts` pins it dead with a default-deny source scan.
 *
 * Everything below this line describes the CLAUDE family, unchanged.
 *
 * ## Why this is a baseURL swap and not a new integration
 *
 * KIE fronts `https://api.kie.ai/claude/v1/messages` — Anthropic's **native Messages API**, not an
 * OpenAI-compatible shim. That distinction is the whole reason this provider is viable, and it is not
 * a detail: **prompt caching does not exist in OpenAI-compatibility mode.** A `/v1/chat/completions`
 * endpoint cannot carry `cache_control`, so routing there would silently disable every cache
 * breakpoint in `spec/context-budget.md` — and the failure would be invisible, because an uncached
 * generation returns the same bytes as a cached one. It would just cost ~3x more on every edit turn
 * (a warm edit is 155,815 cache-read tokens; at full input rate those stop being nearly free).
 *
 * Because it is a native passthrough, every piece of Anthropic hardening applies unchanged and MUST
 * be kept — `thinkingFetch` only rewrites the request BODY (it never looks at the URL), so all three
 * wrappers compose exactly as they do for the direct provider:
 *
 *   - `thinkingFetch`  — `{type:'adaptive', display:'summarized'}` + an explicit `output_config.effort`.
 *                        Omitting either is not "no opinion": display defaults to `omitted` (we pay
 *                        full output rate for reasoning the API returns as EMPTY text) and effort
 *                        defaults to `high` server-side.
 *   - `stripSamplingParams`        — `ai@4` injects `temperature: 0`, which current models 400 on.
 *   - `dropOrphanReasoningSignatures` — empty thinking blocks emit orphan signatures.
 *
 * ## Two things that differ from `anthropic.ts`, both load-bearing
 *
 * 1. **Auth is `Authorization: Bearer`, not `x-api-key`.** `createAnthropic({apiKey})` only ever sends
 *    `x-api-key`, which KIE ignores — so the key is ALSO passed as an explicit header. Without it every
 *    request 401s. (KIE documents two forms: `ANTHROPIC_AUTH_TOKEN` as the bare key, or
 *    `ANTHROPIC_API_KEY` prefixed with a literal `"Bearer "`. We send the header ourselves rather than
 *    relying on a caller to remember a magic prefix.)
 * 2. **`baseURL` ends in `/v1`.** `@ai-sdk/anthropic` appends `/messages`, so `https://api.kie.ai/claude`
 *    alone would POST to `/claude/messages` and 404. KIE's own docs say "do not append /v1/messages —
 *    Claude Code appends that automatically"; the SDK appends only the second half of that.
 *
 * ## The model list is deliberately SHORT
 *
 * Only models KIE is confirmed to serve. A row here that KIE does not carry is not a harmless extra
 * option — it is a 404 at the first generation, which is exactly why `anthropic.ts` warns against
 * guessing model ids. Add rows as they are confirmed against the KIE console, never speculatively.
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
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { kieEnvModel, kieFetch, KIE_DEFAULT_BASE_URL, KIE_MODELS } from './kie-wire';
import { codexFetch, KIE_CODEX_BASE_URL } from './kie-codex-wire';
import { geminiFetch, KIE_GEMINI_BASE_URL } from './kie-gemini-wire';
import { codexEffort, geminiThinkingLevel, requireFamily } from '~/lib/modules/llm/model-families';
import { rateLimitFetch } from '~/lib/modules/llm/rate-limit';

export default class KieProvider extends BaseProvider {
  name = 'KIE';
  getApiKeyLink = 'https://kie.ai/api-key';

  config = {
    baseUrlKey: 'KIE_BASE_URL',
    apiTokenKey: 'KIE_API_KEY',
  };

  staticModels: ModelInfo[] = KIE_MODELS;

  /**
   * The operator's `KIE_DEFAULT_MODEL`, if it is not already a static row — see `kieEnvModel`.
   *
   * "Dynamic" here means "from config", not "from the vendor's API": KIE publishes no model-list
   * endpoint, and guessing ids is what `anthropic.ts` warns against. This is upstream's seam for
   * exactly this, and using it is what keeps `stream-text.ts` from silently running a different model
   * than the one we bill for.
   */
  async getDynamicModels(
    _apiKeys?: Record<string, string>,
    _settings?: IProviderSetting,
    serverEnv?: Record<string, string>,
  ): Promise<ModelInfo[]> {
    const model = kieEnvModel(serverEnv);

    return model ? [model] : [];
  }

  getModelInstance: (options: {
    model: string;
    serverEnv: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
    effort?: EffortLevel;

    /**
     * Force thinking off for THIS request — the proxy's last-resort retry (`proxy.ts`, `retry-policy.ts`).
     *
     * 🔴 **This parameter was MISSING until 2026-08-04, and its absence was a silent no-op on the
     * default platform provider.** `proxy.ts` has been passing `thinkingMode: 'disabled'` on the final
     * retry attempt since KIE's ~30s silent-step timeout was diagnosed (2026-07-27) — the whole point
     * of that attempt is that with no think, text starts flowing in ~1s, so KIE's gateway can never kill
     * the step for silence. It reached `anthropic.ts` (which declares it) and was dropped on the floor
     * here as an excess property across the function-type boundary. So on KIE — the provider the
     * mitigation was written FOR — the third attempt was byte-identical to the first two, and a
     * generation that had already burned two 30-second timeouts re-rolled the same coin a third time.
     */
    thinkingMode?: ThinkingMode;
  }) => LanguageModelV1 = (options) => {
    const { apiKeys, providerSettings, serverEnv, model } = options;

    /*
     * 🔴 FIRST, BEFORE ANYTHING ELSE — before the key lookup, before any wire is built.
     *
     * An id we cannot place has no correct protocol, and the alternative to refusing is guessing one.
     * Guessing used to happen implicitly: `capabilities.ts`'s tables default to modern-Claude, so a
     * `gpt-*` id would have been handed an Anthropic `thinking` block inside an OpenAI request body —
     * a hard 400 before a token, on a model the operator believes is configured. Refusing at model
     * resolution turns that into one loud, immediate, free error naming the id and the accepted
     * prefixes (FR1).
     */
    const family = requireFamily(model);

    const { apiKey, baseUrl } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings,
      serverEnv: serverEnv as any,
      defaultBaseUrlKey: 'KIE_BASE_URL',
      defaultApiTokenKey: 'KIE_API_KEY',
    });

    if (!apiKey) {
      throw `Missing Api Key configuration for ${this.name} provider`;
    }

    // Identical policy to `anthropic.ts` — same models, same reasons. See that file for the rationale.
    const thinkingMode: ThinkingMode =
      options.thinkingMode ?? ((serverEnv as any)?.THINKING_MODE === 'disabled' ? 'disabled' : 'adaptive');
    const effort: EffortLevel = options.effort ?? parseEffort((serverEnv as any)?.THINKING_EFFORT) ?? DEFAULT_EFFORT;

    if (family === 'codex') {
      /*
       * The GPT surface (`kie-codex-wire.ts`). NONE of the Claude wrappers appear here, and that is the
       * FR3 guarantee rather than an omission: `thinkingFetch` would write an Anthropic `thinking`
       * block and an `output_config` into an OpenAI Responses body, `kieFetch` would add KIE's
       * Claude-adapter-specific `thinkingFlag`, and `dropOrphanReasoningSignatures` filters a stream
       * shape this wire does not produce. `stripSamplingParams` is absent too — the Responses model
       * strips them itself for `gpt-5*` ids (see `kie-codex-wire.ts`'s temperature note).
       */
      const codex = createOpenAI({
        apiKey,
        baseURL: KIE_CODEX_BASE_URL,
        headers: { Authorization: `Bearer ${apiKey}` },
        fetch: codexFetch(codexEffort(thinkingMode, effort), rateLimitFetch({ provider: this.name })),
      });

      return codex.responses(model);
    }

    if (family === 'gemini') {
      /* The Gemini surface (`kie-gemini-wire.ts`). Same FR3 guarantee — no Claude wrapper touches it. */
      const gemini = createGoogleGenerativeAI({
        apiKey,
        baseURL: KIE_GEMINI_BASE_URL,
        headers: { Authorization: `Bearer ${apiKey}` },
        fetch: geminiFetch(geminiThinkingLevel(thinkingMode, effort), rateLimitFetch({ provider: this.name })),
      });

      return gemini(model);
    }

    /*
     * 🔴 EXPLICIT, never a fallthrough. This branch used to be the `else`, which was correct for
     * exactly as long as every family this provider did not name was Claude. The moment a fourth
     * family was declared (`chat`, 2026-08-10) `requireFamily('grok-4.5')` started SUCCEEDING, and an
     * `else` would have handed a Grok id to `createAnthropic` — an Anthropic `thinking` block in a
     * chat-completions body, a hard 400 before a token, on precisely the failure `requireFamily`
     * exists to prevent. A branch that catches "everything I have not thought of" is a guess.
     */
    if (family !== 'claude') {
      throw new Error(
        `The KIE provider does not serve the "${family}" family (model "${model}"). KIE fronts ` +
          'claude-*, gpt-* and gemini-* only. Point LLM_MODEL at a model KIE serves, or set ' +
          'LLM_PROVIDER to a provider that serves this family.',
      );
    }

    /*
     * The CLAUDE family — byte-identical to what this provider has always done (§4.2a's regression
     * bar). `baseUrl`/`KIE_BASE_URL` stays CLAUDE-SCOPED, deliberately: it has always meant "the Claude
     * endpoint", an operator who set it meant that, and the other two families carry their own base
     * constants. One override that silently repointed all three would be a config value whose meaning
     * changed under the operator.
     */
    const kie = createAnthropic({
      apiKey,
      baseURL: baseUrl || KIE_DEFAULT_BASE_URL,

      /*
       * The reason this provider exists as its own file. `createAnthropic` sends `x-api-key`; KIE
       * authenticates on `Authorization: Bearer`. Sending both is harmless — the unused one is ignored.
       */
      headers: { Authorization: `Bearer ${apiKey}` },

      /*
       * ORDER MATTERS, and the chain reads outside-in: thinkingFetch -> kieFetch -> rateLimitFetch.
       *
       * `thinkingFetch` parses the body and sets `thinking`/`output_config`, then hands to `kieFetch`,
       * which adds `thinkingFlag` to THAT body (both must be on the same request or KIE thinks without
       * telling us). `rateLimitFetch` sits at the bottom, closest to the network, because it is the only
       * one that decides whether to send the finished body AGAIN — it must see the request exactly as
       * the vendor will.
       *
       * ⚠️ KIE publishes NO rate-limit headers, so throttling here is invisible by default. Measured
       * 2026-07-17: 60 concurrent requests (71/10s, 3.5x their documented 20/10s cap) returned zero
       * 429s — that cap governs their image/video task API, not this endpoint — but p95 latency went
       * 349ms -> 7,474ms. **KIE soft-throttles by QUEUEING rather than rejecting**, which no retry can
       * see and no header reports. `onThrottled` is what makes the 429 case visible if it ever starts.
       */
      fetch: thinkingFetch(thinkingMode, effort, model, kieFetch(rateLimitFetch({ provider: this.name }))),
    });

    const instance = supportsSamplingParams(model) ? kie(model) : stripSamplingParams(kie(model));

    return dropOrphanReasoningSignatures(instance);
  };
}
