/**
 * ServerSession — 把 Engine 暴露为 JSON-RPC 服务。
 * 对应 future-os `rpc::ServerSession`。
 */
import type { Engine } from '@infuture/core';
import { discoverSkills } from '@infuture/core';
import type { ApprovalRequest } from '@infuture/core';
import type { RunEventCallback } from '@infuture/core';
import { LoopControl, LoopStore, WorkerRuntime } from '@infuture/loop';
import type { ChannelManager } from '@infuture/channels';
import { newUserMessage } from '@infuture/types';
import { METHODS, type RpcNotification, type RpcRequest, type RpcResponse } from './protocol.js';
import path from 'node:path';
import fs from 'node:fs/promises';

export interface ServerSessionOptions {
  /** 审批决策注入器（桌面 UI 等）。 */
  approvalResolver?: (approval: ApprovalRequest) => Promise<{ approved: boolean; reason?: string }>;
  /** IM 桥接管理器（桌面端注入，用于 channel.* RPC）。 */
  channelManager?: ChannelManager;
}

export class ServerSession {
  readonly engine: Engine;
  private onNotification?: (n: RpcNotification) => void;
  private readonly channelManager?: ChannelManager;

  constructor(engine: Engine, options: ServerSessionOptions = {}) {
    this.engine = engine;
    this.channelManager = options.channelManager;
    if (options.approvalResolver) {
      engine.approval.setResolver(options.approvalResolver);
    }
    // 审批挂起时通知外部
    engine.approval.onPending = (approval) => {
      this.emit({ method: 'approval.pending', params: { requestId: approval.requestId, toolName: approval.toolName, args: approval.args, sessionId: approval.sessionId } });
    };
  }

  setNotificationHandler(handler: (n: RpcNotification) => void): void {
    this.onNotification = handler;
  }

  private emit(n: RpcNotification): void {
    this.onNotification?.(n);
  }

  /** 统一事件广播（run 事件 + 通知）。带 sessionId 供前端按会话隔离，避免会话串线。 */
  attachRunEvents(sessionId?: string): RunEventCallback {
    return (event) => {
      this.emit({ method: 'event', params: { sessionId, event } });
    };
  }

  /** 处理单条请求。 */
  async handle(request: RpcRequest): Promise<RpcResponse> {
    try {
      const result = await this.dispatch(request.method, request.params);
      return { jsonrpc: '2.0', id: request.id, result };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case METHODS.SessionCreate: {
        const session = await this.engine.sessions.create(typeof p.name === 'string' ? p.name : undefined);
        return { id: session.id, name: session.meta.name, createdAt: session.meta.createdAt };
      }
      case METHODS.SessionList: {
        const sessions = await this.engine.sessions.listAll();
        return sessions.map((s) => ({
          id: s.meta.id,
          name: s.meta.name,
          model: s.meta.model,
          createdAt: s.meta.createdAt,
          updatedAt: s.meta.updatedAt,
          running: s.control.isStreaming,
        }));
      }
      case METHODS.SessionGet: {
        const session = await this.engine.sessions.load(String(p.id));
        if (!session) throw new Error(`session \`${p.id}\` not found`);
        return { id: session.id, name: session.meta.name, model: session.meta.model, cwd: session.meta.cwd };
      }
      case METHODS.SessionFork: {
        const session = await this.engine.sessions.fork(String(p.id));
        return { id: session.id, name: session.meta.name };
      }
      case METHODS.SessionDelete: {
        await this.engine.sessions.delete(String(p.id));
        return { ok: true };
      }
      case METHODS.SessionRename: {
        const id = String(p.id);
        const name = typeof p.name === 'string' ? p.name : '';
        if (!name.trim()) throw new Error('session.rename 需要非空 name');
        const session = await this.engine.sessions.rename(id, name);
        if (!session) throw new Error(`session \`${id}\` not found`);
        return { id: session.id, name: session.meta.name };
      }
      case METHODS.SessionMessages: {
        const session = await this.engine.sessions.load(String(p.id));
        if (!session) throw new Error(`session \`${p.id}\` not found`);
        return session.messages();
      }
      case METHODS.SessionSend: {
        const sessionId = String(p.sessionId ?? p.id);
        const session = await this.engine.sessions.load(sessionId);
        if (!session) throw new Error(`session \`${sessionId}\` not found`);
        const outcome = await this.engine.run(session, String(p.prompt), {
          busyPolicy: typeof p.busyPolicy === 'string' ? (p.busyPolicy as never) : undefined,
          onEvent: this.attachRunEvents(sessionId),
        });
        return outcome;
      }
      case METHODS.SessionStop:
        await this.engine.stop(String(p.runId));
        return { ok: true };
      case METHODS.ToolInvoke: {
        // 直接执行真实工具（斜杠命令绑定，不经模型）：返回文本结果并写入当前会话历史。
        const { tool, args, command, sessionId } = p as {
          tool?: string;
          args?: Record<string, unknown>;
          command?: string;
          sessionId?: string;
        };
        if (!tool) throw new Error('tool required');
        const session = sessionId ? await this.engine.sessions.load(sessionId) : null;
        const t0 = Date.now();
        const out = await this.engine.tools.execute(tool, args ?? {}, { cwd: session?.meta.cwd });
        const costMs = Date.now() - t0;
        if (session) {
          await this.engine.sessions.appendMessage(session, newUserMessage('user', command ?? `\`${tool}\``));
          await this.engine.sessions.appendMessage(
            session,
            newUserMessage('assistant', `[${tool}]\n${out.result}`),
          );
        }
        return { text: out.result, is_error: out.is_error, costMs };
      }
      case METHODS.ToolList:
        // 返回注册工具库（69 个）：前端据此动态生成 `/工具名` 斜杠指令
        return this.engine.tools.defs().map((d) => ({
          name: d.function.name,
          description: d.function.description,
          parameters: d.function.parameters,
        }));
      case METHODS.ModelList:
        return this.engine.models.list().map((m) => ({
          id: m.id,
          name: m.name,
          provider: m.provider,
          api: m.api,
          baseUrl: m.baseUrl,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          reasoning: m.reasoning,
        }));
      case METHODS.ModelSelect: {
        const id = String(p.id);
        if (!this.engine.models.get(id)) throw new Error(`unknown model \`${id}\``);
        this.engine.settings.defaultModel = id;
        await this.engine.saveSettingsToDisk();
        return { ok: true, model: id };
      }
      case METHODS.SkillList:
        return (await discoverSkills()).map((s) => ({ name: s.name, description: s.description }));
      case METHODS.ApprovalResolve: {
        this.engine.approval.resolveApproval(String(p.requestId), Boolean(p.approved));
        return { ok: true };
      }
      case METHODS.SettingsGet:
        return this.engine.settings;
      case METHODS.SettingsSet: {
        const patch = (p ?? {}) as Record<string, unknown>;
        const allowed = ['defaultModel', 'sandboxTier', 'codingToolsApproval', 'networkToolsApproval', 'generalToolsApproval', 'searchProvider', 'maxTurns', 'thinkingBudget', 'thinkingLevel', 'workspaceDir'];
        // 工作区目录：运行时立即切换（重建 workspace/会话默认 cwd/工具 cwd），无需重启
        if ('workspaceDir' in patch) {
          await this.engine.setWorkspace(String(patch.workspaceDir ?? ''));
          return this.engine.settings;
        }
        const merged = { ...this.engine.settings };
        for (const k of allowed) {
          if (k in patch) (merged as Record<string, unknown>)[k] = patch[k];
        }
        this.engine.settings = merged as never;
        await this.engine.saveSettingsToDisk();
        return this.engine.settings;
      }
      case METHODS.AuthGet: {
        const entries = await this.engine.auth.load();
        return Object.fromEntries(
          Object.entries(entries).map(([id, e]) => [id, { baseUrl: e.baseUrl ?? '', hasKey: Boolean(e.key) }]),
        );
      }
      case METHODS.AuthSet: {
        const { providerId, key, baseUrl } = (p ?? {}) as { providerId?: string; key?: string; baseUrl?: string };
        if (!providerId) throw new Error('providerId required');
        const existing = (await this.engine.auth.load())[providerId];
        await this.engine.auth.set(providerId, {
          type: 'api_key',
          key: key ?? existing?.key ?? '',
          baseUrl: baseUrl ?? existing?.baseUrl ?? '',
        });
        return { ok: true, providerId };
      }
      case METHODS.SearchVerify: {
        return await this.engine.verifySearch();
      }
      case METHODS.ChannelConfigGet: {
        if (!this.channelManager) throw new Error('channel manager 未启用');
        return this.channelManager.configView();
      }
      case METHODS.ChannelConfigSet: {
        if (!this.channelManager) throw new Error('channel manager 未启用');
        const patch = (p ?? {}) as Record<string, unknown>;
        const cfg: Record<string, unknown> = {};
        if (patch.feishu && typeof patch.feishu === 'object') {
          const f = patch.feishu as Record<string, unknown>;
          cfg.feishu = {
            appId: String(f.appId ?? ''),
            appSecret: typeof f.appSecret === 'string' && f.appSecret && f.appSecret !== '••••••' ? f.appSecret : undefined,
            useWebSocket: f.useWebSocket === true,
            verifyToken: typeof f.verifyToken === 'string' && f.verifyToken && f.verifyToken !== '••••••' ? f.verifyToken : undefined,
          };
        }
        if (patch.dingtalk && typeof patch.dingtalk === 'object') {
          const d = patch.dingtalk as Record<string, unknown>;
          cfg.dingtalk = {
            appKey: String(d.appKey ?? ''),
            appSecret: typeof d.appSecret === 'string' && d.appSecret && d.appSecret !== '••••••' ? d.appSecret : undefined,
            useWebSocket: d.useWebSocket === true,
          };
        }
        await this.channelManager.setConfig(cfg as never);
        return this.channelManager.getStatus();
      }
      case METHODS.ChannelStatus: {
        if (!this.channelManager) throw new Error('channel manager 未启用');
        return this.channelManager.getStatus();
      }
      case METHODS.ChannelStart: {
        if (!this.channelManager) throw new Error('channel manager 未启用');
        const name = String((p as { channel?: string })?.channel ?? '');
        if (name === 'feishu') await this.channelManager.startFeishu();
        else if (name === 'dingtalk') await this.channelManager.startDingtalk();
        else throw new Error(`未知通道：${name}`);
        return this.channelManager.getStatus();
      }
      case METHODS.ChannelStop: {
        if (!this.channelManager) throw new Error('channel manager 未启用');
        const name = String((p as { channel?: string })?.channel ?? '');
        if (name === 'feishu') this.channelManager.stopFeishu();
        else if (name === 'dingtalk') this.channelManager.stopDingtalk();
        else throw new Error(`未知通道：${name}`);
        return this.channelManager.getStatus();
      }
      case METHODS.ModelCustom: {
        const m = (p ?? {}) as {
          id?: string;
          name?: string;
          provider?: string;
          api?: string;
          baseUrl?: string;
          contextWindow?: number;
          maxTokens?: number;
          reasoning?: boolean;
        };
        if (!m.id) throw new Error('model id required');
        const model = {
          id: m.id,
          name: m.name ?? m.id,
          provider: m.provider ?? 'custom',
          api: m.api ?? 'openai-completions',
          baseUrl: m.baseUrl ?? '',
          contextWindow: m.contextWindow ?? 128000,
          maxTokens: m.maxTokens ?? 4096,
          reasoning: m.reasoning ?? false,
          hide: false,
        };
        this.engine.models.add(model);
        await this.engine.addCustomModelToFile(model);
        return { ok: true, id: model.id };
      }
      case METHODS.ModelRemove: {
        const id = String(p.id);
        if (!id) throw new Error('model id required');
        const removed = this.engine.models.remove(id);
        await this.engine.removeCustomModelFromFile(id);
        return { ok: true, removed, id };
      }
      case METHODS.SettingsSet: {
        const patch = (p ?? {}) as Record<string, unknown>;
        const allowed = ['defaultModel', 'sandboxTier', 'codingToolsApproval', 'networkToolsApproval', 'generalToolsApproval', 'searchProvider', 'maxTurns', 'thinkingBudget', 'thinkingLevel', 'workspaceDir'];
        const merged = { ...this.engine.settings };
        for (const k of allowed) {
          if (k in patch) (merged as Record<string, unknown>)[k] = patch[k];
        }
        this.engine.settings = merged as never;
        await this.engine.saveSettingsToDisk();
        return this.engine.settings;
      }
      case METHODS.AuthGet: {
        const entries = await this.engine.auth.load();
        return Object.fromEntries(
          Object.entries(entries).map(([providerId, e]) => [providerId, { baseUrl: e.baseUrl ?? '', hasKey: Boolean(e.key) }]),
        );
      }
      case METHODS.AuthSet: {
        const { providerId, key, baseUrl } = p as { providerId?: string; key?: string; baseUrl?: string };
        if (!providerId) throw new Error('auth.set 需要 providerId');
        const prev = (await this.engine.auth.load())[providerId];
        await this.engine.auth.set(providerId, {
          type: 'api_key',
          key: key ?? prev?.key ?? '',
          baseUrl: baseUrl ?? prev?.baseUrl ?? '',
        });
        return { ok: true, providerId };
      }
      case METHODS.ModelCustom: {
        const m = p as Record<string, unknown>;
        const id = String(m.id ?? '');
        if (!id) throw new Error('model.custom 需要 id');
        const model = {
          id,
          name: String(m.name ?? id),
          provider: String(m.provider ?? 'custom'),
          api: String(m.api ?? 'openai-completions'),
          baseUrl: String(m.baseUrl ?? ''),
          contextWindow: Number(m.contextWindow ?? 128000),
          maxTokens: Number(m.maxTokens ?? 4096),
          reasoning: Boolean(m.reasoning ?? false),
          hide: false,
        };
        await this.engine.addCustomModelToFile(model);
        return { ok: true, id };
      }
      case METHODS.FsList: {
        const root = await this.fsRoot(p.sessionId as string | undefined);
        const rel = typeof p.path === 'string' ? p.path : '.';
        const entries = await this.engine.files.list(root, rel);
        return { root, path: rel, entries };
      }
      case METHODS.FsRead: {
        const root = await this.fsRoot(p.sessionId as string | undefined);
        return await this.engine.files.read(root, String(p.path ?? ''));
      }
      case METHODS.FsBrowse: {
        return await this.engine.files.browse(String(p.path ?? ''));
      }
      case METHODS.FsWrite: {
        const root = await this.fsRoot(p.sessionId as string | undefined);
        return await this.engine.files.write(root, String(p.path ?? ''), String(p.content ?? ''));
      }
      case METHODS.FsMkdir: {
        const root = await this.fsRoot(p.sessionId as string | undefined);
        await this.engine.files.mkdir(root, String(p.path ?? ''));
        return { ok: true };
      }
      case METHODS.FsRemove: {
        const root = await this.fsRoot(p.sessionId as string | undefined);
        return await this.engine.files.remove(root, String(p.path ?? ''));
      }
      case METHODS.FsRename: {
        const root = await this.fsRoot(p.sessionId as string | undefined);
        await this.engine.files.rename(root, String(p.from ?? ''), String(p.to ?? ''));
        return { ok: true };
      }
      case METHODS.Doctor: {
        let codingOk = false;
        let codingPath: string | null = null;
        try {
          await this.engine.coding.start(8000);
          codingOk = this.engine.coding.available;
          codingPath = codingOk ? this.engine.coding.servicePath : null;
        } catch {
          codingOk = false;
        }
        const allSessions = await this.engine.sessions.listAll();
        return {
          programming: codingOk,
          programmingPath: codingPath,
          tools: this.engine.tools.list().length,
          codingTools: this.engine.tools
            .list()
            .filter((t) => /^(lsp_|dap_|execute_code|bash|ast_|subagent|review|git_)/.test(t.def.function.name)).length,
          sessions: allSessions.length,
        };
      }
      case METHODS.LoopWorkerList: {
        const rt = this.workerRuntime();
        const goalId = typeof p.goalId === 'string' ? p.goalId : undefined;
        return { workers: rt.list(goalId) };
      }
      case METHODS.LoopWorkerStop: {
        const wid = typeof p.workerId === 'string' ? p.workerId : '';
        if (!wid) throw new Error('loop.worker.stop 需要 workerId');
        const w = await this.workerRuntime().stop(wid);
        return { worker: w ?? null };
      }
      case METHODS.LoopWorkerSteer: {
        const wid = typeof p.workerId === 'string' ? p.workerId : '';
        const instruction = typeof p.instruction === 'string' ? p.instruction : '';
        if (!wid || !instruction) throw new Error('loop.worker.steer 需要 workerId + instruction');
        const w = await this.workerRuntime().steer(wid, instruction);
        return { worker: w ?? null };
      }
      case METHODS.LoopWorkerSpawn: {
        const goalId = typeof p.goalId === 'string' ? p.goalId : '';
        const tasks = Array.isArray(p.tasks) ? (p.tasks as { title?: string; prompt?: string; model?: string; thinking?: number }[]) : [];
        const isolate = p.isolate === true;
        if (!goalId || tasks.length === 0) throw new Error('loop.worker.spawn 需要 goalId + tasks[]');
        const workers = await this.workerRuntime().spawn(
          goalId,
          tasks.map((t) => ({ title: t.title ?? 'worker', prompt: t.prompt, model: t.model, thinking: t.thinking })),
          { isolate },
        );
        return { workers };
      }
      case METHODS.LoopWorkerRemove: {
        const wid = typeof p.workerId === 'string' ? p.workerId : '';
        if (!wid) throw new Error('loop.worker.remove 需要 workerId');
        const removed = await this.workerRuntime().remove(wid);
        return { removed };
      }
      case METHODS.LoopGoalDelete: {
        // 清理目标状态：停止运行中的 worker → 删除 worker 会话与隔离工作目录 → 移除 goal 全部状态/事件
        const goalId = typeof p.goalId === 'string' && p.goalId ? p.goalId : '';
        if (!goalId) throw new Error('loop.control.goal.delete 需要 goalId');
        const rt = this.workerRuntime();
        for (const w of rt.list(goalId)) {
          if (w.status === 'running' || w.status === 'idle') await rt.stop(w.id);
          if (w.sessionId) await this.engine.sessions.delete(w.sessionId);
          if (w.cwd && w.cwd !== this.engine.workspace) {
            try {
              await fs.rm(w.cwd, { recursive: true, force: true });
            } catch {
              // 忽略清理失败（目录可能已被手动删除）
            }
          }
        }
        const removed = await this.loopControl().removeGoal(goalId);
        return { ok: true, ...removed };
      }
      case METHODS.LoopControlClear: {
        // 清空全部目标：停止所有运行中 worker → 删除 worker 会话与隔离目录 → 清空 goals/workers/事件历史。
        // 与 goal.delete 不同，这里不要求 goal 记录存在（兼容仅有 worker 记录的孤儿目标）。
        const rt = this.workerRuntime();
        for (const w of rt.list()) {
          if (w.status === 'running' || w.status === 'idle') await rt.stop(w.id);
          if (w.sessionId) await this.engine.sessions.delete(w.sessionId);
          if (w.cwd && w.cwd !== this.engine.workspace) {
            try {
              await fs.rm(w.cwd, { recursive: true, force: true });
            } catch {
              // 忽略清理失败（目录可能已被手动删除）
            }
          }
        }
        const removed = await this.loopControl().clearAll();
        return { ok: true, ...removed };
      }
      case METHODS.LoopGoalHistoryClear: {
        const goalId = String(p.goalId ?? '');
        if (!goalId) throw new Error('goalId required');
        return await this.loopControl().clearHistory(goalId);
      }
      case METHODS.LoopGoalRunRemove: {
        const goalId = String(p.goalId ?? '');
        const workerId = String(p.workerId ?? '');
        if (!goalId || !workerId) throw new Error('goalId + workerId required');
        // 先停止并移除 worker 运行时记录（若存在），再清除其事件历史 → 运行历史条目随之消失
        await this.workerRuntime().remove(workerId);
        return await this.loopControl().removeRun(goalId, workerId);
      }
      case METHODS.LoopGoalTodos: {
        const goalId = typeof p?.goalId === 'string' && p.goalId ? p.goalId : undefined;
        return { todos: this.loopControl().todos(goalId) };
      }
      case METHODS.LoopGoalEvents: {
        const goalId = String(p.goalId ?? '');
        if (!goalId) throw new Error('goalId required');
        return { events: this.loopControl().events(goalId) };
      }
      case METHODS.LoopStatus: {
        const goalId = typeof p?.goalId === 'string' && p.goalId ? p.goalId : undefined;
        return { reports: this.loopControl().status(goalId) };
      }
      case METHODS.LoopRuns: {
        const goalId = typeof p?.goalId === 'string' && p.goalId ? p.goalId : undefined;
        return { runs: this.loopControl().runs(goalId) };
      }
      case METHODS.LoopFrontier: {
        const goalId = typeof p?.goalId === 'string' && p.goalId ? p.goalId : undefined;
        return { todos: this.loopControl().frontier(goalId) };
      }
      case METHODS.LoopTaskGraph: {
        const goalId = typeof p?.goalId === 'string' && p.goalId ? p.goalId : '';
        if (!goalId) throw new Error('loop.control.taskGraph 需要 goalId');
        return { graph: this.loopControl().taskGraph(goalId) };
      }
      case METHODS.LoopLease: {
        const goalId = typeof p?.goalId === 'string' && p.goalId ? p.goalId : undefined;
        return { leases: this.loopControl().leaseStatus(goalId) };
      }
      default:
        throw new Error(`unknown method \`${method}\``);
    }
  }

  /** 文件操作根目录：一律使用工作区根（settings.workspaceDir 或 tmp 临时目录）。 */
  private async fsRoot(_sessionId?: string): Promise<string> {
    return this.engine.workspace;
  }

  /** 共享 loop 事件源单例：worker 运行时与控制平面读写同一份状态，保证删除等操作全局一致。 */
  private loopStore?: LoopStore;
  private getLoopStore(): LoopStore {
    if (!this.loopStore) {
      const loopFile = path.join(process.env.HOME ?? '.', '.future', 'agent', 'loop', 'events.jsonl');
      const store = new LoopStore(loopFile);
      void store.restore();
      this.loopStore = store;
    }
    return this.loopStore;
  }

  /** WorkerRuntime 惰性单例：worker 状态持久化到 loop events.jsonl。 */
  private workerRt?: WorkerRuntime;
  /** 启动 worker（供 engine spawn_workers 工具委托；普通对话即可触发多 worker 协作）。 */
  async spawnWorkers(goalId: string, tasks: { title: string; prompt: string }[], isolate?: boolean): Promise<unknown> {
    return this.workerRuntime().spawn(goalId, tasks, { isolate });
  }
  /** 读取 worker 列表/结果（供 engine list_workers 工具委托）。 */
  async listWorkers(goalId?: string): Promise<unknown> {
    return this.workerRuntime().list(goalId);
  }
  workerRuntime(): WorkerRuntime {
    if (!this.workerRt) {
      this.workerRt = new WorkerRuntime({
        engine: this.engine,
        store: this.getLoopStore(),
        // worker 事件实时推送到前端：状态更新 + 运行日志流
        onWorkerEvent: (worker, ev) => {
          const e = ev as { type?: string; worker?: unknown };
          if (e?.type === 'worker_started' || e?.type === 'worker_updated') {
            this.emit({ method: 'loop.worker.updated', params: { worker: e.worker } });
          } else if (e?.type) {
            // run 事件流：text_delta / reasoning_delta / tool_call / tool_result / usage / complete / error / cancelled
            this.emit({ method: 'loop.worker.log', params: { workerId: worker.id, event: ev } });
          }
        },
      });
    }
    return this.workerRt;
  }

  private controlRt?: LoopControl;
  private loopControl(): LoopControl {
    if (!this.controlRt) {
      this.controlRt = new LoopControl(this.getLoopStore());
    }
    return this.controlRt;
  }
}
