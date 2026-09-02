import React, { useMemo, useRef, useState } from 'react';
import { useAppApi, useAppState } from '../state';
import { ModelMenu } from './ModelMenu';
import { ThinkingMenu } from './ThinkingMenu';

/**
 * 斜杠指令 —— 全部绑定到「真实工具」直调（后端 tool.invoke 直接执行注册工具，不经模型）：
 *  - tool：解析参数后直接调用绑定工具，结果写入会话历史；
 *  - worker：经 loop 控制平面真实启动并行 worker；
 *  - goto：切换视图。
 * 精选命令（下面 CURATED_COMMANDS）提供友好别名与专用解析；其余全部**从注册工具库动态生成**
 * （tools.list 返回 69 个工具，每个自动成为 `/工具名` 指令，参数按 JSON Schema 解析）。
 */
type SlashCommand =
  | { key: string; label: string; hint: string; kind: 'tool'; tool: string; usage: string; parse: (rest: string) => Record<string, unknown> | null }
  | { key: string; label: string; hint: string; kind: 'worker' }
  | { key: string; label: string; hint: string; kind: 'goto' };

const CURATED_COMMANDS: SlashCommand[] = [
  {
    key: '/search',
    label: '网络搜索',
    hint: 'search <关键词>',
    kind: 'tool',
    tool: 'web_search',
    usage: '/search <关键词>',
    parse: (rest) => (rest.trim() ? { query: rest.trim() } : null),
  },
  {
    key: '/files',
    label: '文件内容检索',
    hint: 'files <正则> [路径]',
    kind: 'tool',
    tool: 'grep',
    usage: '/files <正则> [路径]',
    parse: (rest) => {
      const m = rest.trim().split(/\s+/);
      if (!m[0]) return null;
      const args: Record<string, unknown> = { pattern: m[0] };
      if (m[1]) args.path = m.slice(1).join(' ');
      return args;
    },
  },
  {
    key: '/glob',
    label: '按文件名查找',
    hint: 'glob <模式>',
    kind: 'tool',
    tool: 'glob',
    usage: '/glob <glob 模式>',
    parse: (rest) => (rest.trim() ? { pattern: rest.trim() } : null),
  },
  {
    key: '/image',
    label: '图片理解',
    hint: 'image <路径> [问题]',
    kind: 'tool',
    tool: 'inspect_image',
    usage: '/image <图片路径> [问题]',
    parse: (rest) => {
      const m = rest.trim().split(/\s+/);
      if (!m[0]) return null;
      const args: Record<string, unknown> = { path: m[0] };
      if (m[1]) args.question = m.slice(1).join(' ');
      return args;
    },
  },
  {
    key: '/browser',
    label: '浏览器打开网页',
    hint: 'browser <url>',
    kind: 'tool',
    tool: 'browser',
    usage: '/browser <url>',
    parse: (rest) => (rest.trim() ? { action: 'open', url: rest.trim() } : null),
  },
  {
    key: '/git',
    label: 'GitHub PR / 搜索',
    hint: 'git <pr|code|issues|prs|commits|repos> …',
    kind: 'tool',
    tool: 'git_pr',
    usage: '/git pr <repo> <PR号> | /git code <repo> <查询> | /git issues <repo> <查询> | /git repos <查询>',
    parse: (rest) => {
      const m = rest.trim().split(/\s+/);
      if (m[0] !== 'pr' || m.length < 3) return null;
      const pr = Number(m[2]);
      if (!Number.isFinite(pr)) return null;
      return { repo: m[1], pr };
    },
  },
  {
    key: '/code',
    label: '编程工具直调',
    hint: 'code <diag|sym|refs|def|hover|rename|grep|bash|run> …',
    kind: 'tool',
    tool: 'lsp_diagnostics',
    usage: '/code diag <文件> | sym <查询> | refs <文件> <符号> | def <文件> <符号> | hover <文件> <符号> | rename <文件> <旧名> <新名> | grep <模式> [路径] | bash <命令> | run <代码>',
    parse: (rest) => null, // 由 /code 专属解析器处理（见 parseCodeCommand）
  },
  {
    key: '/review',
    label: '双模型代码审查',
    hint: 'review [范围]',
    kind: 'tool',
    tool: 'review',
    usage: '/review [文件或目录]',
    parse: (rest) => (rest.trim() ? { scope: rest.trim() } : {}),
  },
  {
    key: '/worker',
    label: '并行 worker 探索',
    hint: 'worker [数量] 目标 或 任务1 | 任务2 …（{w1} 引用前序输出）',
    kind: 'worker',
  },
  {
    key: '/goal',
    label: '打开目标 / worker 菜单',
    hint: 'goal',
    kind: 'goto',
  },
  {
    key: '/clear',
    label: '清空当前对话',
    hint: 'clear',
    kind: 'tool',
    tool: '__clear__',
    usage: '/clear',
    parse: () => ({ __clear: true }),
  },
];

/** 按 JSON Schema 的 type 做基础类型强转。 */
function coerce(type: string | undefined, value: string): unknown {
  switch (type) {
    case 'integer':
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? n : value;
    }
    case 'boolean':
      return value === 'true' || value === '1' ? true : value === 'false' || value === '0' ? false : value;
    default:
      return value;
  }
}

/** 从工具参数 schema 解析 `/工具名 参数` 的入参：支持 key=value 显式参数与按 schema 顺序的位置参数。 */
function parseToolArgs(parameters: unknown, rest: string): Record<string, unknown> | null {
  const schema = parameters as {
    type?: string;
    properties?: Record<string, { type?: string }>;
    required?: string[];
  };
  const props = schema?.properties ?? {};
  const keys = Object.keys(props);
  if (keys.length === 0) return rest.trim() ? null : {};
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  const args: Record<string, unknown> = {};
  const positional: string[] = [];
  for (const tok of tokens) {
    const m = tok.match(/^([A-Za-z_][\w-]*)=(.+)$/);
    if (m && props[m[1]]) args[m[1]] = coerce(props[m[1]].type, m[2]);
    else positional.push(tok);
  }
  let i = 0;
  for (let kIdx = 0; kIdx < keys.length; kIdx++) {
    const k = keys[kIdx];
    if (args[k] !== undefined) continue;
    const type = props[k].type;
    if (i >= positional.length) continue;
    if (kIdx === keys.length - 1 && type === 'string') {
      // 最后一个 string 属性吞掉剩余全部位置参数（如 /shell 的 command）
      args[k] = positional.slice(i).join(' ');
      i = positional.length;
      break;
    }
    const tok = positional[i];
    if (type === 'number' || type === 'integer') {
      const n = Number(tok);
      if (!Number.isFinite(n)) continue; // 非数字留给后续属性/参数缺失判断
      args[k] = n;
      i++;
    } else if (type === 'boolean') {
      args[k] = tok === 'true' || tok === '1';
      i++;
    } else {
      args[k] = tok;
      i++;
    }
  }
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const missing = required.filter((k) => args[k] === undefined || args[k] === '');
  if (missing.length > 0) return null;
  return args;
}

function requiredParams(parameters: unknown): string[] {
  const s = parameters as { required?: string[] };
  return Array.isArray(s?.required) ? s.required : [];
}

/**
 * 从注册工具库动态生成 `/工具名` 斜杠命令。
 * 已被精选命令覆盖的工具（如 web_search→/search、glob→/glob）跳过，避免菜单重复。
 */
function toolSlashCommands(tools: Array<{ name: string; description: string; parameters: unknown }>): SlashCommand[] {
  const curatedTools = new Set(
    CURATED_COMMANDS.flatMap((c) => (c.kind === 'tool' && c.tool !== '__clear__' ? [c.tool] : [])),
  );
  const out: SlashCommand[] = [];
  for (const t of tools) {
    if (curatedTools.has(t.name)) continue;
    const required = requiredParams(t.parameters);
    const argHint = required.length ? required.map((r) => `<${r}>`).join(' ') : '';
    out.push({
      key: '/' + t.name,
      label: t.name,
      hint: (t.description ?? '').split(/[。\n]/)[0].slice(0, 40) || t.name,
      kind: 'tool',
      tool: t.name,
      usage: `/${t.name}${argHint ? ' ' + argHint : ''}`,
      parse: (rest) => parseToolArgs(t.parameters, rest),
    });
  }
  return out;
}

/** `/code` 子命令解析：映射到具体 lsp / ast / bash / execute_code 工具。 */
function parseCodeCommand(rest: string): { tool: string; args: Record<string, unknown> } | null {
  const [op, ...restParts] = rest.trim().split(/\s+/);
  const tail = restParts.join(' ').trim();
  const first = tail.split(/\s+/)[0];
  switch (op) {
    case 'diag':
      return first ? { tool: 'lsp_diagnostics', args: { file: first } } : null;
    case 'sym':
      return tail ? { tool: 'lsp_symbols', args: { query: tail } } : null;
    case 'def':
      return first ? { tool: 'lsp_definition', args: { file: first, symbol: tail.split(/\s+/).slice(1).join(' ') } } : null;
    case 'refs':
      return first ? { tool: 'lsp_references', args: { file: first, symbol: tail.split(/\s+/).slice(1).join(' ') } } : null;
    case 'hover':
      return first ? { tool: 'lsp_hover', args: { file: first, symbol: tail.split(/\s+/).slice(1).join(' ') } } : null;
    case 'rename': {
      const [f, oldn, ...nn] = tail.split(/\s+/);
      return f && oldn ? { tool: 'lsp_rename', args: { file: f, symbol: oldn, new_name: nn.join(' ') } } : null;
    }
    case 'grep':
      return tail ? { tool: 'ast_grep', args: { pattern: tail } } : null;
    case 'bash':
      return tail ? { tool: 'bash', args: { command: tail } } : null;
    case 'run':
      return tail ? { tool: 'execute_code', args: { code: tail } } : null;
    default:
      return null;
  }
}

/** `/git` 子命令解析：pr → git_pr；搜索类 → 对应 github_search_* 工具。 */
function parseGitCommand(rest: string): { tool: string; args: Record<string, unknown> } | null {
  const [op, ...restParts] = rest.trim().split(/\s+/);
  const [a, b] = restParts;
  if (op === 'pr') {
    const pr = Number(b);
    if (!a || !Number.isFinite(pr)) return null;
    return { tool: 'git_pr', args: { repo: a, pr } };
  }
  if (op === 'repos') return a ? { tool: 'github_search_repos', args: { query: a } } : null;
  if ((op === 'code' || op === 'issues' || op === 'prs' || op === 'commits') && a) {
    const toolMap: Record<string, string> = {
      code: 'github_search_code',
      issues: 'github_search_issues',
      prs: 'github_search_prs',
      commits: 'github_search_commits',
    };
    return { tool: toolMap[op], args: { repo: a, query: b ?? '' } };
  }
  return null;
}

/** 从命令 key 列表动态构建 `/指令` 识别正则（含工具库全部工具名）。 */
function buildSlashRe(keys: string[]): RegExp {
  const names = keys.map((k) => k.replace(/^\//, '').replace(/[^\w-]/g, '')).filter(Boolean);
  return new RegExp('\\/(' + names.join('|') + ')\\b', 'g');
}

/**
 * 从**任意位置**提取文本中的 `/指令` 段（可多个）：
 *  - 每条指令内容到「下一个 /指令」或「句末标点（。！？；;）」或结尾为止；
 *  - 其余非指令文本作为 rest 返回（会作为普通消息发给 agent，可见工具结果历史）。
 */
function extractCommands(text: string, keys: string[]): { segs: string[]; rest: string } {
  const SLASH_CMD_RE = buildSlashRe(keys);
  const hits: Array<{ start: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = SLASH_CMD_RE.exec(text))) hits.push({ start: m.index });
  if (hits.length === 0) return { segs: [], rest: text.trim() };
  const segs: string[] = [];
  const restParts: string[] = [];
  let cursor = 0;
  for (let i = 0; i < hits.length; i++) {
    const { start } = hits[i];
    if (start > cursor) restParts.push(text.slice(cursor, start));
    const nextStart = i + 1 < hits.length ? hits[i + 1].start : text.length;
    // 指令内容边界：句末标点/逗号；若后面还跟着 /指令，连接词（再/然后/接着/并…）也作边界，
    // 避免 "先 /search A 再 /files B" 把 "再" 吞进上一个查询；单个指令时不切连接词，防止误切 /worker 目标。
    const boundaryRe =
      i + 1 < hits.length ? /[，。！？!?；;,]|再|然后|接着|并且|并|随后/ : /[，。！？!?；;,]/;
    const boundaryIdx = text.slice(start, nextStart).search(boundaryRe);
    const segEnd = boundaryIdx === -1 ? nextStart : start + boundaryIdx;
    const seg = text.slice(start, segEnd).trim();
    if (seg) segs.push(seg);
    cursor = segEnd;
  }
  if (cursor < text.length) restParts.push(text.slice(cursor));
  return { segs, rest: restParts.join('').trim() };
}

const CONNECTIVE_CHARS = new Set([
  '先', '再', '然后', '接着', '并且', '并', '同时', '和', '与', '跟', '帮我', '请', '麻烦',
  '顺便', '最后', '随后', '的', '了', '把', '好', '吧', '我', '你', '要', '想', '希望',
]);

/** rest 是否只含连接词/标点（无实质请求）——是则不额外发给 agent。 */
function isConnectiveOnly(s: string): boolean {
  const t = s.replace(/[\s，。！？；、,.;:：!?()（）「」【】"'“”·~～]/g, '');
  if (!t) return true;
  return [...t].every((ch) => CONNECTIVE_CHARS.has(ch));
}

/** 自然语言工具触发：不以 / 开头、但以明确命令动词开头时直接映射到真实工具（"工具调用不一定得是/开头"）。 */
const NL_TRIGGERS: Array<{ re: RegExp; tool: string; args: (m: RegExpMatchArray) => Record<string, unknown> | null }> = [
  { re: /^(?:搜索|搜一下|帮我搜|查一下|查询)\s+([\s\S]+)/, tool: 'web_search', args: (m) => ({ query: m[1].trim() }) },
  { re: /^(?:打开网页|浏览器打开)\s+(https?:\/\/\S+)/, tool: 'browser', args: (m) => ({ action: 'open', url: m[1] }) },
  { re: /^(?:审查|review)\s+(.+)/, tool: 'review', args: (m) => ({ scope: m[1].trim() }) },
  { re: /^(?:查找文件|找文件|glob)\s+([\s\S]+)/, tool: 'glob', args: (m) => ({ pattern: m[1].trim() }) },
  { re: /^(?:查找代码|搜代码|grep)\s+([\s\S]+)/, tool: 'grep', args: (m) => ({ pattern: m[1].trim() }) },
  { re: /^(?:理解图片|看图)\s+([\s\S]+)/, tool: 'inspect_image', args: (m) => ({ path: m[1].trim() }) },
];

function matchNaturalLanguage(text: string): { tool: string; args: Record<string, unknown>; command: string } | null {
  for (const t of NL_TRIGGERS) {
    const m = text.match(t.re);
    if (m) {
      const args = t.args(m);
      if (args) return { tool: t.tool, args, command: text };
    }
  }
  return null;
}

export function Composer() {
  const [text, setText] = useState('');
  const [showMenu, setShowMenu] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const { sendMessage, stop, clearMessages, spawnWorkers, setView, invokeTool, logInfo } = useAppApi();
  const { busy, connected, runId, tools } = useAppState();

  // 斜杠命令 = 精选命令 + 从工具库动态生成（覆盖全部注册工具）
  const allCommands = useMemo(() => [...CURATED_COMMANDS, ...toolSlashCommands(tools)], [tools]);
  const cmdKeys = useMemo(() => allCommands.map((c) => c.key), [allCommands]);

  const matches = useMemo(() => {
    if (!text.startsWith('/')) return [];
    const q = text.split(/\s/)[0].toLowerCase();
    if (q === '/') return allCommands;
    return allCommands.filter((c) => c.key.toLowerCase().startsWith(q));
  }, [text, allCommands]);

  const apply = (cmd: SlashCommand) => {
    if (cmd.kind === 'goto') {
      setView('workers');
      setText('');
      setShowMenu(false);
      return;
    }
    if (cmd.kind === 'tool' && cmd.tool === '__clear__') {
      clearMessages();
      setText('');
      setShowMenu(false);
      return;
    }
    // worker / tool：填入命令前缀，等待用户补参数后回车
    setText(cmd.key + ' ');
    setShowMenu(false);
    setActiveIdx(0);
    taRef.current?.focus();
  };

  /** 解析 `/worker` 指令并真实启动 worker。
   *  两种形态：
   *   - `/worker [数量] 目标`：同一目标并行探索（N 个 worker，默认 3）。
   *   - `/worker 任务1 | 任务2 | 任务3`：每个段一个独立 worker（差异化角色/任务）。
   *     任务内可用 `{w1}`/`{w2}`（1-based）引用前序 worker 的最终输出——
   *     前序完成时其结果自动注入该 worker 的 prompt 再启动（如：一个解决目标、一个反思其输出）。 */
  const runWorkerCommand = (value: string): boolean => {
    const m = value.match(/^\/worker\s*([\s\S]*)$/);
    if (!m) return false;
    const body = (m[1] ?? '').trim();
    if (!body) {
      setView('workers');
      return true;
    }
    const parts = body.split('|').map((s) => s.trim()).filter(Boolean);
    let tasks: { title: string; prompt: string }[];
    if (parts.length > 1) {
      // 差异化任务：每段一个 worker，可用 {w1}/{w2}… 引用前序输出。
      // 剥离段首数量词（如 "/worker 2 解决目标 | 反思 {w1} 的输出" 中首段开头的 2），
      // 差异化模式下任务数由段数决定，数字只是习惯性提示。
      tasks = parts.map((p, i) => ({ title: `Worker ${i + 1}`, prompt: p.replace(/^\d+\s*/, '') }));
    } else {
      // 兼容：/worker [数量] 目标 → 同目标并行探索
      const mm = body.match(/^(\d+)\s*([\s\S]*)$/);
      const count = Math.min(Math.max(mm ? Number.parseInt(mm[1], 10) || 3 : 3, 1), 8);
      const goal = (mm ? (mm[2] ?? '') : body).trim();
      if (!goal) {
        setView('workers');
        return true;
      }
      tasks = Array.from({ length: count }, (_, i) => ({
        title: `探索 ${i + 1}/${count}`,
        prompt: `${goal}\n\n你是 goal 下的并行探索 worker ${i + 1}/${count}。请独立探索这个目标（可从可行性、风险、实现路径、证据等角度分别切入），用工具收集证据，最后简明汇报你的发现。不要等待其他 worker。`,
      }));
    }
    void spawnWorkers('manual-goal', tasks, false);
    setView('workers');
    return true;
  };

  /** 工具指令：解析参数 → 真实直调绑定工具（结果由后端写入会话历史）。 */
  const runToolCommand = async (value: string): Promise<void> => {
    const [cmd, ...restParts] = value.split(/\s+/);
    const rest = restParts.join(' ').trim();
    const sc = allCommands.find((c) => c.key === cmd);
    if (!sc || sc.kind !== 'tool') return;
    if (cmd === '/code') {
      const parsed = parseCodeCommand(rest);
      if (!parsed) {
        logInfo('/code', '用法：/code diag <文件> | sym <查询> | refs/def/hover <文件> <符号> | rename <文件> <旧> <新> | grep <模式> [路径] | bash <命令> | run <代码>');
        return;
      }
      await invokeTool(parsed.tool, parsed.args, value);
      return;
    }
    if (cmd === '/git') {
      const parsed = parseGitCommand(rest);
      if (!parsed) {
        logInfo('/git', '用法：/git pr <repo> <PR号> | /git code <repo> <查询> | /git issues <repo> <查询> | /git prs <repo> <查询> | /git commits <repo> <查询> | /git repos <查询>');
        return;
      }
      await invokeTool(parsed.tool, parsed.args, value);
      return;
    }
    const args = sc.parse(rest);
    if (!args) {
      logInfo(cmd, `用法：${sc.usage}`);
      return;
    }
    await invokeTool(sc.tool, args, value);
  };

  /** 执行一条已提取的指令段（/worker /goal /clear /tool…），复用各命令解析器。 */
  const executeParsed = async (seg: string): Promise<void> => {
    const [cmd] = seg.split(/\s+/);
    switch (cmd) {
      case '/clear':
        clearMessages();
        return;
      case '/goal':
        setView('workers');
        return;
      case '/worker':
        runWorkerCommand(seg);
        return;
      default:
        if (allCommands.some((c) => c.key === cmd && c.kind === 'tool')) {
          await runToolCommand(seg);
        }
    }
  };

  const submit = async () => {
    const value = text.trim();
    if (!value) return;
    setShowMenu(false);

    // 1) 文本**任意位置**的 /指令 都提取触发（可多个；如 "先 /search A，再 /git pr repo 1"）
    const { segs, rest } = extractCommands(value, cmdKeys);

    // 1a) 裸 /worker（无结构化任务体）或嵌在句中的 /worker（非句首）→ 这是自然语言 worker 规划：
    //     不吞指令、也不误当"单目标并行探索"；整段交给 agent，模型会用真实 spawn_workers 工具
    //     按角色拆分（解题/反思 {w1}/再探索 {w2}…）真实启动 worker。
    if (
      segs.length === 1 &&
      /^\/worker\b/.test(segs[0]) &&
      (segs[0].replace(/^\/worker\s*/, '').trim() === '' || !value.startsWith('/worker')) &&
      value !== segs[0]
    ) {
      if (busy) return;
      setText('');
      await sendMessage(value);
      return;
    }

    if (segs.length > 0) {
      for (const seg of segs) await executeParsed(seg);
      // 剩余非指令文本作为普通消息（agent 能看到工具结果历史，可继续总结/追问）
      if (rest && !isConnectiveOnly(rest) && !busy) {
        await sendMessage(rest);
      }
      setText('');
      return;
    }

    // 2) 无 /指令 → 自然语言命令也触发真实工具（"工具调用不一定得是/开头"）
    const nl = matchNaturalLanguage(value);
    if (nl) {
      await invokeTool(nl.tool, nl.args, nl.command);
      setText('');
      return;
    }

    // 3) 普通消息
    if (busy) return;
    setText('');
    await sendMessage(value);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMenu && matches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        apply(matches[activeIdx]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowMenu(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="composer">
      {showMenu && matches.length > 0 && (
        <div className="slash-menu">
          {matches.map((c, i) => (
            <div
              key={c.key}
              className={`slash-item ${i === activeIdx ? 'active' : ''}`}
              onMouseEnter={() => setActiveIdx(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                apply(c);
              }}
            >
              <span className="slash-key">{c.key}</span>
              <span className="slash-label">{c.label}</span>
              <span className="slash-hint">{c.hint}</span>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        value={text}
        placeholder={connected ? '输入消息…（/ 指令在任意位置都触发；也可直接说 搜索 / 审查 / 打开网页 / 找文件…；Enter 发送）' : '未连接到 infuture server — 先运行 npm run server'}
        onChange={(e) => {
          setText(e.target.value);
          setShowMenu(e.target.value.startsWith('/'));
        }}
        onKeyDown={onKey}
        disabled={!connected}
      />
      <div className="row">
        <div className="hint">
          <ModelMenu />
          <ThinkingMenu />
          {busy && ' · 运行中…'}
        </div>
        {busy ? (
          runId ? (
            <button className="btn danger" onClick={() => void stop()}>
              停止
            </button>
          ) : (
            <button className="btn" disabled>
              运行中…
            </button>
          )
        ) : (
          <button className="btn primary" onClick={submit} disabled={!connected || !text.trim()}>
            发送
          </button>
        )}
      </div>
    </div>
  );
}
