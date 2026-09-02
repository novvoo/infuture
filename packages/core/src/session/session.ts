/**
 * Session — 单个会话：消息历史 + RunControl + 元数据。
 * 对应 Rust `session::Session`。
 */
import type { AgentMessage } from '@infuture/types';
import { RunControl } from '../runtime/run-control.js';
import type { BusyPolicy } from '../runtime/run-request.js';

export interface SessionMeta {
  id: string;
  name: string;
  model: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  parentId?: string;
  /** fork/clone 关系。 */
  kind?: 'root' | 'fork' | 'clone';
}

export class Session {
  readonly meta: SessionMeta;
  readonly control: RunControl;
  private entries: AgentMessage[] = [];
  private queue: Array<{ prompt: string }> = [];

  constructor(meta: SessionMeta, runControlOptions?: ConstructorParameters<typeof RunControl>[0]) {
    this.meta = meta;
    this.control = new RunControl(runControlOptions);
  }

  get id(): string {
    return this.meta.id;
  }

  messages(): AgentMessage[] {
    return [...this.entries];
  }

  pushMessage(message: AgentMessage): void {
    this.entries.push(message);
    this.meta.updatedAt = Date.now();
  }

  restoreMessages(entries: AgentMessage[]): void {
    this.entries = [...entries];
  }

  /** 入队待运行提示词（busy=enqueue_if_busy）。 */
  enqueue(prompt: string): void {
    this.queue.push({ prompt });
  }

  dequeue(): { prompt: string } | undefined {
    return this.queue.shift();
  }

  get queueLength(): number {
    return this.queue.length;
  }
}
