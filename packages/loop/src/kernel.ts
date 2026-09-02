/**
 * Should-Run Kernel — 确定性决策：目标是否应继续运行、哪些 todo 可推进。
 * 对应 future-os `orchestration/loop` 的 deterministic should-run kernel。
 * 纯函数，无副作用，便于测试。
 */
import type { Goal, Gate, Todo } from './types.js';

export interface ShouldRunInput {
  goal: Goal;
  todos: Todo[];
  gates: Gate[];
  activeLease?: { id: string; expiresAt: number } | null;
  now?: number;
}

export interface ShouldRunDecision {
  shouldRun: boolean;
  reason: string;
  /** 可推进的 todo（依赖满足且未阻塞）。 */
  runnableTodos: Todo[];
  /** 未通过且达到运行条件的 gate。 */
  pendingGates: Gate[];
}

/**
 * 决定是否运行 & 哪些 todo 可推进。
 * 规则：
 *  - goal 非 active → 不运行
 *  - 持有有效租约 → 不重复运行（防抖动）
 *  - 无 pending todo 且所有 gate 通过 → 完成
 */
export function shouldRun(input: ShouldRunInput): ShouldRunDecision {
  const now = input.now ?? Date.now();

  if (input.goal.status !== 'active') {
    return { shouldRun: false, reason: `goal status is ${input.goal.status}`, runnableTodos: [], pendingGates: [] };
  }
  if (input.activeLease && input.activeLease.expiresAt > now) {
    return { shouldRun: false, reason: 'active lease held', runnableTodos: [], pendingGates: [] };
  }

  const pendingGates = input.gates.filter((g) => !g.passed);
  const runnableTodos = input.todos.filter((t) => {
    if (t.status === 'done' || t.status === 'skipped') return false;
    if (t.status === 'blocked') return false;
    // 依赖全部 done
    const depsOk = t.dependencies.every((depId) => input.todos.some((d) => d.id === depId && d.status === 'done'));
    return depsOk;
  });

  const allTodoDone = input.todos.every((t) => t.status === 'done' || t.status === 'skipped');
  if (allTodoDone && pendingGates.length === 0) {
    return { shouldRun: false, reason: 'all todos done, all gates passed', runnableTodos: [], pendingGates: [] };
  }

  return {
    shouldRun: runnableTodos.length > 0,
    reason: runnableTodos.length > 0 ? `${runnableTodos.length} todo(s) runnable` : 'no runnable todos',
    runnableTodos,
    pendingGates,
  };
}

/** 检查一条 gate：是否达到验收标准（evidence floor）。 */
export function gatePassed(gate: Gate, evidenceCount: number): boolean {
  return evidenceCount >= gate.evidenceFloor;
}
