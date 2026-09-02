/**
 * OpenAI Responses API 适配器 — 对应 Rust `llm/adapters/openai_responses.rs`。
 * 解析 Responses 的事件流（response.output_text.delta / response.completed 等）。
 */
import type { AgentMessage, Model, Usage } from '@infuture/types';
import { convertToLlm, parseCreditCost } from '@infuture/types';
import type { LLMProvider, ModelRequest, ModelStream, ModelStreamEvent, ProviderRoute } from '../schema.js';
import { parseSseStream } from '../sse.js';

export interface OpenAiResponsesConfig {
  store: boolean;
  includeEncryptedReasoning: boolean;
  supportsReasoningSummary: boolean;
  reasoningContext?: string;
  reasoningMode?: string;
  promptCacheOptions?: unknown;
}

export function defaultOpenAiResponsesConfig(): OpenAiResponsesConfig {
  return {
    store: false,
    includeEncryptedReasoning: true,
    supportsReasoningSummary: true,
    reasoningContext: undefined,
    reasoningMode: undefined,
    promptCacheOptions: undefined,
  };
}

interface ResponseEvent {
  type: string;
  delta?: string;
  item?: {
    id?: string;
    call_id?: string;
    type?: string;
    name?: string;
    arguments?: string;
    summary?: Array<{ text?: string }>;
  };
  usage?: Record<string, unknown>;
  response?: { output?: Array<Record<string, unknown>>; usage?: Record<string, unknown> };
}

export class OpenAiResponsesProvider implements LLMProvider {
  constructor(
    private readonly route: ProviderRoute,
    private readonly model: Model,
    private readonly cfg: OpenAiResponsesConfig = defaultOpenAiResponsesConfig(),
  ) {}

  async streamModel(request: ModelRequest): Promise<ModelStream> {
    const url = `${this.route.baseUrl.replace(/\/$/, '')}/responses`;
    const msgs = request.messages as AgentMessage[];

    const body: Record<string, unknown> = {
      model: request.model,
      input: convertToLlm(msgs).map((m) => m),
      stream: true,
      store: this.cfg.store,
    };
    if (request.systemPrompt) body['instructions'] = request.systemPrompt;
    if (request.tools.length > 0) body['tools'] = request.tools;
    const maxTokens = request.maxTokens ?? this.model.maxTokens;
    if (maxTokens > 0) body['max_output_tokens'] = maxTokens;
    if (this.cfg.reasoningContext) body['reasoning'] = { ...(this.cfg.reasoningMode ? { effort: this.cfg.reasoningMode } : {}), summary: 'auto' };

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
      throw new Error(`openai responses ${resp.status}: ${errText.slice(0, 500)}`);
    }

    return this.consume(resp.body);
  }

  private async *consume(body: ReadableStream<Uint8Array>): AsyncGenerator<ModelStreamEvent> {
    const toolCalls: Array<{ id: string; name: string; args: string }> = [];
    const yielded = new Set<string>();
    let usage: Usage | null = null;

    const callIdOf = (item: ResponseEvent['item']): string =>
      item?.call_id ?? item?.id ?? `fc_${toolCalls.length}`;
    const collect = (item: ResponseEvent['item']): { id: string; name: string; args: string } => {
      const id = callIdOf(item);
      let t = toolCalls.find((x) => x.id === id);
      if (!t) {
        t = { id, name: item?.name ?? '', args: item?.arguments ?? '' };
        toolCalls.push(t);
      }
      return t;
    };

    for await (const data of parseSseStream(body)) {
      let ev: ResponseEvent;
      try {
        ev = JSON.parse(data) as ResponseEvent;
      } catch {
        continue;
      }
      switch (ev.type) {
        case 'response.output_text.delta':
          if (ev.delta) yield { type: 'text', text: ev.delta };
          break;
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta':
          if (ev.delta) yield { type: 'reasoning', text: ev.delta };
          break;
        case 'response.output_item.added':
          // 仅收集，不 yield（等 done 事件）
          if (ev.item?.type === 'function_call') collect(ev.item);
          break;
        case 'response.output_item.done':
          if (ev.item?.type === 'function_call') {
            const t = collect(ev.item);
            if (!yielded.has(t.id)) {
              yielded.add(t.id);
              yield { type: 'tool_call', id: t.id, name: t.name, arguments: t.args };
            }
          }
          break;
        case 'response.completed':
          usage = ev.response?.usage ? parseUsage(ev.response.usage) : usage;
          break;
        default:
          break;
      }
    }

    // 兜底：某些实现只发 added 不发 done 时补发
    for (const tc of toolCalls) {
      if (!yielded.has(tc.id)) yield { type: 'tool_call', id: tc.id, name: tc.name, arguments: tc.args };
    }
    if (usage) yield { type: 'usage', usage };
    yield { type: 'done' };
  }
}

function parseUsage(u: Record<string, unknown>): Usage {
  return {
    prompt_tokens: Number(u.input_tokens ?? 0),
    completion_tokens: Number(u.output_tokens ?? 0),
    total_tokens: Number(u.input_tokens ?? 0) + Number(u.output_tokens ?? 0),
    reasoning_tokens: u.output_tokens_details
      ? Number((u.output_tokens_details as Record<string, unknown>).reasoning_tokens ?? 0)
      : undefined,
    credit_cost: parseCreditCost(u.credit_cost),
  };
}
