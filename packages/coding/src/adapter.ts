/**
 * CodingAdapter — infuture 与编程引擎之间的唯一桥梁。
 * 基于真实 `--mode rpc` 协议（已实测：`bun <cli> --mode rpc` → stdout 输出
 * `{type:'ready'}`；命令 `{id, type, ...}` → 响应 `{id, type:'response', command,
 * success, data|error}`；agent 运行期间流式输出 agent_start/message_update/
 * message_end/agent_end 事件）。
 *
 * 模式取自参考实现的桌面适配器：
 *  - runTask: follow_up/steer/prompt 委派一个编码子任务，等到 agent_end 收最终答案
 *  - runBash : bash 命令直接执行（无 agent 轮，快速）
 *
 * 解析顺序：options.cliPath → env OMP_CLI_PATH → 仓库 node_modules → cwd node_modules。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CodingAdapterOptions {
  /** 覆盖 CLI 路径。 */
  cliPath?: string;
  cwd?: string;
  onLog?: (line: string) => void;
  /** 单条命令超时（默认 120s）。 */
  commandTimeoutMs?: number;
  /** 启动握手超时（默认 30s）。 */
  startupTimeoutMs?: number;
  /** 流式事件透传回调（agent 事件 / host_tool_call / 子 agent 进度）。 */
  onEvent?: (msg: Record<string, unknown>) => void;
}

export interface OmpToolResult {
  result: string;
  is_error: boolean;
}

export interface OmpTaskResult {
  answer: string;
  cancelled: boolean;
  error?: string;
}

/** host tool 定义（set_host_tools 注册进编程 agent 循环）。 */
export interface OmpHostToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  hidden?: boolean;
}

/** host tool 执行结果（AgentToolResult 兼容：content 为内容块数组）。 */
export interface OmpHostToolResult {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
}

/** host tool 处理器：由 infuture 侧实现（可接审批门/通用工具）。 */
export type OmpHostToolHandler = (
  args: Record<string, unknown>,
  toolCallId: string,
) => OmpHostToolResult | Promise<OmpHostToolResult>;

interface RpcMessage {
  id?: string | number;
  type?: string;
  command?: string;
  success?: boolean;
  data?: unknown;
  error?: string | { message?: string };
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** 向上逐级搜索含 @oh-my-pi/pi-coding-agent 的 node_modules。 */
function searchUpwards(start: string): string | null {
  let dir = start;
  while (true) {
    const pkg = path.join(dir, 'node_modules', '@oh-my-pi', 'pi-coding-agent');
    if (fs.existsSync(path.join(pkg, 'package.json'))) return pkg;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function packageRootCandidates(): string[] {
  const found: string[] = [];
  const push = (p: string | null) => {
    if (p && !found.includes(p)) found.push(p);
  };
  push(searchUpwards(here));
  push(searchUpwards(process.cwd()));
  return found;
}

export function resolveOmpCliPath(cliPath?: string): string {
  if (cliPath) return cliPath;
  if (process.env.OMP_CLI_PATH) return process.env.OMP_CLI_PATH;

  for (const pkgRoot of packageRootCandidates()) {
    try {
      const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf-8'));
      const bin = pkgJson.bin;
      const binEntry = typeof bin === 'string' ? bin : bin && typeof bin === 'object' ? (bin.omp ?? bin['pi-coding-agent']) : undefined;
      if (typeof binEntry === 'string') {
        const resolved = path.join(pkgRoot, binEntry);
        if (fs.existsSync(resolved)) return resolved;
      }
      if (pkgJson.main && fs.existsSync(path.join(pkgRoot, pkgJson.main))) {
        return path.join(pkgRoot, pkgJson.main);
      }
    } catch {
      // 继续下一个候选
    }
  }
  throw new Error(
    '未找到 @oh-my-pi/pi-coding-agent 包，请运行: npm add @oh-my-pi/pi-coding-agent，或设置 OMP_CLI_PATH 环境变量',
  );
}

export class CodingAdapter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private nextId = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = '';
  private readonly cwd: string;
  private readonly onLog: (line: string) => void;
  private readonly commandTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  /** agent_end 等待者。 */
  private endWaiters = new Set<() => void>();
  private answerAcc = '';
  /** 串行化 runTask，避免并发工具调用交错同一编程会话。 */
  private taskTail: Promise<unknown> = Promise.resolve();
  private disposed = false;
  /** 已注册的 host tool 处理器（编程循环内调用 infuture 能力）。 */
  private hostToolHandlers = new Map<string, OmpHostToolHandler>();
  /** 流式事件透传（agent 事件 / host_tool_call / 子 agent 进度）。 */
  private onEvent?: (msg: Record<string, unknown>) => void;

  constructor(private readonly options: CodingAdapterOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.onLog = options.onLog ?? (() => {});
    this.commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
    this.onEvent = options.onEvent ?? (() => {});
  }

  get resolvedPath(): string {
    return resolveOmpCliPath(this.options.cliPath);
  }

  /** 路径级可用性（廉价检查；doctor 用 verify 做真实握手）。 */
  get available(): boolean {
    try {
      resolveOmpCliPath(this.options.cliPath);
      return true;
    } catch {
      return false;
    }
  }

  /** 真实握手：spawn + 等待 ready。成功才算真正可用。 */
  async verify(timeoutMs?: number): Promise<boolean> {
    try {
      await this.start(timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  private spawnChild(): void {
    const cliPath = this.resolvedPath;
    this.onLog(`[coding] spawn bun ${cliPath} --mode rpc`);
    const child = spawn(process.env.BUN_PATH || 'bun', [cliPath, '--mode', 'rpc'], {
      cwd: this.cwd,
      env: { ...process.env, BUN_PATH: process.env.BUN_PATH ?? 'bun' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    child.stderr.on('data', (d: Buffer) => this.onLog(`[engine] ${d.toString().trim()}`));
    child.stdout.on('data', (d: Buffer) => this.onStdout(d));
    child.on('error', (err) => {
      this.onLog(`[coding] engine spawn error: ${err.message}`);
      this.failAll(new Error(`engine spawn failed: ${err.message}`));
    });
    child.on('exit', (code) => {
      this.ready = false;
      this.onLog(`[coding] engine exited (code=${code})`);
      this.failAll(new Error(`engine process exited (code=${code})`));
    });
    this.child = child;
  }

  private onStdout(data: Buffer): void {
    this.buffer += data.toString();
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line) as RpcMessage;
      } catch {
        this.onLog(`[coding] non-json stdout: ${line.slice(0, 120)}`);
        continue;
      }
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: RpcMessage): void {
    if (msg.type === 'ready') {
      this.ready = true;
      return;
    }
    // host 工具调用：编程 agent 循环请求 infuture 执行注册的工具
    if (msg.type === 'host_tool_call') {
      this.handleHostToolCall(msg as RpcMessage & { id: string; toolCallId: string; toolName: string; arguments?: Record<string, unknown> });
      return;
    }
    if (msg.type === 'response') {
      const id = String(msg.id);
      const entry = this.pending.get(id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        if (msg.success) entry.resolve(msg.data);
        else entry.reject(new Error(msg.error && typeof msg.error === 'object' ? msg.error.message ?? 'engine error' : String(msg.error ?? 'engine error')));
      }
      return;
    }
    // 流式事件透传（除已处理的类型外，全部转发给 infuture）
    this.onEvent?.(msg as unknown as Record<string, unknown>);
    // agent 事件
    switch (msg.type) {
      case 'agent_start':
        this.answerAcc = '';
        break;
      case 'message_end': {
        const m = (msg as { message?: { role?: string; content?: unknown } }).message;
        if (m?.role === 'assistant') {
          const text = extractMessageText(m.content);
          if (text) this.answerAcc += text;
        }
        break;
      }
      case 'message_update': {
        const update = (msg as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
        if (update?.type === 'text_delta' && update.delta) this.answerAcc += update.delta;
        break;
      }
      case 'agent_end':
        for (const w of this.endWaiters) w();
        this.endWaiters.clear();
        break;
      default:
        break;
    }
  }

  /** 处理 host_tool_call：查处理器 → 执行 → 回 host_tool_result 帧。 */
  private handleHostToolCall(msg: RpcMessage & { id: string; toolCallId: string; toolName: string; arguments?: Record<string, unknown> }): void {
    const { id, toolCallId, toolName, arguments: args } = msg;
    const handler = this.hostToolHandlers.get(toolName);
    if (!handler) {
      this.writeFrame({
        type: 'host_tool_result',
        id,
        result: { content: [{ type: 'text', text: `host tool \`${toolName}\` 未注册` }] },
        isError: true,
      });
      return;
    }
    Promise.resolve(handler(args ?? {}, toolCallId)).then(
      (res) => {
        this.writeFrame({ type: 'host_tool_result', id, result: res, isError: res.isError });
      },
      (err) => {
        const text = err instanceof Error ? err.message : String(err);
        this.writeFrame({ type: 'host_tool_result', id, result: { content: [{ type: 'text', text }] }, isError: true });
      },
    );
  }

  /** 发送一帧到编程引擎 stdin（host→engine 方向：result/update）。 */
  private writeFrame(frame: Record<string, unknown>): void {
    if (!this.child || !this.child.stdin.writable) return;
    this.child.stdin.write(JSON.stringify(frame) + '\n');
  }

  private failAll(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    for (const w of this.endWaiters) w();
    this.endWaiters.clear();
  }

  /** 启动并等待 ready。幂等。 */
  async start(timeoutMs?: number): Promise<void> {
    if (this.ready && this.child && !this.child.killed) return;
    this.spawnChild();
    const child = this.child;
    if (!child) throw new Error('engine spawn failed');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('engine ready 超时'));
        child.kill('SIGKILL');
      }, timeoutMs ?? this.startupTimeoutMs);
      const interval = setInterval(() => {
        if (this.ready) {
          clearTimeout(timer);
          clearInterval(interval);
          resolve();
        }
      }, 20);
      child.once('exit', () => {
        clearTimeout(timer);
        clearInterval(interval);
        reject(new Error('engine 在 ready 前退出'));
      });
      child.once('error', () => {
        clearTimeout(timer);
        clearInterval(interval);
        reject(new Error('engine 启动失败'));
      });
    });
  }

  /** 发送一条 RPC 命令并等待响应。 */
  private sendCommand(cmd: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    if (!this.child || !this.child.stdin.writable || !this.ready) {
      return Promise.reject(new Error('engine not ready'));
    }
    const id = `omp_${++this.nextId}`;
    const payload = { ...cmd, id };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`engine 命令超时: ${String(cmd.type)}`));
      }, timeoutMs ?? this.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  /** 委派一个编码子任务给编程 agent，等到 agent_end 收最终答案。 */
  async runTask(
    input: string,
    options: { mode?: 'prompt' | 'steer' | 'follow_up'; images?: unknown[] } = {},
    timeoutMs?: number,
  ): Promise<OmpTaskResult> {
    const exec = async (): Promise<OmpTaskResult> => {
      await this.start();
      const mode = options.mode ?? 'prompt';
      const command: Record<string, unknown> = {
        type: mode,
        message: input,
      };
      if (mode === 'prompt') command.streamingBehavior = 'followUp';
      if (options.images && options.images.length > 0) command.images = options.images;

      this.answerAcc = '';
      const completed = new Promise<void>((resolve) => this.endWaiters.add(resolve));

      try {
        const result = (await this.sendCommand(command, timeoutMs)) as { agentInvoked?: boolean } | undefined;
        if (result && result.agentInvoked === false) {
          // skill 命令同步处理，无 agent_end
          this.endWaiters.clear();
          return { answer: this.answerAcc, cancelled: false };
        }
        await completed;
        return { answer: this.answerAcc, cancelled: false };
      } catch (err) {
        this.endWaiters.clear();
        return {
          answer: this.answerAcc,
          cancelled: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    };
    // 串行化，避免并发交错
    const run = this.taskTail.then(exec, exec);
    this.taskTail = run.catch(() => {});
    return (await run) as OmpTaskResult;
  }

  /** 直接执行 bash（无 agent 轮）。 */
  async runBash(command: string, timeoutMs?: number): Promise<OmpToolResult> {
    try {
      await this.start();
      const data = (await this.sendCommand({ type: 'bash', command }, timeoutMs)) as
        | { output?: string; exitCode?: number; cancelled?: boolean; truncated?: boolean }
        | string
        | undefined;
      if (typeof data === 'string') return { result: data, is_error: false };
      const output = data?.output ?? '';
      const isErr = (data?.exitCode ?? 0) !== 0;
      const suffix = data?.truncated ? '\n[output truncated]' : '';
      return { result: output.trim() || `(no output, exit ${data?.exitCode ?? 0})${suffix}`, is_error: isErr };
    } catch (err) {
      return { result: err instanceof Error ? err.message : String(err), is_error: true };
    }
  }

  /** 取消当前 agent 运行。 */
  async abort(): Promise<void> {
    if (!this.ready) return;
    try {
      await this.sendCommand({ type: 'abort' }, 5000);
    } catch {
      // 忽略 abort 超时
    }
  }

  /** 获取会话状态。 */
  async getState(): Promise<Record<string, unknown>> {
    await this.start();
    const data = (await this.sendCommand({ type: 'get_state' })) as Record<string, unknown>;
    return data ?? {};
  }

  /** 可用模型列表。 */
  async availableModels(): Promise<Array<{ id: string; name?: string; provider?: string }>> {
    await this.start();
    const data = (await this.sendCommand({ type: 'get_available_models' })) as {
      models?: Array<{ id: string; name?: string; provider?: string }>;
    };
    return data?.models ?? [];
  }

  // ===========================================================================
  // 融合底座：统一模型 / 注入工具 / 会话命令（编程引擎为内核，infuture 统一控制面）
  // ===========================================================================

  /** 设置编程 agent 使用的模型（provider/modelId 必须已在编程引擎模型列表中）。 */
  async setModel(provider: string, modelId: string): Promise<Record<string, unknown>> {
    await this.start();
    return (await this.sendCommand({ type: 'set_model', provider, modelId })) as Record<string, unknown>;
  }

  /** 把 infuture 的工具注册进编程 agent 循环（引擎调用时经 host_tool_call 回传）。 */
  async setHostTools(tools: OmpHostToolDefinition[]): Promise<string[]> {
    await this.start();
    const data = (await this.sendCommand({ type: 'set_host_tools', tools })) as { toolNames?: string[] };
    return data?.toolNames ?? [];
  }

  /** 注册 host tool 处理器：编程引擎发起 host_tool_call 时由 infuture 执行。 */
  registerHostToolHandler(name: string, handler: OmpHostToolHandler): void {
    this.hostToolHandlers.set(name, handler);
  }

  /** 取消 host tool 调用（处理 host_tool_cancel）。 */
  cancelHostTool(targetId: string): void {
    this.writeFrame({ type: 'host_tool_cancel', id: `cancel_${targetId}`, targetId });
  }

  /** 新建编程会话（可选父会话分支）。 */
  async newSession(parentSession?: string): Promise<boolean> {
    await this.start();
    const data = (await this.sendCommand({ type: 'new_session', ...(parentSession ? { parentSession } : {}) })) as {
      cancelled?: boolean;
    };
    return data?.cancelled === true;
  }

  /** 设置编程会话名称（用于会话同步）。 */
  async setSessionName(name: string): Promise<void> {
    await this.start();
    await this.sendCommand({ type: 'set_session_name', name });
  }

  /** 读取编程会话消息（用于同步到 infuture 会话）。 */
  async getMessages(): Promise<unknown[]> {
    await this.start();
    const data = (await this.sendCommand({ type: 'get_messages' })) as { messages?: unknown[] };
    return data?.messages ?? [];
  }

  /** 获取子 agent 快照。 */
  async getSubagents(): Promise<unknown[]> {
    await this.start();
    const data = (await this.sendCommand({ type: 'get_subagents' })) as { subagents?: unknown[] };
    return data?.subagents ?? [];
  }

  /** 获取会话统计。 */
  async getSessionStats(): Promise<Record<string, unknown>> {
    await this.start();
    const data = (await this.sendCommand({ type: 'get_session_stats' })) as Record<string, unknown>;
    return data ?? {};
  }

  dispose(): void {
    this.disposed = true;
    if (this.child && !this.child.killed) {
      try {
        this.child.kill();
      } catch {
        // ignore
      }
    }
    this.child = null;
    this.ready = false;
    this.failAll(new Error('engine disposed'));
  }
}

/** 从 wire message content 提取纯文本。 */
function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === 'object') {
          const o = b as Record<string, unknown>;
          if (o.type === 'text' && typeof o.text === 'string') return o.text;
          if (o.type === 'tool_result' && typeof o.content === 'string') return o.content;
        }
        return '';
      })
      .join('');
  }
  return '';
}
