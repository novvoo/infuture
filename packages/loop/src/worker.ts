/**
 * WorkerRuntime — goal 下的多 worker 并行探索运行时。
 * 对应 future-os `orchestration/loop` 的 worker 机制：
 *  - 一个 goal 可 spawn 多个 worker，各自独立 agent 会话（WorkerSessionBound）
 *  - 每个 worker 运行在隔离工作目录（git worktree，非 git 仓库 fallback 临时目录）
 *  - 支持 worker list / stop（turn 边界中断）/ steer（定向或广播指令）
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Engine } from '@infuture/core';
import { generateId } from '@infuture/core';
import type { LoopStore } from './store.js';
import type { Worker, WorkerStatus } from './types.js';

const execFileAsync = promisify(execFile);

export interface WorkerTask {
  title: string;
  /** 探索提示词（默认用 title）。 */
  prompt?: string;
  /** 该 worker 使用的模型 id（缺省用默认模型）。 */
  model?: string;
  /** 该 worker 的思考强度（thinking budget，缺省用默认）。 */
  thinking?: number;
}

export interface WorkerRuntimeOptions {
  engine: Engine;
  store: LoopStore;
  /** worktree 隔离：true 时每个 worker 用独立 git worktree/临时目录。 */
  isolate?: boolean;
  /** 隔离目录基址（默认仓库根或 tmp）。 */
  baseDir?: string;
  /** 外部事件回调（前端/RPC 用）。 */
  onWorkerEvent?: (worker: Worker, ev: unknown) => void;
}

/** 为 worker 创建隔离工作目录：git 仓库 → worktree；否则临时目录。 */
async function createWorkerWorktree(baseDir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: baseDir });
    if (stdout.trim() === 'true') {
      const dir = path.join(
        os.tmpdir(),
        `infuture-worker-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      );
      const branch = `worker/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      await execFileAsync('git', ['worktree', 'add', '-b', branch, dir], { cwd: baseDir });
      return dir;
    }
  } catch {
    // 非 git 仓库，fallback 到临时目录
  }
  return fs.mkdtemp(path.join(os.tmpdir(), 'infuture-worker-'));
}

export class WorkerRuntime {
  private readonly engine: Engine;
  private readonly store: LoopStore;
  private readonly isolate: boolean;
  private readonly baseDir: string;
  private readonly onWorkerEvent?: (worker: Worker, ev: unknown) => void;
  /** workerId → runId（engine.run 返回前从事件流捕获）。 */
  private runIds = new Map<string, string>();

  constructor(options: WorkerRuntimeOptions) {
    this.engine = options.engine;
    this.store = options.store;
    this.isolate = options.isolate ?? false;
    this.baseDir = options.baseDir ?? this.engine.workspace;
    this.onWorkerEvent = options.onWorkerEvent;
  }

  /** 为 goal 并行启动多个 worker，立即返回（各自异步运行）。若 goal 不存在则自动创建。
   *  任务 prompt 可用 `{wN}`（1-based）引用前序 worker 的最终输出：被引用的 worker 完成后，
   *  其结果会注入到该 worker 的 prompt 再启动（实现"一个 worker 解决目标、另一个反思其输出"等差异化协作）。 */
  async spawn(goalId: string, tasks: WorkerTask[], opts: { isolate?: boolean } = {}): Promise<Worker[]> {
    if (!goalId) throw new Error('goalId required');
    const isolate = opts.isolate ?? this.isolate;
    // goal 不存在则自动创建（桌面端直接 spawn 时目标菜单能显示真实目标实体）
    if (this.store.goalsFor(goalId).length === 0) {
      const first = tasks[0];
      this.store.addGoal({
        id: goalId,
        title: first?.title ?? goalId,
        objective: first?.prompt ?? '',
        acceptanceCriteria: [],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    const workers: Worker[] = [];
    for (const task of tasks) {
      const worker = await this.createWorker(goalId, task, isolate);
      workers.push(worker);
    }
    // 依赖编排：解析 {wN} 占位符 → 前序完成后注入其输出再启动；无依赖则立即并行启动
    const donePromises: Array<Promise<void> | undefined> = new Array(tasks.length);
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const refs = [...(task.prompt ?? '').matchAll(/\{w(\d+)\}/g)]
        .map((m) => parseInt(m[1], 10) - 1)
        .filter((x) => x >= 0 && x < tasks.length && x !== i);
      const run = (async () => {
        if (refs.length > 0) {
          await Promise.all(refs.map((r) => donePromises[r]!));
          const injected = (task.prompt ?? '').replace(/\{w(\d+)\}/g, (_, n) => {
            const id = workers[parseInt(n, 10) - 1]?.id;
            const src = id ? this.store.worker(id) : undefined;
            return src?.result ?? src?.error ?? '(前序 worker 无输出)';
          });
          await this.runWorker(workers[i], injected);
        } else {
          await this.runWorker(workers[i], task.prompt ?? task.title);
        }
      })();
      donePromises[i] = run;
    }
    return workers;
  }

  private async createWorker(goalId: string, task: WorkerTask, isolate: boolean): Promise<Worker> {
    const cwd = isolate ? await createWorkerWorktree(this.baseDir) : this.baseDir;
    const session = await this.engine.sessions.create(`[worker] ${task.title}`, { setCurrent: false });
    session.meta.cwd = cwd; // 会话工作目录 = worker 隔离目录（工具按 session cwd 执行）
    const worker: Worker = {
      id: generateId('worker'),
      goalId,
      title: task.title,
      status: 'idle',
      sessionId: session.id,
      model: task.model,
      thinking: task.thinking,
      runId: '',
      cwd,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.store.addWorker(worker);
    this.emit(worker, { type: 'worker_started', worker });
    return worker;
  }

  private async runWorker(worker: Worker, prompt: string): Promise<void> {
    const w = { ...worker, status: 'running' as WorkerStatus, updatedAt: Date.now() };
    this.store.updateWorker(w);
    this.emit(w, { type: 'worker_updated', worker: w });
    try {
      const outcome = await this.engine.run(w.sessionId, prompt, {
        // per-worker 模型/思考强度覆盖默认
        model: w.model,
        thinkingBudget: w.thinking,
        onEvent: (ev) => {
          // 捕获 runId（事件流首个带 runId 的事件）
          const rid = (ev as { runId?: string }).runId;
          if (rid && !this.runIds.has(w.id)) this.runIds.set(w.id, rid);
          this.emit(w, ev);
        },
      });
      this.runIds.set(w.id, outcome.runId);
      const done: Worker = {
        ...w,
        status: outcome.cancelled ? ('stopped' as WorkerStatus) : outcome.error ? ('error' as WorkerStatus) : ('done' as WorkerStatus),
        runId: outcome.runId,
        result: outcome.error ? undefined : outcome.reply,
        error: outcome.error,
        updatedAt: Date.now(),
      };
      this.store.updateWorker(done);
      this.emit(done, { type: 'worker_updated', worker: done });
    } catch (err) {
      const failed: Worker = {
        ...w,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        updatedAt: Date.now(),
      };
      this.store.updateWorker(failed);
      this.emit(failed, { type: 'worker_updated', worker: failed });
    }
  }

  /** worker 列表。 */
  list(goalId?: string): Worker[] {
    return this.store.workersFor(goalId);
  }

  /** 停止一个 worker：在 turn 边界中断当前 run。 */
  async stop(workerId: string): Promise<Worker | undefined> {
    const w = this.store.worker(workerId);
    if (!w) return undefined;
    const runId = this.runIds.get(workerId);
    if (runId) await this.engine.stop(runId);
    const stopped: Worker = { ...w, status: 'stopped', updatedAt: Date.now() };
    this.store.updateWorker(stopped);
    this.emit(stopped, { type: 'worker_updated', worker: stopped });
    return stopped;
  }

  /** 指引一个 worker（WorkerSteered）：追加指令，当前 run 完成后排队执行。 */
  async steer(workerId: string, instruction: string): Promise<Worker | undefined> {
    const w = this.store.worker(workerId);
    if (!w) return undefined;
    const steered: Worker = { ...w, lastSteer: { instruction, at: Date.now() }, updatedAt: Date.now() };
    this.store.updateWorker(steered);
    this.emit(steered, { type: 'worker_updated', worker: steered });
    // 追加到 worker 会话，busy 时排队（当前 run 完成后执行）
    void this.engine.run(w.sessionId, instruction, {
      busyPolicy: 'enqueue_if_busy',
      onEvent: (ev) => this.emit(steered, ev),
    });
    return steered;
  }

  /** 指引某 goal 的全部 worker（广播）。 */
  async steerAll(goalId: string, instruction: string): Promise<number> {    const workers = this.store.workersFor(goalId);
    for (const w of workers) {
      if (w.status === 'running' || w.status === 'idle') {
        await this.steer(w.id, instruction);
      }
    }
    return workers.length;
  }

  /** 删除一个 worker 记录（运行中的先停止再删，历史记录一并清除）。 */
  async remove(workerId: string): Promise<boolean> {
    const w = this.store.worker(workerId);
    if (!w) return false;
    const runId = this.runIds.get(workerId);
    if (runId) await this.engine.stop(runId);
    this.runIds.delete(workerId);
    this.store.removeWorker(workerId);
    this.emit(w, { type: 'worker_removed', workerId });
    return true;
  }

  private emit(worker: Worker, ev: unknown): void {
    this.onWorkerEvent?.(worker, ev);
  }
}
