/** 客户端类型。 */
import type { AgentMessage, Usage } from '@infuture/types';

/** 活动导航视图（聊天 / 文件 / 目标（含状态总览+详情） / 设置）。 */
export type RailView = 'chat' | 'files' | 'workers' | 'settings';

export interface SessionInfo {
  id: string;
  name: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  running?: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  api: string;
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
}

export type RunEvent =
  | { type: 'text_delta'; runId: string; text: string }
  | { type: 'reasoning_delta'; runId: string; text: string }
  | { type: 'tool_call'; runId: string; id: string; name: string; args: unknown }
  | { type: 'tool_result'; runId: string; id: string; name: string; result: string; isError: boolean; costMs?: number }
  | { type: 'tool_update'; runId: string; tool: string; partial: string }
  | { type: 'approval_requested'; runId: string; requestId: string; toolName: string; args: unknown }
  | { type: 'approval_resolved'; runId: string; requestId: string; approved: boolean }
  | { type: 'usage'; runId: string; usage: Usage }
  | { type: 'complete'; runId: string; message: AgentMessage; usage?: Usage }
  | { type: 'error'; runId: string; message: string }
  | { type: 'cancelled'; runId: string };

export interface ApprovalPending {
  requestId: string;
  toolName: string;
  args: unknown;
  sessionId: string;
}

export interface RunLogItem {
  kind: 'tool_call' | 'tool_result' | 'approval' | 'usage' | 'info' | 'error';
  label: string;
  detail: string;
  isError?: boolean;
  /** 是否为编程工具（lsp_/dap_/execute_code/ast_/subagent/review/git_ 等直调编程能力）。 */
  coding?: boolean;
  ts: number;
}

/** 文件浏览器条目（相对工作区根的路径）。 */
export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  mtime?: number;
}

/** 当前打开的文件视图。 */
export interface FileView {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
  isText: boolean;
}

/** 只读目录浏览结果（供界面选择工作区目录）。 */
export interface BrowseResult {
  path: string;
  dirs: string[];
}

export type WorkerStatus = 'idle' | 'running' | 'done' | 'stopped' | 'error';

/** Loop worker — goal 下的并行探索 agent。 */
export interface LoopWorker {
  id: string;
  goalId: string;
  title: string;
  status: WorkerStatus;
  sessionId: string;
  runId: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  result?: string;
  error?: string;
  lastSteer?: { instruction: string; at: number };
}

/** worker 运行日志条目（由 loop.worker.log 事件累积）。 */
export interface WorkerLogEntry {
  kind: 'text' | 'reasoning' | 'tool' | 'result' | 'usage' | 'status' | 'error';
  text?: string;
  name?: string;
  detail?: string;
  ts: number;
}

/** loop 控制平面（吸收 future-loop）：goal 状态报告。 */
export interface LoopGoalStatus {
  goalId: string;
  title: string;
  status: string;
  objective: string;
  todos: { total: number; done: number; inProgress: number; pending: number; blocked: number; skipped: number };
  gates: { total: number; passed: number };
  progress: number;
  lease?: { holder: string; expiresAt: number };
  workers: { total: number; running: number; done: number; stopped: number; error: number };
  nextAction?: string;
}

/** loop 运行历史记录。 */
export interface LoopRunRecord {
  goalId: string;
  workerId?: string;
  title: string;
  status: string;
  at: number;
  result?: string;
  error?: string;
}

/** loop 可推进前沿 todo。 */
export interface LoopFrontierTodo {
  id: string;
  goalId: string;
  title: string;
  status: string;
  dependencies: string[];
  evidence: string[];
  createdAt: number;
  updatedAt: number;
}

/** loop 具体事项（某 goal 的全部 todo，含状态/阻塞/证据）。 */
export interface LoopTodo {
  id: string;
  goalId: string;
  title: string;
  status: 'pending' | 'in_progress' | 'blocked' | 'done' | 'skipped';
  blocker?: string;
  dependencies: string[];
  evidence: string[];
  createdAt: number;
  updatedAt: number;
}

/** loop 事件日志展示行（goal 菜单的“日志”）。 */
export interface LoopEventView {
  type: string;
  ts: number;
  text: string;
}

/** IM 通道状态条目（channel.status）。 */
export interface ChannelStatusEntry {
  state: 'stopped' | 'starting' | 'running' | 'error';
  hasConfig: boolean;
  detail?: string;
}

export interface ChannelStatus {
  feishu: ChannelStatusEntry;
  dingtalk: ChannelStatusEntry;
}

/** IM 通道配置视图（secret 掩码，channel.config.get）。 */
export interface ChannelConfigView {
  feishu?: { appId: string; appSecret: string; useWebSocket?: boolean };
  dingtalk?: { appKey: string; appSecret: string; useWebSocket?: boolean };
}
