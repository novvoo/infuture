/**
 * AgentMessage — 会话持久化与协议层使用的规范化消息。
 * content 是唯一权威；历史 JSONL 的 thinking/tool_calls/tool_call_id 边字段在反序列化时归一化。
 */
import {
  type ContentBlock,
  type ProviderMetadata,
  textBlock,
  reasoningBlock,
  toolCallBlock,
  toolResultBlock,
  imageBlock,
  contentFromUserJson,
} from './content.js';
import { type Message, type WireToolCall, lowerContent } from './wire.js';

export interface AgentToolCall {
  id: string;
  name: string;
  args: unknown;
  provider_metadata?: ProviderMetadata;
}

export interface AgentMessage {
  role: string;
  content: ContentBlock[];
  name?: string;
  tool_args?: string;
  metadata?: Record<string, unknown>;
}

export function emptyAgentMessage(): AgentMessage {
  return { role: 'user', content: [] };
}

export function newUserMessage(role: string, content: unknown): AgentMessage {
  return { role, content: contentFromUserJson(content), name: '', tool_args: '' };
}

export function newAssistantMessage(): AgentMessage {
  return { role: 'assistant', content: [] };
}

export function newToolMessage(toolCallId: string, content: string, isError = false): AgentMessage {
  return { role: 'tool', content: [toolResultBlock(toolCallId, content, isError)] };
}

/** 全部可见文本（text 块 + tool_result 内容拼接）。 */
export function messageText(m: AgentMessage): string {
  return m.content
    .map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'tool_result') return b.content;
      return '';
    })
    .join('');
}

/** 用户可见文本：仅第一个 text 块（后续 text 块是 agent 注入的上下文，不得进气泡）。 */
export function displayText(m: AgentMessage): string {
  for (const b of m.content) {
    if (b.type === 'text') return b.text;
  }
  return '';
}

export function reasoningText(m: AgentMessage): string {
  return m.content
    .filter((b): b is Extract<ContentBlock, { type: 'reasoning' }> => b.type === 'reasoning')
    .map((b) => b.text)
    .join('');
}

export function toolCalls(m: AgentMessage): AgentToolCall[] {
  return m.content
    .filter((b): b is Extract<ContentBlock, { type: 'tool_call' }> => b.type === 'tool_call')
    .map((b) => ({
      id: b.id,
      name: b.name,
      args: b.args,
      provider_metadata: b.provider_metadata,
    }));
}

export function hasToolCalls(m: AgentMessage): boolean {
  return m.content.some((b) => b.type === 'tool_call');
}

export function firstToolCallId(m: AgentMessage): string {
  const b = m.content.find((x) => x.type === 'tool_result');
  return b && b.type === 'tool_result' ? b.tool_call_id : '';
}

export function addText(m: AgentMessage, text: string): void {
  m.content.push(textBlock(text));
}

export function addImage(m: AgentMessage, mimeType: string, data: string): void {
  m.content.push(imageBlock(`data:${mimeType};base64,${data}`));
}

/** AgentMessage → wire Message（OpenAI 兼容）。 */
export function toLlm(m: AgentMessage): Message {
  const content = lowerContent(m.content);
  const canonicalToolCalls: WireToolCall[] = m.content
    .filter((b): b is Extract<ContentBlock, { type: 'tool_call' }> => b.type === 'tool_call')
    .map((b) => ({
      id: b.id,
      type: 'function',
      function: {
        name: b.name,
        arguments: typeof b.args === 'string' ? b.args : JSON.stringify(b.args),
      },
    }));
  const reasoning = reasoningText(m);
  const toolResultId = firstToolCallId(m);
  return {
    role: m.role,
    content,
    tool_calls: canonicalToolCalls.length > 0 ? canonicalToolCalls : null,
    tool_call_id: toolResultId,
    name: m.name ?? '',
    tool_args: m.tool_args ?? '',
    reasoning_content: reasoning,
  };
}

/**
 * 转 LLM 消息序列；丢弃"仅 reasoning"的 assistant 空消息（崩溃/中断可能留下，
 * API 会以 "content or tool_calls must be set" 拒绝）。
 */
export function convertToLlm(msgs: AgentMessage[]): Message[] {
  return msgs
    .filter((m) => {
      if (m.role !== 'assistant') return true;
      return !m.content.every((b) => b.type === 'reasoning');
    })
    .map(toLlm);
}

/** wire Message → AgentMessage。 */
export function convertFromLlm(msgs: Message[]): AgentMessage[] {
  return msgs.map((m) => {
    const content: ContentBlock[] = [];
    const raw = m.content;
    if (Array.isArray(raw)) {
      for (const v of raw) {
        if (v === null || typeof v !== 'object') continue;
        const obj = v as Record<string, unknown>;
        const type = obj.type;
        if (type === 'text') {
          content.push(textBlock(typeof obj.text === 'string' ? obj.text : ''));
        } else if (type === 'image_url') {
          const iu = obj.image_url as { url?: string } | string | undefined;
          let url = '';
          if (typeof iu === 'string') url = iu;
          else if (iu && typeof iu.url === 'string') url = iu.url;
          content.push({ type: 'image_url', image_url: { url } });
        }
      }
    } else if (typeof raw === 'string' && raw.length > 0) {
      content.push(textBlock(raw));
    }

    if (m.reasoning_content && m.reasoning_content.length > 0) {
      content.unshift(reasoningBlock(m.reasoning_content));
    }
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        content.push(toolCallBlock(tc.id, tc.function.name, tc.function.arguments));
      }
    }
    if (m.role === 'tool') {
      const text = content
        .filter((b) => b.type === 'text')
        .map((b) => (b as Extract<ContentBlock, { type: 'text' }>).text)
        .join('');
      content.splice(0, content.length, toolResultBlock(m.tool_call_id ?? '', text, false));
    }

    return {
      role: m.role,
      content,
      name: m.name ?? '',
      tool_args: m.tool_args ?? '',
    };
  });
}
