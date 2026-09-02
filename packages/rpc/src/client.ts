/**
 * JsonRpcClient — 本地 JSON-RPC 客户端（stdin/stdout 或内存 channel）。
 */
import type { RpcNotification, RpcRequest, RpcResponse } from './protocol.js';

export interface JsonRpcChannel {
  send(line: string): void;
  onMessage(cb: (line: string) => void): void;
  dispose?(): void;
}

export class JsonRpcClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  private onNotification?: (n: RpcNotification) => void;

  constructor(private readonly channel: JsonRpcChannel) {
    channel.onMessage((line) => {
      if (!line.trim()) return;
      let msg: RpcResponse | RpcNotification;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if ('id' in msg && msg.id !== undefined) {
        const entry = this.pending.get(Number(msg.id));
        if (entry) {
          this.pending.delete(Number(msg.id));
          if (msg.error) entry.reject(new Error(msg.error.message));
          else entry.resolve(msg.result);
        }
      } else if ('method' in msg) {
        this.onNotification?.(msg as RpcNotification);
      }
    });
  }

  setNotificationHandler(handler: (n: RpcNotification) => void): void {
    this.onNotification = handler;
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const req: RpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (r) => resolve(r as T), reject });
      this.channel.send(JSON.stringify(req));
    });
  }

  dispose(): void {
    this.channel.dispose?.();
  }
}
