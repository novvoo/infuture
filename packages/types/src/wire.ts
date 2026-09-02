/**
 * Message — LLM API wire 格式，匹配 对应 Rust `types::Message`。
 */
import type { ContentBlock } from './content.js';

export interface ToolCallFn {
  name: string;
  /** 保持与 Rust 一致：arguments 可能是字符串或对象。 */
  arguments: unknown;
}

export interface WireToolCall {
  id: string;
  type: string;
  function: ToolCallFn;
}

export interface TextContent {
  type: string;
  text: string;
}

export interface ImageSource {
  type: string;
  media_type: string;
  data: string;
}

export interface ImageContent {
  type: string;
  mime_type?: string;
  data?: string;
  source?: ImageSource;
  file_path?: string;
}

/**
 * Message 是发给模型的原生消息。
 * content 为 null 表示缺失（与 Rust `Option`、Go `null` 对齐）。
 */
export interface Message {
  role: string;
  content?: unknown[] | string | null;
  tool_calls?: WireToolCall[] | null;
  tool_call_id?: string;
  name?: string;
  tool_args?: string;
  reasoning_content?: string;
}

export function emptyMessage(): Message {
  return {
    role: 'user',
    content: null,
    tool_calls: null,
    tool_call_id: '',
    name: '',
    tool_args: '',
    reasoning_content: '',
  };
}

/** 把 AgentMessage 的 content[] 下降为 wire content 数组（过滤 reasoning/tool_call）。 */
export function lowerContent(blocks: ContentBlock[]): unknown[] | null {
  const out: unknown[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'text':
      case 'image_url':
        out.push(b);
        break;
      case 'tool_result':
        out.push({ type: 'text', text: b.content });
        break;
      case 'reasoning':
      case 'tool_call':
        break;
    }
  }
  return out.length > 0 ? out : null;
}
