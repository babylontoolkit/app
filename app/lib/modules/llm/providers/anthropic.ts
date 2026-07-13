import { BaseProvider } from '~/lib/modules/llm/base-provider';
import {
  dropOrphanReasoningSignatures,
  stripSamplingParams,
  supportsSamplingParams,
} from '~/lib/modules/llm/capabilities';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { LanguageModelV1 } from 'ai';
import type { IProviderSetting } from '~/types/model';
import { createAnthropic } from '@ai-sdk/anthropic';

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
  }) => LanguageModelV1 = (options) => {
    const { apiKeys, providerSettings, serverEnv, model } = options;
    const { apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings,
      serverEnv: serverEnv as any,
      defaultBaseUrlKey: '',
      defaultApiTokenKey: 'ANTHROPIC_API_KEY',
    });

    // No `output-128k-2025-02-19` beta header — that capability is GA on Claude 4+.
    const anthropic = createAnthropic({ apiKey });

    const instance = supportsSamplingParams(model) ? anthropic(model) : stripSamplingParams(anthropic(model));

    // Applied to EVERY Claude model: any thinking-capable model can emit an empty thinking block.
    return dropOrphanReasoningSignatures(instance);
  };
}
