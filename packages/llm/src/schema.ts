/**
 * LLM schema — 模型请求/流事件/协议路由。
 * 对应 对应 Rust `llm::schema`。
 */
import type { AgentMessage, Message, ToolDef, Usage } from '@infuture/types';

export type ApiProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic';

export function parseApiProtocol(value: string): ApiProtocol {
  const v = value.trim().toLowerCase();
  switch (v) {
    case '':
    case 'chat':
    case 'openai':
    case 'completions':
    case 'openai-completions':
    case 'openai-chat':
    case 'openai-chat-completions':
      return 'openai-completions';
    case 'responses':
    case 'openai-responses':
      return 'openai-responses';
    case 'anthropic':
    case 'anthropic-messages':
      return 'anthropic';
    default:
      throw new Error(
        `unsupported model API protocol \`${value}\`; expected openai-completions, openai-responses, or anthropic`,
      );
  }
}

export type AuthScheme = 'bearer' | 'anthropic-api-key';

export interface ProviderRoute {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  auth: AuthScheme;
  headers: Record<string, string>;
}

/** 模型请求：发往 stream_model 的统一结构。 */
export interface ModelRequest {
  model: string;
  systemPrompt: string;
  messages: AgentMessage[] | Message[];
  tools: ToolDef[];
  /** 可选的思考级别/预算覆盖。 */
  thinkingLevel?: string;
  thinkingBudget?: number;
  maxTokens?: number;
  /** 取消信号（会话中断时传入）。 */
  signal?: AbortSignal;
}

/** 模型流事件（流式 SSE 翻译后的统一形态）。 */
export type ModelStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; metadata?: Record<string, unknown> };

export type ModelStream = AsyncIterable<ModelStreamEvent>;

/** LLMProvider 抽象（对应 Rust trait）。 */
export interface LLMProvider {
  streamModel(request: ModelRequest): Promise<ModelStream>;
  updateThinking?(level: string, budget: number): void;
}

export const CHAT_MAX_TOKENS_KEYS = ['max_tokens', 'max_completion_tokens'] as const;
