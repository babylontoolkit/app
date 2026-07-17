/**
 * KIE.ai — the same Claude models, served through an Anthropic-native passthrough (SPEC §4.2a).
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
import { kieFetch, KIE_DEFAULT_BASE_URL, KIE_MODELS } from './kie-wire';

export default class KieProvider extends BaseProvider {
  name = 'KIE';
  getApiKeyLink = 'https://kie.ai/api-key';

  config = {
    baseUrlKey: 'KIE_BASE_URL',
    apiTokenKey: 'KIE_API_KEY',
  };

  staticModels: ModelInfo[] = KIE_MODELS;

  getModelInstance: (options: {
    model: string;
    serverEnv: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
    effort?: EffortLevel;
  }) => LanguageModelV1 = (options) => {
    const { apiKeys, providerSettings, serverEnv, model } = options;
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
    const thinkingMode: ThinkingMode = (serverEnv as any)?.THINKING_MODE === 'disabled' ? 'disabled' : 'adaptive';
    const effort: EffortLevel = options.effort ?? parseEffort((serverEnv as any)?.THINKING_EFFORT) ?? DEFAULT_EFFORT;

    const kie = createAnthropic({
      apiKey,
      baseURL: baseUrl || KIE_DEFAULT_BASE_URL,

      /*
       * The reason this provider exists as its own file. `createAnthropic` sends `x-api-key`; KIE
       * authenticates on `Authorization: Bearer`. Sending both is harmless — the unused one is ignored.
       */
      headers: { Authorization: `Bearer ${apiKey}` },

      /*
       * ORDER MATTERS. `thinkingFetch` parses the body, sets `thinking`/`output_config`, re-stringifies
       * and hands off to its baseFetch — so `kieFetch` runs LAST and adds `thinkingFlag` to the body
       * that already carries the thinking settings. Both must be on the same request or KIE thinks
       * without telling us (see `kieFetch`).
       */
      fetch: thinkingFetch(thinkingMode, effort, model, kieFetch()),
    });

    const instance = supportsSamplingParams(model) ? kie(model) : stripSamplingParams(kie(model));

    return dropOrphanReasoningSignatures(instance);
  };
}
