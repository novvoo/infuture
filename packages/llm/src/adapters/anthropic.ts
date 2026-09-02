/**
 * Anthropic Messages 适配器 — 对应 Rust `llm/adapters/anthropic.rs`。
 * 解析 /v1/messages 的 SSE 事件（content_block_delta / message_delta）。
 */
import type { AgentMessage, Message, Model, ToolDef, Usage } from '@infuture/types';
import { convertToLlm, parseCreditCost } from '@infuture/types';
import type { LLMProvider, ModelRequest, ModelStream, ModelStreamEvent, ProviderRoute } from '../schema.js';
import { parseSseStream } from '../sse.js';

interface AnthropicEvent {
  type: string;
  delta?: { type?: string; text?: string; partial_json?: string };
  index?: number;
  content_block?: { type?: string; id?: string; name?: string; input?: unknown };
  message?: { usage?: Record<string, unknown> };
  usage?: Record<string, unknown>;
  error?: { type?: string; message?: string };
}

export class AnthropicProvider implements LLMProvider {
  constructor(
    private readonly route: ProviderRoute,
    private readonly model: Model,
  ) {}

  async streamModel(request: ModelRequest): Promise<ModelStream> {
    const url = `${this.route.baseUrl.replace(/\/$/, '')}/v1/messages`;
    const msgs = request.messages as AgentMessage[];

    const body: Record<string, unknown> = {
      model: request.model,
      messages: toAnthropicMessages(msgs),
      max_tokens: request.maxTokens ?? this.model.maxTokens ?? 4096,
      stream: true,
    };
    if (request.systemPrompt) body['system'] = request.systemPrompt;
    if (request.tools.length > 0) {
      body['tools'] = request.tools.map((t: ToolDef) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...this.route.headers,
    };
    if (this.route.apiKey) headers['x-api-key'] = this.route.apiKey;

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`anthropic ${resp.status}: ${errText.slice(0, 500)}`);
    }

    return this.consume(resp.body);
  }

  private async *consume(body: ReadableStream<Uint8Array>): AsyncGenerator<ModelStreamEvent> {
    const toolAcc: Record<number, { id: string; name: string; input: string }> = {};
    let usage: Usage | null = null;
    let stopYielded = false;

    for await (const data of parseSseStream(body)) {
      let ev: AnthropicEvent;
      try {
        ev = JSON.parse(data) as AnthropicEvent;
      } catch {
        continue;
      }
      switch (ev.type) {
        case 'content_block_start':
          if (ev.content_block?.type === 'tool_use') {
            const idx = ev.index ?? Object.keys(toolAcc).length;
            toolAcc[idx] = { id: ev.content_block.id ?? '', name: ev.content_block.name ?? '', input: '' };
          }
          break;
        case 'content_block_delta':
          if (ev.delta?.type === 'text_delta' && ev.delta.text) {
            yield { type: 'text', text: ev.delta.text };
          } else if (ev.delta?.type === 'thinking_delta' && ev.delta.text) {
            yield { type: 'reasoning', text: ev.delta.text };
          } else if (ev.delta?.type === 'input_json_delta' && ev.index !== undefined) {
            const acc = toolAcc[ev.index];
            if (acc) acc.input += ev.delta.partial_json ?? '';
          }
          break;
        case 'message_delta':
          if (ev.usage) usage = parseUsage(ev.usage);
          break;
        case 'message_stop':
          if (!stopYielded) {
            for (const acc of Object.values(toolAcc)) {
              yield { type: 'tool_call', id: acc.id, name: acc.name, arguments: acc.input };
            }
            stopYielded = true;
          }
          break;
        case 'error':
          throw new Error(`anthropic stream error: ${ev.error?.message ?? JSON.stringify(ev.error)}`);
        default:
          break;
      }
    }
    if (!stopYielded) {
      for (const acc of Object.values(toolAcc)) {
        yield { type: 'tool_call', id: acc.id, name: acc.name, arguments: acc.input };
      }
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
    cache_read_tokens: u.cache_read_input_tokens !== undefined ? Number(u.cache_read_input_tokens) : undefined,
    cache_write_tokens: u.cache_creation_input_tokens !== undefined ? Number(u.cache_creation_input_tokens) : undefined,
    credit_cost: parseCreditCost(u.credit_cost),
  };
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const o = b as { type?: string; text?: string } | null;
        return o && o.type === 'text' && typeof o.text === 'string' ? o.text : '';
      })
      .join('');
  }
  return '';
}

/**
 * 把 OpenAI 兼容 wire 消息转换为 Anthropic Messages 协议：
 * - tool 消息 → role=user + content:[{type:'tool_result', tool_use_id, content}]
 * - assistant 消息的 tool_calls → content 里的 {type:'tool_use'} 块
 * - system 已在 body.system 单独发送，此处剔除
 */
function toAnthropicMessages(msgs: AgentMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of convertToLlm(msgs)) {
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id ?? '',
            content: extractText(m.content),
          },
        ],
      });
    } else if (m.role === 'assistant') {
      const blocks: unknown[] = [];
      if (Array.isArray(m.content)) {
        for (const b of m.content as Array<Record<string, unknown>>) {
          if (b?.type === 'text' && typeof b.text === 'string') blocks.push({ type: 'text', text: b.text });
        }
      }
      for (const tc of m.tool_calls ?? []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) });
      }
      out.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'user') {
      out.push({ role: 'user', content: Array.isArray(m.content) && m.content.length > 0 ? m.content : '' });
    }
    // system 跳过（走 body.system）
  }
  return out;
}
