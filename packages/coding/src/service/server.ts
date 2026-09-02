/**
 * CodingToolsService — bun 侧工具服务进程。
 *
 * 在 bun 运行时内 import @oh-my-pi/pi-coding-agent 的 BUILTIN_TOOLS 工厂，
 * 把编程能力（LSP/DAP/ast-grep/子 agent/审查/git…）暴露为"工具级直调"：
 * infuture 的 inloop 发一条精确命令 → 本服务直接构造并执行对应 AgentTool → 返回结构化 JSON。
 *
 * 与"外挂"（把 prompt 委派给外部 agent）的本质区别：
 *   - 编程引擎的 agent 循环、会话、模型配置不参与
 *   - inloop（infuture 自己的循环、自己的模型、自己的审批）主导一切
 *   - 每个工具调用是精确命令 + 结构化结果，而非"让另一个 agent 去理解"
 *
 * 协议（jsonl over stdin/stdout）：
 *   请求  { "id": number|string, "tool": string, "params": object }
 *   响应  { "id": ..., "ok": true,  "result": AgentToolResult }
 *         { "id": ..., "ok": false, "error": string }
 *   流式  { "type": "update", "id": ..., "partial": AgentToolResult }
 */
// @ts-nocheck — 本文件仅由 bun 运行时执行（import 编程引擎源码），不参与 node 侧 tsc 检查。
// 直调模式用结构化参数（path+edits）而非 hashline 文本，强制 edit 走 replace 模式。
process.env.PI_EDIT_VARIANT = 'replace';
import { BUILTIN_TOOLS } from '../../../../node_modules/@oh-my-pi/pi-coding-agent/src/tools/index.ts';
import { Settings } from '../../../../node_modules/@oh-my-pi/pi-coding-agent/src/config/settings.ts';
import { discoverAuthStorage } from '../../../../node_modules/@oh-my-pi/pi-coding-agent/src/sdk.ts';
import { ModelRegistry } from '../../../../node_modules/@oh-my-pi/pi-coding-agent/src/config/model-registry.ts';
import { setPreferredSearchProvider } from '../../../../node_modules/@oh-my-pi/pi-coding-agent/src/web/search/index.ts';
import readline from 'node:readline';
import process from 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';

/** 初始化编程引擎全局 settings（BashTool 等依赖 settings.get）。 */
const ompSettings = await Settings.init();

/** 本服务暴露的工具白名单（覆盖编程能力核心集）。 */
const TOOL_WHITELIST = new Set([
  'read', 'write', 'edit', 'bash', 'grep', 'glob',
  'lsp', 'debug', 'eval', 'ast_grep', 'ast_edit',
  'task', 'github', 'review', 'checkpoint',
  'browser', 'inspect_image', 'web_search', 'web_fetch',
  // hashline 锚点编辑（独立模式路由：code_read 产出行号+快照tag → hash_edit 校验并应用）
  'code_read', 'hash_edit',
]);

function buildSession(cwd: string): Record<string, unknown> {
  return {
    cwd,
    hasUI: false,
    enableLsp: true,
    hasEditTool: true,
    settings: ompSettings,
    getSessionFile: () => null,
    getEvalSessionId: () => 'infuture-eval',
    getEvalKernelOwnerId: () => 'infuture-eval',
    assertEvalExecutionAllowed: () => {},
    taskDepth: 0,
    suppressSpawnAdvisory: true,
  };
}

interface ServiceRequest {
  id?: number | string;
  tool?: string;
  params?: Record<string, unknown>;
  action?: string;
}

class CodingToolsService {
  private tools = new Map<string, any>();
  private readonly cwd: string;
  private readonly session: Record<string, unknown>;

  constructor(cwd: string, authStorage?: unknown, modelRegistry?: unknown) {
    this.cwd = cwd;
    this.session = buildSession(cwd);
    // 注入编程引擎凭据与模型注册表（web_search / inspect_image 等依赖）
    if (authStorage) this.session.authStorage = authStorage;
    if (modelRegistry) {
      this.session.modelRegistry = modelRegistry;
      this.session.authStorage = this.session.authStorage ?? authStorage;
    }
    this.session.sessionId = 'infuture-session';
  }

  private async getTool(name: string): Promise<any> {
    const cached = this.tools.get(name);
    if (cached) return cached;
    const factory = (BUILTIN_TOOLS as Record<string, ((s: Record<string, unknown>) => any) | undefined>)[name];
    if (!factory) throw new Error(`unknown tool: ${name}`);
    // 部分工厂（如 task）是 async，返回 Promise<Tool>
    const tool = await factory(this.session);
    if (!tool) throw new Error(`tool unavailable: ${name}`);
    this.tools.set(name, tool);
    return tool;
  }

  private async execute(req: ServiceRequest): Promise<void> {
    const { id = 'x', tool = '', params = {} } = req;
    // search.verify：运行时重新注入最新搜索配置 + 真实调用一次 web_search，供前端配置窗口验证
    if (req.action === 'search.verify') {
      try {
        const authStorage = this.session.authStorage as { setConfigApiKey?: (p: string, k: string) => void } | undefined;
        if (authStorage) await applySearchConfig(authStorage);
        const searchTool = await this.getTool('web_search');
        const t0 = Date.now();
        const result = await searchTool.execute(
          `v-${String(id)}`,
          { query: 'infuture agent', limit: 2, num_search_results: 2 },
          undefined,
          () => {},
          undefined,
        );
        const costMs = Date.now() - t0;
        const text = Array.isArray(result.content)
          ? result.content.map((c: { text?: string }) => c.text ?? '').join('\n')
          : JSON.stringify(result);
        this.write({ id, ok: true, result: { ok: true, costMs, sample: text.slice(0, 400) } });
      } catch (err) {
        this.write({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (!TOOL_WHITELIST.has(tool)) {
      this.write({ id, ok: false, error: `tool '${tool}' not allowed by coding tools service` });
      return;
    }
    // web_fetch：与 web_search 共用同一搜索/读取引擎 —— 经 ReadTool 的 URL 读取管道抓取
    // （复用已注入的 searchProvider + provider 凭据，支持 HTML/PDF/Office/reader 等多格式）。
    if (tool === 'web_fetch') {
      try {
        const readTool = await this.getTool('read');
        const url = typeof params.url === 'string' ? params.url : '';
        if (!url) throw new Error('web_fetch: missing `url`');
        const result = await readTool.execute(`w-${String(id)}`, { path: url }, undefined, () => {}, undefined);
        const text = Array.isArray(result.content)
          ? result.content.map((c: { text?: string }) => c.text ?? '').join('\n')
          : JSON.stringify(result);
        const maxChars = typeof params.maxChars === 'number' ? params.maxChars : 12000;
        this.write({ id, ok: true, result: { url, text: text.slice(0, maxChars) } });
      } catch (err) {
        this.write({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    // code_read：以 hashline 模式执行内置 read，输出 LINE:TEXT 行号 + [PATH#TAG] 快照tag，
    // 并在服务端记录快照与已见行（供 hash_edit 锚点校验）。与普通 read 分离，避免污染日常阅读输出。
    if (tool === 'code_read') {
      const prev = process.env.PI_EDIT_VARIANT;
      try {
        process.env.PI_EDIT_VARIANT = 'hashline';
        const readTool = await this.getTool('read');
        const result = await readTool.execute(
          `r-${String(id)}`,
          params,
          undefined,
          (partial) => {
            this.write({ type: 'update', id, partial });
          },
          undefined,
        );
        this.write({ id, ok: true, result });
      } catch (err) {
        this.write({
          id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        process.env.PI_EDIT_VARIANT = prev;
      }
      return;
    }
    // hash_edit：hashline 锚点编辑（行号 + 快照tag 的 SWAP/DEL/INS/BLK/REM/MV）。
    // 与 code_edit（replace 模式）分开：本分支临时以 hashline 模式构造 EditTool 执行。
    // 前置条件：模型需先用 read（code_read）读过目标文件，服务端已记录快照 tag 与已见行，
    // 否则 Patcher 会以 stale-tag / unseen-line 拒绝（防错位保护）。
    if (tool === 'hash_edit') {
      const prev = process.env.PI_EDIT_VARIANT;
      try {
        process.env.PI_EDIT_VARIANT = 'hashline';
        const editTool = await BUILTIN_TOOLS.edit(this.session);
        const input = typeof params.input === 'string' ? params.input : '';
        if (!input) throw new Error('hash_edit: missing `input`');
        const result = await editTool.execute(
          `h-${String(id)}`,
          { input },
          undefined,
          (partial) => {
            this.write({ type: 'update', id, partial });
          },
          undefined,
        );
        this.write({ id, ok: true, result });
      } catch (err) {
        this.write({
          id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        process.env.PI_EDIT_VARIANT = prev;
      }
      return;
    }
    try {
      const toolObj = await this.getTool(tool);
      const result = await toolObj.execute(
        `c-${String(id)}`,
        params,
        undefined,
        (partial) => {
          // 流式部分结果（如 bash 输出、长任务进度）
          this.write({ type: 'update', id, partial });
        },
        undefined,
      );
      this.write({ id, ok: true, result });
    } catch (err) {
      this.write({
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private write(frame: Record<string, unknown>): void {
    process.stdout.write(JSON.stringify(frame) + '\n');
  }

  start(): void {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let req: ServiceRequest;
      try {
        req = JSON.parse(trimmed) as ServiceRequest;
      } catch {
        this.write({ ok: false, error: 'invalid json' });
        return;
      }
      // 串行执行，避免并发交错同一工具实例（LSP/debug 会话需保持顺序）
      void this.execute(req);
    });
    rl.on('close', () => {
      process.exit(0);
    });
  }
}

const cwd = process.env.INFUTURE_CWD || process.cwd();
process.stdout.write(JSON.stringify({ type: 'ready', tools: [...TOOL_WHITELIST] }) + '\n');

/** 搜索 provider 清单（web_search 支持的凭据型 provider）。 */
const SEARCH_PROVIDER_IDS = ['tinyfish', 'exa', 'jina', 'kagi', 'tavily', 'perplexity', 'xai', 'codex', 'gemini', 'anthropic', 'zai'];

/**
 * 把 infuture 的搜索配置注入编程引擎运行时：
 *  1) settings.json 的 searchProvider → setPreferredSearchProvider（默认搜索引擎，auto 不设置）
 *  2) auth.json 中搜索 provider 的 key → authStorage.setConfigApiKey（web_search provider 经 getApiKey 读到）
 */
async function applySearchConfig(authStorage: unknown): Promise<void> {
  const cfgDir = path.join(process.env.HOME ?? '.', '.future', 'agent');
  try {
    const settingsRaw = await fs.readFile(path.join(cfgDir, 'settings.json'), 'utf-8');
    const settings = JSON.parse(settingsRaw) as { searchProvider?: string };
    const sp = settings.searchProvider;
    if (sp && sp !== 'auto') {
      try {
        setPreferredSearchProvider(sp);
        process.stderr.write(`[search] default provider = ${sp}\n`);
      } catch (e) {
        process.stderr.write(`[search] setPreferredSearchProvider(${sp}) failed: ${String(e)}\n`);
      }
    }
  } catch {
    /* settings.json 缺失时忽略 */
  }
  try {
    const authRaw = await fs.readFile(path.join(cfgDir, 'auth.json'), 'utf-8');
    const auth = JSON.parse(authRaw) as Record<string, { key?: string }>;
    const store = authStorage as { setConfigApiKey?: (p: string, k: string) => void } | undefined;
    for (const pid of SEARCH_PROVIDER_IDS) {
      const key = auth[pid]?.key;
      if (key && store?.setConfigApiKey) {
        try {
          store.setConfigApiKey(pid, key);
          process.stderr.write(`[search] injected key for ${pid}\n`);
        } catch {
          /* 单 provider 注入失败不影响其他 */
        }
      }
    }
  } catch {
    /* auth.json 缺失时忽略 */
  }
}

// 发现编程引擎凭据（~/.claude 等）以支持 web_search/inspect_image 等依赖 authStorage 的工具
discoverAuthStorage()
  .then(async (authStorage) => {
    await applySearchConfig(authStorage);
    return new CodingToolsService(cwd, authStorage, new ModelRegistry(authStorage)).start();
  })
  .catch(() => new CodingToolsService(cwd).start());
