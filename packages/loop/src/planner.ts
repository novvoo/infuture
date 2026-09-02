/**
 * LoopPlanner — 长运行编排：驱动 goals → todos → gates → monitors 的一轮推进。
 * 对应 future-os `orchestration/loop` 的 executor / drive 层。
 */
import type { Engine } from '@infuture/core';
import { LoopStore } from './store.js';
import { shouldRun, gatePassed } from './kernel.js';
import type { Gate, Goal, Monitor, Todo } from './types.js';
import { generateId } from '@infuture/core';

export type LoopApprovalMode = 'timeout' | 'auto' | 'deny';

export interface LoopPlannerOptions {
  engine: Engine;
  store?: LoopStore;
  /** 每个 goal 并行 agent 数上限。 */
  maxParallel?: number;
  leaseMs?: number;
  cwd?: string;
  /**
   * 无人值守 loop 的审批策略：
   * - timeout: 不干预，等审批门超时自动拒绝（默认，保守）
   * - auto   : 自动批准所有工具调用（适合可信无人值守）
   * - deny   : 快速拒绝（跳过 5 分钟等待）
   */
  approvalMode?: LoopApprovalMode;
}

export class LoopPlanner {
  readonly store: LoopStore;
  private readonly engine: Engine;
  private readonly maxParallel: number;
  private readonly leaseMs: number;
  private readonly approvalMode: LoopApprovalMode;

  constructor(options: LoopPlannerOptions) {
    this.engine = options.engine;
    this.store = options.store ?? new LoopStore();
    this.maxParallel = options.maxParallel ?? 1;
    this.leaseMs = options.leaseMs ?? 5 * 60 * 1000;
    this.approvalMode = options.approvalMode ?? 'timeout';
  }

  createGoal(title: string, objective: string, acceptanceCriteria: string[]): Goal {
    const goal: Goal = {
      id: generateId('goal'),
      title,
      objective,
      acceptanceCriteria,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.store.addGoal(goal);
    return goal;
  }

  addTodo(goalId: string, title: string, dependencies: string[] = []): Todo {
    const todo: Todo = {
      id: generateId('todo'),
      goalId,
      title,
      status: 'pending',
      dependencies,
      evidence: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.store.setTodo(todo);
    return todo;
  }

  addGate(goalId: string, kind: Gate['kind'], check: string, evidenceFloor = 1): Gate {
    const gate: Gate = { id: generateId('gate'), goalId, kind, check, evidenceFloor, passed: false };
    this.store.setGate(gate, false);
    return gate;
  }

  /** 推进一轮：对每个 active goal 决定是否运行并执行 runnable todo。 */
  async driveOnce(cwd?: string): Promise<{ ran: number; completed: Goal[] }> {
    const completed: Goal[] = [];
    let ran = 0;

    for (const goal of this.store.goalsFor()) {
      if (goal.status !== 'active') continue;
      const lease = this.store.activeLease(goal.id);
      const decision = shouldRun({
        goal,
        todos: this.store.todosFor(goal.id),
        gates: this.store.gatesFor(goal.id),
        activeLease: lease,
      });

      if (!decision.shouldRun) {
        // 全部完成 → 标记 goal 完成
        const allTodoDone = this.store.todosFor(goal.id).every((t) => t.status === 'done' || t.status === 'skipped');
        if (allTodoDone && decision.pendingGates.length === 0) {
          this.store.completeGoal(goal.id);
          completed.push(goal);
        }
        continue;
      }

      const newLease = {
        id: generateId('lease'),
        goalId: goal.id,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + this.leaseMs,
        holder: `loop-${goal.id}`,
      };
      this.store.acquireLease(newLease);

      for (const todo of decision.runnableTodos.slice(0, this.maxParallel)) {
        await this.executeTodo(goal, todo, cwd);
        ran++;
      }

      this.store.releaseLease(newLease.id);
    }

    return { ran, completed };
  }

  private async executeTodo(goal: Goal, todo: Todo, cwd?: string): Promise<void> {
    this.store.setTodo({ ...todo, status: 'in_progress', updatedAt: Date.now() });
    try {
      const session = await this.engine.sessions.create(`loop-${goal.id}-${todo.id}`);
      const outcome = await this.engine.run(session, todo.title, {
        onEvent: (ev) => {
          // 工具结果作为证据记录
          if (ev.type === 'tool_result' && !ev.isError) {
            todo.evidence.push(`[${ev.name}] ${ev.result.slice(0, 200)}`);
          }
          // 无人值守审批策略
          if (ev.type === 'approval_requested') {
            if (this.approvalMode === 'auto') this.engine.approval.resolveApproval(ev.requestId, true);
            else if (this.approvalMode === 'deny') this.engine.approval.resolveApproval(ev.requestId, false);
          }
        },
      });
      const updated = { ...todo, status: outcome.error ? 'blocked' as const : 'done' as const, blocker: outcome.error, updatedAt: Date.now() };
      this.store.setTodo(updated);

      // 更新 gate 证据
      for (const gate of this.store.gatesFor(goal.id)) {
        if (gate.kind === 'evidence') {
          const passed = gatePassed(gate, updated.evidence.length);
          if (!gate.passed) this.store.setGate({ ...gate, passed, lastRun: Date.now() }, passed);
        }
      }
    } catch (err) {
      this.store.setTodo({
        ...todo,
        status: 'blocked',
        blocker: err instanceof Error ? err.message : String(err),
        updatedAt: Date.now(),
      });
    }
  }

  /** 注册监控指标。 */
  async tickMonitors(report: (goalId: string, metric: string, value: number) => number): Promise<void> {
    for (const goal of this.store.goalsFor()) {
      for (const m of this.store.monitorsFor(goal.id)) {
        const value = report(goal.id, m.metric, m.lastValue ?? 0);
        const ok = value >= m.threshold;
        void ok;
      }
    }
  }

  addMonitor(goalId: string, metric: string, threshold: number): Monitor {
    const m: Monitor = { id: generateId('mon'), goalId, metric, threshold, ok: false };
    this.store.addMonitor(m);
    return m;
  }
}
