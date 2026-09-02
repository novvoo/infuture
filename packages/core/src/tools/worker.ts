/**
 * spawn_workers — 启动多个并行/协作 worker（子 agent）探索目标。
 * 通过回调委托 loop worker 运行时（desktop 注入），inloop 可在普通对话中启动 worker。
 * 任务 prompt 内可用 `{wN}`（1-based）引用前序 worker 的最终输出，实现"解决+反思"等协作。
 */
import type { AgentTool, ToolCallResult } from '@infuture/types';
import { toolDef } from '@infuture/types';

export interface SpawnWorkerTask {
  title: string;
  prompt: string;
  /** 该 worker 使用的模型 id（用户配置中的模型 id；缺省用默认模型）。 */
  model?: string;
  /** 思考强度（thinking budget，数值越大推理越深；缺省用默认）。 */
  thinking?: number;
}

export type WorkerSpawner = (
  goalId: string,
  tasks: SpawnWorkerTask[],
  isolate?: boolean,
) => Promise<unknown>;

export type WorkerLister = (goalId?: string) => Promise<unknown>;

/** worker 终态：wait 模式下全部进入这些状态即视为完成。 */
const TERMINAL_WORKER_STATUS = new Set(['done', 'error', 'stopped']);

function normalizeWorkerList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray((raw as { workers?: unknown }).workers)) {
    return (raw as { workers: unknown[] }).workers;
  }
  return [];
}

function workerStatus(w: unknown): string | undefined {
  return (w as { status?: string } | undefined)?.status;
}

/** 轮询 lister 直到该 goal 全部 worker 进入终态（done/error/stopped）或超时/取消。 */
async function waitAllWorkers(
  lister: NonNullable<WorkerLister>,
  goal: string | undefined,
  timeoutSec: number,
  signal?: AbortSignal,
): Promise<{ workers: unknown[]; timedOut: boolean; aborted: boolean }> {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    if (signal?.aborted) return { workers: [], timedOut: false, aborted: true };
    const workers = normalizeWorkerList(await lister(goal));
    const allTerminal =
      workers.length > 0 && workers.every((w) => !!workerStatus(w) && TERMINAL_WORKER_STATUS.has(workerStatus(w)!));
    if (allTerminal) return { workers, timedOut: false, aborted: false };
    if (Date.now() >= deadline) return { workers, timedOut: true, aborted: false };
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** list_workers — 读取 worker 状态与最终输出（含 result/error/status）。配合 spawn_workers 做"直到完成"的多轮迭代决策。 */
export function listWorkersTool(lister?: WorkerLister): AgentTool {
  return {
    def: toolDef('list_workers', '读取已启动 worker 的状态与最终输出（status/result/error，按 goal 过滤）。传 wait:true 会阻塞等待该 goal 全部 worker 进入终态（done/error/stopped，最多 timeoutSec 秒）后一次性返回全部结果——spawn_workers 之后调用一次即可拿到所有 worker 的最终输出，无需反复轮询消耗轮次。', {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'goal id/标题过滤（缺省返回全部 worker）' },
        wait: { type: 'boolean', description: '是否阻塞等待该 goal 全部 worker 完成后再返回（默认 false）' },
        timeoutSec: { type: 'number', description: 'wait 模式下的最长等待秒数（默认 600）' },
      },
    }),
    guidelines: [
      'spawn_workers 后调用 list_workers({goal, wait:true}) 阻塞等待全部 worker 完成，拿到各自 result/error 后向用户汇报；如需限制等待时长可传 timeoutSec',
      'worker 的 result 是其最终答复文本，可注入后续 worker prompt（{wN}）',
    ],
    handler: async (args, ctx): Promise<ToolCallResult> => {
      if (!lister) {
        return { result: 'list_workers: worker 运行时未注入（当前环境不支持，desktop 端可用）', is_error: true };
      }
      const { goal, wait, timeoutSec } = (args ?? {}) as { goal?: string; wait?: boolean; timeoutSec?: number };
      const g = typeof goal === 'string' && goal ? goal : undefined;
      try {
        if (wait === true) {
          const t0 = Date.now();
          const { workers, timedOut, aborted } = await waitAllWorkers(lister, g, timeoutSec || 600, ctx?.signal);
          const body = JSON.stringify(workers, null, 2);
          if (aborted) {
            return { result: `list_workers: 等待已被取消。当前状态：\n${body}`, is_error: false };
          }
          const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
          const note = timedOut
            ? `\n(已等待 ${elapsed}s 超时，仍有 worker 未完成，可再次调用 wait 继续等待)`
            : `\n(全部 worker 已完成，等待 ${elapsed}s)`;
          return { result: body + note, is_error: false };
        }
        const workers = await lister(g);
        return { result: JSON.stringify(workers, null, 2), is_error: false };
      } catch (err) {
        return { result: `list_workers 失败: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
      }
    },
  };
}

export function spawnWorkersTool(spawner?: WorkerSpawner): AgentTool {
  return {
    def: toolDef('spawn_workers', '启动多个并行/协作 worker（子 agent）探索目标。适合多角色分工：多个 worker 用不同模型分别探索、一个 worker 反思前序输出、再分多 worker 二轮深化。tasks 每项 {title, prompt, model?, thinking?}；model 为该 worker 指定模型（必须是用户配置中的模型 id，缺省用默认模型），thinking 为思考强度（数值越大推理越深）。prompt 内可用 {w1}/{w2}（1-based）引用前序 worker 的最终输出——前序完成后其结果自动注入该 worker 的 prompt 再启动。适合"多个 worker 用不同模型分别探索、一个 worker 反思第一个的输出、再分多 worker 二轮深化"等协作。', {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '目标 id/标题（如用户目标的一段摘要）' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'worker 名称/角色' },
              prompt: { type: 'string', description: '该 worker 的任务；可用 {w1}/{w2}… 引用前序 worker 输出' },
              model: { type: 'string', description: '该 worker 使用的模型 id（用户配置中的 id；缺省用默认模型）' },
              thinking: { type: 'number', description: '思考强度/思考预算（数值越大推理越深；缺省用默认）' },
            },
            required: ['title', 'prompt'],
          },
          description: 'worker 任务列表（顺序即依赖编号）',
        },
        isolate: { type: 'boolean', description: '是否隔离工作目录（默认 false）' },
      },
      required: ['goal', 'tasks'],
    }),
    guidelines: [
      '按用户角色拆分为多个任务：第 1 个解决目标，后续 worker 可用 {w1} 引用其输出做反思/审查',
      '若用户只要求"启动 N 个 worker 探索"，tasks 可给同一目标的 N 个不同切入角度',
    ],
    handler: async (args): Promise<ToolCallResult> => {
      if (!spawner) {
        return { result: 'spawn_workers: worker 运行时未注入（当前环境不支持，desktop 端可用）', is_error: true };
      }
      const { goal, tasks, isolate } = (args ?? {}) as {
        goal?: string;
        tasks?: { title?: string; prompt?: string; model?: string; thinking?: number }[];
        isolate?: boolean;
      };
      if (!goal || !Array.isArray(tasks) || tasks.length === 0) {
        return { result: 'spawn_workers: 需要 goal + tasks[]', is_error: true };
      }
      const normalized = tasks
        .filter((t) => t && t.prompt)
        .map((t) => ({
          title: t.title ?? 'worker',
          prompt: t.prompt as string,
          model: typeof t.model === 'string' && t.model ? t.model : undefined,
          thinking: typeof t.thinking === 'number' && t.thinking > 0 ? t.thinking : undefined,
        }));
      if (normalized.length === 0) {
        return { result: 'spawn_workers: tasks 缺少有效 prompt', is_error: true };
      }
      try {
        const workers = await spawner(goal, normalized, isolate === true);
        return { result: `已启动 ${normalized.length} 个 worker（goal=${goal}）：\n` + JSON.stringify(workers, null, 2), is_error: false };
      } catch (err) {
        return { result: `spawn_workers 失败: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
      }
    },
  };
}
