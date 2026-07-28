import { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV1 } from 'ai';
import { logger } from '~/utils/logger';

export default class LMStudioProvider extends BaseProvider {
  name = 'LMStudio';
  getApiKeyLink = 'https://lmstudio.ai/';
  labelForGetApiKey = 'Get LMStudio';
  icon = 'i-ph:cloud-arrow-down';

  config = {
    baseUrlKey: 'LMSTUDIO_API_BASE_URL',
    baseUrl: 'http://localhost:1234/',
  };

  staticModels: ModelInfo[] = [];

  private _resolveBaseUrl(
    apiKeys?: Record<string, string>,
    settings?: IProviderSetting,
    serverEnv?: Record<string, string>,
  ): string {
    let { baseUrl } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: settings,
      serverEnv,
      defaultBaseUrlKey: 'LMSTUDIO_API_BASE_URL',
      defaultApiTokenKey: '',
    });

    if (!baseUrl) {
      throw new Error('No baseUrl found for LMStudio provider');
    }

    baseUrl = this.resolveDockerUrl(baseUrl, serverEnv);

    return baseUrl;
  }

  async getDynamicModels(
    apiKeys?: Record<string, string>,
    settings?: IProviderSetting,
    serverEnv: Record<string, string> = {},
  ): Promise<ModelInfo[]> {
    const baseUrl = this._resolveBaseUrl(apiKeys, settings, serverEnv);

    try {
      const response = await fetch(`${baseUrl}/v1/models`, {
        signal: this.createTimeoutSignal(),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as { data: Array<{ id: string }> };

      return data.data.map((model) => ({
        name: model.id,
        label: model.id,
        provider: this.name,
        maxTokenAllowed: 8000,
      }));
    } catch (error) {
      // Same rule as the Ollama provider: only report "not running" if somebody asked for it.
      const configured = Boolean(settings?.baseUrl || serverEnv?.LMSTUDIO_API_BASE_URL);
      const report = configured ? logger.warn.bind(logger) : logger.debug.bind(logger);

      if (error instanceof DOMException && error.name === 'TimeoutError') {
        report('LMStudio model fetch timed out — is LM Studio running?');

        return [];
      }

      if (error instanceof TypeError && error.message.includes('fetch')) {
        report(`LMStudio not reachable at ${baseUrl} — is LM Studio running?`);

        return [];
      }

      logger.error('Error fetching LMStudio models:', error);

      return [];
    }
  }

  getModelInstance: (options: {
    model: string;
    serverEnv?: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }) => LanguageModelV1 = (options) => {
    const { apiKeys, providerSettings, serverEnv, model } = options;
    const envRecord = this.convertEnvToRecord(serverEnv);

    const baseUrl = this._resolveBaseUrl(apiKeys, providerSettings?.[this.name], envRecord);

    logger.debug('LMStudio Base Url used: ', baseUrl);

    const lmstudio = createOpenAI({
      baseURL: `${baseUrl}/v1`,
      apiKey: '',
    });

    return lmstudio(model);
  };
}
