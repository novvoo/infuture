/**
 * ContentBlock — 多态内容块，1:1 兼容 对应 Rust `types::ContentBlock`
 * 与 Go `pkg/types/types.go`。
 *
 * 序列化形态（wire）：
 * - text:        {"type":"text","text":"..."}
 * - image_url:   {"type":"image_url","image_url":{"url":"data:...;base64,..."}}
 * - reasoning:   {"type":"reasoning","text":"...","provider_metadata":{...}}
 * - tool_call:   {"type":"tool_call","id":"...","name":"...","args":{...},"provider_metadata":{...}}
 * - tool_result: {"type":"tool_result","tool_call_id":"...","content":"...","is_error":bool}
 */

/** Opaque 命名空间协议状态，必须能跨模型往返无损存活。 */
export type ProviderMetadata = Record<string, unknown>;

export interface ImageUrlData {
  url?: string;
}

export interface ReasoningBlock {
  type: 'reasoning';
  text: string;
  provider_metadata?: ProviderMetadata;
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ImageBlock {
  type: 'image_url';
  image_url: ImageUrlData;
}

export interface ToolCallBlock {
  type: 'tool_call';
  id: string;
  name: string;
  args: unknown;
  provider_metadata?: ProviderMetadata;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_call_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ReasoningBlock
  | ToolCallBlock
  | ToolResultBlock;

export function textBlock(text: string): TextBlock {
  return { type: 'text', text };
}

export function imageBlock(url: string): ImageBlock {
  return { type: 'image_url', image_url: { url } };
}

export function reasoningBlock(text: string, provider_metadata: ProviderMetadata = {}): ReasoningBlock {
  return { type: 'reasoning', text, provider_metadata };
}

export function toolCallBlock(
  id: string,
  name: string,
  args: unknown,
  provider_metadata: ProviderMetadata = {},
): ToolCallBlock {
  return { type: 'tool_call', id, name, args, provider_metadata };
}

export function toolResultBlock(
  tool_call_id: string,
  content: string,
  is_error = false,
): ToolResultBlock {
  return { type: 'tool_result', tool_call_id, content, is_error };
}

/** 从任意 JSON 值构造 user 消息的 content 数组（兼容 new_user）。 */
export function contentFromUserJson(content: unknown): ContentBlock[] {
  if (Array.isArray(content)) {
    const blocks: ContentBlock[] = [];
    for (const v of content) {
      if (v === null || typeof v !== 'object') continue;
      const obj = v as Record<string, unknown>;
      const type = typeof obj.type === 'string' ? obj.type : 'text';
      switch (type) {
        case 'text':
          blocks.push(textBlock(typeof obj.text === 'string' ? obj.text : ''));
          break;
        case 'image_url': {
          const iu = obj.image_url as { url?: string } | string | undefined;
          let url = '';
          if (typeof iu === 'string') url = iu;
          else if (iu && typeof iu === 'object' && typeof iu.url === 'string') url = iu.url;
          blocks.push({ type: 'image_url', image_url: { url } });
          break;
        }
        default:
          blocks.push(textBlock(JSON.stringify(obj)));
      }
    }
    return blocks;
  }
  if (typeof content === 'string') return [textBlock(content)];
  return [];
}
