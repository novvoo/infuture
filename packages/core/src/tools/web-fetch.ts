/**
 * web_fetch 工具 — 抓取 URL 网页并提取可读正文文本。
 * 配套 web_search（只返回搜索结果列表）使用：搜到 URL 后进一步抓取正文。
 * 审批门控在运行环层完成，工具本身只执行。
 */
import type { AgentTool, ToolCallResult } from '@infuture/types';
import { toolDef } from '@infuture/types';

const MAX_BODY = 60_000;
const TIMEOUT_MS = 20_000;

/** 去掉 HTML 标签 / script / style / 注释，压缩空白，尽量保留正文文本。 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function webFetchTool(): AgentTool {
  return {
    def: toolDef('web_fetch', 'Fetch a URL and extract readable page text. Use after web_search to read page content.', {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch (http/https)' },
        maxChars: { type: 'number', description: 'Max chars of extracted text (default 60000)' },
      },
      required: ['url'],
    }),
    guidelines: ['Prefer web_fetch over shell curl', 'web_search returns result lists; use web_fetch to read the actual page', 'Respect robots.txt and site terms'],
    handler: async (args, _ctx): Promise<ToolCallResult> => {
      const { url } = (args ?? {}) as { url?: string; maxChars?: number };
      if (!url) return { result: 'web_fetch: missing `url`', is_error: true };
      if (!/^https?:\/\//i.test(url)) {
        return { result: 'web_fetch: url must start with http(s)://', is_error: true };
      }
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        let res: Response;
        try {
          res = await fetch(url, {
            signal: ctrl.signal,
            headers: { 'user-agent': 'infuture/1.0 (+research)' },
            redirect: 'follow',
          });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) {
          return { result: `web_fetch: HTTP ${res.status} ${res.statusText}`, is_error: true };
        }
        const ctype = res.headers.get('content-type') ?? '';
        if (!ctype.includes('text') && !ctype.includes('html') && !ctype.includes('json') && !ctype.includes('xml')) {
          return { result: `web_fetch: unsupported content-type ${ctype}`, is_error: true };
        }
        const raw = await res.text();
        const text = htmlToText(raw);
        const { maxChars: mc } = (args ?? {}) as { maxChars?: number };
        const cap = typeof mc === 'number' && mc > 0 ? mc : MAX_BODY;
        const body = text.length > cap ? text.slice(0, cap) + '\n…[truncated]' : text;
        if (!body) return { result: 'web_fetch: page yielded no readable text', is_error: true };
        return { result: `[${res.url}] ${body}`, is_error: false };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `web_fetch failed: ${msg}`, is_error: true };
      }
    },
  };
}
