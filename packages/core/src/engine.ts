/**
 * Engine — infuture 核心编排入口。
 * 组装：SessionManager + RunControl + LLM 适配 + 工具注册表（通用+编程）+ 审批门。
 * 对应 Rust `engine::Engine` + `agent::cli` 的核心路径。
 */
import type { AgentMessage, Model } from '@infuture/types';
import { newUserMessage } from '@infuture/types';
import { Client } from '@infuture/llm';
import { CodingToolsClient, codingTools } from '@infuture/coding';
import { SessionManager } from './session/manager.js';
import type { Session } from './session/session.js';
import { RunControl } from './runtime/run-control.js';
import type { BusyPolicy } from './runtime/run-request.js';
import { parseBusyPolicy } from './runtime/run-request.js';
import { DefaultApprovalGate, type ApprovalGate, type ApprovalRequest } from './sandbox/gate.js';
import { ToolRegistry } from './tools/registry.js';
import { readTool, writeTool, editTool, listTool } from './tools/fs.js';
import { shellTool } from './tools/shell.js';
import { computerUseTool } from './tools/computer-use.js';
import { spawnWorkersTool, listWorkersTool, type WorkerSpawner, type WorkerLister } from './tools/worker.js';
import { Registry, getDefaultModel } from './models/catalog.js';
import { LocalModelManager } from './local/local-models.js';
import { imageBlock, textBlock } from '@infuture/types';
import { AuthStore } from './config/auth.js';
import { loadSettings, saveSettings, type Settings } from './config/settings.js';
import { WorkspaceFiles } from './workspace/files.js';
import { defaultConfigDir, generateId } from './utils/id.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

/** browser 内嵌浮窗的一帧（截图 base64 + 页面信息，坐标按页面 CSS 像素换算）。 */
export interface BrowserPreviewFrame {
  image: string;
  url: string;
  title: string;
  width: number;
  height: number;
  ts: number;
}

/** 浮窗交互转发请求（坐标均为页面 CSS 像素；x/y 相对页面左上角）。 */
export interface BrowserPreviewInput {
  type: 'click' | 'scroll' | 'type' | 'key' | 'drag' | 'nav';
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  dx?: number;
  dy?: number;
  text?: string;
  dir?: 'back' | 'forward';
}
import { inloop } from './agent/run-loop.js';
import type { RunEventCallback } from './agent/events.js';
import { defaultAgentConfig } from '@infuture/types';

export interface EngineOptions {
  sessionDir?: string;
  model?: string;
  sandboxTier?: Settings['sandboxTier'];
  codingToolsApproval?: Settings['codingToolsApproval'];
  networkToolsApproval?: Settings['networkToolsApproval'];
  generalToolsApproval?: Settings['generalToolsApproval'];
  settings?: Partial<Settings>;
  /** 配置目录（auth.json/settings.json/models.json），默认 ~/.future/agent。 */
  configDir?: string;
  onEvent?: RunEventCallback;
  /** worker 启动回调（spawn_workers 工具委托；desktop 注入 loop worker 运行时）。 */
  workerSpawner?: WorkerSpawner;
  /** worker 列表回调（list_workers 工具委托；desktop 注入）。 */
  workerLister?: WorkerLister;
}

const CODING_READY_TIMEOUT = 20_000;
const SUBAGENT_TIMEOUT_MS = 120_000;
const REVIEW_TIMEOUT_MS = 90_000;

/** 给 Promise 加超时：超时拒绝并携带清晰信息，避免 LLM 调用挂死 agent 循环。 */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(message)), ms);
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}

/** 从 编程工具服务的 AgentToolResult 提取文本（用于流式 tool_update 事件）。 */
function extractPartialText(partial: unknown): string {
  const p = partial as { content?: Array<{ type?: string; text?: string }> } | undefined;
  const content = Array.isArray(p?.content) ? p.content : [];
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

/**
 * 规范化 hashline 语法文本内 `[PATH#TAG]` 的文件路径：
 * 相对路径 → 基于 base 的绝对路径；`~/` → HOME 绝对路径。
 * coding 服务按自身 cwd（进程 cwd）解析相对路径，模型写相对路径会 File not found，
 * 故在转发前统一转成绝对路径。
 */
function normalizeHashlinePaths(input: string, base: string): string {
  return input.replace(/\[([^\]#]+)#([0-9a-fA-F]{4})\]/g, (_m, p: string, tag: string) => {
    let abs = p.trim();
    if (abs.startsWith('~/')) abs = path.join(os.homedir(), abs.slice(2));
    if (!path.isAbsolute(abs)) abs = path.resolve(base, abs);
    return `[${abs}#${tag}]`;
  });
}

export interface RunOutcome {
  sessionId: string;
  runId: string;
  reply: string;
  turns: number;
  cancelled: boolean;
  error?: string;
}

export class Engine {
  readonly sessions: SessionManager;
  tools: ToolRegistry;
  readonly approval: DefaultApprovalGate;
  readonly models: Registry;
  readonly auth: AuthStore;
  /** 本地模型管理（下载 / mlx_lm 服务启动 / 自动注册到模型菜单）。 */
  readonly localModels: LocalModelManager;
  /** coding tools 服务（bun 进程，inloop 直调编程工具）。 */
  readonly coding: CodingToolsClient;
  /** 工作台文件管理服务（UI RPC 用）。 */
  readonly files: WorkspaceFiles;
  /** 工作区根目录：init 时解析（settings.workspaceDir 或系统 tmp 下创建的临时目录）。 */
  workspace: string;
  settings: Settings;
  private readonly onEvent?: RunEventCallback;
  private readonly workerSpawner?: WorkerSpawner;
  private readonly workerLister?: WorkerLister;
  private readonly configDir: string;
  private activeRuns = new Map<string, AbortController>();

  constructor(options: EngineOptions = {}) {
    this.configDir = options.configDir ?? defaultConfigDir();
    this.settings = {
      defaultModel: options.model ?? '',
      sandboxTier: options.sandboxTier ?? 'manual',
      codingToolsApproval: options.codingToolsApproval ?? 'on',
      networkToolsApproval: options.networkToolsApproval ?? 'on',
      generalToolsApproval: options.generalToolsApproval ?? 'auto',
      workspaceDir: '',
      maxTurns: 10,
      thinkingBudget: 0,
      thinkingLevel: '',
      ...options.settings,
    } as Settings;
    this.onEvent = options.onEvent;
    this.workerSpawner = options.workerSpawner;
    this.workerLister = options.workerLister;
    this.sessions = new SessionManager({ sessionDir: options.sessionDir });
    this.models = new Registry();
    this.auth = new AuthStore({ configDir: this.configDir });
    this.approval = new DefaultApprovalGate({ tier: this.settings.sandboxTier });
    this.coding = new CodingToolsClient({ cwd: process.cwd(), onLog: (l) => void l });
    // 编程工具的流式过程输出（eval 中间结果 / bash 增量输出等）转发为 tool_update 事件
    this.coding.onUpdate((_id, partial, tool) => {
      const text = extractPartialText(partial);
      if (text) this.onEvent?.({ type: 'tool_update', runId: 'coding', tool, partial: text });
    });
    this.workspace = process.cwd();
    this.files = new WorkspaceFiles();
    this.tools = this.buildToolRegistry();
    this.localModels = new LocalModelManager(
      this.configDir,
      async (m) => {
        const model = m as Model;
        this.models.add(model);
        await this.addCustomModelToFile(model);
      },
      async (id) => {
        this.models.remove(id);
        await this.removeCustomModelFromFile(id);
      },
    );
    void this.localModels.init();
  }

  private buildToolRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    const cwd = this.workspace || process.cwd();
    registry.registerAll([
      readTool(cwd, {
        // read 整合 hashline 读：经 coding 服务 code_read 产出行号 + [PATH#TAG] 并记录快照，供后续 edit(input) 使用
        hashlineRead: async (path) => {
          const res = (await this.coding.call('code_read', { path })) as {
            content?: Array<{ type?: string; text?: string }>;
            isError?: boolean;
          };
          return {
            result: extractPartialText(res) || '(no text output)',
            is_error: Boolean(res?.isError),
          };
        },
      }),
      writeTool(cwd),
      editTool(cwd, {
        // edit 走 hashline 路由：input（hashline 语法）→ coding 服务 code_edit（默认 hashline）；replace 参数走本地兜底
        hashline: async (input) => {
          try {
            // 规范化 input 内 [PATH#TAG] 的路径：相对/~/ → 基于 workspace 的绝对路径，
            // 避免模型写相对路径时 coding 服务按自身 cwd（进程 cwd）解析失败（File not found）
            const normalized = normalizeHashlinePaths(input, cwd);
            const res = (await this.coding.call('code_edit', { input: normalized })) as {
              content?: Array<{ type?: string; text?: string }>;
              isError?: boolean;
            };
            return {
              result: extractPartialText(res) || '(hashline edit: no text output)',
              is_error: Boolean(res?.isError),
            };
          } catch (err) {
            return { result: `edit(hashline) failed: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
          }
        },
      }),
      listTool(cwd),
      shellTool({ cwd }),
    ]);
    // worker 协作：普通对话经 spawn_workers 工具启动多 worker、list_workers 读取结果（desktop 注入运行时）
    registry.register(spawnWorkersTool(this.workerSpawner));
    registry.register(listWorkersTool(this.workerLister));
    // 桌面 GUI 控制（Open Computer Use CLI；macOS 需授权 Accessibility/Screen Recording）
    registry.register(
      computerUseTool({
        // computer_use 网页分支 → 内嵌浏览器（browser 工具 + 应用内浮窗），不打开外部 Chrome
        embeddedBrowser: {
          open: async (url) => this.coding.call('browser', { action: 'open', url, timeout: 20 }),
          input: (input) => this.browserPreviewInput(input),
          // OCU 风格：get_app_state app=__embedded__ → 内嵌页面无障碍树（element_index = observe id）
          // 注意：includeAll 树可能极大（百度等页面数千节点），必须截断返回，否则 run 输出被截断导致 JSON 解析失败。
          observe: async (opts?: { maxTreeNodes?: number; maxTreeDepth?: number }) => {
            const cap = Math.max(1, Math.min(opts?.maxTreeNodes ?? 200, 800));
            const code = `const obs = await tab.observe({ includeAll: true }); JSON.stringify({ url: obs.url, title: obs.title, elements: (obs.elements || []).slice(0, ${cap}) })`;
            const res = (await this.coding.call('browser', { action: 'run', name: 'main', code }, 20000)) as {
              content?: Array<{ type?: string; text?: string }>;
              isError?: boolean;
            };
            const text = res?.isError ? '' : extractPartialText(res);
            if (text) {
              try {
                const info = JSON.parse(text) as { url?: string; title?: string; elements?: unknown[] };
                return { url: String(info.url ?? ''), title: String(info.title ?? ''), elements: Array.isArray(info.elements) ? info.elements : [] };
              } catch {
                // 树解析失败（截断/超限）——降级：只探测标签是否存活，让上层报更准确的错误
              }
            }
            // 区分"标签不存在"与"页面树过大/解析失败"：轻量探测当前标签 URL
            try {
              const probe = (await this.coding.call(
                'browser',
                { action: 'run', name: 'main', code: `tab.url()`, timeout: 20 },
                10000,
              )) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
              const probeText = probe?.isError ? '' : extractPartialText(probe);
              if (probeText && /^https?:\/\//i.test(probeText.trim())) {
                return { url: probeText.trim(), title: '', elements: [] };
              }
            } catch {
              // fallthrough
            }
            return null;
          },
          // 定向查询：CSS selector → 匹配元素列表（轻量，不加载全量无障碍树）
          find: async (selector, limit = 20) => {
            const cap = Math.max(1, Math.min(limit, 50));
            const sel = JSON.stringify(selector);
            const code = `const list = await tab.evaluate((s, c) => { const els = [...document.querySelectorAll(s)].slice(0, c); return els.map((el, i) => ({ i, tag: (el.tagName || '').toLowerCase(), text: (el.textContent || '').trim().slice(0, 120), href: el.href || '', target: el.target || '' })); }, ${sel}, ${cap}); JSON.stringify(list)`;
            const res = (await this.coding.call('browser', { action: 'run', name: 'main', code }, 15000)) as {
              content?: Array<{ type?: string; text?: string }>;
              isError?: boolean;
            };
            const t = res?.isError ? '' : extractPartialText(res);
            if (!t) return [];
            try {
              const arr = JSON.parse(t) as Array<Record<string, unknown>>;
              return Array.isArray(arr) ? arr : [];
            } catch {
              return [];
            }
          },
          // 定向点击：selector+index 点击匹配元素；target=_blank 自动改同标签导航（避免"点了没跳转"）。
          // 点击/导航会销毁 evaluate 上下文，忽略导航中断（只要执行了点击/跳转即算成功）。
          // 返回前等导航启动窗口：立即返回会让前端在 tool_result 时截到旧页面帧（浮窗不更新）。
          clickSelector: async (selector, index) => {
            const sel = JSON.stringify(selector);
            const i = Math.max(0, Number(index) || 0);
            const code = `try { await tab.evaluate((s, n) => { const el = document.querySelectorAll(s)[n]; if (!el) return "no-match"; if (el.target === '_blank' || el.target === 'blank') { const href = el.href || el.getAttribute('href') || ''; if (href) location.href = href; } else { el.click(); } return "clicked"; }, ${sel}, ${i}); } catch (e) {} await new Promise(r => setTimeout(r, 1500)); "ok"`;
            const res = (await this.coding.call('browser', { action: 'run', name: 'main', code }, 20000)) as {
              content?: Array<{ type?: string; text?: string }>;
              isError?: boolean;
            };
            const t = extractPartialText(res);
            const failed = res?.isError || /no-match|执行失败|is not alive/i.test(t);
            return failed ? { ok: false, error: t || '无匹配元素' } : { ok: true };
          },
          // OCU 风格：click / type / fill 由 element_index（observe id，number）→ tab.id(id) 元素 handle → CDP
          // 注意：`await tab.id(n).click()` 会被解析为 await (tab.id(n).click())（在 Promise 上取 click，undefined），
          // 必须 `await (await tab.id(n)).click()` 先取到 handle。
          elementAction: async (op, id, text) => {
            const n = Number(id);
            const code =
              op === 'click'
                ? `await (await tab.id(${n})).click(); "ok"`
                : op === 'type'
                  ? `const h = await tab.id(${n}); await h.click(); await h.type(${JSON.stringify(text ?? '')}); "ok"`
                  : `await (await tab.id(${n})).fill(${JSON.stringify(text ?? '')}); "ok"`;
            const res = (await this.coding.call('browser', { action: 'run', name: 'main', code }, 15000)) as {
              content?: Array<{ type?: string; text?: string }>;
              isError?: boolean;
            };
            const t = extractPartialText(res);
            const failed = res?.isError || /执行失败|is not alive/i.test(t);
            return failed ? { ok: false, error: t || '内嵌浏览器标签不可用' } : { ok: true };
          },
        },
      }),
    );
    // 编程工具：inloop 经 coding tools 服务直调编程引擎（懒启动 bun 进程）
    registry.registerAll(
      codingTools(this.coding, {
        spawnSubagent: (task, o) => this.spawnSubagent(task, o),
        reviewCode: (o) => this.reviewCode(o),
      }),
    );
    return registry;
  }

  /** 启动初始化：会话目录 + 持久化设置 + 工作区 + 自定义模型（settings.json / models.json）。 */
  async init(): Promise<void> {
    await this.sessions.init();
    await this.loadPersistedSettings();
    await this.resolveWorkspace();
    await this.loadCustomModels();
  }

  /**
   * 解析工作区根目录（启动时）：settings.workspaceDir 已配置 → 使用；未配置 → 系统 tmp 临时目录。
   */
  async resolveWorkspace(): Promise<void> {
    await this.setWorkspace(this.settings.workspaceDir || '');
  }

  /**
   * 设置/切换工作区根目录并**立即生效**（供 settings.set 运行时调用）：
   * - dir 非空 → 使用该目录（确保存在）；空 → 在系统 tmp 下新建 infuture-workspace-<rand>；
   * - 同步更新：内存 settings + 持久化 + 会话默认 cwd + agent 工具相对路径。
   */
  async setWorkspace(dir: string): Promise<void> {
    if (dir && dir.trim()) {
      const abs = path.resolve(dir.trim());
      await fs.mkdir(abs, { recursive: true });
      this.workspace = abs;
      this.settings.workspaceDir = abs;
    } else {
      const base = path.join(os.tmpdir(), `infuture-workspace-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`);
      await fs.mkdir(base, { recursive: true });
      this.workspace = base;
      this.settings.workspaceDir = base;
    }
    // 会话默认 cwd 与工具相对路径统一指向新工作区
    this.sessions.setDefaultCwd(this.workspace);
    // coding 服务 cwd 跟随 workspace：编程工具相对路径以工作区为基准解析
    this.coding.setCwd(this.workspace);
    this.tools = this.buildToolRegistry();
    await this.saveSettingsToDisk();
  }

  /** 读取 settings.json 合并进内存设置。 */
  async loadPersistedSettings(): Promise<void> {
    const disk = await loadSettings({ configDir: this.configDir });
    this.settings = { ...this.settings, ...disk };
  }

  /** 持久化当前设置到 settings.json。 */
  async saveSettingsToDisk(): Promise<void> {
    await saveSettings(this.settings, { configDir: this.configDir });
  }

  /** 读取 models.json 的自定义 provider 合并进模型目录。 */
  async loadCustomModels(): Promise<void> {
    const file = path.join(this.configDir, 'models.json');
    const custom = await Registry.fromFile(file);
    for (const m of custom.listAll()) {
      if (!this.models.get(m.id)) this.models.add(m);
    }
  }

  /** 把自定义模型写进 models.json（providers 对象格式，与 Registry.fromFile 一致）。 */
  async addCustomModelToFile(model: Model): Promise<void> {
    const file = path.join(this.configDir, 'models.json');
    let data: { providers?: Record<string, { baseUrl?: string; apiKey?: string; models?: Model[] }> } = {};
    try {
      data = JSON.parse(await fs.readFile(file, 'utf-8')) as typeof data;
    } catch {
      data = {};
    }
    const providers = data.providers ?? {};
    const entry = providers[model.provider] ?? { models: [] };
    const models = entry.models ?? [];
    const idx = models.findIndex((m) => m.id === model.id);
    if (idx >= 0) models[idx] = model;
    else models.push(model);
    providers[model.provider] = { ...entry, models };
    data.providers = providers;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf-8');
  }

  /** 从 models.json 删除一个自定义模型；若 defaultModel 指向它则重置为空。 */
  async removeCustomModelFromFile(id: string): Promise<void> {
    const file = path.join(this.configDir, 'models.json');
    let data: { providers?: Record<string, { baseUrl?: string; apiKey?: string; models?: Model[] }> } = {};
    try {
      data = JSON.parse(await fs.readFile(file, 'utf-8')) as typeof data;
    } catch {
      return;
    }
    const providers = data.providers ?? {};
    let removed = false;
    for (const [provider, cfg] of Object.entries(providers)) {
      const models = cfg.models ?? [];
      const idx = models.findIndex((m) => m.id === id);
      if (idx >= 0) {
        models.splice(idx, 1);
        removed = true;
        if (models.length === 0) delete providers[provider];
        else providers[provider] = { ...cfg, models };
      }
    }
    if (!removed) return;
    data.providers = providers;
    await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf-8');
    // 默认模型被删则重置，避免指向不存在的模型
    if (this.settings.defaultModel === id) {
      this.settings.defaultModel = '';
      await this.saveSettingsToDisk();
    }
  }

  /**
   * 搜索配置验证：运行时重新注入最新搜索配置（默认引擎 + provider key），
   * 并真实调用一次 web_search 返回结果，供前端搜索配置窗口「验证」。
   * 注入作用于运行中的 coding 服务进程，验证即应用，无需重启桌面端。
   */
  /**
   * browser 内嵌浮窗：拉取当前标签的实时帧（截图 + 页面信息）。
   * 无已打开标签时返回 null（前端不显示浮窗）。
   */
  async browserPreview(): Promise<BrowserPreviewFrame | null> {
    try {
      const res = (await this.coding.call(
        'browser',
        {
          action: 'run',
          name: 'main',
          code: [
            `const dest = "/tmp/infuture-browser-preview-" + Date.now() + ".png";`,
            `const s = await tab.screenshot({ silent: true, save: dest });`,
            `const info = await tab.evaluate(() => ({ url: location.href, title: document.title, w: innerWidth, h: innerHeight }));`,
            `({ dest: s.dest, url: info.url, title: info.title, w: info.w, h: info.h })`,
          ].join('\n'),
        },
        15000,
      )) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
      if (res?.isError) return null;
      const text = extractPartialText(res);
      if (!text) return null;
      const info = JSON.parse(text) as { dest?: string; url?: string; title?: string; w?: number; h?: number };
      if (!info.dest) return null;
      const buf = await fs.readFile(info.dest);
      await fs.unlink(info.dest).catch(() => {});
      return {
        image: buf.toString('base64'),
        url: String(info.url ?? ''),
        title: String(info.title ?? ''),
        width: Number(info.w) || 1280,
        height: Number(info.h) || 720,
        ts: Date.now(),
      };
    } catch {
      return null;
    }
  }

  /** browser 浮窗交互转发：浮窗里的点击/滚动/键盘 → CDP 输入（作用于同一页面实例）。 */
  async browserPreviewInput(input: BrowserPreviewInput): Promise<{ ok: boolean; error?: string }> {
    const { type, x, y, text, dx, dy, x2, y2 } = input ?? {};
    let code: string;
    switch (type) {
      case 'click':
        code = `await page.mouse.click(${Math.round(Number(x) || 0)}, ${Math.round(Number(y) || 0)}); "ok"`;
        break;
      case 'scroll':
        code = `await page.mouse.wheel({ deltaX: ${Number(dx) || 0}, deltaY: ${Number(dy) || 0} }); "ok"`;
        break;
      case 'type':
        code = `await page.keyboard.type(${JSON.stringify(String(text ?? ''))}); "ok"`;
        break;
      case 'key':
        code = `await page.keyboard.press(${JSON.stringify(String(text ?? 'Enter'))}); "ok"`;
        break;
      case 'drag':
        code = [
          `await page.mouse.move(${Math.round(Number(x) || 0)}, ${Math.round(Number(y) || 0)});`,
          `await page.mouse.down();`,
          `await page.mouse.move(${Math.round(Number(x2 ?? x) || 0)}, ${Math.round(Number(y2 ?? y) || 0)}, { steps: 8 });`,
          `await page.mouse.up(); "ok"`,
        ].join('\n');
        break;
      case 'nav': {
        const go = input.dir === 'forward' ? 'goForward' : 'goBack';
        // 历史导航：返回结果可能是 Response 或 null；加载慢时 catch 兜底，导航已发出
        code = `try { await page.${go}({ waitUntil: 'domcontentloaded', timeout: 8000 }); } catch (e) {} "ok"`;
        break;
      }
      default:
        return { ok: false, error: `unknown input type: ${type}` };
    }
    try {
      const res = (await this.coding.call('browser', { action: 'run', name: 'main', code }, 15000)) as {
        content?: Array<{ type?: string; text?: string }>;
        isError?: boolean;
      };
      const textOut = extractPartialText(res);
      const failed = res?.isError || /执行失败|is not alive/i.test(textOut);
      return failed ? { ok: false, error: textOut || 'browser 标签不可用' } : { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async verifySearch(): Promise<{ ok: boolean; costMs?: number; sample?: string; error?: string }> {
    try {
      const r = (await this.coding.call('web_search', {}, 45000, 'search.verify')) as {
        ok?: boolean;
        costMs?: number;
        sample?: string;
      };
      if (r?.ok) return { ok: true, costMs: r.costMs, sample: r.sample };
      return { ok: false, error: 'web_search 验证未通过' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 选择会话用模型；无配置时回退默认模型 + auth key。auth.baseUrl 可覆盖模型地址。 */
  private async resolveClient(session: Session, overrideModel?: string) {
    const modelId =
      overrideModel ??
      (session.meta.model && session.meta.model !== 'default' ? session.meta.model : this.settings.defaultModel);
    const model = this.models.get(modelId) ?? getDefaultModel(this.models, modelId);
    if (!model) {
      throw new Error('未配置模型：请先在 LLM 配置中添加模型（id + api + baseUrl + api key）');
    }
    const authEntry = (await this.auth.load())[model.provider];
    const key = authEntry?.key ?? '';
    // auth.baseUrl（凭据区填写）覆盖模型自带地址；留空则用模型自定义 baseUrl
    const baseUrl = authEntry?.baseUrl || model.baseUrl;
    const client = Client.fromModel({ ...model, baseUrl }, key);
    return { model, client };
  }

  /**
   * subagent —— infuture 自实现的子 agent（一等子任务，非外部 agent 委派）。
   *
   * 用 inloop 递归跑一个独立子任务：复用同一模型/工具/审批，单条 user 消息，
   * 返回最终文本。这是 `task` 工具在直调模式下的替代——子 agent 由
   * infuture 自己的循环驱动，不依赖外部 agent 会话。
   */
  async spawnSubagent(task: string, _opts: { isolated?: boolean } = {}): Promise<string> {
    // 子 agent 解析当前默认模型（会话内模型接入后续阶段）
    const virtual = { meta: { model: 'default' } } as unknown as Session;
    const { model, client } = await this.resolveClient(virtual);
    // 持久化子会话（可查），不抢占当前会话
    const subSession = await this.sessions.create(`[sub] ${task.slice(0, 24)}`, {
      kind: 'clone',
      setCurrent: false,
    });
    await this.sessions.appendMessage(subSession, newUserMessage('user', task));
    const sub = await withTimeout(
      inloop({
        runId: generateId('run'),
        sessionId: subSession.id,
        model: this.settings.defaultModel,
        provider: client.provider(),
        config: defaultAgentConfig({
          systemPrompt:
            'You are infuture subagent — you execute a single delegated coding task. ' +
            'Work autonomously using tools, then report your findings or result concisely.\n' +
            '编辑默认用 hashline 锚点编辑：先 read 或 code_read 拿行号与 [PATH#TAG] tag，再传 input 给 edit/code_edit；' +
            '只有简单唯一字符串替换才用 path/old_string/new_string。',
          maxTurns: this.settings.maxTurns,
          thinkingBudget: this.settings.thinkingBudget,
          thinkingLevel: this.settings.thinkingLevel,
          vision: (model.input_types ?? []).includes('image'),
          toolsExecutionMode: 'parallel',
          contextCompaction: { enabled: true },
        }),
        registry: this.tools,
        approval: this.approval,
        codingToolsApproval: this.settings.codingToolsApproval,
        networkToolsApproval: this.settings.networkToolsApproval,
        generalToolsApproval: this.settings.generalToolsApproval,
        contextWindow: model.contextWindow,
        // 子 agent 是执行委派编程任务的 worker：强制暴露编程工具组（execute_code/bash/ast/subagent/review/git_pr）
        toolSelection: { forceGroups: ['coding'] },
        history: [newUserMessage('user', task)],
        onEvent: (e) => this.onEvent?.(e),
      }),
      SUBAGENT_TIMEOUT_MS,
      `subagent 超时（${SUBAGENT_TIMEOUT_MS / 1000}s）`,
    );
    // 子会话历史持久化（含最终回复），实现"会话双向同步"中可查的子 agent 会话
    await this.sessions.appendMessage(subSession, sub.message);
    const reply = sub.message.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
    return reply || '(subagent: no text output)';
  }

  /**
   * review —— 双模型审查（advisor 角色）的 infuture 自实现。
   *
   * 收集审查范围（patch 或文件/目录）代码 → 以独立审查者视角调用模型产出意见。
   * 初版使用当前默认模型充当 advisor（模型与主 agent 相同）；配置独立 advisor
   * 模型的能力作为后续增强。
   */
  async reviewCode(opts: { scope?: string; patch?: string }): Promise<string> {
    // 收集待审查代码
    let code = '';
    if (opts.patch) {
      code = opts.patch;
    } else if (opts.scope) {
      try {
        const st = await fs.stat(opts.scope);
        if (st.isFile()) {
          code = await fs.readFile(opts.scope, 'utf8');
        } else if (st.isDirectory()) {
          const entries = await fs.readdir(opts.scope, { withFileTypes: true });
          const parts: string[] = [];
          for (const e of entries) {
            if (e.isFile()) {
              try {
                parts.push(`--- ${e.name} ---\n` + (await fs.readFile(path.join(opts.scope, e.name), 'utf8')));
              } catch {
                /* 单个文件读取失败跳过 */
              }
            }
          }
          code = parts.join('\n\n');
        }
      } catch {
        code = '';
      }
      if (!code) return `review: 无法读取审查范围「${opts.scope}」`;
    }
    if (!code.trim()) return 'review: 无可审查内容（需要 patch 或可读 scope）';

    const virtual = { meta: { model: 'default' } } as unknown as Session;
    const { client } = await this.resolveClient(virtual);
    const stream = await withTimeout(
      client.provider().streamModel({
        model: this.settings.defaultModel,
        systemPrompt:
          'You are an independent senior code reviewer (advisor role). Review the provided code/diff ' +
          'for correctness, bugs, security issues, style and testability. Be concrete and actionable. ' +
          'Output in the same language as the code context.',
        messages: [newUserMessage('user', `请审查以下代码 / diff，指出问题并给出修改建议：\n\n${code.slice(0, 60_000)}`)],
        tools: [],
      }),
      REVIEW_TIMEOUT_MS,
      `review 超时（${REVIEW_TIMEOUT_MS / 1000}s）`,
    );
    let out = '';
    for await (const ev of stream) {
      if (ev.type === 'text') out += ev.text;
    }
    return out || '(review: no output)';
  }

  /** 启动一次会话运行。返回最终回复。 */
  async run(
    sessionOrId: Session | string,
    prompt: string,
    options: {
      busyPolicy?: BusyPolicy;
      onEvent?: RunEventCallback;
      model?: string;
      thinkingBudget?: number;
      thinkingLevel?: string;
      /** 消息附件：图片（dataUrl，base64 data URL）或文本文件（content 已由前端读出）。 */
      attachments?: Array<{ kind: 'image' | 'file'; name: string; dataUrl?: string; content?: string }>;
    } = {},
  ): Promise<RunOutcome> {
    const session = typeof sessionOrId === 'string' ? await this.sessions.load(sessionOrId) : sessionOrId;
    if (!session) throw new Error('session not found');

    const busy = parseBusyPolicy(options.busyPolicy ?? 'enqueue_if_busy');

    // 忙时按 busy 策略处理
    if (session.control.isStreaming) {
      if (busy === 'enqueue_if_busy') {
        // 排队：不 acquire 租约（否则 begin 会因 active 抛错），运行完成后 drain
        session.enqueue(prompt);
        return { sessionId: session.id, runId: '', reply: '(queued)', turns: 0, cancelled: false };
      }
      // supersede_session：取消当前 run，等待释放后再启动新 run
      const snap = session.control.snapshot();
      if (snap) {
        session.control.cancel({ runId: snap.runId, epoch: snap.epoch });
        this.activeRuns.get(snap.runId)?.abort();
      }
      await waitUntilIdle(session, 15_000);
    }

    const lease = session.control.begin(undefined, prompt.slice(0, 24));
    const emit: RunEventCallback = (e) => {
      this.onEvent?.(e);
      options.onEvent?.(e);
    };

    // 先记录用户消息（即使后续 resolveClient 失败也不丢用户输入）
    const userMsg: AgentMessage = newUserMessage('user', prompt);
    // 附件：图片 → image_url 块（多模态 VLM 本地模型可理解）；文本文件 → 内容块（避免模型瞎猜路径）
    if (options.attachments && options.attachments.length > 0) {
      userMsg.content = [...userMsg.content];
      for (const a of options.attachments) {
        if (a.kind === 'image' && a.dataUrl) {
          userMsg.content.push(imageBlock(a.dataUrl));
        } else if (a.kind === 'file' && a.content != null) {
          userMsg.content.push(
            textBlock(`\n\n【附件文件：${a.name}】\n${a.content.slice(0, 100_000)}`),
          );
        }
      }
    }
    await this.sessions.appendMessage(session, userMsg);
    // 注意：不在此发空 text_delta——会残留空 assistant 消息（模型先推理/工具时正文为空）

    try {
      const { model, client } = await this.resolveClient(session, options.model);
      const abort = new AbortController();
      this.activeRuns.set(lease.runId, abort);

      session.control.installCancellation(lease, () => abort.abort());
      const result = await inloop({
        runId: lease.runId,
        sessionId: session.id,
        model: model.id,
        provider: client.provider(),
        config: defaultAgentConfig({
          systemPrompt:
            'You are infuture — a general-purpose agent with coding capability.\n\n' +
            '工具使用规则（必须遵守）：\n' +
            '0. ACTION-FIRST：调用工具前不要长时间空想/规划。先尽早用工具获取真实信息' +
            '（读文件 / 列目录 / 执行命令 / 检索），基于证据行动，再根据工具结果逐步调整。' +
            '能用工具完成的任务必须用工具，不要只凭推理给出答案。\n' +
            '1. 当用户明确要求"启动/开启多个 worker（子 agent）协作、分角色（解题、反思、审查、探索）执行"时，' +
            '必须调用 spawn_workers 工具真实启动 worker，而不是直接替用户作答。\n' +
            '2. spawn_workers 的 tasks 按角色拆分：第 1 个解决目标，后续 worker 的 prompt 内用 {w1}/{w2}（1-based）' +
            '引用前序 worker 的最终输出（如反思 worker 写"反思 {w1} 的输出"，二轮 worker 写"基于 {w2} 重新探索"）。\n' +
            '3. 每个 worker 可用 model 指定不同模型、thinking 指定思考强度（用户指定时）。\n' +
            '4. 启动后用 list_workers({goal, wait:true}) 一次性阻塞等待全部 worker 完成（全部 done/error 后返回各 worker 结论），' +
            '再向用户汇报各 worker 结论；' +
            '用户要求"直到完成/继续迭代"时，基于已有 worker 结果 spawn 新一轮 worker。\n' +
            '5. 编程编辑默认走 hashline 锚点编辑：先调 read（或 code_read）读取目标文件——输出带行号与 [PATH#TAG] 快照tag，' +
            '再调 edit / code_edit / hash_edit 并传 input（hashline 语法：SWAP N.=M: 替换行 / DEL N 删行 / ' +
            'INS.PRE/POST N 插行 / INS.TAIL: 末尾追加 / SWAP.BLK N 整块替换 / REM / MV DEST）。' +
            'tag 必须来自最近的 read/code_read 输出，禁止凭空编造；只有做简单唯一字符串替换时才用 path/old_string/new_string（replace 兜底）。\n' +
            '6. 文件/目录路径不确定时，先 list / glob 确认实际结构再操作，禁止凭记忆猜测路径；' +
            'grep/read 输出里的行号标记（如 main.css:12 或 #12-42）只是定位信息，不是路径的一部分，禁止拼进 path 参数。\n' +
            '7. 当任务产出 HTML 网页/可视化内容时，除了按需保存文件，还必须在最终回复里用 ```html 代码块包裹完整 HTML 输出，' +
            'web 端会自动把它渲染成可交互网页预览（不要只给文件路径或描述）。\n' +
            '8. 桌面 GUI 操作自动使用 computer_use（无需用户明确指示）：任务需要打开/切换/操作桌面应用、' +
            '点击 UI 元素、在非浏览器窗口输入文本、滚动/拖拽、检查桌面界面状态时，直接调用 computer_use，' +
            '优先于用 shell 猜测坐标模拟（shell 的 open -a 只能启动应用，不能读 UI 树或点击元素）。' +
            '网页路由：浏览网页/打开 URL/读取网页内容时，用 computer_use 的网页分支（open_url 打开、page_click/page_type/page_scroll/page_key 交互）' +
            '或 browser 工具——页面显示在应用内嵌浮窗，禁止为网页打开外部 Chrome。' +
            '流程：先 list_apps 确认可用应用 → get_app_state 拿 UI 树与 element_index → 用 element_index 精确操作；' +
            'macOS 首次使用前先 action=doctor 检查权限；element_index 必须来自最近一次 get_app_state，禁止猜测；' +
            '操作目标窗口时保持其原有尺寸与位置，不要缩放/最大化/全屏（除非用户明确要求）。\n' +
            '9. 用户要求"用绘图工具/画布模拟人工还原图片"或任何需要看到界面/画面的任务时，走视觉闭环：' +
            '系统已自动截取当前屏幕并注入（视觉/截图任务首轮会自动截图，无需你再调 screenshot 也能看到屏幕）。' +
            '任务涉及参考图片文件时用 read 读取该路径（read 图片会返回"图片路径"并自动注入，你就能看到参考图）；' +
            '禁止用 browser 打开本地 HTML 画布模拟还原（headless 无法操作画布也无法截图验证）；' +
            '必须操作真实桌面画布/绘图应用（list_apps → get_app_state → click/drag 逐块绘制），' +
            '每完成一部分再用 computer_use action=screenshot 截屏验证并与参考图对比，直到还原；' +
            '不允许只输出颜色分析/操作序列 JSON/SVG 后声称完成，必须真实操作画布并截图验证。\n' +
            '10. 画布/绘图类应用（无边记 Freeform、画板、CAD、Photoshop 等）的 UI 树通常不含画布内容：' +
            '不要用 osascript 反复枚举菜单死磕，也不要对着空白 UI 树猜按钮；' +
            '正确路径：screenshot 观察屏幕（能看到画布、工具栏、参考图）→ 视觉理解目标位置 → ' +
            'click/drag 传截图像素坐标（x/y 从最近一次 screenshot 的图片像素读取）→ 操作后再次 screenshot 验证，迭代推进。\n',
          maxTurns: this.settings.maxTurns,
          // worker/subagent 可在 options.thinkingBudget/thinkingLevel 覆盖全局思考设置；未指定时回退全局
          thinkingBudget: options.thinkingBudget ?? this.settings.thinkingBudget,
          thinkingLevel: options.thinkingLevel ?? this.settings.thinkingLevel,
          // 当前模型是否支持图像输入：false 时 run-loop 剥离自动截图注入，避免非视觉模型 1210 报错中断
          vision: (model.input_types ?? []).includes('image'),
          toolsExecutionMode: 'parallel',
          // 上下文压缩：长会话自动把早期历史压缩为摘要（防超窗）。默认启用，保守触发（0.85 窗口）。
          contextCompaction: { enabled: true },
        }),
        registry: this.tools,
        approval: this.approval,
        codingToolsApproval: this.settings.codingToolsApproval,
        networkToolsApproval: this.settings.networkToolsApproval,
        generalToolsApproval: this.settings.generalToolsApproval,
        contextWindow: model.contextWindow,
        history: session.messages(),
        cwd: session.meta.cwd,
        onEvent: emit,
        signal: abort.signal,
      });

      await this.sessions.appendMessage(session, result.message);
      session.control.finalizing(lease);
      session.control.complete(lease, true);
      this.activeRuns.delete(lease.runId);

      // 处理排队中的后续提示词（busy=enqueue_if_busy）
      await this.drainQueue(session, emit);

      return {
        sessionId: session.id,
        runId: lease.runId,
        reply: result.message.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
        turns: result.turns,
        cancelled: result.cancelled,
      };
    } catch (err) {
      // 持久化错误详情到服务端日志：工具异常/模型流异常都会走到这里，
      // 打印完整栈便于排查"任务中途终止"（前端仅显示 error 事件，栈不可见）。
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[infuture] run error:', errMsg, '\n', err instanceof Error ? err.stack : '');
      session.control.finalizing(lease);
      session.control.complete(lease, true);
      this.activeRuns.delete(lease.runId);
      emit({ type: 'error', runId: lease.runId, message: errMsg });
      return { sessionId: session.id, runId: lease.runId, reply: '', turns: 0, cancelled: false, error: errMsg };
    }
  }

  /** 处理队列中后续提示词（递归运行，保持事件流）。 */
  async drainQueue(session: Session, onEvent?: RunEventCallback): Promise<void> {
    while (session.queueLength > 0 && !session.control.isStreaming) {
      const item = session.dequeue();
      if (!item) break;
      await this.run(session, item.prompt, { busyPolicy: 'enqueue_if_busy', onEvent });
    }
  }

  async stop(runId: string): Promise<void> {
    this.activeRuns.get(runId)?.abort();
  }

  async dispose(): Promise<void> {
    this.coding.dispose();
    // 本地模型进程是本服务的子进程：服务退出时一并停止（含清理注册的本地模型）
    try {
      await this.localModels.stop();
    } catch {
      // 清理失败不阻断退出
    }
  }
}

/** 等待会话空闲（supersede 取消后释放）。超时仍返回，避免永久阻塞。 */
async function waitUntilIdle(session: import('./session/session.js').Session, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (session.control.isStreaming && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}
