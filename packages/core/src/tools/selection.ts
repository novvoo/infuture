/**
 * ToolSelection — 按会话上下文动态裁剪暴露给模型的工具集。
 *
 * 动机：infuture 原先每轮把全部 71 个工具（lsp、dap、github 等重型 schema，
 * 共 ~38KB / ~9.5k tokens）一次性发给模型，导致 prompt 膨胀、模型注意力被稀释，
 * 复杂任务（如"启动多个 worker"）下推理模型进入无限推理、永不发出工具调用。
 *
 * 策略（对齐 future-os 的 lean tool set + 动态扩展）：
 *  - 核心工具恒在：read/write/edit/list/shell/grep/glob/code_edit/inspect_image + spawn_workers/list_workers；
 *  - 联网工具（web_search/web_fetch）恒在，browser 按语境按需；
 *  - 重型编程工具（lsp_*、dap_*、github_*、execute_code、bash、ast_*、subagent、review、git_pr）
 *    仅在上下文出现对应关键词或模型点名时暴露；
 *  - 模型在上下文中点名的工具（工具名出现即自动加入）形成天然"按需加载"。
 */
import type { AgentTool, ToolDef } from '@infuture/types';

/** 核心工具：任何会话都暴露（轻量、高频，含多 worker 协作）。 */
const CORE_TOOLS = new Set([
  'read',
  'write',
  'edit',
  'list',
  'shell',
  'grep',
  'glob',
  'code_edit',
  'inspect_image',
  'spawn_workers',
  'list_workers',
]);

/** 联网工具：默认暴露（web_search / web_fetch）。 */
const WEB_TOOLS = new Set(['web_search', 'web_fetch']);

/** 按前缀分类的重型工具组（lsp_* / dap_* / github_*）。 */
function groupOfName(name: string): string | undefined {
  if (name.startsWith('lsp_')) return 'lsp';
  if (name.startsWith('dap_')) return 'dap';
  if (name.startsWith('github_')) return 'github';
  return undefined;
}

/** 需要按关键词触发的工具名（非前缀类）。 */
const CONDITIONAL_BY_NAME = new Set([
  'browser',
  'execute_code',
  'bash',
  'ast_grep',
  'ast_edit',
  'subagent',
  'review',
  'git_pr',
]);

/** 工具组 → 触发关键词（大小写不敏感，命中任一即启用整组）。 */
const GROUP_RULES: Array<{ group: string; re: RegExp }> = [
  {
    group: 'coding',
    re: /(写代码|实现|编程|脚本|运行代码|执行|python|javascript|typescript|rust|go语言|java|c\+\+|测试|单元测试|构建|编译|命令行|终端|bash|重构|代码审查|审查|子任务|subagent|并行|git|计算|验证|模拟|跑一下|运行一下)/i,
  },
  {
    group: 'lsp',
    re: /(代码|重构|重命名|符号|跳转|引用|定义|诊断|语法错误|补全|hover|lsp|类型检查|编译错误|definition|reference|rename|symbols|diagnostic|autocomplete|goto\s+definition|find\s+references)/i,
  },
  {
    group: 'dap',
    re: /(调试|断点|单步|变量查看|堆栈|崩溃|异常|debug|breakpoint|step\s*(in|over|out)|variable|stack|crash|attach|launch|lldb|gdb|dlv|debugpy)/i,
  },
  {
    group: 'github',
    re: /(github|git\s?hub|pull\s+request|\bpr\b|issue|代码搜索|仓库|推送|提交记录|创建\s*PR|检查\s*PR)/i,
  },
  {
    group: 'browser',
    re: /(打开网页|浏览网页|网页|网站|上网|浏览器|browse|open\s+url|访问.*网站)/i,
  },
];

/** 哪些名字属于 coding 组（供 forceGroups / 匹配后归类）。 */
const CODING_GROUP_NAMES = new Set([
  'execute_code',
  'bash',
  'ast_grep',
  'ast_edit',
  'subagent',
  'review',
  'git_pr',
]);

export interface ToolSelectionOptions {
  /** 强制启用的工具组名：'coding' | 'lsp' | 'dap' | 'github' | 'browser'。 */
  forceGroups?: string[];
  /** 额外恒包含的工具名。 */
  always?: string[];
  /** 白名单覆盖：仅暴露这些工具（与注册表取交集）。用于"委派优先"强制模型只能起 worker。 */
  only?: string[];
}

export interface ToolSelectionResult {
  defs: ToolDef[];
  /** 命中的分组，便于排查。 */
  enabledGroups: string[];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从注册表中选择本轮暴露给模型的工具定义。
 * @param tools 全部注册工具（AgentTool[]）
 * @param contextText 会话上下文（用户文本 + assistant 文本/推理 + 已调用工具名）
 */
export function selectToolDefs(tools: AgentTool[], contextText: string, opts: ToolSelectionOptions = {}): ToolSelectionResult {
  // 白名单覆盖：仅暴露指定工具（与注册表取交集），用于"委派优先"强制模型只能起 worker
  if (opts.only && opts.only.length > 0) {
    const onlySet = new Set(opts.only);
    const defs = tools.filter((t) => onlySet.has(t.def.function.name)).map((t) => t.def);
    return { defs, enabledGroups: [] };
  }

  // 核心 + 联网工具恒在；重型工具按语境/点名按需加入
  const enabled = new Set<string>([...CORE_TOOLS, ...WEB_TOOLS]);
  const enabledGroups = new Set<string>([]);
  const forced = opts.forceGroups ?? [];
  const always = opts.always ?? [];
  for (const n of always) enabled.add(n);
  for (const g of forced) {
    enabledGroups.add(g);
    if (g === 'browser') enabled.add('browser');
    if (g === 'coding') for (const n of CODING_GROUP_NAMES) enabled.add(n);
  }

  // 关键词匹配（命中即启用对应组）
  const lower = contextText.toLowerCase();
  for (const rule of GROUP_RULES) {
    if (rule.re.test(lower)) enabledGroups.add(rule.group);
  }

  // 按工具名归类补齐
  for (const t of tools) {
    const name = t.def.function.name;
    if (enabled.has(name)) continue;
    const prefixGroup = groupOfName(name);
    const mentioned = lower.includes(name.toLowerCase());
    if (prefixGroup) {
      if (enabledGroups.has(prefixGroup) || mentioned) enabled.add(name);
    } else if (CONDITIONAL_BY_NAME.has(name)) {
      if (enabledGroups.has('coding') || mentioned) enabled.add(name);
    }
  }

  const defs = tools.filter((t) => enabled.has(t.def.function.name)).map((t) => t.def);
  return { defs, enabledGroups: [...enabledGroups] };
}

/** 构建用于工具选择的会话上下文文本（用户文本 + assistant 文本/推理 + 已调用工具名）。 */
export function buildSelectionContext(
  history: Array<{ role: string; content: Array<{ type?: string; text?: string; name?: string }> }>,
): string {
  const parts: string[] = [];
  for (const m of history) {
    for (const b of m.content ?? []) {
      const type = (b as { type?: string }).type;
      if (type === 'text') parts.push(String((b as { text?: string }).text ?? ''));
      else if (type === 'reasoning') parts.push(String((b as { text?: string }).text ?? ''));
      else if (type === 'tool_call') parts.push(String((b as { name?: string }).name ?? ''));
    }
  }
  return parts.join('\n');
}

/**
 * 检测用户是否明确要求多 worker/子 agent 协作（委派意图）。
 * 命中时进入"委派优先"模式：第一轮只暴露 spawn_workers/list_workers，强制模型起 worker 而非自己解题。
 * 要求出现动作词（启动/开启/创建/让/派…）或角色拆分（解题/反思/审查/协作/并行），
 * 避免"解释 worker 是什么"这类纯提问误触发。
 */
const WORKER_INTENT_RE =
  /\/worker|spawn\s*_?\s*workers?|(启动|开启|创建|让|派|起|跑|拆成).{0,12}(worker|子\s?agent|子\s?代理|并行|协作)|worker.{0,12}(反思|审查|协作|并行|子任务|再|重新|解题|解答|探索|分析|角色)|(多个|三个|两个|四个|若干|\d+\s*个).{0,6}(worker|子\s?agent|子\s?代理)/i;
export function detectWorkerIntent(contextText: string): boolean {
  return WORKER_INTENT_RE.test(contextText);
}

/** 任务类型：决定执行路由（工具暴露 + 推理策略）。worker 为委派优先（强制 spawn），coding/web 走对应工具组，general 走核心工具。 */
export type TaskType = 'worker' | 'coding' | 'web' | 'general';

/** 编程任务关键词（与 GROUP_RULES 的 coding 组一致）。 */
const CODING_TYPE_RE =
  /(写代码|实现|编程|脚本|运行代码|执行|python|javascript|typescript|rust|go语言|java|c\+\+|测试|单元测试|构建|编译|命令行|终端|bash|重构|代码审查|审查|子任务|subagent|git|调试|断点|debug|compute|验证|模拟|跑一下|运行一下)/i;
/** 联网/检索任务关键词。 */
const WEB_TYPE_RE = /(搜索|查一下|找一下|查找|上网|网页|网站|浏览器|browse|打开.*网页|最新消息|新闻|资讯|行情|天气)/i;

/** 识别命令的任务类型。worker 优先（命中即委派优先），其次编程，其次联网，兜底通用。 */
export function classifyTaskType(contextText: string): TaskType {
  if (detectWorkerIntent(contextText)) return 'worker';
  if (CODING_TYPE_RE.test(contextText)) return 'coding';
  if (WEB_TYPE_RE.test(contextText)) return 'web';
  return 'general';
}
