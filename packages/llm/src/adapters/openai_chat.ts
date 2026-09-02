/**
 * OpenAI Chat Completions 适配器 — 对应 Rust `llm/adapters/openai_chat.rs`。
 * 支持流式 SSE、thinking/reasoning_content、工具调用增量、usage。
 */
import type { AgentMessage, Message, Model, Usage } from '@infuture/types';
import { convertToLlm, parseCreditCost } from '@infuture/types';
import type { LLMProvider, ModelRequest, ModelStream, ModelStreamEvent, ProviderRoute } from '../schema.js';
import { parseSseStream } from '../sse.js';

export interface OpenAiChatConfig {
  reasoning: 'none' | 'reasoning_effort' | 'reasoning_split' | 'deepseek' | 'zai' | 'qwen';
  supportsReasoningEffort: boolean;
  replayAssistantReasoning: boolean;
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  toolStream: boolean;
}

export function defaultOpenAiChatConfig(): OpenAiChatConfig {
  return {
    reasoning: 'none',
    supportsReasoningEffort: false,
    replayAssistantReasoning: false,
    maxTokensField: 'max_tokens',
    toolStream: false,
  };
}

function reasoningConfigFromModel(model: Model): OpenAiChatConfig['reasoning'] {
  const compat = (model.compat ?? {}) as Record<string, unknown>;
  const r = compat['reasoning'];
  const known: OpenAiChatConfig['reasoning'][] = ['reasoning_effort', 'reasoning_split', 'deepseek', 'zai', 'qwen'];
  if (typeof r === 'string' && (known as string[]).includes(r)) {
    return r as OpenAiChatConfig['reasoning'];
  }
  return model.reasoning ? 'reasoning_split' : 'none';
}

/**
 * 是否为 GLM 系 wire（zai/zhipu）：使用 `thinking: { type: enabled|disabled }`
 * 二态开关控制思考（GLM-5 系列默认会深思考，不传即按模型默认行为）。
 */
function isGlmWire(model: Model, route: ProviderRoute, cfg: OpenAiChatConfig): boolean {
  if (cfg.reasoning === 'zai') return true;
  const compat = (model.compat ?? {}) as Record<string, unknown>;
  if (compat['thinkingFormat'] === 'zai') return true;
  const id = String(model.id ?? '').toLowerCase();
  const base = String(route.baseUrl || model.baseUrl || '').toLowerCase();
  return id.includes('glm') || base.includes('bigmodel.cn') || base.includes('z.ai') || base.includes('zhipu');
}

/**
 * 将统一思考档位映射到 GLM reasoning_effort 合法取值（low/high/max）。
 * GLM-5 系列不支持 disabled/off/medium：off/low→low（几乎不思考）、medium→high、high→max。
 */
function mapGlmEffort(level: string): string | undefined {
  const l = String(level ?? '').toLowerCase();
  if (['off', 'low', 'none', 'minimal'].includes(l)) return 'low';
  if (['medium', 'balanced', 'moderate'].includes(l)) return 'high';
  if (['high', 'max', 'xhigh', 'deep'].includes(l)) return 'max';
  return undefined;
}

interface ChatDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
}

interface ChatChunk {
  choices?: Array<{ delta?: ChatDelta; finish_reason?: string | null }>;
  usage?: Record<string, unknown>;
}

export class OpenAiChatProvider implements LLMProvider {
  private readonly cfg: OpenAiChatConfig;
  private runtimeThinkingLevel?: string;
  private runtimeThinkingBudget?: number;

  constructor(
    private readonly route: ProviderRoute,
    private readonly model: Model,
    cfg: Partial<OpenAiChatConfig> = {},
  ) {
    this.cfg = { ...defaultOpenAiChatConfig(), ...cfg, reasoning: cfg.reasoning ?? reasoningConfigFromModel(model) };
  }

  /** 运行时更新思考偏好（UI/设置切换时由外层调用；request 未显式携带时生效）。 */
  updateThinking(level: string, budget: number): void {
    this.runtimeThinkingLevel = level;
    this.runtimeThinkingBudget = budget;
  }

  async streamModel(request: ModelRequest): Promise<ModelStream> {
    const url = `${this.route.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const wireMsgs = request.messages as AgentMessage[];

    const msgs: Message[] = [];
    if (request.systemPrompt) {
      msgs.push({ role: 'system', content: request.systemPrompt });
    }
    msgs.push(...convertToLlm(wireMsgs));

    const body: Record<string, unknown> = {
      model: request.model,
      messages: msgs,
      stream: true,
      stream_options: { include_usage: true },
    };

    // 思考偏好：request 显式 > updateThinking 运行时设置 > 模型默认
    const thinkingLevel = request.thinkingLevel ?? this.runtimeThinkingLevel;
    const thinkingBudget = request.thinkingBudget ?? this.runtimeThinkingBudget;
    if (isGlmWire(this.model, this.route, this.cfg)) {
      // GLM-5 系列「始终思考」：thinking.disabled 会直接 400（错误 1210："不支持关闭思考"），
      // 正确做法是用 reasoning_effort 控制强度（实测 low≈几乎不思考 / high / max 深思考）。
      // 档位映射：off/low→low、medium→high、high/max→max；无 level 但有 budget 时用
      // thinking.enabled + budget_tokens 限预算；两者都没有则不发参数（走模型默认 + ACTION-FIRST 引导）。
      const effort = thinkingLevel ? mapGlmEffort(thinkingLevel) : undefined;
      if (effort) {
        body['reasoning_effort'] = effort;
      } else if ((thinkingBudget ?? 0) > 0) {
        body['thinking'] = { type: 'enabled', budget_tokens: thinkingBudget };
      }
    } else if (this.cfg.reasoning === 'reasoning_effort' && this.cfg.supportsReasoningEffort) {
      body['reasoning_effort'] = thinkingLevel ?? 'medium';
    }
    const maxTokens = request.maxTokens ?? this.model.maxTokens;
    if (maxTokens > 0) body[this.cfg.maxTokensField] = maxTokens;

    if (request.tools.length > 0) {
      body['tools'] = request.tools;
      body['tool_choice'] = 'auto';
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.route.headers,
    };
    if (this.route.apiKey) headers['authorization'] = `Bearer ${this.route.apiKey}`;

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`openai chat ${resp.status}: ${errText.slice(0, 500)}`);
    }

    return this.consume(resp.body);
  }

  private async *consume(body: ReadableStream<Uint8Array>): AsyncGenerator<ModelStreamEvent> {
    const toolAcc: { id: string; name: string; args: string }[] = [];
    let usage: Usage | null = null;
    let pendingText = '';
    let pendingReasoning = '';

    const flush = () => {
      if (pendingText) {
        if (toolAcc.length === 0) return; // 文本在工具模式下不单独发
        pendingText = '';
      }
    };

    for await (const data of parseSseStream(body)) {
      let obj: ChatChunk;
      try {
        obj = JSON.parse(data) as ChatChunk;
      } catch {
        continue;
      }

      if (obj.usage) usage = parseUsage(obj.usage);

      const choice = obj.choices?.[0];
      const delta = choice?.delta;
      if (delta) {
        if (delta.reasoning_content) {
          pendingReasoning += delta.reasoning_content;
          if (pendingReasoning.length >= 8) {
            yield { type: 'reasoning', text: pendingReasoning };
            pendingReasoning = '';
          }
        }
        if (delta.content) {
          pendingText += delta.content;
          if (pendingText.length >= 4 && toolAcc.length === 0) {
            yield { type: 'text', text: pendingText };
            pendingText = '';
          }
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            let acc = toolAcc[tc.index];
            if (!acc) {
              acc = { id: '', name: '', args: '' };
              toolAcc[tc.index] = acc;
            }
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
          }
          pendingText = '';
        }
      }
    }

    if (pendingText) yield { type: 'text', text: pendingText };
    if (pendingReasoning) yield { type: 'reasoning', text: pendingReasoning };
    for (const acc of toolAcc) {
      yield { type: 'tool_call', id: acc.id, name: acc.name, arguments: acc.args };
    }
    if (usage) yield { type: 'usage', usage };
    yield { type: 'done' };
  }
}

function parseUsage(u: Record<string, unknown>): Usage {
  const details = u.completion_tokens_details as Record<string, unknown> | undefined;
  return {
    prompt_tokens: Number(u.prompt_tokens ?? 0),
    completion_tokens: Number(u.completion_tokens ?? 0),
    total_tokens: Number(u.total_tokens ?? 0),
    cache_read_tokens: u.prompt_cache_hit_tokens !== undefined ? Number(u.prompt_cache_hit_tokens) : undefined,
    cache_write_tokens: u.prompt_cache_miss_tokens !== undefined ? Number(u.prompt_cache_miss_tokens) : undefined,
    reasoning_tokens: details ? Number(details.reasoning_tokens ?? 0) : undefined,
    credit_cost: parseCreditCost(u.credit_cost),
  };
}
