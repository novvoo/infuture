/**
 * EventStore — 事件源存储。对应 future-os `orchestration/loop` 的 event-sourced store。
 * 内存 + JSONL 持久化（每行一个事件，重放恢复状态）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Goal, LoopEvent, Todo, Gate, Monitor, Lease, Worker } from './types.js';

export class LoopStore {
  private goals = new Map<string, Goal>();
  private todos = new Map<string, Todo>();
  private gates = new Map<string, Gate>();
  private monitors = new Map<string, Monitor>();
  private leases = new Map<string, Lease>();
  private workers = new Map<string, Worker>();
  private events: LoopEvent[] = [];

  constructor(private readonly filePath?: string) {}

  getEvents(): LoopEvent[] {
    return [...this.events];
  }

  apply(event: LoopEvent): void {
    this.events.push(event);
    switch (event.type) {
      case 'goal_created':
        this.goals.set(event.goal.id, event.goal);
        break;
      case 'todo_updated':
        this.todos.set(event.todo.id, event.todo);
        break;
      case 'gate_passed':
      case 'gate_failed': {
        const existing = this.gates.get(event.gate.id);
        if (existing) this.gates.set(event.gate.id, { ...existing, ...event.gate, passed: event.type === 'gate_passed' });
        else this.gates.set(event.gate.id, event.gate);
        break;
      }
      case 'lease_acquired':
        this.leases.set(event.lease.id, event.lease);
        break;
      case 'lease_expired':
        this.leases.delete(event.leaseId);
        break;
      case 'goal_completed': {
        const g = this.goals.get(event.goalId);
        if (g) this.goals.set(event.goalId, { ...g, status: 'done', updatedAt: Date.now() });
        break;
      }
      case 'worker_started':
        this.workers.set(event.worker.id, event.worker);
        break;
      case 'worker_updated':
        this.workers.set(event.worker.id, event.worker);
        break;
      case 'worker_removed':
        this.workers.delete(event.workerId);
        break;
    }
  }

  addGoal(goal: Goal): void {
    this.apply({ type: 'goal_created', goal });
  }
  setTodo(todo: Todo): void {
    this.apply({ type: 'todo_updated', todo });
  }
  setGate(gate: Gate, passed: boolean): void {
    this.apply(passed ? { type: 'gate_passed', gate } : { type: 'gate_failed', gate });
  }
  acquireLease(lease: Lease): void {
    this.apply({ type: 'lease_acquired', lease });
  }
  releaseLease(leaseId: string): void {
    this.apply({ type: 'lease_expired', leaseId });
  }
  completeGoal(goalId: string): void {
    this.apply({ type: 'goal_completed', goalId });
  }

  addMonitor(monitor: Monitor): void {
    this.monitors.set(monitor.id, monitor);
  }

  addWorker(worker: Worker): void {
    this.apply({ type: 'worker_started', worker });
  }
  updateWorker(worker: Worker): void {
    this.apply({ type: 'worker_updated', worker });
  }
  removeWorker(workerId: string): void {
    this.apply({ type: 'worker_removed', workerId });
  }
  workersFor(goalId?: string): Worker[] {
    const all = [...this.workers.values()];
    return goalId ? all.filter((w) => w.goalId === goalId) : all;
  }
  worker(id: string): Worker | undefined {
    return this.workers.get(id);
  }

  goalsFor(goalId?: string): Goal[] {
    const all = [...this.goals.values()];
    return goalId ? all.filter((g) => g.id === goalId) : all;
  }
  todosFor(goalId: string): Todo[] {
    return [...this.todos.values()].filter((t) => t.goalId === goalId);
  }
  gatesFor(goalId: string): Gate[] {
    return [...this.gates.values()].filter((g) => g.goalId === goalId);
  }
  monitorsFor(goalId: string): Monitor[] {
    return [...this.monitors.values()].filter((m) => m.goalId === goalId);
  }
  activeLease(goalId: string): Lease | undefined {
    return [...this.leases.values()].find((l) => l.goalId === goalId && l.expiresAt > Date.now());
  }

  /**
   * 删除一个 goal 的全部状态：内存中移除 goal/todos/gates/monitors/leases/workers，
   * 并从事件日志中过滤掉属于该 goal 的所有事件（含其 worker 的 worker_removed 墓碑
   * 与 lease 的 lease_expired），随后重写持久化文件 —— 让目标状态真正被清除，而非只打墓碑。
   * 返回移除的事件数。
   */
  async removeGoal(goalId: string, dir?: string): Promise<{ removedEvents: number }> {
    // 先收集属于该 goal 的 worker / lease id，用于过滤 worker_removed / lease_expired 事件
    const workerIds = new Set<string>();
    const leaseIds = new Set<string>();
    for (const e of this.events) {
      if (e.type === 'worker_started' || e.type === 'worker_updated') {
        if (e.worker.goalId === goalId) workerIds.add(e.worker.id);
      } else if (e.type === 'lease_acquired') {
        if (e.lease.goalId === goalId) leaseIds.add(e.lease.id);
      }
    }
    const before = this.events.length;
    this.events = this.events.filter((e) => !eventBelongsToGoal(e, goalId, workerIds, leaseIds));
    const removedEvents = before - this.events.length;

    this.goals.delete(goalId);
    for (const [id, t] of this.todos) if (t.goalId === goalId) this.todos.delete(id);
    for (const [id, g] of this.gates) if (g.goalId === goalId) this.gates.delete(id);
    for (const [id, m] of this.monitors) if (m.goalId === goalId) this.monitors.delete(id);
    for (const [id, l] of this.leases) if (l.goalId === goalId) this.leases.delete(id);
    for (const [id, w] of this.workers) if (w.goalId === goalId) this.workers.delete(id);

    await this.persist(dir);
    return { removedEvents };
  }

  /** 清空全部目标状态（内存 + 持久化）。返回移除的事件数。 */
  async clearAll(dir?: string): Promise<{ removedEvents: number }> {
    const removedEvents = this.events.length;
    this.goals.clear();
    this.todos.clear();
    this.gates.clear();
    this.monitors.clear();
    this.leases.clear();
    this.workers.clear();
    this.events = [];
    await this.persist(dir);
    return { removedEvents };
  }

  /**
   * 清理一个 goal 的运行历史：移除该 goal 的 worker 启动/更新/删除、租约获取/过期、
   * 目标完成等历史性事件，并清空其内存中的 worker/lease 记录；
   * 但**保留 goal 本身与其 todos/gates 当前状态**（可继续推进）。
   * 返回移除的事件数。
   */
  async clearHistory(goalId: string, dir?: string): Promise<{ removedEvents: number }> {
    const workerIds = new Set<string>();
    const leaseIds = new Set<string>();
    for (const e of this.events) {
      if (e.type === 'worker_started' || e.type === 'worker_updated') {
        if (e.worker.goalId === goalId) workerIds.add(e.worker.id);
      } else if (e.type === 'lease_acquired') {
        if (e.lease.goalId === goalId) leaseIds.add(e.lease.id);
      }
    }
    const isHistory = (e: LoopEvent): boolean => {
      switch (e.type) {
        case 'goal_completed':
          return e.goalId === goalId;
        case 'lease_acquired':
          return e.lease.goalId === goalId;
        case 'lease_expired':
          return leaseIds.has(e.leaseId);
        case 'worker_started':
        case 'worker_updated':
          return e.worker.goalId === goalId;
        case 'worker_removed':
          return workerIds.has(e.workerId);
        default:
          return false;
      }
    };
    const before = this.events.length;
    this.events = this.events.filter((e) => !isHistory(e));
    for (const [id, w] of this.workers) if (w.goalId === goalId) this.workers.delete(id);
    for (const [id, l] of this.leases) if (l.goalId === goalId) this.leases.delete(id);
    const removedEvents = before - this.events.length;
    await this.persist(dir);
    return { removedEvents };
  }

  /**
   * 删除一条运行记录：移除该 worker 的启动/更新/删除事件并清掉内存 worker 记录，
   * 运行历史（由这些事件派生）随之消失；goal 本身不受影响。
   */
  async removeRun(goalId: string, workerId: string, dir?: string): Promise<{ removedEvents: number }> {
    const before = this.events.length;
    this.events = this.events.filter((e) => {
      if ((e.type === 'worker_started' || e.type === 'worker_updated') && e.worker.id === workerId && e.worker.goalId === goalId) {
        return false;
      }
      if (e.type === 'worker_removed' && e.workerId === workerId) return false;
      return true;
    });
    this.workers.delete(workerId);
    const removedEvents = before - this.events.length;
    await this.persist(dir);
    return { removedEvents };
  }

  /** JSONL 持久化。 */
  async persist(dir?: string): Promise<void> {
    const file = this.filePath ?? path.join(dir ?? '.', '.loop', 'events.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const lines = this.events.map((e) => JSON.stringify(e)).join('\n');
    await fs.writeFile(file, lines + (lines ? '\n' : ''), 'utf-8');
  }

  async restore(dir?: string): Promise<void> {
    const file = this.filePath ?? path.join(dir ?? '.', '.loop', 'events.jsonl');
    try {
      const raw = await fs.readFile(file, 'utf-8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          this.apply(JSON.parse(line) as LoopEvent);
        } catch {
          // 跳过损坏事件
        }
      }
    } catch {
      // 无历史
    }
  }
}

/** 判断事件是否属于某 goal（含其关联的 worker 墓碑 / lease 过期事件）。 */
export function eventBelongsToGoal(e: LoopEvent, goalId: string, workerIds: Set<string>, leaseIds: Set<string>): boolean {
  switch (e.type) {
    case 'goal_created':
      return e.goal.id === goalId;
    case 'goal_completed':
      return e.goalId === goalId;
    case 'todo_updated':
      return e.todo.goalId === goalId;
    case 'gate_passed':
    case 'gate_failed':
      return e.gate.goalId === goalId;
    case 'lease_acquired':
      return e.lease.goalId === goalId;
    case 'lease_expired':
      return leaseIds.has(e.leaseId);
    case 'worker_started':
    case 'worker_updated':
      return e.worker.goalId === goalId;
    case 'worker_removed':
      return workerIds.has(e.workerId);
    default:
      return false;
  }
}
