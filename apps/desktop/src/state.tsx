import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { DesktopRpc } from './rpc';
import type { ApprovalPending, ChannelConfigView, ChannelStatus, DirEntry, FileView, LoopEventView, LoopTodo, LoopWorker, ModelInfo, RailView, RunEvent, RunLogItem, SessionInfo, WorkerLogEntry } from './types';

export interface SettingsInfo {
  defaultModel?: string;
  sandboxTier?: 'off' | 'manual' | 'sandbox';
  codingToolsApproval?: 'on' | 'auto' | 'off';
  networkToolsApproval?: 'on' | 'auto' | 'off';
  generalToolsApproval?: 'on' | 'auto' | 'off';
  searchProvider?: string;
  maxTurns?: number;
  thinkingBudget?: number;
  thinkingLevel?: string;
  workspaceDir?: string;
}
export type AuthInfo = Record<string, { baseUrl: string; hasKey: boolean }>;

interface AppApi {
  sendMessage: (text: string) => Promise<void>;
  stop: () => Promise<void>;
  newSession: () => Promise<void>;
  switchSession: (id: string) => Promise<void>;
  setModel: (id: string) => Promise<void>;
  resolveApproval: (approved: boolean) => Promise<void>;
  updateSettings: (patch: Partial<SettingsInfo>) => Promise<void>;
  saveAuth: (providerId: string, key: string, baseUrl?: string) => Promise<void>;
  verifySearch: () => Promise<{ ok: boolean; costMs?: number; sample?: string; error?: string }>;
  addModel: (m: {
    id: string;
    name: string;
    provider: string;
    api: string;
    baseUrl: string;
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
  }) => Promise<void>;
  removeModel: (id: string) => Promise<void>;
  refreshModels: () => Promise<void>;
  // 会话管理
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
  forkSession: (id: string) => Promise<void>;
  // 文件管理
  refreshFiles: () => Promise<void>;
  browseDir: (absPath: string) => Promise<import('./types').BrowseResult | null>;
  openDir: (rel: string) => Promise<void>;
  openFile: (rel: string) => Promise<void>;
  saveFile: (rel: string, content: string) => Promise<void>;
  createFile: (rel: string, content?: string) => Promise<void>;
  createDir: (rel: string) => Promise<void>;
  deleteEntry: (rel: string) => Promise<void>;
  renameEntry: (from: string, to: string) => Promise<void>;
  closeFile: () => void;
  clearMessages: () => void;
  /** 切换活动视图（聊天 / 文件 / 运行 / 目标-worker / 设置）。 */
  setView: (v: RailView) => void;
  /** 直调真实工具（斜杠命令绑定，不经模型）。结果由后端写入当前会话历史，随后刷新消息。 */
  invokeTool: (
    tool: string,
    args: Record<string, unknown>,
    command: string,
  ) => Promise<{ text: string; is_error: boolean; costMs?: number } | null>;
  /** 拉取注册工具库（供斜杠指令菜单动态生成）。 */
  loadTools: () => Promise<void>;
  /** 写入一条运行日志（info），用于斜杠命令的用法提示等。 */
  logInfo: (label: string, detail: string) => void;
  // loop workers
  loadWorkers: (goalId?: string) => Promise<void>;
  stopWorker: (workerId: string) => Promise<void>;
  steerWorker: (workerId: string, instruction: string) => Promise<void>;
  spawnWorkers: (goalId: string, tasks: { title: string; prompt: string }[], isolate?: boolean) => Promise<void>;
  removeWorker: (workerId: string) => Promise<void>;
  /** 清理一个目标（goal）的全部状态：停止 worker、删除会话/隔离目录、清除事件历史。 */
  deleteGoal: (goalId: string) => Promise<void>;
  /** 清空全部目标状态。 */
  clearAllGoals: () => Promise<void>;
  /** 加载某 goal 的具体事项列表。 */
  loadGoalTodos: (goalId: string) => Promise<void>;
  /** 加载某 goal 的事件日志。 */
  loadGoalEvents: (goalId: string) => Promise<void>;
  /** 清理某 goal 的运行历史（保留 goal 与事项，清空 worker/运行/事件历史）。 */
  clearGoalHistory: (goalId: string) => Promise<void>;
  /** 删除某 goal 下的一条运行记录（停止对应 worker 并清除其事件历史）。 */
  removeGoalRun: (goalId: string, workerId: string) => Promise<void>;
  // loop 控制平面（runs 视图）
  loadLoopStatus: () => Promise<void>;
  loadLoopRuns: () => Promise<void>;
  loadLoopFrontier: () => Promise<void>;
  refreshLoop: () => Promise<void>;
  // IM 通道
  loadChannel: () => Promise<{ config: ChannelConfigView; status: ChannelStatus }>;
  saveChannel: (patch: Partial<ChannelConfigView>) => Promise<ChannelStatus>;
  startChannel: (channel: 'feishu' | 'dingtalk') => Promise<ChannelStatus>;
  stopChannel: (channel: 'feishu' | 'dingtalk') => Promise<ChannelStatus>;
}

interface AppState {
  connected: boolean;
  sessions: SessionInfo[];
  currentSessionId: string | null;
  messages: Array<{ role: string; text: string; meta?: string; reasoning?: string }>;
  models: ModelInfo[];
  currentModel: string;
  /** 注册工具库（tools.list）：前端据此动态生成 `/工具名` 斜杠指令。 */
  tools: Array<{ name: string; description: string; parameters: unknown }>;
  runLog: RunLogItem[];
  pendingApproval: ApprovalPending | null;
  busy: boolean;
  /** 当前正在运行的 runId（用于停止）。 */
  runId: string | null;
  doctor: { programming: boolean; programmingPath: string | null; tools: number; codingTools: number; sessions: number } | null;
  settings: SettingsInfo | null;
  auth: AuthInfo | null;
  channelStatus: ChannelStatus | null;
  // 文件浏览器状态
  files: DirEntry[];
  fsPath: string;
  fsRoot: string;
  fileView: FileView | null;
  workers: LoopWorker[];
  /** workerId → 运行日志（由 loop.worker.log 事件累积，实时流式）。 */
  workerLogs: Record<string, WorkerLogEntry[]>;
  /** goalId → 具体事项列表（loop.control.goal.todos）。 */
  goalTodos: Record<string, LoopTodo[]>;
  /** goalId → 事件日志（loop.control.goal.events）。 */
  goalEvents: Record<string, LoopEventView[]>;
  loopStatus: import('./types').LoopGoalStatus[];
  loopRuns: import('./types').LoopRunRecord[];
  loopFrontier: import('./types').LoopFrontierTodo[];
  /** 当前活动视图（聊天 / 文件 / 运行 / 目标-worker / 设置）。 */
  view: RailView;
}

const StateCtx = createContext<AppState | null>(null);
const ApiCtx = createContext<AppApi | null>(null);

export function useAppState(): AppState {
  const s = useContext(StateCtx);
  if (!s) throw new Error('useAppState outside provider');
  return s;
}
export function useAppApi(): AppApi {
  const a = useContext(ApiCtx);
  if (!a) throw new Error('useAppApi outside provider');
  return a;
}

/** 是否为编程工具（inloop 直调编程能力的工具名）。 */
function isCodingTool(name: string): boolean {
  return /^(lsp_|dap_|execute_code|bash|ast_|subagent|review|git_|code_edit|hash_edit|code_read)/.test(name);
}

/** 编辑工具调用模式标注：input → hashline；old_string/new_string → replace 兜底。用于日志可观测。 */
function editModeLabel(name: string, args: unknown): string | undefined {
  if (name !== 'edit' && name !== 'code_edit' && name !== 'hash_edit') return undefined;
  if (!args || typeof args !== 'object') return undefined;
  const o = args as Record<string, unknown>;
  if (typeof o.input === 'string' && o.input.trim()) return 'hashline';
  if (o.old_string !== undefined || o.new_string !== undefined) return 'replace';
  return undefined;
}

/** 把 worker 运行事件转成日志条目（前端展示用）。 */
function workerEventToLog(ev: RunEvent): WorkerLogEntry | null {
  const ts = Date.now();
  switch (ev.type) {
    case 'text_delta':
      return { kind: 'text', text: ev.text, ts };
    case 'reasoning_delta':
      return { kind: 'reasoning', text: ev.text, ts };
    case 'tool_call':
      return { kind: 'tool', name: `${ev.name}${editModeLabel(ev.name, ev.args) ? '·' + editModeLabel(ev.name, ev.args) : ''}`, detail: JSON.stringify(ev.args ?? '').slice(0, 200), ts };
    case 'tool_result':
      return { kind: 'result', name: ev.name, detail: `${ev.costMs !== undefined ? `(${ev.costMs}ms) ` : ''}${(ev.result ?? '').slice(0, 300)}`, ts };
    case 'tool_update':
      return { kind: 'tool', name: ev.tool, detail: ev.partial, ts };
    case 'usage':
      return {
        kind: 'usage',
        detail: `in=${ev.usage?.prompt_tokens ?? 0} out=${ev.usage?.completion_tokens ?? 0}`,
        ts,
      };
    case 'complete':
      return { kind: 'status', text: '✓ 完成', ts };
    case 'cancelled':
      return { kind: 'status', text: '已停止', ts };
    case 'error':
      return { kind: 'error', text: ev.message, ts };
    default:
      return null;
  }
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Array<{ role: string; text: string; reasoning?: string }>>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [tools, setTools] = useState<Array<{ name: string; description: string; parameters: unknown }>>([]);
  const [currentModel, setCurrentModel] = useState('');
  const [runLog, setRunLog] = useState<RunLogItem[]>([]);
  const [workers, setWorkers] = useState<LoopWorker[]>([]);
  const [workerLogs, setWorkerLogs] = useState<Record<string, WorkerLogEntry[]>>({});
  const [goalTodos, setGoalTodos] = useState<Record<string, LoopTodo[]>>({});
  const [goalEvents, setGoalEvents] = useState<Record<string, LoopEventView[]>>({});
  const [loopStatus, setLoopStatus] = useState<import('./types').LoopGoalStatus[]>([]);
  const [loopRuns, setLoopRuns] = useState<import('./types').LoopRunRecord[]>([]);
  const [loopFrontier, setLoopFrontier] = useState<import('./types').LoopFrontierTodo[]>([]);
  const [pendingApproval, setPendingApproval] = useState<ApprovalPending | null>(null);
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const [doctor, setDoctor] = useState<AppState['doctor']>(null);
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [channelStatus, setChannelStatus] = useState<ChannelStatus | null>(null);
  const [files, setFiles] = useState<DirEntry[]>([]);
  const [fsPath, setFsPath] = useState('');
  const [fsRoot, setFsRoot] = useState('');
  const [fileView, setFileView] = useState<FileView | null>(null);
  const [view, setViewState] = useState<RailView>('chat');

  const rpcRef = useRef<DesktopRpc | null>(null);
  const currentIdRef = useRef<string | null>(null);
  const pendingTextRef = useRef('');
  const currentSessionRef = useRef<string | null>(null);
  const fsPathRef = useRef('');

  const loadMessages = useCallback(async (sessionId: string) => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    const msgs = (await rpc.call<Array<{ role: string; content: unknown[] }>>('session.messages', { id: sessionId })) ?? [];
    setMessages(
      msgs.map((m) => ({
        role: m.role,
        text: m.content
          .map((raw: unknown) => {
            const b = raw as { type?: string; text?: string; content?: string };
            return b.type === 'text' ? b.text ?? '' : b.type === 'tool_result' ? b.content ?? '' : '';
          })
          .join(''),
      })),
    );
  }, []);

  const loadWorkers = useCallback(async (goalId?: string) => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    const res = (await rpc.call('loop.worker.list', { goalId })) as { workers: LoopWorker[] };
    setWorkers(res.workers ?? []);
  }, []);

  // loop 控制平面（runs 视图数据源）
  const loadLoopStatus = useCallback(async () => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    const res = (await rpc.call('loop.control.status', {})) as { reports: import('./types').LoopGoalStatus[] };
    setLoopStatus(res.reports ?? []);
  }, []);
  const loadLoopRuns = useCallback(async () => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    const res = (await rpc.call('loop.control.runs', {})) as { runs: import('./types').LoopRunRecord[] };
    setLoopRuns(res.runs ?? []);
  }, []);
  const loadLoopFrontier = useCallback(async () => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    const res = (await rpc.call('loop.control.frontier', {})) as { todos: import('./types').LoopFrontierTodo[] };
    setLoopFrontier(res.todos ?? []);
  }, []);
  const refreshLoop = useCallback(async () => {
    await Promise.all([loadLoopStatus(), loadLoopRuns(), loadLoopFrontier()]);
  }, [loadLoopStatus, loadLoopRuns, loadLoopFrontier]);

  // IM 通道：读取配置+状态、保存配置、启动/停止桥接
  const loadChannel = useCallback(async () => {
    const rpc = rpcRef.current;
    if (!rpc) return { config: {} as ChannelConfigView, status: null as unknown as ChannelStatus };
    const [config, status] = await Promise.all([
      rpc.call<ChannelConfigView>('channel.config.get'),
      rpc.call<ChannelStatus>('channel.status'),
    ]);
    setChannelStatus(status ?? null);
    return { config: config ?? {}, status: status ?? null as unknown as ChannelStatus };
  }, []);

  const saveChannel = useCallback(async (patch: Partial<ChannelConfigView>) => {
    const rpc = rpcRef.current;
    if (!rpc) return null as unknown as ChannelStatus;
    const status = await rpc.call<ChannelStatus>('channel.config.set', patch);
    setChannelStatus(status ?? null);
    return status ?? null as unknown as ChannelStatus;
  }, []);

  const startChannel = useCallback(async (channel: 'feishu' | 'dingtalk') => {
    const rpc = rpcRef.current;
    if (!rpc) return null as unknown as ChannelStatus;
    const status = await rpc.call<ChannelStatus>('channel.start', { channel });
    setChannelStatus(status ?? null);
    return status ?? null as unknown as ChannelStatus;
  }, []);

  const stopChannel = useCallback(async (channel: 'feishu' | 'dingtalk') => {
    const rpc = rpcRef.current;
    if (!rpc) return null as unknown as ChannelStatus;
    const status = await rpc.call<ChannelStatus>('channel.stop', { channel });
    setChannelStatus(status ?? null);
    return status ?? null as unknown as ChannelStatus;
  }, []);

  useEffect(() => {
    const rpc = new DesktopRpc();
    rpcRef.current = rpc;
    rpc
      .connect()
      .then(async () => {
        setConnected(true);
        const list = (await rpc.call<SessionInfo[]>('session.list')) ?? [];
        let current = list[0]?.id ?? null;
        if (!current) {
          const created = await rpc.call<{ id: string }>('session.create', { name: '新会话' });
          current = created.id;
          list.unshift({ id: created.id, name: '新会话', model: '', createdAt: Date.now(), updatedAt: Date.now() });
        }
        currentIdRef.current = current;
        currentSessionRef.current = current;
        setSessions(list);
        setCurrentSessionId(current);
        // 拉取模型列表；若尚无 defaultModel 但存在模型，自动以第一个作为当前模型（与后端 getDefaultModel 兜底一致）
        const modelList = (await rpc.call<ModelInfo[]>('model.list')) ?? [];
        setModels(modelList);
        await loadTools();
        setDoctor((await rpc.call('doctor')) as AppState['doctor']);
        const st = await rpc.call<SettingsInfo>('settings.get');
        setSettings(st ?? null);
        setCurrentModel(st?.defaultModel || modelList[0]?.id || '');
        setAuth((await rpc.call<AuthInfo>('auth.get')) ?? null);
        await loadMessages(current);
        await loadWorkers();
        await refreshLoop();
        await refreshFiles();
      })
      .catch(() => {
        setConnected(false);
      });

    return () => rpc.dispose();
  }, [loadMessages, loadWorkers, refreshLoop]);

  useEffect(() => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    const off = rpc.onNotification((n) => {
      if (n.method === 'approval.pending') {
        setPendingApproval(n.params as ApprovalPending);
        return;
      }
      if (n.method === 'loop.worker.updated') {
        const w = (n.params as { worker: LoopWorker }).worker;
        if (w) {
          setWorkers((prev) => {
            const i = prev.findIndex((x) => x.id === w.id);
            if (i >= 0) return prev.map((x) => (x.id === w.id ? { ...x, ...w } : x));
            return [...prev, w];
          });
          // 状态同步：worker 状态变化（idle→running→done/error/stopped）时刷新控制面，
          // 让目标头"运行 N"、目标状态、进度等实时一致
          void refreshLoop();
        }
        return;
      }
      if (n.method === 'loop.worker.removed') {
        const { workerId } = n.params as { workerId: string };
        if (workerId) {
          setWorkers((prev) => prev.filter((x) => x.id !== workerId));
          void refreshLoop();
        }
        return;
      }
      if (n.method === 'loop.worker.log') {
        const { workerId, event } = n.params as { workerId: string; event: RunEvent };
        if (workerId && event) {
          const entry = workerEventToLog(event);
          if (entry) {
            setWorkerLogs((prev) => {
              const list = prev[workerId] ?? [];
              const last = list[list.length - 1];
              // 连续正文/思考合并为一条，避免日志条目爆炸
              const merged =
                last && last.kind === entry.kind && (entry.kind === 'text' || entry.kind === 'reasoning')
                  ? [...list.slice(0, -1), { ...last, text: (last.text ?? '') + (entry.text ?? '') }]
                  : [...list, entry];
              return { ...prev, [workerId]: merged };
            });
          }
        }
        return;
      }
      if (n.method !== 'event') return;
      const { sessionId, event: ev } = n.params as { sessionId?: string; event: RunEvent };
      // 会话隔离：只处理属于当前查看会话的 run 事件，避免新会话串进正在运行的旧会话响应
      if (sessionId && sessionId !== currentSessionRef.current) return;
      // 跟踪当前 runId：运行中记录，结束/取消/出错时清空
      if (ev.runId) {
        runIdRef.current = ev.runId;
        setRunId(ev.runId);
      }
      if (ev.type === 'complete' || ev.type === 'cancelled' || ev.type === 'error') {
        runIdRef.current = null;
        setRunId(null);
      }
      switch (ev.type) {
        case 'reasoning_delta':
          // 实时显示思考过程
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant') {
              const next = [...prev];
              next[next.length - 1] = { ...last, reasoning: (last.reasoning ?? '') + ev.text };
              return next;
            }
            return [...prev, { role: 'assistant', text: '', reasoning: ev.text }];
          });
          setBusy(true);
          break;
        case 'text_delta':
          // 空 delta 不创建/不污染消息（防止残留空 assistant 气泡）
          if (!ev.text) break;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant') {
              const next = [...prev];
              next[next.length - 1] = { ...last, text: last.text + ev.text };
              return next;
            }
            return [...prev, { role: 'assistant', text: ev.text }];
          });
          setBusy(true);
          void pendingTextRef;
          break;
        case 'tool_call':
          setRunLog((prev) => [
            ...prev,
            {
              kind: 'tool_call',
              label: `${ev.name}${editModeLabel(ev.name, ev.args) ? '·' + editModeLabel(ev.name, ev.args) : ''}`,
              detail: JSON.stringify(ev.args).slice(0, 400),
              coding: isCodingTool(ev.name),
              ts: Date.now(),
            },
          ]);
          break;
        case 'tool_result':
          setRunLog((prev) => [
            ...prev,
            { kind: 'tool_result', label: ev.name, detail: `${ev.costMs !== undefined ? `(${ev.costMs}ms) ` : ''}${ev.result.slice(0, 500)}`, isError: ev.isError, coding: isCodingTool(ev.name), ts: Date.now() },
          ]);
          break;
        case 'usage':
          setRunLog((prev) => [
            ...prev,
            {
              kind: 'usage',
              label: 'usage',
              detail: `in=${ev.usage.prompt_tokens} out=${ev.usage.completion_tokens}`,
              ts: Date.now(),
            },
          ]);
          break;
        case 'tool_update':
          setRunLog((prev) => [
            ...prev,
            { kind: 'info', label: `⚡ ${ev.tool}`, detail: ev.partial.slice(0, 300), coding: true, ts: Date.now() },
          ]);
          break;
        case 'complete':
        case 'cancelled':
          setBusy(false);
          break;
        case 'error':
          setBusy(false);
          setRunLog((prev) => [
            ...prev,
            { kind: 'error', label: 'error', detail: ev.message, isError: true, ts: Date.now() },
          ]);
          break;
        default:
          break;
      }
    });
    return off;
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    const rpc = rpcRef.current;
    const sessionId = currentSessionRef.current;
    if (!rpc || !sessionId) return;
    setMessages((prev) => [...prev, { role: 'user', text }]);
    setBusy(true);
    try {
      await rpc.call('session.send', { sessionId, prompt: text });
    } catch (err) {
      setBusy(false);
      setRunLog((prev) => [
        ...prev,
        { kind: 'error', label: 'error', detail: String(err), isError: true, ts: Date.now() },
      ]);
    }
  }, []);

  /** 停止当前运行：发给后端 session.stop，运行环会发 cancelled 事件并复位 busy。 */
  const stop = useCallback(async () => {
    const rpc = rpcRef.current;
    const rid = runIdRef.current;
    if (!rpc || !rid) return;
    try {
      await rpc.call('session.stop', { runId: rid });
    } catch (err) {
      setRunLog((prev) => [
        ...prev,
        { kind: 'error', label: 'error', detail: String(err), isError: true, ts: Date.now() },
      ]);
    }
  }, []);

  const newSession = useCallback(async () => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    const created = await rpc.call<{ id: string }>('session.create', { name: '新会话' });
    currentSessionRef.current = created.id;
    currentIdRef.current = created.id;
    setSessions((prev) => [
      { id: created.id, name: '新会话', model: '', createdAt: Date.now(), updatedAt: Date.now() },
      ...prev,
    ]);
    setCurrentSessionId(created.id);
    setMessages([]);
    setRunLog([]);
    // 复位运行状态，避免继承其他会话的运行中标记
    setBusy(false);
    setRunId(null);
    runIdRef.current = null;
  }, []);

  const switchSession = useCallback(
    async (id: string) => {
      currentSessionRef.current = id;
      currentIdRef.current = id;
      setCurrentSessionId(id);
      setRunLog([]);
      // 复位运行状态：切换会话后只响应当前会话的 run 事件
      setBusy(false);
      setRunId(null);
      runIdRef.current = null;
      await loadMessages(id);
    },
    [loadMessages],
  );

  const setModel = useCallback(async (id: string) => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    try {
      await rpc.call('model.select', { id });
      setCurrentModel(id);
    } catch (err) {
      setRunLog((prev) => [
        ...prev,
        { kind: 'error', label: 'model.select', detail: String(err), isError: true, ts: Date.now() },
      ]);
    }
  }, []);

  const resolveApproval = useCallback(async (approved: boolean) => {
    const rpc = rpcRef.current;
    const approval = pendingApproval;
    if (!rpc || !approval) return;
    await rpc.call('approval.resolve', { requestId: approval.requestId, approved });
    setPendingApproval(null);
  }, [pendingApproval]);

  const updateSettings = useCallback(async (patch: Partial<SettingsInfo>) => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    const merged = (await rpc.call<SettingsInfo>('settings.set', patch)) ?? {};
    setSettings(merged);
    if (merged.defaultModel) setCurrentModel(merged.defaultModel);
  }, []);

  const saveAuth = useCallback(async (providerId: string, key: string, baseUrl?: string) => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    await rpc.call('auth.set', { providerId, key, baseUrl: baseUrl ?? undefined });
    setAuth((await rpc.call<AuthInfo>('auth.get')) ?? null);
  }, []);

  const verifySearch = useCallback(async () => {
    const rpc = rpcRef.current;
    if (!rpc) return { ok: false as const, error: '服务未连接' };
    return (await rpc.call('search.verify')) as { ok: boolean; costMs?: number; sample?: string; error?: string };
  }, []);

  const addModel = useCallback(async (m: {
    id: string;
    name: string;
    provider: string;
    api: string;
    baseUrl: string;
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
  }) => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    await rpc.call('model.custom', m);
    setModels((await rpc.call<ModelInfo[]>('model.list')) ?? []);
  }, []);

  const removeModel = useCallback(async (id: string) => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    await rpc.call('model.remove', { id });
    setModels((await rpc.call<ModelInfo[]>('model.list')) ?? []);
    if (currentModel === id) setCurrentModel('');
  }, [currentModel]);

  /** 重新拉取模型列表（打开下拉时调用，以拾取外部新增/修改的模型配置）。 */
  const refreshModels = useCallback(async () => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    setModels((await rpc.call<ModelInfo[]>('model.list')) ?? []);
  }, []);

  // ===== 会话管理（增删改） =====
  const deleteSession = useCallback(async (id: string) => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    await rpc.call('session.delete', { id });
    const list = (await rpc.call<SessionInfo[]>('session.list')) ?? [];
    setSessions(list);
    if (currentSessionRef.current !== id) return;
    const next = list[0]?.id ?? null;
    if (next) {
      currentSessionRef.current = next;
      currentIdRef.current = next;
      setCurrentSessionId(next);
      setMessages([]);
      setRunLog([]);
      await loadMessages(next);
    } else {
      const created = await rpc.call<{ id: string }>('session.create', { name: '新会话' });
      currentSessionRef.current = created.id;
      currentIdRef.current = created.id;
      setCurrentSessionId(created.id);
      setSessions((prev) => [{ id: created.id, name: '新会话', model: '', createdAt: Date.now(), updatedAt: Date.now() }, ...prev]);
      setMessages([]);
      setRunLog([]);
    }
  }, [loadMessages]);

  const renameSession = useCallback(async (id: string, name: string) => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    await rpc.call('session.rename', { id, name });
    setSessions((await rpc.call<SessionInfo[]>('session.list')) ?? []);
  }, []);

  const forkSession = useCallback(async (id: string) => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    const created = await rpc.call<{ id: string }>('session.fork', { id });
    setSessions((await rpc.call<SessionInfo[]>('session.list')) ?? []);
    currentSessionRef.current = created.id;
    currentIdRef.current = created.id;
    setCurrentSessionId(created.id);
    setMessages([]);
    setRunLog([]);
    await loadMessages(created.id);
  }, [loadMessages]);

  // ===== 文件管理（增删改查） =====
  const refreshFiles = useCallback(async () => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    const res = await rpc.call<{ root: string; path: string; entries: DirEntry[] } | null>('fs.list', {
      path: fsPathRef.current || '.',
      sessionId: currentSessionRef.current ?? undefined,
    });
    if (res) {
      setFsRoot(res.root);
      setFsPath(res.path);
      fsPathRef.current = res.path;
      setFiles(res.entries);
    }
  }, []);

  /** 只读浏览任意目录（选择工作区用），返回目录下子目录名列表。 */
  const browseDir = useCallback(async (absPath: string) => {
    const rpc = rpcRef.current;
    if (!rpc) return null;
    return await rpc.call<import('./types').BrowseResult | null>('fs.browse', { path: absPath });
  }, []);

  const openDir = useCallback(
    async (rel: string) => {
      fsPathRef.current = rel;
      setFsPath(rel);
      await refreshFiles();
    },
    [refreshFiles],
  );

  const openFile = useCallback(async (rel: string) => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    try {
      const res = await rpc.call<FileView>('fs.read', {
        path: rel,
        sessionId: currentSessionRef.current ?? undefined,
      });
      setFileView({ ...res, path: rel, isText: true });
    } catch (err) {
      setFileView({ path: rel, content: `读取失败：${String(err)}`, truncated: false, size: 0, isText: false });
    }
  }, []);

  const saveFile = useCallback(
    async (rel: string, content: string) => {
      const rpc = rpcRef.current;
      if (!rpc) return;
      await rpc.call('fs.write', { path: rel, content, sessionId: currentSessionRef.current ?? undefined });
      setFileView((prev) => (prev && prev.path === rel ? { ...prev, content } : prev));
      await refreshFiles();
    },
    [refreshFiles],
  );

  const createFile = useCallback(
    async (rel: string, content = '') => {
      const rpc = rpcRef.current;
      if (!rpc) return;
      await rpc.call('fs.write', { path: rel, content, sessionId: currentSessionRef.current ?? undefined });
      await refreshFiles();
    },
    [refreshFiles],
  );

  const createDir = useCallback(
    async (rel: string) => {
      const rpc = rpcRef.current;
      if (!rpc) return;
      await rpc.call('fs.mkdir', { path: rel, sessionId: currentSessionRef.current ?? undefined });
      await refreshFiles();
    },
    [refreshFiles],
  );

  const deleteEntry = useCallback(
    async (rel: string) => {
      const rpc = rpcRef.current;
      if (!rpc) return;
      await rpc.call('fs.remove', { path: rel, sessionId: currentSessionRef.current ?? undefined });
      setFileView((prev) => (prev && (prev.path === rel || (rel.endsWith('/') && prev.path.startsWith(rel))) ? null : prev));
      await refreshFiles();
    },
    [refreshFiles],
  );

  const renameEntry = useCallback(
    async (from: string, to: string) => {
      const rpc = rpcRef.current;
      if (!rpc) return;
      await rpc.call('fs.rename', { from, to, sessionId: currentSessionRef.current ?? undefined });
      setFileView((prev) => (prev && prev.path === from ? { ...prev, path: to } : prev));
      await refreshFiles();
    },
    [refreshFiles],
  );

  const closeFile = useCallback(() => setFileView(null), []);

  const stopWorker = useCallback(
    async (workerId: string) => {
      const rpc = rpcRef.current;
      if (!rpc) return;
      await rpc.call('loop.worker.stop', { workerId });
      await loadWorkers();
    },
    [loadWorkers],
  );

  const steerWorker = useCallback(
    async (workerId: string, instruction: string) => {
      const rpc = rpcRef.current;
      if (!rpc) return;
      await rpc.call('loop.worker.steer', { workerId, instruction });
      await loadWorkers();
    },
    [loadWorkers],
  );

  const loadGoalTodos = useCallback(async (goalId: string) => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    const res = (await rpc.call('loop.control.goal.todos', { goalId })) as { todos: LoopTodo[] };
    setGoalTodos((prev) => ({ ...prev, [goalId]: res.todos ?? [] }));
  }, []);

  const loadGoalEvents = useCallback(async (goalId: string) => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    const res = (await rpc.call('loop.control.goal.events', { goalId })) as { events: LoopEventView[] };
    setGoalEvents((prev) => ({ ...prev, [goalId]: res.events ?? [] }));
  }, []);

  const clearGoalHistory = useCallback(
    async (goalId: string) => {
      const rpc = rpcRef.current;
      if (!rpc) return;
      await rpc.call('loop.control.goal.history.clear', { goalId });
      await loadWorkers();
      await refreshLoop();
      await loadGoalTodos(goalId);
      await loadGoalEvents(goalId);
    },
    [loadWorkers, refreshLoop, loadGoalTodos, loadGoalEvents],
  );

  /** 删除某目标下的一条运行记录（对应 worker：停止 + 清除事件历史）。 */
  const removeGoalRun = useCallback(
    async (goalId: string, workerId: string) => {
      const rpc = rpcRef.current;
      if (!rpc) return;
      await rpc.call('loop.control.goal.run.remove', { goalId, workerId });
      await loadWorkers();
      await refreshLoop();
      await loadGoalTodos(goalId);
      await loadGoalEvents(goalId);
    },
    [loadWorkers, refreshLoop, loadGoalTodos, loadGoalEvents],
  );

  const spawnWorkers = useCallback(
    async (goalId: string, tasks: { title: string; prompt: string }[], isolate = false) => {
      const rpc = rpcRef.current;
      if (!rpc) return;
      await rpc.call('loop.worker.spawn', { goalId, tasks, isolate });
      await loadWorkers();
      await refreshLoop();
      await loadGoalTodos(goalId);
      await loadGoalEvents(goalId);
    },
    [loadWorkers, refreshLoop, loadGoalTodos, loadGoalEvents],
  );

  const removeWorker = useCallback(
    async (workerId: string) => {
      const rpc = rpcRef.current;
      if (!rpc) return;
      await rpc.call('loop.worker.remove', { workerId });
      await loadWorkers();
    },
    [loadWorkers],
  );

  const deleteGoal = useCallback(
    async (goalId: string) => {
      const rpc = rpcRef.current;
      if (!rpc) return;
      await rpc.call('loop.control.goal.delete', { goalId });
      await loadWorkers();
      await refreshLoop();
    },
    [loadWorkers, refreshLoop],
  );

  const clearAllGoals = useCallback(async () => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    // 后端统一清空全部目标（含仅有 worker 记录、无 goal 记录的孤儿目标）：停止 worker、删会话/隔离目录、清事件历史
    await rpc.call('loop.control.clear', {});
    await loadWorkers();
    await refreshLoop();
  }, [loadWorkers, refreshLoop]);

  const logInfo = useCallback((label: string, detail: string) => {
    setRunLog((prev) => [...prev, { kind: 'info', label, detail, isError: false, ts: Date.now() }]);
  }, []);

  const invokeTool = useCallback(
    async (tool: string, args: Record<string, unknown>, command: string) => {
      const rpc = rpcRef.current;
      const sid = currentIdRef.current;
      if (!rpc || !sid) return null;
      try {
        const res = await rpc.call<{ text: string; is_error: boolean; costMs?: number }>('tool.invoke', {
          tool,
          args,
          command,
          sessionId: sid,
        });
        // 后端已把「命令 + 工具结果」写入会话历史，刷新使消息区可见
        await loadMessages(sid);
        return res;
      } catch (err) {
        setRunLog((prev) => [
          ...prev,
          { kind: 'error', label: 'tool.invoke', detail: String(err), isError: true, ts: Date.now() },
        ]);
        return null;
      }
    },
    [loadMessages],
  );

  const loadTools = useCallback(async () => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    try {
      const res = (await rpc.call('tools.list')) as { tools: Array<{ name: string; description: string; parameters: unknown }> };
      setTools(res.tools ?? []);
    } catch {
      // 工具库拉取失败不影响主流程
    }
  }, []);

  const state: AppState = { connected, sessions, currentSessionId, messages, models, currentModel, tools, runLog, pendingApproval, busy, runId, doctor, settings, auth, channelStatus, files, fsPath, fsRoot, fileView, workers, workerLogs, goalTodos, goalEvents, loopStatus, loopRuns, loopFrontier, view };
  const api: AppApi = {
    sendMessage,
    stop,
    newSession,
    switchSession,
    setModel,
    resolveApproval,
    updateSettings,
    saveAuth,
    verifySearch,
    addModel,
    removeModel,
    refreshModels,
    deleteSession,
    clearMessages: () => setMessages([]),
    renameSession,
    forkSession,
    setView: setViewState,
    invokeTool,
    logInfo,
    loadTools,
    refreshFiles,
    browseDir,
    openDir,
    openFile,
    saveFile,
    createFile,
    createDir,
    deleteEntry,
    renameEntry,
    closeFile,
    loadWorkers,
    stopWorker,
    steerWorker,
    spawnWorkers,
    removeWorker,
    deleteGoal,
    clearAllGoals,
    loadGoalTodos,
    loadGoalEvents,
    clearGoalHistory,
    removeGoalRun,
    loadLoopStatus,
    loadLoopRuns,
    loadLoopFrontier,
    refreshLoop,
    loadChannel,
    saveChannel,
    startChannel,
    stopChannel,
  };

  return (
    <StateCtx.Provider value={state}>
      <ApiCtx.Provider value={api}>{children}</ApiCtx.Provider>
    </StateCtx.Provider>
  );
}
