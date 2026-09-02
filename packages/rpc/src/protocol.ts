/**
 * RPC 协议 — infuture 的客户端/服务端消息契约。
 * 对应 future-os `packages/rpc`（原 protobuf）的 JSON-RPC 形态。
 * 字段保持 snake_case 兼容。
 */

export interface RpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface RpcNotification {
  jsonrpc?: '2.0';
  method: string;
  params?: unknown;
}

/** 服务端 → 客户端事件通知（run 事件流、审批请求等）。 */
export type ServerEvent =
  | { method: 'event'; params: { event: unknown } }
  | { method: 'approval.pending'; params: { requestId: string; toolName: string; args: unknown; sessionId: string } };

/** 方法名枚举。 */
export const METHODS = {
  SessionCreate: 'session.create',
  SessionList: 'session.list',
  SessionGet: 'session.get',
  SessionFork: 'session.fork',
  SessionDelete: 'session.delete',
  SessionRename: 'session.rename',
  SessionSend: 'session.send',
  SessionStop: 'session.stop',
  SessionMessages: 'session.messages',
  ToolInvoke: 'tool.invoke',
  ToolList: 'tools.list',
  ModelList: 'model.list',
  ModelSelect: 'model.select',
  ModelCustom: 'model.custom',
  ModelRemove: 'model.remove',
  SkillList: 'skill.list',
  ApprovalResolve: 'approval.resolve',
  SettingsGet: 'settings.get',
  SettingsSet: 'settings.set',
  AuthGet: 'auth.get',
  AuthSet: 'auth.set',
  SearchVerify: 'search.verify',
  ChannelConfigGet: 'channel.config.get',
  ChannelConfigSet: 'channel.config.set',
  ChannelStatus: 'channel.status',
  ChannelStart: 'channel.start',
  ChannelStop: 'channel.stop',
  Doctor: 'doctor',
  FsList: 'fs.list',
  FsBrowse: 'fs.browse',
  FsRead: 'fs.read',
  FsWrite: 'fs.write',
  FsMkdir: 'fs.mkdir',
  FsRemove: 'fs.remove',
  FsRename: 'fs.rename',
  LoopWorkerList: 'loop.worker.list',
  LoopWorkerStop: 'loop.worker.stop',
  LoopWorkerSteer: 'loop.worker.steer',
  LoopWorkerSpawn: 'loop.worker.spawn',
  LoopWorkerRemove: 'loop.worker.remove',
  LoopGoalDelete: 'loop.control.goal.delete',
  LoopGoalHistoryClear: 'loop.control.goal.history.clear',
  LoopGoalRunRemove: 'loop.control.goal.run.remove',
  LoopControlClear: 'loop.control.clear',
  LoopGoalTodos: 'loop.control.goal.todos',
  LoopGoalEvents: 'loop.control.goal.events',
  LoopStatus: 'loop.control.status',
  LoopRuns: 'loop.control.runs',
  LoopFrontier: 'loop.control.frontier',
  LoopTaskGraph: 'loop.control.taskGraph',
  LoopLease: 'loop.control.lease',
} as const;

export type MethodName = (typeof METHODS)[keyof typeof METHODS];
