/** RunEvent — 运行环对外广播的事件。对应 Rust `agent::events`。 */
import type { AgentMessage, Usage } from '@infuture/types';

export type RunEvent =
  | { type: 'text_delta'; runId: string; text: string }
  | { type: 'reasoning_delta'; runId: string; text: string }
  | { type: 'tool_call'; runId: string; id: string; name: string; args: unknown }
  | { type: 'tool_result'; runId: string; id: string; name: string; result: string; isError: boolean; costMs?: number }
  | { type: 'tool_update'; runId: string; tool: string; partial: string }
  | { type: 'approval_requested'; runId: string; requestId: string; toolName: string; args: unknown }
  | { type: 'approval_resolved'; runId: string; requestId: string; approved: boolean; reason?: string }
  | { type: 'usage'; runId: string; usage: Usage }
  | { type: 'complete'; runId: string; message: AgentMessage; usage?: Usage }
  | { type: 'error'; runId: string; message: string }
  | { type: 'cancelled'; runId: string }
  | { type: 'task_type'; runId: string; taskType: 'worker' | 'coding' | 'web' | 'general' };

export type RunEventCallback = (event: RunEvent) => void;
