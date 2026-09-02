/**
 * Loop 类型 — 长运行控制平面的领域模型。
 * 对应 future-os `orchestration/loop`（goals/todos/gates/monitors/lease）。
 */

export type GoalStatus = 'active' | 'paused' | 'done' | 'cancelled';

export interface Goal {
  id: string;
  title: string;
  objective: string;
  /** 验收标准（evidence floor）。 */
  acceptanceCriteria: string[];
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
}

export type TodoStatus = 'pending' | 'in_progress' | 'blocked' | 'done' | 'skipped';

export interface Todo {
  id: string;
  goalId: string;
  title: string;
  status: TodoStatus;
  /** 阻塞原因。 */
  blocker?: string;
  dependencies: string[];
  evidence: string[];
  createdAt: number;
  updatedAt: number;
}

export type GateKind = 'acceptance' | 'verify' | 'evidence';

export interface Gate {
  id: string;
  goalId: string;
  kind: GateKind;
  /** 硬检查描述。 */
  check: string;
  /** 证据阈值。 */
  evidenceFloor: number;
  /** 是否已通过。 */
  passed: boolean;
  lastRun?: number;
  result?: string;
}

export interface Monitor {
  id: string;
  goalId: string;
  metric: string;
  threshold: number;
  lastValue?: number;
  ok: boolean;
}

export type WorkerStatus = 'idle' | 'running' | 'done' | 'stopped' | 'error';

/** Worker — 一个 goal 下的并行探索 agent。每个 worker 绑定独立会话与工作目录。 */
export interface Worker {
  id: string;
  goalId: string;
  title: string;
  status: WorkerStatus;
  /** 绑定的 agent 会话 id（WorkerSessionBound）。 */
  sessionId: string;
  /** 当前 run 的 runId（运行中才有）。 */
  runId: string;
  /** worker 工作目录（git worktree 或临时目录）。 */
  cwd: string;
  createdAt: number;
  updatedAt: number;
  result?: string;
  error?: string;
  /** 最近一次 operator 指引（WorkerSteered）。 */
  lastSteer?: { instruction: string; at: number };
  /** 该 worker 使用的模型 id（缺省用默认模型）。 */
  model?: string;
  /** 该 worker 的思考强度（thinking budget，缺省用默认）。 */
  thinking?: number;
}

export interface Lease {
  id: string;
  goalId: string;
  acquiredAt: number;
  expiresAt: number;
  holder: string;
}

export type LoopEvent =
  | { type: 'goal_created'; goal: Goal }
  | { type: 'todo_updated'; todo: Todo }
  | { type: 'gate_passed'; gate: Gate }
  | { type: 'gate_failed'; gate: Gate }
  | { type: 'lease_acquired'; lease: Lease }
  | { type: 'lease_expired'; leaseId: string }
  | { type: 'goal_completed'; goalId: string }
  | { type: 'worker_started'; worker: Worker }
  | { type: 'worker_updated'; worker: Worker }
  | { type: 'worker_removed'; workerId: string };
