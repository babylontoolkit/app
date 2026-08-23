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
import { rateLimitFetch } from '~/lib/modules/llm/rate-limit';
import { refusalFallbackFetch } from '~/lib/modules/llm/refusal-fallback';
import { tapStopReasons } from '~/lib/modules/llm/stop-reason-tap';

export default class AnthropicProvider extends BaseProvider {
  name = 'Anthropic';
  getApiKeyLink = 'https://console.anthropic.com/settings/keys';

  config = {
    apiTokenKey: 'ANTHROPIC_API_KEY',
  };

  /*
   * Model IDs are COMPLETE as written — never append a date (`-20251114`) or `-latest`.
   * Those belong to the retired dated-snapshot scheme and now 404.
   *
   * `maxTokenAllowed` = context window. `maxCompletionTokens` = OUTPUT cap. They are different
   * numbers and must not be copied between rows: Haiku 4.5 is the exception at 200k/64k, and
   * asking for more output than a model allows is a hard 400.
   */
  staticModels: ModelInfo[] = [
    {
      name: 'claude-sonnet-5',
      label: 'Claude Sonnet 5',
      provider: 'Anthropic',
      maxTokenAllowed: 1_000_000,
      maxCompletionTokens: 128_000,
    },
    {
      name: 'claude-haiku-4-5',
      label: 'Claude Haiku 4.5',
      provider: 'Anthropic',
      maxTokenAllowed: 200_000,
      maxCompletionTokens: 64_000, // NOT 128k — see above
    },
    {
      name: 'claude-opus-4-8',
      label: 'Claude Opus 4.8',
      provider: 'Anthropic',
      maxTokenAllowed: 1_000_000,
      maxCompletionTokens: 128_000,
    },
    {
      name: 'claude-opus-5',
      label: 'Claude Opus 5',
      provider: 'Anthropic',
      maxTokenAllowed: 1_000_000,
      maxCompletionTokens: 128_000,
    },
    {
      name: 'claude-fable-5',
      label: 'Claude Fable 5',
      provider: 'Anthropic',
      maxTokenAllowed: 1_000_000,
      maxCompletionTokens: 128_000,
    },
  ];

  async getDynamicModels(
    apiKeys?: Record<string, string>,
    settings?: IProviderSetting,
    serverEnv?: Record<string, string>,
  ): Promise<ModelInfo[]> {
    const { apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: settings,
      serverEnv: serverEnv as any,
      defaultBaseUrlKey: '',
      defaultApiTokenKey: 'ANTHROPIC_API_KEY',
    });

    if (!apiKey) {
      throw `Missing Api Key configuration for ${this.name} provider`;
    }

    const response = await fetch(`https://api.anthropic.com/v1/models`, {
      headers: {
        'x-api-key': `${apiKey}`,
        'anthropic-version': '2023-06-01',
      },
    });

    const res = (await response.json()) as any;
    const staticModelIds = this.staticModels.map((m) => m.name);

    const data = res.data.filter((model: any) => model.type === 'model' && !staticModelIds.includes(model.id));

    return data.map((m: any) => {
      /*
       * The Models API is self-describing and returns BOTH numbers — do not guess, and do not
       * swap them. Fallbacks are deliberately asymmetric: undershooting output truncates,
       * overshooting is a 400. So the output fallback is pessimistic.
       */
      const contextWindow: number = m.max_input_tokens ?? 200_000;
      const maxCompletionTokens: number = m.max_tokens ?? 8192;

      return {
        name: m.id,
        label: `${m.display_name} (${Math.floor(contextWindow / 1000)}k context)`,
        provider: this.name,
        maxTokenAllowed: contextWindow,
        maxCompletionTokens,
      };
    });
  }

  getModelInstance: (options: {
    model: string;
    serverEnv: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
    effort?: EffortLevel;

    /**
     * Force thinking OFF for THIS request (§4.2a) — the late retries, and nothing else.
     *
     * KIE kills any step that puts no bytes on the wire for ~30s, and an extended think is exactly that:
     * silence. Disabling thinking makes the model start emitting text almost immediately, so the stream
     * can never go quiet long enough to be killed. See `retryThinkingMode` in `retry-policy.ts` for why
     * this is scoped late rather than everywhere — a general "go quiet, drop thinking" rule would eat
     * the reasoning text on precisely the long thinks whose reasoning is worth reading. ⚠️ WHICH
     * retries is asserted in `retry-policy.spec.ts` and stated in no comment: every wrong version of
     * that sentence was a count somebody typed.
     *
     * Omitted on every ordinary generation, which keeps the operator's `THINKING_MODE` authoritative.
     */
    thinkingMode?: ThinkingMode;
  }) => LanguageModelV1 = (options) => {
    const { apiKeys, providerSettings, serverEnv, model } = options;
    const { apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings,
      serverEnv: serverEnv as any,
      defaultBaseUrlKey: '',
      defaultApiTokenKey: 'ANTHROPIC_API_KEY',
    });

    /*
     * Thinking is ON, and VISIBLE (§4.2a). Both halves matter.
     *
     * Current Claude models (Sonnet 5, the Opus 4.x family, Fable 5) think by default and are better
     * for it — a game build is exactly the kind of multi-step work adaptive thinking is meant for, so
     * turning it off to make the app feel fast would be trading quality for a progress bar.
     *
     * The real defect was never that the model thinks. It was that `thinking.display` defaults to
     * `"omitted"`: the model reasons, we are billed for every token at the full output rate, and the
     * API returns a thinking block whose text is EMPTY. We paid for reasoning and then had nothing to
     * show, so a 90-second think rendered as a dead spinner. `display: 'summarized'` (set in
     * `thinkingFetch`) costs NOTHING extra — thinking is billed identically under every display
     * setting — and turns those tokens into a stream the user can watch.
     *
     * `THINKING_MODE=disabled` remains available as a speed lever (measured: 152s → 72s, $0.293 →
     * $0.200 on one creation), but it is not the default: it buys latency with intelligence.
     */
    const thinkingMode: ThinkingMode =
      options.thinkingMode ?? ((serverEnv as any)?.THINKING_MODE === 'disabled' ? 'disabled' : 'adaptive');

    /*
     * Effort — the dial that bounds what thinking COSTS (§4.2a).
     *
     * `output_config.effort` defaults to `high` server-side. Omitting it, which is what we did until
     * now, is not "no opinion" — it silently buys the second-most-expensive setting, and it is why one
     * creation spent ~15,000 thinking tokens to emit ~5,500 tokens of landing page. We pay for those
     * at the full OUTPUT rate.
     *
     * Precedence: the per-turn policy (the proxy knows a repair from a first draft) > the operator's
     * `THINKING_EFFORT` > `medium`. `parseEffort` is what makes that last hop safe — a `.env` file is
     * a string file, and it is also what refuses `low` (a measured correctness bug, not a discount).
     */
    const effort: EffortLevel = options.effort ?? parseEffort((serverEnv as any)?.THINKING_EFFORT) ?? DEFAULT_EFFORT;

    /*
     * No `output-128k-2025-02-19` beta header — that capability is GA on Claude 4+.
     *
     * `rateLimitFetch` sits UNDER `thinkingFetch`, closest to the network: it is the one that may send
     * the finished body again, so it must see the request exactly as Anthropic will. It honours
     * `retry-after` (the SDK's own retry backs off on a fixed 2s/4s and ignores the header Anthropic
     * actually sends) and reports every absorbed 429, so throttling on a shared platform key is visible
     * rather than something we infer from failed generations (§5A).
     */
    /*
     * `refusalFallbackFetch` sits INSIDE `thinkingFetch` so it sees the finished body (the fallback
     * attempt inherits thinking + output_config) — and on the way back it strips the `fallback`
     * content block the beta splices into the stream, which the SDK's chunk schema would reject.
     * `tapStopReasons` stays innermost-but-one so the diagnostic records the RAW wire, including a
     * final refusal when every model in the chain declined.
     */
    const anthropic = createAnthropic({
      apiKey,
      fetch: thinkingFetch(
        thinkingMode,
        effort,
        model,
        refusalFallbackFetch(model, tapStopReasons(rateLimitFetch({ provider: this.name }))),
      ),
    });

    const instance = supportsSamplingParams(model) ? anthropic(model) : stripSamplingParams(anthropic(model));

    // Applied to EVERY Claude model: any thinking-capable model can emit an empty thinking block.
    return dropOrphanReasoningSignatures(instance);
  };
}
