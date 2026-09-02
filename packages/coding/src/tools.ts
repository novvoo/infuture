/**
 * codingTools — 把编程能力注册为 agent 工具（工具级直调，非 agent 委派）。
 *
 * 执行模型（融合后）：
 *  - 每个编程工具经 CodingToolsClient → bun 工具服务进程 → 直接执行编程引擎的
 *    BUILTIN_TOOLS 对应实现（LspTool / DebugTool / AstGrepTool / EvalTool / TaskTool …）。
 *  - 参数是工具 schema 的结构化字段，返回是结构化 AgentToolResult JSON。
 *  - 编程引擎的 agent 循环、会话、模型配置不参与：inloop（infuture 自己的
 *    循环、自己的模型、自己的审批）主导一切。
 *
 * 命名空间前缀 `lsp_*` / `dap_*` 避免与通用工具冲突。
 */
import type { AgentTool, ToolCallResult } from '@infuture/types';
import { toolDef } from '@infuture/types';
import { DAP_OPERATIONS, LSP_OPERATIONS, type DapOperation, type LspOperation } from './capabilities.js';
import type { CodingToolsClient } from './service/client.js';

/** github 远程操作 op 集（补齐 GitHub 集成：PR 创建/推送/检出 + 搜索）。 */
const GITHUB_OPS = [
  'pr_create',
  'pr_checkout',
  'pr_push',
  'search_issues',
  'search_prs',
  'search_code',
  'search_commits',
  'search_repos',
] as const;

/** 常见搜索 provider id → 可读名（运行日志标注实际命中的搜索引擎）。 */
const SEARCH_PROVIDER_LABELS: Record<string, string> = {
  tinyfish: 'TinyFish',
  exa: 'Exa',
  jina: 'Jina',
  kagi: 'Kagi',
  tavily: 'Tavily',
  perplexity: 'Perplexity',
  xai: 'xAI',
  gemini: 'Gemini',
  anthropic: 'Anthropic',
  codex: 'Codex',
  zai: 'Z.ai',
  brave: 'Brave',
  duckduckgo: 'DuckDuckGo',
  google: 'Google',
  kimi: 'Kimi',
  mojeek: 'Mojeek',
  searxng: 'SearXNG',
  startpage: 'Startpage',
  ecosia: 'Ecosia',
  firecrawl: 'Firecrawl',
  public: 'Public',
  synthetic: 'Synthetic',
  parallel: 'Parallel',
};

/** 从工具服务返回的 AgentToolResult 提取“实际命中的搜索引擎”元信息（web_search 等搜索类工具）。 */
function extractEngineMeta(result: unknown): { engine?: string; model?: string } {
  const r = result as { details?: { response?: { provider?: string; model?: string } } } | undefined;
  const response = r?.details?.response;
  if (!response || !response.provider || response.provider === 'none') return {};
  const engine = SEARCH_PROVIDER_LABELS[response.provider] ?? response.provider;
  return { engine, model: response.model };
}

/** 把工具服务返回的 AgentToolResult 转成文本结果。 */
function toText(result: unknown): { text: string; isError: boolean } {
  const r = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | undefined;
  const content = Array.isArray(r?.content) ? r.content : [];
  const text = content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  return { text: text || '(no text output)', isError: Boolean(r?.isError) };
}

/** 带超时的直调（搜索等依赖外部凭据的工具防止无限等待）。 */
async function callToolWithTimeout(
  client: CodingToolsClient | null,
  tool: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<ToolCallResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${tool} 超时（${timeoutMs / 1000}s）`)), timeoutMs);
  });
  const callP = callTool(client, tool, params);
  // 迟到结果：若超时先到而工具后续才返回/报错，吞噬掉避免 unhandled rejection。
  callP.catch(() => {});
  const res = await Promise.race([callP, timeoutP]);
  if (timer) clearTimeout(timer);
  return res;
}

/** 直调工具服务并包装结果。 */
async function callTool(
  client: CodingToolsClient | null,
  tool: string,
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!client) {
    return {
      result: `编程工具 \`${tool}\` 不可用：coding tools 服务未启动`,
      is_error: true,
    };
  }
  try {
    const res = await client.call(tool, params);
    const { text, isError } = toText(res);
    // 搜索结果标注实际命中的搜索引擎（如 web_search → [engine: TinyFish · model]），
    // 运行日志与模型上下文都能直接看到用的是什么引擎。
    const { engine, model } = extractEngineMeta(res);
    const meta = engine ? `[engine: ${engine}${model ? ` · ${model}` : ''}]\n` : '';
    return { result: meta + text, is_error: isError };
  } catch (err) {
    return {
      result: `\`${tool}\` 执行失败: ${err instanceof Error ? err.message : String(err)}`,
      is_error: true,
    };
  }
}

interface LspArgs {
  file?: string;
  line?: number;
  symbol?: string;
  new_name?: string;
  query?: string;
}

function lspTool(client: CodingToolsClient | null, op: LspOperation): AgentTool {
  return {
    def: toolDef(`lsp_${op}`, `LSP 操作：${op}（直调语言服务器，结构化结果）`, {
      type: 'object',
      properties: {
        file: { type: 'string', description: '目标文件路径' },
        line: { type: 'number', description: '行号（0 基）' },
        symbol: { type: 'string', description: '符号名（rename/references 等）' },
        new_name: { type: 'string', description: '新名称（rename/rename_file）' },
        query: { type: 'string', description: 'workspace 级查询（symbols 等）' },
      },
    }),
    guidelines: [`lsp_${op} 直调内置 lsp 工具（action=${op}）`],
    handler: (args) => {
      const a = (args ?? {}) as LspArgs;
      const params: Record<string, unknown> = { action: op };
      if (a.file) params.file = a.file;
      if (a.line !== undefined) params.line = a.line;
      if (a.symbol) params.symbol = a.symbol;
      if (a.new_name) params.new_name = a.new_name;
      if (a.query) params.query = a.query;
      return callTool(client, 'lsp', params);
    },
  };
}

interface DapArgs {
  program?: string;
  adapter?: string;
  args?: string[];
  file?: string;
  line?: number;
}

function dapTool(client: CodingToolsClient | null, op: DapOperation): AgentTool {
  return {
    def: toolDef(`dap_${op}`, `DAP 调试操作：${op}（直调调试适配器，支持 lldb/dlv/debugpy）`, {
      type: 'object',
      properties: {
        program: { type: 'string', description: '目标程序/脚本' },
        adapter: { type: 'string', description: '调试器后端（lldb-dap/dlv/debugpy 等）' },
        args: { type: 'array', items: { type: 'string' }, description: '程序参数' },
        file: { type: 'string', description: '源文件（断点/栈）' },
        line: { type: 'number', description: '源文件行号' },
      },
    }),
    guidelines: [`dap_${op} 直调内置 debug 工具（action=${op}）`],
    handler: (args) => {
      const a = (args ?? {}) as DapArgs;
      const params: Record<string, unknown> = { action: op };
      if (a.program) params.program = a.program;
      if (a.adapter) params.adapter = a.adapter;
      if (a.args && a.args.length > 0) params.args = a.args;
      if (a.file) params.file = a.file;
      if (a.line !== undefined) params.line = a.line;
      return callTool(client, 'debug', params);
    },
  };
}

export interface CodingToolsOptions {
  /** 预留：未来按能力开关裁剪工具集。 */
  enabled?: (name: string) => boolean;
  /** subagent 由 infuture 递归 inloop 实现（非外部 agent 委派）。 */
  spawnSubagent?: (task: string, opts: { isolated?: boolean }) => Promise<string>;
  /** review 由 infuture 自实现（advisor 模型审查）。 */
  reviewCode?: (opts: { scope?: string; patch?: string }) => Promise<string>;
}

export function codingTools(client: CodingToolsClient | null, options: CodingToolsOptions = {}): AgentTool[] {
  const enabled = options.enabled ?? (() => true);
  const tools: AgentTool[] = [];

  for (const op of LSP_OPERATIONS) tools.push(lspTool(client, op));
  for (const op of DAP_OPERATIONS) tools.push(dapTool(client, op));

  tools.push(
    {
      def: toolDef('execute_code', '在持久 kernel 中执行 Python / JS / TS / bash 代码并返回输出（跨调用保持状态）', {
        type: 'object',
        properties: {
          language: { type: 'string', enum: ['python', 'javascript', 'typescript', 'bash'] },
          code: { type: 'string', description: '要执行的代码' },
        },
        required: ['code'],
      }),
      guidelines: ['execute_code 直调内置 eval 工具（持久 Python/Bun kernel）'],
      handler: async (args) => {
        const { language, code } = (args ?? {}) as { language?: string; code?: string };
        if (!code) return { result: 'execute_code: missing `code`', is_error: true };
        if (language === 'bash') return await callTool(client, 'bash', { command: code });
        const lang = language === 'python' ? 'py' : 'js';
        return await callTool(client, 'eval', { language: lang, code });
      },
    },
    {
      def: toolDef('bash', '在持久 shell 中执行命令（比通用 shell 更丰富的交互）', {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      }),
      guidelines: ['bash 直调内置持久 shell 工具'],
      handler: async (args) => {
        const { command } = (args ?? {}) as { command?: string };
        if (!command) return { result: 'bash: missing `command`', is_error: true };
        return await callTool(client, 'bash', { command });
      },
    },
    {
      def: toolDef('ast_grep', '用 ast-grep 结构模式搜索代码', {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'ast-grep 结构模式（如 `console.log($A)`）' },
          path: { type: 'string', description: '文件/目录/glob' },
        },
        required: ['pattern'],
      }),
      guidelines: ['ast_grep 直调内置 ast_grep 工具'],
      handler: (args) => {
        const { pattern, path: p } = (args ?? {}) as { pattern?: string; path?: string };
        const params: Record<string, unknown> = { pat: pattern ?? '' };
        if (p) params.path = p;
        return callTool(client, 'ast_grep', params);
      },
    },
    {
      def: toolDef('ast_edit', '基于 ast-grep 的结构化代码重写（模式匹配 + 模板替换）', {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件/目录/glob' },
          pattern: { type: 'string', description: 'ast-grep 匹配模式' },
          rewrite: { type: 'string', description: '重写模板' },
        },
        required: ['path', 'pattern', 'rewrite'],
      }),
      guidelines: ['ast_edit 直调内置 ast_edit 工具（结构化重写，优于文本 edit）'],
      handler: (args) => {
        const { path: p, pattern, rewrite } = (args ?? {}) as { path?: string; pattern?: string; rewrite?: string };
        if (!p || !pattern || !rewrite) {
          return Promise.resolve({ result: 'ast_edit 需要 path/pattern/rewrite 三个参数', is_error: true });
        }
        return callTool(client, 'ast_edit', { ops: [{ pat: pattern, out: rewrite }], paths: [p] });
      },
    },
    {
      def: toolDef('subagent', '派发一等子 agent（infuture 递归 inloop）到隔离 worktree 并行执行任务', {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          isolated: { type: 'boolean', description: '是否隔离 worktree' },
        },
        required: ['prompt'],
      }),
      guidelines: ['subagent 由 infuture 递归 inloop 实现（一等子 agent，非外部 agent 委派）'],
      handler: async (args) => {
        const { prompt, isolated } = (args ?? {}) as { prompt?: string; isolated?: boolean };
        if (!prompt) return { result: 'subagent: missing `prompt`', is_error: true };
        if (!options.spawnSubagent) {
          return {
            result: 'subagent 不可用：未注入 spawnSubagent（需要 infuture Engine 支持）',
            is_error: true,
          };
        }
        try {
          const text = await options.spawnSubagent(prompt, { isolated: Boolean(isolated) });
          return { result: text, is_error: false };
        } catch (err) {
          return {
            result: `subagent 失败: ${err instanceof Error ? err.message : String(err)}`,
            is_error: true,
          };
        }
      },
    },
    {
      def: toolDef('review', '双模型 advisor 代码审查（infuture 自实现：收集代码 → 模型审查）', {
        type: 'object',
        properties: {
          scope: { type: 'string', description: '审查范围（文件或目录路径）' },
          patch: { type: 'string', description: '直接提供待审查的 diff/patch' },
        },
      }),
      guidelines: ['双模型审查 advisor 由 infuture 自实现（收集代码 + 独立审查视角模型调用）'],
      handler: async (args) => {
        const { scope, patch } = (args ?? {}) as { scope?: string; patch?: string };
        if (!options.reviewCode) {
          return {
            result: 'review 不可用：未注入 reviewCode（需要 infuture Engine 支持）',
            is_error: true,
          };
        }
        try {
          const text = await options.reviewCode({ scope, patch });
          return { result: text, is_error: false };
        } catch (err) {
          return {
            result: `review 失败: ${err instanceof Error ? err.message : String(err)}`,
            is_error: true,
          };
        }
      },
    },
    {
      def: toolDef('git_pr', '读取 GitHub PR 信息', {
        type: 'object',
        properties: {
          repo: { type: 'string' },
          pr: { type: 'number' },
        },
        required: ['repo', 'pr'],
      }),
      guidelines: ['git_pr 直调内置 github 工具（op=repo_view）'],
      handler: (args) => {
        const { repo, pr } = (args ?? {}) as { repo?: string; pr?: number };
        if (!repo || !pr) {
          return Promise.resolve({ result: 'git_pr 需要 repo 和 pr', is_error: true });
        }
        return callTool(client, 'github', { op: 'repo_view', repo, pr: String(pr) });
      },
    },
    // ---- 第二轮吸收：补齐剩余编程能力（浏览器 / 搜索 / 检索 / 图片 / git 远程操作）----
    {
      def: toolDef('grep', '用正则递归搜索文件内容（直调内置 GrepTool）', {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则模式' },
          path: { type: 'string', description: '文件或目录（默认 cwd）' },
          glob: { type: 'string', description: '仅匹配该 glob（如 *.ts）' },
          ignore: { type: 'string', description: '忽略的 glob' },
          case_sensitive: { type: 'boolean' },
        },
        required: ['pattern'],
      }),
      guidelines: ['grep 直调内置 grep 工具'],
      handler: (args) => {
        const { pattern, path: p, glob: g, ignore, case_sensitive } = (args ?? {}) as Record<string, unknown>;
        if (!pattern) return Promise.resolve({ result: 'grep: missing `pattern`', is_error: true });
        const params: Record<string, unknown> = { pattern };
        if (p) params.path = p;
        if (g) params.glob = g;
        if (ignore) params.ignore = ignore;
        if (typeof case_sensitive === 'boolean') params.case_sensitive = case_sensitive;
        return callTool(client, 'grep', params);
      },
    },
    {
      def: toolDef('glob', '按 glob 模式查找文件路径（直调内置 GlobTool）', {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'glob 模式，如 **/*.ts' },
          path: { type: 'string', description: '起始目录（默认工作区根）' },
        },
        required: ['pattern'],
      }),
      guidelines: ['glob 直调内置 glob 工具（findSchema，path 即 glob 模式）'],
      handler: (args) => {
        const { pattern, path: p } = (args ?? {}) as { pattern?: string; path?: string };
        if (!pattern) return Promise.resolve({ result: 'glob: missing `pattern`', is_error: true });
        // 内置 GlobTool 的 path 参数即 glob 模式；若给目录则当作相对 glob 拼接
        return callTool(client, 'glob', { path: p ? `${p}/${pattern}` : pattern });
      },
    },
    {
      def: toolDef('browser', '无头/真实浏览器控制：打开网页、执行 JS、读取页面（直调内置 BrowserTool）', {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'open | close | run' },
          url: { type: 'string', description: '要打开的 URL（action=open）' },
          code: { type: 'string', description: '在页面上下文中执行的 JS 主体（action=run）' },
          name: { type: 'string', description: '标签页 id（默认 main）' },
          timeout: { type: 'number', description: '超时秒数' },
          wait_until: { type: 'string', description: "load | domcontentloaded | networkidle0 | networkidle2" },
          viewport: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } } },
        },
        required: ['action'],
      }),
      guidelines: ['browser 直调内置 browser 工具（Puppeteer 驱动的浏览器控制）'],
      handler: (args) => {
        const { action, url, code, name, timeout, wait_until, viewport } = (args ?? {}) as Record<string, unknown>;
        const params: Record<string, unknown> = { action };
        if (url) params.url = url;
        if (code) params.code = code;
        if (name) params.name = name;
        if (timeout) params.timeout = timeout;
        if (wait_until) params.wait_until = wait_until;
        if (viewport) params.viewport = viewport;
        return callTool(client, 'browser', params);
      },
    },
    {
      def: toolDef('web_search', '网络搜索并返回带来源的结果（直调内置 WebSearchTool）', {
        type: 'object',
        properties: {
          query: { type: 'string' },
          provider: { type: 'string', description: '指定搜索 provider：perplexity | gemini | anthropic | codex | xai | exa | jina | kagi | tavily | tinyfish | zai | auto（默认 auto 自动按可用链 fallback）' },
          recency: { type: 'string', description: "day | week | month | year" },
          limit: { type: 'number' },
          max_tokens: { type: 'number' },
          num_search_results: { type: 'number' },
        },
        required: ['query'],
      }),
      guidelines: ['web_search 直调内置 web_search 工具', '默认 auto：自动轮换可用 provider；多 provider 全部失败才报 All web search providers failed', '指定 provider 需先配置对应凭据（如 EXA_API_KEY / JINA_API_KEY / PERPLEXITY_API_KEY 环境变量或 auth）'],
      handler: (args) => {
        const { query, provider, recency, limit, max_tokens, num_search_results } = (args ?? {}) as Record<string, unknown>;
        if (!query) return Promise.resolve({ result: 'web_search: missing `query`', is_error: true });
        const params: Record<string, unknown> = { query };
        if (provider) params.provider = provider;
        if (recency) params.recency = recency;
        if (limit) params.limit = limit;
        if (max_tokens) params.max_tokens = max_tokens;
        if (num_search_results) params.num_search_results = num_search_results;
        // 真实联网搜索（多来源抓取）常超 15s，给足 60s 避免"成功却误报超时"。
        return callToolWithTimeout(client, 'web_search', params, 60_000);
      },
    },
    {
      def: toolDef('web_fetch', '抓取 URL 网页并提取可读正文（经搜索/读取引擎，复用已配置的 searchProvider 与 provider 凭据；支持 HTML/PDF/Office 等）', {
        type: 'object',
        properties: {
          url: { type: 'string', description: '目标 URL（http/https）' },
          maxChars: { type: 'number', description: '返回正文最大字符数，默认 12000' },
        },
        required: ['url'],
      }),
      guidelines: ['web_fetch 与 web_search 共用同一套搜索/读取引擎（默认按 searchProvider 配置，走已配置的 provider 抓取）', '搜到 URL 后用 web_fetch 抓取正文'],
      handler: (args) => {
        const { url, maxChars } = (args ?? {}) as { url?: string; maxChars?: number };
        if (!url) return Promise.resolve({ result: 'web_fetch: missing `url`', is_error: true });
        if (!/^https?:\/\//i.test(url)) return Promise.resolve({ result: 'web_fetch: url must start with http(s)://', is_error: true });
        const params: Record<string, unknown> = { url };
        if (typeof maxChars === 'number') params.maxChars = maxChars;
        // 真实网页抓取（reader/多来源）常超 15s，给足 60s。
        return callToolWithTimeout(client, 'web_fetch', params, 60_000);
      },
    },
    {
      def: toolDef('inspect_image', '读取并理解图片内容（直调内置 InspectImageTool）', {
        type: 'object',
        properties: {
          path: { type: 'string', description: '图片文件路径' },
          question: { type: 'string', description: '关于图片的问题' },
        },
        required: ['path'],
      }),
      guidelines: ['inspect_image 直调内置 inspect_image 工具'],
      handler: (args) => {
        const { path: p, question } = (args ?? {}) as { path?: string; question?: string };
        if (!p) return Promise.resolve({ result: 'inspect_image: missing `path`', is_error: true });
        return callTool(client, 'inspect_image', { path: p, ...(question ? { question } : {}) });
      },
    },
    {
      def: toolDef('code_edit', '文本编辑（内置 EditTool replace 模式，内置 git 冲突标记检测与冲突历史记忆）', {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目标文件路径' },
          old_text: { type: 'string' },
          new_text: { type: 'string' },
        },
        required: ['path', 'old_text', 'new_text'],
      }),
      guidelines: ['code_edit 直调内置 edit 工具（replace 模式；比通用 edit 多冲突检测/记忆）'],
      handler: (args) => {
        const { path: p, old_text, new_text } = (args ?? {}) as { path?: string; old_text?: string; new_text?: string };
        if (!p || !old_text || new_text === undefined) {
          return Promise.resolve({ result: 'code_edit 需要 path/old_text/new_text', is_error: true });
        }
        return callTool(client, 'edit', { path: p, edits: [{ old_text, new_text }] });
      },
    },
    ...GITHUB_OPS.map((op) => ({
      def: toolDef(
        `github_${op}`,
        `GitHub 远程操作：${op}（直调内置 github 工具）`,
        {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'repo（owner/name）' },
            pr: { type: 'number', description: 'PR 编号（pr_create/pr_checkout/pr_push）' },
            query: { type: 'string', description: '搜索关键词（search_*）' },
            branch: { type: 'string', description: '分支' },
            title: { type: 'string', description: 'PR 标题（pr_create）' },
            body: { type: 'string', description: 'PR 描述（pr_create）' },
            base: { type: 'string', description: '目标分支（pr_create）' },
            head: { type: 'string', description: '源分支（pr_create）' },
          },
        },
      ),
      guidelines: [`github_${op} 直调内置 github 工具`],
      handler: (args: unknown) => {
        const params: Record<string, unknown> = { op };
        for (const [k, v] of Object.entries((args ?? {}) as Record<string, unknown>)) {
          if (v !== undefined && v !== null && v !== '') params[k] = v;
        }
        return callTool(client, 'github', params);
      },
    })),
  );

  return tools.filter((t) => enabled(t.def.function.name));
}

export function codingToolNames(client: CodingToolsClient | null): string[] {
  return codingTools(client).map((t) => t.def.function.name);
}
