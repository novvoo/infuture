/**
 * CodingToolsClient — node 侧客户端，spawn bun 工具服务进程（service/server.ts）。
 *
 * inloop 通过它把编程工具调用下沉为"工具级直调"：
 *   await client.call('lsp', { action: 'references', file, line, character })
 *   → bun 进程内直接执行编程引擎的 LspTool → 结构化 AgentToolResult 返回
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CodingToolsClientOptions {
  /** bun 可执行路径（默认 env BUN_PATH || 'bun'）。 */
  bunPath?: string;
  /** 服务工作目录。 */
  cwd?: string;
  onLog?: (line: string) => void;
  /** 启动握手超时（默认 30s）。 */
  startupTimeoutMs?: number;
  /** 单条命令超时（默认 120s）。 */
  commandTimeoutMs?: number;
}

interface ServiceFrame {
  id?: number | string;
  type?: string;
  tool?: string;
  params?: Record<string, unknown>;
  ok?: boolean;
  result?: unknown;
  error?: string;
  partial?: unknown;
}

const here = path.dirname(fileURLToPath(import.meta.url));

export class CodingToolsClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private nextId = 0;
  private buffer = '';
  private cwd: string;
  private readonly onLog: (line: string) => void;
  private readonly startupTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly bunPath: string;
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private updateHandlers = new Set<(id: string, partial: unknown, tool: string) => void>();
  /** call-id → 工具名，流式 partial 转发时带上工具名。 */
  private toolById = new Map<string, string>();
  private disposed = false;

  constructor(private readonly options: CodingToolsClientOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.onLog = options.onLog ?? (() => {});
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
    this.bunPath = options.bunPath ?? process.env.BUN_PATH ?? 'bun';
  }

  /** 服务脚本绝对路径。 */
  get servicePath(): string {
    return path.join(here, 'server.ts');
  }

  get available(): boolean {
    return this.ready && !!this.child && !this.child.killed;
  }

  /**
   * 更新服务工作目录（跟随 workspace）。若服务已启动则重启——快照/seen-lines 为会话级，
   * 切换 workspace 本就应重置；未启动则下一次 start() 用新 cwd（懒启动场景零成本）。
   */
  setCwd(cwd: string): void {
    if (cwd === this.cwd) return;
    this.cwd = cwd;
    if (this.child && !this.child.killed) {
      this.onLog(`[coding] restart for cwd=${cwd}`);
      try {
        this.child.kill();
      } catch {
        // ignore
      }
      this.child = null;
      this.ready = false;
      this.failAll(new Error('coding service restarted (cwd changed)'));
    }
  }

  /** 当前服务工作目录。 */
  get cwdPath(): string {
    return this.cwd;
  }

  /** 启动并等待 ready。幂等。 */
  async start(timeoutMs?: number): Promise<void> {
    if (this.ready && this.child && !this.child.killed) return;
    const script = this.servicePath;
    if (!fs.existsSync(script)) {
      throw new Error(`coding tools service not found: ${script}`);
    }
    this.onLog(`[coding] spawn ${this.bunPath} ${script} (cwd=${this.cwd})`);
    const child = spawn(this.bunPath, [script], {
      cwd: this.cwd,
      env: { ...process.env, INFUTURE_CWD: this.cwd },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    child.stderr.on('data', (d: Buffer) => this.onLog(`[service] ${d.toString().trim()}`));
    child.stdout.on('data', (d: Buffer) => this.onStdout(d));
    child.on('error', (err) => {
      this.onLog(`[coding] service spawn error: ${err.message}`);
      this.failAll(new Error(`coding service spawn failed: ${err.message}`));
    });
    child.on('exit', (code) => {
      this.ready = false;
      this.onLog(`[coding] service exited (code=${code})`);
      this.failAll(new Error(`coding service exited (code=${code})`));
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('coding service ready 超时'));
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
        reject(new Error('coding service 在 ready 前退出'));
      });
      child.once('error', () => {
        clearTimeout(timer);
        clearInterval(interval);
        reject(new Error('coding service 启动失败'));
      });
    });
  }

  private onStdout(data: Buffer): void {
    this.buffer += data.toString();
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let frame: ServiceFrame;
      try {
        frame = JSON.parse(line) as ServiceFrame;
      } catch {
        this.onLog(`[coding] non-json stdout: ${line.slice(0, 120)}`);
        continue;
      }
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: ServiceFrame): void {
    if (frame.type === 'ready') {
      this.ready = true;
      return;
    }
    if (frame.type === 'update' && frame.id !== undefined) {
      const id = String(frame.id);
      const tool = this.toolById.get(id) ?? 'coding';
      for (const h of this.updateHandlers) h(id, frame.partial, tool);
      return;
    }
    if (frame.id !== undefined && 'ok' in frame) {
      const id = String(frame.id);
      this.toolById.delete(id);
      const entry = this.pending.get(id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        if (frame.ok) entry.resolve(frame.result);
        else entry.reject(new Error(frame.error ?? 'coding tool error'));
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  /** 发送一条工具调用命令并等待结果。 */
  async call(tool: string, params: Record<string, unknown>, timeoutMs?: number, action?: string): Promise<unknown> {
    if (!this.ready || !this.child || !this.child.stdin.writable) {
      await this.start();
    }
    const id = `c_${++this.nextId}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.toolById.delete(id);
        reject(new Error(`coding tool 超时: ${tool}`));
      }, timeoutMs ?? this.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.toolById.set(id, tool);
      const msg: Record<string, unknown> = { id, tool, params };
      if (action) msg.action = action;
      this.child!.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  /** 订阅流式部分结果（带工具名）。返回取消函数。 */
  onUpdate(handler: (id: string, partial: unknown, tool: string) => void): () => void {
    this.updateHandlers.add(handler);
    return () => this.updateHandlers.delete(handler);
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
    this.failAll(new Error('coding service disposed'));
  }
}
