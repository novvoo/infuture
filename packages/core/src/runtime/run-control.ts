/**
 * RunControl — 单会话生命周期的权威状态机。
 * 对应 Rust `runtime/run_state.rs`。
 *
 * 阶段：starting → running → finalizing → idle；
 * 取消：running → cancelling → (cancellation_stuck 自愈)。
 * 幂等：同 clientRequestId 拒绝重复受理；CancellationStuck 租约在下次 begin 自愈释放。
 */
import { generateId } from '../utils/id.js';

export type RunPhase =
  | 'starting'
  | 'running'
  | 'cancelling'
  | 'cancellation_stuck'
  | 'persistence_degraded'
  | 'finalizing';

export const RUN_PHASES: RunPhase[] = [
  'starting',
  'running',
  'cancelling',
  'cancellation_stuck',
  'persistence_degraded',
  'finalizing',
];

export interface RunLease {
  runId: string;
  epoch: number;
  runSequence?: number;
}

export interface RunSnapshot {
  runId: string;
  epoch: number;
  runSequence?: number;
  phase: RunPhase;
}

interface ActiveRun {
  lease: RunLease;
  clientRequestId: string;
  phase: RunPhase;
  cancel: (() => void) | null;
}

export interface RunControlOptions {
  /** 取消时回调（中断 LLM 流）。 */
  onCancel?: (runId: string) => void;
  /** 持久化降级时回调。 */
  onPersistenceDegraded?: (runId: string) => void;
}

/**
 * 会话运行的受理控制。`isStreaming` 仅作旧客户端兼容投影；
 * 受理与完成决策必须以本状态机为准。
 */
export class RunControl {
  private active: ActiveRun | null = null;
  private epoch = 0;
  private recentRequests: Array<{ requestId: string; lease: RunLease }> = [];
  private isStreamingFlag = false;
  private activeTasks = 0;
  private persistenceDegradedCount = 0;

  constructor(private readonly options: RunControlOptions = {}) {}

  get isStreaming(): boolean {
    return this.isStreamingFlag;
  }

  get activeTaskCount(): number {
    return this.activeTasks;
  }

  get persistenceDegraded(): number {
    return this.persistenceDegradedCount;
  }

  /** 受理一个新 run；忙时抛错或走 busy 策略（由 SessionRuntime 处理）。 */
  begin(requestedRunId?: string | null, clientRequestId?: string | null, runSequence?: number): RunLease {
    const crid = clientRequestId ?? '';
    const alreadyAccepted =
      crid !== '' &&
      ((this.active && this.active.clientRequestId === crid && this.active.phase !== 'cancellation_stuck') ||
        this.recentRequests.some((r) => r.requestId === crid));
    if (alreadyAccepted) {
      throw new Error(`client request \`${crid}\` was already accepted`);
    }

    // 自愈 cancellation_stuck 死租约
    if (this.active && this.active.phase === 'cancellation_stuck') {
      const dead = this.active.lease;
      this.active = null;
      this.isStreamingFlag = false;
      this.activeTasks = Math.max(0, this.activeTasks - 1);
      // 不把死 clientRequestId 推进 recentRequests：卡死 run 未完成，同 id 重试必须放行
    } else if (this.active) {
      throw new Error(
        `agent run ${this.active.lease.runId} is ${this.active.phase}; wait for it to finish before starting another run`,
      );
    }

    this.epoch = this.epoch + 1;
    const lease: RunLease = {
      runId: requestedRunId && requestedRunId !== '' ? requestedRunId : generateId('run'),
      epoch: this.epoch,
      runSequence,
    };
    this.active = { lease, clientRequestId: crid, phase: 'starting', cancel: null };
    this.isStreamingFlag = true;
    this.activeTasks += 1;
    return lease;
  }

  /** 安装取消通道并转入 running。 */
  installCancellation(lease: RunLease, cancel: () => void): boolean {
    if (!this.active) return false;
    if (this.active.lease.runId !== lease.runId || this.active.lease.epoch !== lease.epoch) return false;
    this.active.cancel = cancel;
    this.active.phase = 'running';
    return true;
  }

  /** 请求取消，不把会话置闲。仅匹配 run 可经 finalizing 释放会话。 */
  cancel(lease: RunLease): boolean {
    if (!this.active || this.active.lease.runId !== lease.runId) return false;
    this.active.phase = 'cancelling';
    this.active.cancel?.();
    return true;
  }

  /** 标记取消卡死。 */
  markCancellationStuck(lease: RunLease): boolean {
    if (!this.active || this.active.lease.runId !== lease.runId) return false;
    this.active.phase = 'cancellation_stuck';
    return true;
  }

  /** 转入 finalizing。 */
  finalizing(lease: RunLease): boolean {
    if (!this.active || this.active.lease.runId !== lease.runId) return false;
    this.active.phase = 'finalizing';
    return true;
  }

  /** run 终止：释放会话。 */
  complete(lease: RunLease, persistenceOk = true): void {
    if (!this.active || this.active.lease.runId !== lease.runId) return;
    if (!persistenceOk) {
      // fail-closed：持久化失败需人工介入
      this.active.phase = 'persistence_degraded';
      this.persistenceDegradedCount += 1;
      this.options.onPersistenceDegraded?.(lease.runId);
      return;
    }
    if (this.active.clientRequestId) {
      this.recentRequests.push({ requestId: this.active.clientRequestId, lease });
      if (this.recentRequests.length > 64) this.recentRequests.shift();
    }
    this.active = null;
    this.isStreamingFlag = false;
    this.activeTasks = Math.max(0, this.activeTasks - 1);
  }

  /** 当前快照。 */
  snapshot(): RunSnapshot | null {
    if (!this.active) return null;
    return { ...this.active.lease, phase: this.active.phase };
  }
}
