/**
 * computer_use 工具 — 桌面 GUI 控制（macOS / Linux / Windows）。
 * 经 Open Computer Use CLI（open-computer-use / ocu）直调，返回 MCP 风格 JSON。
 * 前置：`npm i -g open-computer-use`；macOS 14+ 首次运行需授权 Accessibility 与 Screen Recording。
 * 对应 Rust `tools::computer_use`（桌面自动化能力，与 browser 并列的外部系统控制）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { AgentTool, ToolCallResult } from '@infuture/types';
import { toolDef } from '@infuture/types';

const execFileAsync = promisify(execFile);
/** 单次返回保护上限：UI 树可能很大，超限截断并提示收窄（max_tree_nodes/max_tree_depth/text_limit）。 */
const MAX_OUTPUT = 50_000;
const CALL_TIMEOUT_MS = 120_000;

/**
 * screenshot — 截取当前屏幕（视觉闭环核心）。
 * macOS 用内置 screencapture；Linux 尝试 import（ImageMagick）→ gnome-screenshot；Windows 用 PowerShell。
 * 返回截图绝对路径；agent 循环会把结果图片作为图像消息注入下一轮（视觉模型直接看到屏幕）。
 */
async function takeScreenshot(target?: string): Promise<string> {
  // 统一输出 JPEG：多数视觉模型/API（如智谱 GLM）只接受 JPEG 图像，PNG 会报 1210 图片格式错误。
  const file = (target && target.trim()) || path.join(os.tmpdir(), `infuture-shot-${Date.now()}.jpg`);
  await import('node:fs/promises').then((fs) => fs.mkdir(path.dirname(file), { recursive: true }));
  try {
    if (process.platform === 'darwin') {
      await execFileAsync('screencapture', ['-x', '-t', 'jpg', file], { timeout: 15_000, windowsHide: true });
    } else if (process.platform === 'win32') {
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        'Add-Type -AssemblyName System.Drawing;',
        '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;',
        `$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;`,
        '$g=[System.Drawing.Graphics]::FromImage($bmp);',
        '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);',
        `$bmp.Save('${file.replace(/'/g, "''")}');`,
      ].join(' ');
      await execFileAsync('powershell', ['-NoProfile', '-Command', ps], { timeout: 20_000, windowsHide: true });
    } else {
      try {
        await execFileAsync('import', ['-window', 'root', file], { timeout: 15_000, windowsHide: true });
      } catch {
        await execFileAsync('gnome-screenshot', ['-f', file], { timeout: 15_000, windowsHide: true });
      }
    }
  } catch (err) {
    throw new Error(`截图失败：${err instanceof Error ? err.message : String(err)}（macOS 需授权 Screen Recording）`);
  }
  return file;
}

/** 已探测到的 CLI 路径（模块级缓存，避免每次调用都探测）。 */
let resolvedBin: string | null = null;

/** 项目内 node_modules/.bin 候选（npm install 随包安装 open-computer-use，hoist 到根）。 */
function localBinCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const roots = new Set<string>([process.cwd(), path.resolve(here, '../../../..')]);
  const out: string[] = [];
  for (const root of roots) {
    out.push(path.join(root, 'node_modules/.bin/open-computer-use'));
    out.push(path.join(root, 'node_modules/.bin/ocu'));
  }
  return out;
}

async function resolveOcu(): Promise<string> {
  if (resolvedBin) return resolvedBin;
  const candidates: string[] = [];
  if (process.env.OCU_BIN) candidates.push(process.env.OCU_BIN);
  candidates.push(...localBinCandidates());
  candidates.push('ocu', 'open-computer-use');
  for (const c of candidates) {
    try {
      await execFileAsync(c, ['-h'], { timeout: 8_000, windowsHide: true });
      resolvedBin = c;
      return c;
    } catch {
      // 尝试下一个候选
    }
  }
  throw new Error(
    'Open Computer Use 未安装：请先 `npm i -g open-computer-use`，或确认本包已通过 npm install 安装（node_modules/.bin/open-computer-use）；macOS 需 14+ 并授权 Accessibility 与 Screen Recording；也可用 OCU_BIN 环境变量指定可执行路径',
  );
}

export interface ComputerUseToolOptions {
  /** 覆盖 CLI 路径（默认探测 OCU_BIN → ocu → open-computer-use）。 */
  cliPath?: string;
  /**
   * 内嵌浏览器桥接：computer_use 的网页类 action（open_url / page_click / page_type /
   * page_key / page_scroll）转调 browser 工具（headless + 应用内浮窗实时显示），
   * 而不是打开外部 Chrome。不注入则这些 action 报"未启用内嵌浏览器"。
   */
  embeddedBrowser?: {
    open: (url: string) => Promise<unknown>;
    input: (input: {
      type: 'click' | 'scroll' | 'type' | 'key' | 'drag';
      x?: number;
      y?: number;
      x2?: number;
      y2?: number;
      dx?: number;
      dy?: number;
      text?: string;
    }) => Promise<{ ok: boolean; error?: string }>;
    /** OCU 风格：返回内嵌页面无障碍树（element_index = observe id）。maxTreeNodes 截断元素数。 */
    observe?: (opts?: { maxTreeNodes?: number; maxTreeDepth?: number }) => Promise<{ url: string; title: string; elements: unknown[] } | null>;
    /** 定向查询：按 CSS selector 返回匹配元素（轻量，不加载全量无障碍树）。 */
    find?: (selector: string, limit?: number) => Promise<Array<Record<string, unknown>>>;
    /** 定向点击：按 selector + index 点击匹配元素，自动处理 target=_blank（同标签导航）。 */
    clickSelector?: (selector: string, index: number) => Promise<{ ok: boolean; error?: string }>;
    /** OCU 风格：按 element_index 对页面元素 click / type / fill。 */
    elementAction?: (
      op: 'click' | 'type' | 'fill',
      id: string,
      text?: string,
    ) => Promise<{ ok: boolean; error?: string }>;
  };
}

/** 内嵌浏览器作为"OCU 特殊应用"的名字：get_app_state/click/type_text/scroll 的 app 传它。 */
export const EMBEDDED_APP = '__embedded__';

/** 各 action 必填参数（缺参时给出友好提示，避免模型拿着 CLI 英文报错反复试错）。 */
const REQUIRED_ARGS: Record<string, string[]> = {
  list_apps: [],
  get_app_state: ['app'],
  screenshot: [],
  click: ['app'],
  perform_secondary_action: ['app', 'element_index'],
  scroll: ['app', 'direction'],
  drag: ['app'],
  type_text: ['app', 'text'],
  press_key: ['app', 'key'],
  set_value: ['app', 'element_index', 'value'],
  // 内嵌浏览器（网页分支）：转调 browser 工具，页面在应用内浮窗显示
  open_url: ['url'],
  page_click: [],
  page_scroll: ['dx', 'dy'],
  page_type: ['text'],
  page_key: ['key'],
  page_find: ['selector'],
};

/** 内嵌浏览器 action 集合。 */
const EMBEDDED_ACTIONS = new Set(['open_url', 'page_click', 'page_scroll', 'page_type', 'page_key', 'page_find']);

/** 从 coding 服务 ToolResult 提取文本。 */
function resultText(res: unknown): string {
  const p = res as { content?: Array<{ type?: string; text?: string }> } | undefined;
  const content = Array.isArray(p?.content) ? p.content : [];
  const text = content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  return text || JSON.stringify(res ?? {}).slice(0, 400);
}

export function computerUseTool(options: ComputerUseToolOptions = {}): AgentTool {
  return {
    def: toolDef('computer_use', 'Desktop GUI control (macOS/Linux/Windows) + 内嵌浏览器网页操作。桌面分支：AUTO-USE whenever the task needs to open/switch/operate a desktop app, click UI elements, type into non-browser windows, scroll/drag, or inspect desktop state — do not wait for explicit user instruction; prefer this over shell coordinate guessing. Actions: list_apps / get_app_state / screenshot / click / perform_secondary_action / scroll / drag / type_text / press_key / set_value / doctor. 内嵌浏览器分支（app 传 __embedded__，页面显示在应用内浮窗，不打开外部 Chrome）：open_url 打开 URL；get_app_state 返回页面无障碍树（元素带 element_index）；click/type_text 用 element_index 操作页面元素；scroll 滚动页面。另支持网页快捷 action：open_url / page_click / page_scroll / page_type / page_key。screenshot 截取当前屏幕并返回路径（agent 会自动把截图作为图像消息回传，视觉模型可直接看到屏幕；视觉/绘图/UI 任务先截图观察，再操作，操作后再截图验证）。画布类应用（无边记 Freeform、画板、绘图/设计软件、CAD、Photoshop）：无障碍树基本为空，get_app_state 只返回菜单/工具栏外壳，画布内容不可见——必须 screenshot 看屏幕后用截图像素坐标 click/drag 操作，不要用 osascript 反复枚举菜单。', {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description:
            '要执行的 Computer Use 动作：桌面：list_apps（列出应用）/ get_app_state（读 UI 树，元素带 element_index）/ click / perform_secondary_action（右键）/ scroll / drag / type_text / press_key / set_value / doctor（检查安装与权限）；' +
            '网页（内嵌浏览器，浮窗显示，不打开外部 Chrome）：open_url（打开 URL）/ page_find（按 CSS selector 定向查元素，返回 text/href/target，轻量不加载全量树）/ page_click（selector+index 定向点击，或 x/y 坐标）/ page_scroll（dx,dy）/ page_type（text）/ page_key（key）',
        },
        args: {
          type: 'object',
          description:
            '按 action 传对应字段：list_apps 无参数；get_app_state: {app}（可选 max_tree_nodes/max_tree_depth/text_limit 控制输出；' +
            'app=__embedded__ 时返回内嵌浏览器页面的无障碍树，元素带 element_index）；' +
            'click: {app, element_index}（优先）或 {app, x, y} 像素坐标；perform_secondary_action: {app, element_index}；' +
            'scroll: {app, direction: up|down|left|right}；drag: {app, x1, y1, x2, y2}（起点→终点像素坐标）；' +
            'type_text: {app, text}（app=__embedded__ 时另传 element_index 定位输入框）；' +
            'press_key: {app, key}；' +
            'set_value: {app, element_index, value}（三者必填）。element_index 必须来自最近一次 get_app_state 的 UI 树（含 __embedded__）；' +
            'x/y 坐标必须是最近一次 screenshot 返回截图图片的像素坐标（在截图上看准目标位置再换算，禁止凭空猜、禁止用 0-1000 归一化）。',
        },
        calls: {
          type: 'array',
          description: '多步序列：[{tool,args},...]，同一进程内复用 element_index 映射（推荐连续操作）',
          items: { type: 'object' },
        },
      },
      required: ['action'],
    }),
    guidelines: [
      '自动触发：任务需要桌面应用操作/UI 元素点击/非浏览器窗口输入/滚动拖拽/桌面状态检查时直接调用，无需用户指示；优先于 shell 猜坐标模拟',
      '网页路由：浏览网页/打开 URL/读取网页内容 → 用内嵌浏览器（app=__embedded__ 走 get_app_state/click/type_text/scroll 的 OCU 风格流程，或 open_url/page_* 快捷 action）——页面显示在应用内嵌浮窗，不会打开外部 Chrome；桌面分支的 click/type 等仅用于非浏览器应用窗口。流程与桌面一致：open_url 打开 → get_app_state app=__embedded__ 拿页面 UI 树（element_index）→ click/type_text 用 element_index 精确操作',
      '轻量优先：找特定元素（链接/按钮/输入框）时用 page_find（CSS selector 定向查询，返回前 20 个匹配的 text/href/target），再 page_click(selector,index) 点击——不要对大页面 get_app_state 全量无障碍树（数千节点，浪费资源）；确需整体布局时 get_app_state 并传 max_tree_nodes 小值（如 50-100）',
      '窗口礼仪：操作目标应用/窗口时保持其原有尺寸与位置，不要缩放、最大化或全屏窗口（除非用户明确要求），避免打扰用户当前工作',
      '前置：macOS 需 14+；首次用前先跑 action=doctor 检查权限，缺失时请用户授权 Accessibility 与 Screen Recording',
      '操作流程：先 list_apps 看可用应用 → get_app_state 拿当前 UI 树 → 用元素上的 element_index 做 click/type_text 等精确操作',
      '画布类应用（无边记 Freeform/画板/绘图软件）：UI 树不含画布内容，先 screenshot 观察屏幕与工具栏，再用截图像素坐标 click/drag；Freeform 手绘走「插入 > 绘制」或工具栏画笔按钮后按坐标拖拽，颜色在绘制前选好，画完截图验证',
      'element_index 必须来自最近一次 get_app_state，跨调用或 UI 变化后重新 get_app_state，禁止猜测',
      'get_app_state 输出过大时传 max_tree_nodes / max_tree_depth 或 text_limit 收窄；连续多步用 calls 序列复用索引',
      '不检查密码管理器等敏感内容；发送/删除/购买等外部可见操作前先询问用户',
    ],
    handler: async (rawArgs): Promise<ToolCallResult> => {
      const { action, args, calls } = (rawArgs ?? {}) as {
        action?: string;
        args?: Record<string, unknown>;
        calls?: Array<{ tool: string; args?: Record<string, unknown> }>;
      };
      if (!action || !action.trim()) {
        return {
          result:
            'computer_use: missing `action`（list_apps/get_app_state/screenshot/click/perform_secondary_action/scroll/drag/type_text/press_key/set_value/doctor；网页类：open_url/page_click/page_scroll/page_type/page_key）',
          is_error: true,
        };
      }
      // 内嵌浏览器（网页分支）：open_url / page_* 转调 browser 工具，
      // 页面在应用内浮窗实时显示、交互转发回同一页面实例——不再打开外部 Chrome。
      if (EMBEDDED_ACTIONS.has(action)) {
        const eb = options.embeddedBrowser;
        if (!eb) {
          return {
            result: `computer_use(${action}) 失败：内嵌浏览器未启用（embeddedBrowser 未注入）。网页操作请直接用 browser 工具（页面会自动显示在应用内浮窗）。`,
            is_error: true,
          };
        }
        const argObj = (args ?? {}) as Record<string, unknown>;
        try {
          if (action === 'open_url') {
            const res = await eb.open(String(argObj.url));
            return { result: resultText(res), is_error: false };
          }
          if (action === 'page_find') {
            if (!eb.find) return { result: 'page_find 失败：内嵌浏览器未启用定向查询', is_error: true };
            const list = await eb.find(String(argObj.selector), typeof argObj.limit === 'number' ? Number(argObj.limit) : 20);
            if (!list || list.length === 0) {
              return { result: `page_find("${argObj.selector}") 无匹配元素`, is_error: false };
            }
            return { result: JSON.stringify(list, null, 2).slice(0, MAX_OUTPUT), is_error: false };
          }
          if (action === 'page_click') {
            // 定向点击：selector + index（配合 page_find 使用，无需加载全量树）
            if (typeof argObj.selector === 'string' && eb.clickSelector) {
              const r = await eb.clickSelector(argObj.selector, typeof argObj.index === 'number' ? Number(argObj.index) : 0);
              return r.ok
                ? { result: `page_click(${argObj.selector}[${argObj.index ?? 0}]) 已发送`, is_error: false }
                : { result: `page_click 失败: ${r.error ?? ''}`, is_error: true };
            }
            // 坐标点击
            if (argObj.x !== undefined && argObj.y !== undefined) {
              const r = await eb.input({ type: 'click', x: Number(argObj.x), y: Number(argObj.y) });
              return r.ok
                ? { result: `page_click(${argObj.x},${argObj.y}) 已发送`, is_error: false }
                : { result: `page_click 失败: ${r.error ?? ''}`, is_error: true };
            }
            return { result: 'page_click 需要 selector+index（定向点击）或 x/y（坐标点击）', is_error: true };
          }
          if (action === 'page_scroll') {
            const r = await eb.input({ type: 'scroll', dx: Number(argObj.dx), dy: Number(argObj.dy) });
            return r.ok
              ? { result: `page_scroll(${argObj.dx},${argObj.dy}) 已发送`, is_error: false }
              : { result: `page_scroll 失败: ${r.error ?? ''}`, is_error: true };
          }
          if (action === 'page_type') {
            const r = await eb.input({ type: 'type', text: String(argObj.text ?? '') });
            return r.ok
              ? { result: 'page_type 已发送', is_error: false }
              : { result: `page_type 失败: ${r.error ?? ''}`, is_error: true };
          }
          if (action === 'page_key') {
            const r = await eb.input({ type: 'key', text: String(argObj.key ?? 'Enter') });
            return r.ok
              ? { result: `page_key(${argObj.key}) 已发送`, is_error: false }
              : { result: `page_key 失败: ${r.error ?? ''}`, is_error: true };
          }
        } catch (err) {
          return { result: `computer_use(${action}) 执行失败: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
        }
      }
      // OCU 风格操作内嵌浏览器：app='__embedded__' 时 get_app_state / click / type_text / scroll
      // 映射到内嵌页面（无障碍树 + element_index → CDP），而不是打开/操作外部 Chrome。
      const appName = typeof (args as { app?: unknown } | undefined)?.app === 'string' ? ((args as { app: string }).app) : '';
      if (appName === EMBEDDED_APP) {
        const eb = options.embeddedBrowser;
        if (!eb) {
          return {
            result: `computer_use(${action}, app=${EMBEDDED_APP}) 失败：内嵌浏览器未启用。请先 open_url 打开页面，或直接用 browser 工具。`,
            is_error: true,
          };
        }
        try {
          if (action === 'get_app_state') {
            const a = (args ?? {}) as { max_tree_nodes?: unknown; max_tree_depth?: unknown };
            const tree = eb.observe
              ? await eb.observe({
                  maxTreeNodes: typeof a.max_tree_nodes === 'number' ? a.max_tree_nodes : undefined,
                  maxTreeDepth: typeof a.max_tree_depth === 'number' ? a.max_tree_depth : undefined,
                })
              : null;
            if (!tree) {
              return { result: '内嵌浏览器无标签页：先用 computer_use open_url <url> 打开页面', is_error: true };
            }
            // OCU 风格：elements 里带 element_index（= observe 的 id，number），供后续 click/type_text 复用
            const mapped = (tree.elements as Array<Record<string, unknown>>).map((el, i) => ({
              element_index: el.id !== undefined && el.id !== null ? String(el.id) : String(i),
              role: el.role ?? '',
              name: el.name ?? '',
              value: el.value ?? '',
              states: el.states ?? [],
            }));
            const truncated = mapped.length >= 200 ? `\n（树过大，已截断前 ${mapped.length} 个元素；可传 max_tree_nodes 调大，或传 max_tree_depth 收窄深度）` : '';
            return { result: JSON.stringify({ url: tree.url, title: tree.title, elements: mapped }, null, 2).slice(0, MAX_OUTPUT) + truncated, is_error: false };
          }
          if (action === 'click') {
            const a = (args ?? {}) as { element_index?: unknown; x?: unknown; y?: unknown };
            if (typeof a.element_index === 'string' && eb.elementAction) {
              const r = await eb.elementAction('click', a.element_index);
              return r.ok
                ? { result: `click(${a.element_index}) 已发送`, is_error: false }
                : { result: `click 失败: ${r.error ?? ''}`, is_error: true };
            }
            if (a.x !== undefined && a.y !== undefined) {
              const r = await eb.input({ type: 'click', x: Number(a.x), y: Number(a.y) });
              return r.ok
                ? { result: `click(${a.x},${a.y}) 已发送`, is_error: false }
                : { result: `click 失败: ${r.error ?? ''}`, is_error: true };
            }
            return { result: `click(app=${EMBEDDED_APP}) 需要 element_index（来自 get_app_state）或 x/y 页面坐标`, is_error: true };
          }
          if (action === 'type_text') {
            const a = (args ?? {}) as { element_index?: unknown; text?: unknown };
            if (typeof a.element_index === 'string' && eb.elementAction) {
              const r = await eb.elementAction('type', a.element_index, String(a.text ?? ''));
              return r.ok
                ? { result: `type_text 已发送到 ${a.element_index}`, is_error: false }
                : { result: `type_text 失败: ${r.error ?? ''}`, is_error: true };
            }
            const r = await eb.input({ type: 'type', text: String(a.text ?? '') });
            return r.ok
              ? { result: 'type_text 已发送', is_error: false }
              : { result: `type_text 失败: ${r.error ?? ''}`, is_error: true };
          }
          if (action === 'scroll') {
            const a = (args ?? {}) as { direction?: string };
            const dir = String(a.direction ?? 'down');
            const dy = dir === 'up' ? -300 : dir === 'down' ? 300 : 0;
            const dx = dir === 'left' ? -300 : dir === 'right' ? 300 : 0;
            const r = await eb.input({ type: 'scroll', dx, dy });
            return r.ok
              ? { result: `scroll(${dir}) 已发送`, is_error: false }
              : { result: `scroll 失败: ${r.error ?? ''}`, is_error: true };
          }
          return {
            result: `computer_use(${action}) 不支持 app=${EMBEDDED_APP}；内嵌浏览器支持：get_app_state / click / type_text / scroll / open_url / page_click / page_scroll / page_type / page_key`,
            is_error: true,
          };
        } catch (err) {
          return { result: `computer_use(${action}, app=${EMBEDDED_APP}) 执行失败: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
        }
      }
      // 必填参数校验：缺参直接给出可操作的补参提示，比 CLI 英文报错对模型更友好
      const required = REQUIRED_ARGS[action];
      if (required) {
        const argObj = (args ?? {}) as Record<string, unknown>;
        const missing = required.filter((k) => argObj[k] === undefined || argObj[k] === null || argObj[k] === '');
        if (missing.length > 0) {
          return {
            result:
              `computer_use(${action}) 缺少必填参数: ${missing.join(', ')}。` +
              '补参提示：app 用 list_apps 返回的应用名；element_index 必须来自最近一次 get_app_state 的 UI 树；' +
              (action === 'set_value' ? 'value 是要设置到元素的值。' : '') +
              (action === 'type_text' ? 'text 是要输入的完整文本。' : '') +
              (action === 'press_key' ? 'key 是按键名（如 enter/tab/escape/command+w）。' : '') +
              (action === 'scroll' ? 'direction 是滚动方向 up/down/left/right。' : '') +
              ' 请补齐后重试。',
            is_error: true,
          };
        }
      }
      // screenshot 不走 OCU：直接系统截屏（OCU 无截图命令）
      if (action === 'screenshot') {
        try {
          const file = await takeScreenshot(typeof args?.target === 'string' ? (args.target as string) : undefined);
          return { result: `screenshot saved: ${file}`, is_error: false };
        } catch (err) {
          return { result: err instanceof Error ? err.message : String(err), is_error: true };
        }
      }
      let bin: string;
      try {
        bin = options.cliPath ?? (await resolveOcu());
      } catch (err) {
        return { result: err instanceof Error ? err.message : String(err), is_error: true };
      }
      // doctor 是顶级命令（ocu doctor），其余动作走 call 通道
      const argv = action === 'doctor' ? ['doctor'] : ['call'];
      if (action !== 'doctor') {
        if (Array.isArray(calls) && calls.length > 0) {
          argv.push('--calls', JSON.stringify(calls));
        } else {
          argv.push(action);
          if (args && typeof args === 'object' && Object.keys(args).length > 0) {
            argv.push('--args', JSON.stringify(args));
          }
        }
      }
      try {
        const { stdout } = await execFileAsync(bin, argv, {
          timeout: CALL_TIMEOUT_MS,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        });
        const out = stdout.trim();
        if (!out) return { result: `computer_use(${action}): 无输出`, is_error: false };
        let result = out;
        try {
          result = JSON.stringify(JSON.parse(out) as unknown, null, 2);
        } catch {
          // 非 JSON（诊断/日志）则原文返回
        }
        if (result.length > MAX_OUTPUT) {
          result = result.slice(0, MAX_OUTPUT) + '\n…（输出过长已截断；请用更小 max_tree_nodes/max_tree_depth 或分步操作）';
        }
        return { result, is_error: false };
      } catch (err) {
        const e = err as { stderr?: string; stdout?: string; message?: string };
        // doctor 权限缺失等场景退出码非 0 但 stderr 含诊断信息——优先透传内容
        const detail = (e.stderr ?? '').trim() || (e.stdout ?? '').trim() || e.message || String(err);
        return { result: `computer_use(${action}) 执行失败: ${detail}`, is_error: true };
      }
    },
  };
}
