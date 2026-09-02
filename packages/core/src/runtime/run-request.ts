/**
 * BusyPolicy — 会话忙时的原子行为。
 * 对应 Rust `runtime/run_request.rs`。
 */
export type BusyPolicy = 'enqueue_if_busy' | 'supersede_session';

export const BUSY_POLICY_VALUES: BusyPolicy[] = ['enqueue_if_busy', 'supersede_session'];

export function parseBusyPolicy(value: string): BusyPolicy {
  const v = value.trim();
  if (v === '' || v === 'enqueue_if_busy') return 'enqueue_if_busy';
  if (v === 'supersede_session') return 'supersede_session';
  throw new Error(
    `unknown busy policy \`${value}\`; expected one of: ${BUSY_POLICY_VALUES.join(', ')}`,
  );
}

/** RunAcceptedState / RunAck — 运行受理应答。 */
export interface RunAck {
  runId: string;
  epoch: number;
  runSequence?: number;
  accepted: boolean;
  message?: string;
}
