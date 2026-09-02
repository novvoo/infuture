/**
 * 沙箱与审批门 — Trust-First 工具执行。
 * 对应 Rust `sandbox::*`。
 *
 * SandboxTier:
 * - off    : 直接执行
 * - manual : 每个工具调用都需人工审批
 * - sandbox: 平台规则（macOS seatbelt / Windows 受限令牌）+ 审批
 *            （TS 侧实现策略描述层；平台强隔离降级为 manual 并记录 tier:"degraded"）
 */
export type SandboxTier = 'off' | 'manual' | 'sandbox';

export const SANDBOX_TIERS: SandboxTier[] = ['off', 'manual', 'sandbox'];

export function parseSandboxTier(value: string): SandboxTier {
  const v = value.trim().toLowerCase();
  if (v === 'off') return 'off';
  if (v === 'manual') return 'manual';
  if (v === 'sandbox') return 'sandbox';
  throw new Error(`unknown sandbox tier \`${value}\`; expected off|manual|sandbox`);
}

export interface ApprovalRequest {
  requestId: string;
  toolName: string;
  args: unknown;
  sessionId: string;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
}

/**
 * 审批门。tier=manual/sandbox 时对工具调用发起审批；
 * 也可由调用方注入 autoApprove 策略（CLI 无人值守）。
 */
export interface ApprovalGate {
  tier: SandboxTier;
  /** 请求审批；tier=off 时总是放行。 */
  request(approval: ApprovalRequest): Promise<ApprovalDecision>;
  /** 将挂起审批推送给外部 UI（桌面弹窗 / TUI /approve）。 */
  onPending?: (approval: ApprovalRequest) => void;
}

export interface ApprovalGateOptions {
  tier: SandboxTier;
  /** 是否自动批准（沙箱内跑测试用；生产必须 false）。 */
  autoApprove?: boolean;
  /** 自定义决策器（如桌面 UI 注入的 resolver）。 */
  resolver?: (approval: ApprovalRequest) => Promise<ApprovalDecision>;
  /** 挂起审批超时（默认 5 分钟，超时自动拒绝，避免 run 永久挂起）。 */
  timeoutMs?: number;
}

export class DefaultApprovalGate implements ApprovalGate {
  tier: SandboxTier;
  onPending?: (approval: ApprovalRequest) => void;

  private readonly autoApprove: boolean;
  private readonly timeoutMs: number;
  private resolver?: (approval: ApprovalRequest) => Promise<ApprovalDecision>;
  private pending = new Map<string, (d: ApprovalDecision) => void>();

  constructor(options: ApprovalGateOptions) {
    this.tier = options.tier;
    this.autoApprove = options.autoApprove ?? false;
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    this.resolver = options.resolver;
  }

  setTier(tier: SandboxTier): void {
    this.tier = tier;
  }

  /** 外部注入审批决策器（桌面 UI / RPC 服务）。 */
  setResolver(resolver: (approval: ApprovalRequest) => Promise<ApprovalDecision>): void {
    this.resolver = resolver;
  }

  async request(approval: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.tier === 'off') return { approved: true, reason: 'tier=off' };
    if (this.autoApprove) return { approved: true, reason: 'autoApprove' };

    this.onPending?.(approval);

    if (this.resolver) {
      return await this.resolver(approval);
    }

    // 默认：挂起等待外部 resolveApproval（带超时自动拒绝）
    return await new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(approval.requestId);
        resolve({ approved: false, reason: 'approval timeout' });
      }, this.timeoutMs);
      this.pending.set(approval.requestId, (d) => {
        clearTimeout(timer);
        resolve(d);
      });
    });
  }

  /** 外部 UI 调用以响应挂起审批。 */
  resolveApproval(requestId: string, approved: boolean): void {
    const resolve = this.pending.get(requestId);
    if (resolve) {
      this.pending.delete(requestId);
      resolve({ approved });
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }
}
