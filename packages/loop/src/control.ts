/**
 * LoopControl — 吸收 future-os `future-loop` 控制平面的核心子命令：
 * status / replan / lease(claim·renew·release) / task-graph / frontier / backup / runs。
 *
 * 全部基于 LoopStore 事件源状态计算，不改变 engine 语义。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { eventBelongsToGoal, LoopStore } from './store.js';
import type { Goal, Lease, LoopEvent, Todo, Worker } from './types.js';

/** 事件日志展示行（前端 goal 菜单的“日志”）。 */
export interface LoopEventView {
  type: string;
  ts: number;
  text: string;
}

/** 从事件载荷提取时间戳（无则 0）。 */
function eventTs(e: LoopEvent): number {
  switch (e.type) {
    case 'goal_created':
      return e.goal.createdAt;
    case 'todo_updated':
      return e.todo.updatedAt;
    case 'gate_passed':
    case 'gate_failed':
      return e.gate.lastRun ?? 0;
    case 'lease_acquired':
      return e.lease.acquiredAt;
    case 'lease_expired':
      return 0;
    case 'goal_completed':
      return 0;
    case 'worker_started':
    case 'worker_updated':
      return e.worker.updatedAt;
    case 'worker_removed':
      return 0;
  }
}

/** 事件 → 可读日志文本。 */
function eventText(e: LoopEvent): string {
  switch (e.type) {
    case 'goal_created':
      return `目标创建：${e.goal.title}`;
    case 'goal_completed':
      return `目标完成`;
    case 'todo_updated':
      return `事项 ${e.todo.title} → ${e.todo.status}`;
    case 'gate_passed':
      return `门禁通过：${e.gate.check}`;
    case 'gate_failed':
      return `门禁失败：${e.gate.check}`;
    case 'lease_acquired':
      return `租约获取：${e.lease.holder}`;
    case 'lease_expired':
      return `租约过期`;
    case 'worker_started':
      return `worker 启动：${e.worker.title}`;
    case 'worker_updated':
      return `worker ${e.worker.title} → ${e.worker.status}`;
    case 'worker_removed':
      return `worker 移除`;
  }
}

export interface TodoCounts {
  total: number;
  done: number;
  inProgress: number;
  pending: number;
  blocked: number;
  skipped: number;
}

export interface GoalStatusReport {
  goalId: string;
  title: string;
  status: Goal['status'];
  objective: string;
  todos: TodoCounts;
  gates: { total: number; passed: number };
  progress: number;
  lease?: { holder: string; expiresAt: number };
  workers: { total: number; running: number; done: number; stopped: number; error: number };
  nextAction?: string;
}

export interface ReplanChange {
  todoId: string;
  from: Todo['status'];
  to: Todo['status'];
}

export interface ReplanResult {
  goalId: string;
  changes: ReplanChange[];
  nextAction?: string;
  frontier: Todo[];
}

export interface TaskGraphNode {
  id: string;
  title: string;
  status: Todo['status'];
  deps: string[];
  blockedBy: string[];
}

export interface TaskGraph {
  goalId: string;
  nodes: TaskGraphNode[];
}

export interface RunRecord {
  goalId: string;
  workerId?: string;
  title: string;
  status: Worker['status'];
  at: number;
  result?: string;
  error?: string;
}

const DONE_SET: ReadonlySet<Todo['status']> = new Set(['done', 'skipped']);

export class LoopControl {
  constructor(private readonly store: LoopStore) {}

  /** 目标状态总览（原版 `loop status`）。 */
  status(goalId?: string): GoalStatusReport[] {
    const goals = this.store.goalsFor(goalId);
    return goals.map((g) => this.reportFor(g));
  }

  private reportFor(goal: Goal): GoalStatusReport {
    const todos = this.store.todosFor(goal.id);
    const gates = this.store.gatesFor(goal.id);
    const workers = this.store.workersFor(goal.id);
    const lease = this.store.activeLease(goal.id);
    const frontier = this.frontier(goal.id);

    const counts: TodoCounts = {
      total: todos.length,
      done: todos.filter((t) => t.status === 'done').length,
      inProgress: todos.filter((t) => t.status === 'in_progress').length,
      pending: todos.filter((t) => t.status === 'pending').length,
      blocked: todos.filter((t) => t.status === 'blocked').length,
      skipped: todos.filter((t) => t.status === 'skipped').length,
    };
    const progress =
      counts.total === 0 ? 0 : Math.round(((counts.done + counts.skipped) / counts.total) * 100);

    return {
      goalId: goal.id,
      title: goal.title,
      status: goal.status,
      objective: goal.objective,
      todos: counts,
      gates: { total: gates.length, passed: gates.filter((g) => g.passed).length },
      progress,
      ...(lease ? { lease: { holder: lease.holder, expiresAt: lease.expiresAt } } : {}),
      workers: {
        total: workers.length,
        running: workers.filter((w) => w.status === 'running' || w.status === 'idle').length,
        done: workers.filter((w) => w.status === 'done').length,
        stopped: workers.filter((w) => w.status === 'stopped').length,
        error: workers.filter((w) => w.status === 'error').length,
      },
      ...(frontier[0] ? { nextAction: frontier[0].title } : {}),
    };
  }

  /** 可推进前沿：依赖已满足且未完成的 todo（原版 `loop frontier`）。 */
  frontier(goalId?: string): Todo[] {
    const goals = this.store.goalsFor(goalId);
    return goals.flatMap((g) => {
      const todos = this.store.todosFor(g.id);
      const byId = new Map(todos.map((t) => [t.id, t]));
      return todos
        .filter((t) => !DONE_SET.has(t.status))
        .filter((t) => t.dependencies.every((d) => {
          const dep = byId.get(d);
          return dep && DONE_SET.has(dep.status);
        }))
        .sort((a, b) => a.createdAt - b.createdAt);
    });
  }

  /**
   * 重规划（原版 `loop replan`）：按依赖一致性重算 todo 状态。
   * 依赖未满足的 pending → blocked；依赖已满足的 blocked → pending。
   * 返回变化并写入事件源。
   */
  replan(goalId: string): ReplanResult {
    const goal = this.store.goalsFor(goalId)[0];
    if (!goal) throw new Error(`goal ${goalId} not found`);
    const todos = this.store.todosFor(goalId);
    const byId = new Map(todos.map((t) => [t.id, t]));
    const changes: ReplanChange[] = [];

    for (const t of todos) {
      if (DONE_SET.has(t.status)) continue;
      const depsDone = t.dependencies.every((d) => {
        const dep = byId.get(d);
        return dep && DONE_SET.has(dep.status);
      });
      let target: Todo['status'];
      if (!depsDone) {
        target = 'blocked';
      } else if (t.status === 'blocked') {
        target = 'pending';
      } else {
        target = t.status;
      }
      if (target !== t.status) {
        this.store.setTodo({ ...t, status: target, updatedAt: Date.now() });
        changes.push({ todoId: t.id, from: t.status, to: target });
      }
    }

    const frontier = this.frontier(goalId);
    return {
      goalId,
      changes,
      ...(frontier[0] ? { nextAction: frontier[0].title } : {}),
      frontier,
    };
  }

  /** 任务依赖图（原版 `loop task-graph`）。 */
  taskGraph(goalId: string): TaskGraph {
    const todos = this.store.todosFor(goalId);
    const byId = new Map(todos.map((t) => [t.id, t]));
    return {
      goalId,
      nodes: todos.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        deps: t.dependencies,
        blockedBy: t.dependencies.filter((d) => {
          const dep = byId.get(d);
          // 缺失依赖同样视为阻塞（与 replan 一致）
          return !dep || !DONE_SET.has(dep.status);
        }),
      })),
    };
  }

  /** 抢占租赁（原版 `loop lease claim`）。已有有效租赁且非本 holder → 拒绝。 */
  claimLease(goalId: string, holder: string, ttlMs = 300_000): Lease {
    const existing = this.store.activeLease(goalId);
    if (existing) {
      if (existing.holder === holder) return { ...existing, expiresAt: Date.now() + ttlMs };
      throw new Error(`goal ${goalId} 已被 ${existing.holder} 持有，lease 至 ${new Date(existing.expiresAt).toISOString()}`);
    }
    const lease: Lease = {
      id: `lease_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      goalId,
      holder,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    };
    this.store.acquireLease(lease);
    return lease;
  }

  /** 续租（原版 `loop lease renew`）。仅持有者可续。 */
  renewLease(goalId: string, holder: string, ttlMs = 300_000): Lease {
    const existing = this.store.activeLease(goalId);
    if (!existing) throw new Error(`goal ${goalId} 无活跃 lease`);
    if (existing.holder !== holder) throw new Error(`holder 不匹配：${holder} ≠ ${existing.holder}`);
    const renewed = { ...existing, expiresAt: Date.now() + ttlMs };
    // 事件源不支持直接更新 lease，用 release + claim 语义
    this.store.releaseLease(existing.id);
    this.store.acquireLease(renewed);
    return renewed;
  }

  /** 释放租赁（原版 `loop lease release`）。 */
  releaseLease(goalId: string, holder: string): boolean {
    const existing = this.store.activeLease(goalId);
    if (!existing) return false;
    if (existing.holder !== holder) throw new Error(`holder 不匹配：${holder} ≠ ${existing.holder}`);
    this.store.releaseLease(existing.id);
    return true;
  }

  /** 活跃租赁列表（原版 `loop lease status`）。 */
  leaseStatus(goalId?: string): Lease[] {
    const goals = this.store.goalsFor(goalId);
    return goals
      .map((g) => this.store.activeLease(g.id))
      .filter((l): l is Lease => Boolean(l));
  }

  /**
   * 删除一个 goal 的全部状态（goals/todos/gates/leases/workers + 事件历史）。
   * goal 不存在抛错。返回目标标题与移除的事件数。
   */
  async removeGoal(goalId: string): Promise<{ goalTitle: string; removedEvents: number }> {
    const goal = this.store.goalsFor(goalId)[0];
    if (!goal) throw new Error(`goal ${goalId} not found`);
    const { removedEvents } = await this.store.removeGoal(goalId);
    return { goalTitle: goal.title, removedEvents };
  }

  /** 清空全部目标状态。返回移除的事件数。 */
  async clearAll(): Promise<{ removedEvents: number }> {
    return await this.store.clearAll();
  }

  /** 备份事件源（原版 `loop backup`）。返回备份文件路径。 */
  async backup(dir?: string): Promise<string> {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir ?? '.', `.future-loop-backup-${ts}.jsonl`);
    const events = this.store.getEvents();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''), 'utf-8');
    return file;
  }

  /** 运行历史（原版 `loop runs history`）。从事件源提取 worker 记录。 */
  runs(goalId?: string): RunRecord[] {
    const events = this.store.getEvents();
    const recs: RunRecord[] = [];
    for (const e of events) {
      if (e.type === 'worker_started' && (!goalId || e.worker.goalId === goalId)) {
        recs.push({
          goalId: e.worker.goalId,
          workerId: e.worker.id,
          title: e.worker.title,
          status: e.worker.status,
          at: e.worker.createdAt,
        });
      } else if (e.type === 'worker_updated' && (!goalId || e.worker.goalId === goalId)) {
        const existing = recs.find((r) => r.workerId === e.worker.id);
        if (existing) {
          existing.status = e.worker.status;
          existing.result = e.worker.result;
          existing.error = e.worker.error;
        }
      }
    }
    return recs.sort((a, b) => b.at - a.at);
  }

  /** 某 goal（或全部）的具体事项列表（含状态与证据，按创建时间排序）。 */
  todos(goalId?: string): Todo[] {
    const goals = this.store.goalsFor(goalId);
    return goals
      .flatMap((g) => this.store.todosFor(g.id))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 某 goal 的事件日志（含其关联的 worker/lease 事件，文件顺序即时间顺序）。 */
  events(goalId: string): LoopEventView[] {
    const all = this.store.getEvents();
    const workerIds = new Set<string>();
    const leaseIds = new Set<string>();
    for (const e of all) {
      if ((e.type === 'worker_started' || e.type === 'worker_updated') && e.worker.goalId === goalId) {
        workerIds.add(e.worker.id);
      } else if (e.type === 'lease_acquired' && e.lease.goalId === goalId) {
        leaseIds.add(e.lease.id);
      }
    }
    return all
      .filter((e) => eventBelongsToGoal(e, goalId, workerIds, leaseIds))
      .map((e) => ({ type: e.type, ts: eventTs(e), text: eventText(e) }));
  }

  /** 清理一个 goal 的运行历史（保留 goal 与 todos/gates 当前状态）。 */
  async clearHistory(goalId: string): Promise<{ goalTitle: string; removedEvents: number }> {
    const goals = this.store.goalsFor(goalId);
    if (goals.length === 0) throw new Error(`goal ${goalId} not found`);
    const removed = await this.store.clearHistory(goalId);
    return { goalTitle: goals[0].title, removedEvents: removed.removedEvents };
  }

  /** 删除一条运行记录（对应某个 worker 的历史事件 + worker 记录）。 */
  async removeRun(goalId: string, workerId: string): Promise<{ removedEvents: number }> {
    const goals = this.store.goalsFor(goalId);
    if (goals.length === 0) throw new Error(`goal ${goalId} not found`);
    return this.store.removeRun(goalId, workerId);
  }
}
