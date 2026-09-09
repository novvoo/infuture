/**
 * computer_use 工具 — 桌面 GUI 控制（macOS / Linux / Windows）。
 * 经 Open Computer Use CLI（open-computer-use / ocu）直调，返回 MCP 风格 JSON。
 * 前置：`npm i -g open-computer-use`；macOS 14+ 首次运行需授权 Accessibility 与 Screen Recording。
 * 对应 Rust `tools::computer_use`（桌面自动化能力，与 browser 并列的外部系统控制）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentTool, ToolCallResult } from '@infuture/types';
import { toolDef } from '@infuture/types';

const execFileAsync = promisify(execFile);
/** 单次返回保护上限：UI 树可能很大，超限截断并提示收窄（max_tree_nodes/max_tree_depth/text_limit）。 */
const MAX_OUTPUT = 50_000;
const CALL_TIMEOUT_MS = 120_000;

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
}

/** 各 action 必填参数（缺参时给出友好提示，避免模型拿着 CLI 英文报错反复试错）。 */
const REQUIRED_ARGS: Record<string, string[]> = {
  list_apps: [],
  get_app_state: ['app'],
  click: ['app'],
  perform_secondary_action: ['app', 'element_index'],
  scroll: ['app', 'direction'],
  drag: ['app'],
  type_text: ['app', 'text'],
  press_key: ['app', 'key'],
  set_value: ['app', 'element_index', 'value'],
};

export function computerUseTool(options: ComputerUseToolOptions = {}): AgentTool {
  return {
    def: toolDef('computer_use', 'Desktop GUI control (macOS/Linux/Windows). AUTO-USE whenever the task needs to open/switch/operate a desktop app, click UI elements, type into non-browser windows, scroll/drag, or inspect desktop state — do not wait for explicit user instruction; prefer this over shell coordinate guessing. Actions: list_apps / get_app_state / click / perform_secondary_action / scroll / drag / type_text / press_key / set_value / doctor.', {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description:
            '要执行的 Computer Use 动作：list_apps（列出应用）/ get_app_state（读 UI 树，元素带 element_index）/ click / perform_secondary_action（右键）/ scroll / drag / type_text / press_key / set_value / doctor（检查安装与权限）',
        },
        args: {
          type: 'object',
          description:
            '按 action 传对应字段：list_apps 无参数；get_app_state: {app}（可选 max_tree_nodes/max_tree_depth/text_limit 控制输出）；' +
            'click: {app, element_index}（或用 {app, x, y} 坐标）；perform_secondary_action: {app, element_index}；' +
            'scroll: {app, direction: up|down|left|right}；drag: {app, 起点终点元素或坐标}；' +
            'type_text: {app, text}；press_key: {app, key}；' +
            'set_value: {app, element_index, value}（三者必填）。element_index 必须来自最近一次 get_app_state 的 UI 树。',
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
      '窗口礼仪：操作目标应用/窗口时保持其原有尺寸与位置，不要缩放、最大化或全屏窗口（除非用户明确要求），避免打扰用户当前工作',
      '前置：macOS 需 14+；首次用前先跑 action=doctor 检查权限，缺失时请用户授权 Accessibility 与 Screen Recording',
      '操作流程：先 list_apps 看可用应用 → get_app_state 拿当前 UI 树 → 用元素上的 element_index 做 click/type_text 等精确操作',
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
          result: 'computer_use: missing `action`（list_apps/get_app_state/click/perform_secondary_action/scroll/drag/type_text/press_key/set_value/doctor）',
          is_error: true,
        };
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
