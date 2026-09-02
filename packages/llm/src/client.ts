/**
 * LLM Client — 根据 Model + ProviderRoute 构建对应协议适配器。
 * 对应 Rust `llm::Client` 与 provider 路由逻辑。
 */
import type { Model } from '@infuture/types';
import { parseApiProtocol, type ApiProtocol, type LLMProvider, type ProviderRoute } from './schema.js';
import { OpenAiChatProvider, type OpenAiChatConfig } from './adapters/openai_chat.js';
import { OpenAiResponsesProvider } from './adapters/openai_responses.js';
import { AnthropicProvider } from './adapters/anthropic.js';

export interface ClientOptions {
  protocol?: ApiProtocol;
  openAiChatConfig?: Partial<OpenAiChatConfig>;
}

export class Client {
  constructor(
    private readonly model: Model,
    private readonly route: ProviderRoute,
    private readonly options: ClientOptions = {},
  ) {}

  static fromModel(model: Model, apiKey?: string): Client {
    const route: ProviderRoute = {
      providerId: model.provider,
      baseUrl: model.baseUrl,
      apiKey: apiKey ?? model.apiKey ?? '',
      auth: model.api === 'anthropic' ? 'anthropic-api-key' : 'bearer',
      headers: model.headers ?? {},
    };
    const protocol = parseApiProtocol(model.api || model.provider);
    return new Client(model, route, { protocol });
  }

  provider(): LLMProvider {
    const protocol = this.options.protocol ?? parseApiProtocol(this.model.api || this.model.provider);
    switch (protocol) {
      case 'openai-completions':
        return new OpenAiChatProvider(this.route, this.model, this.options.openAiChatConfig);
      case 'openai-responses':
        return new OpenAiResponsesProvider(this.route, this.model);
      case 'anthropic':
        return new AnthropicProvider(this.route, this.model);
    }
  }
}
