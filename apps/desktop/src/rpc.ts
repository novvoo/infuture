/** WebSocket JSON-RPC 客户端（浏览器侧）。 */
export interface RpcNotification {
  method: string;
  params?: unknown;
}

/** 后端 ws 地址：可用构建期环境变量 VITE_WS_URL 覆盖（容器/远程部署用），默认本机开发地址。 */
const DEFAULT_WS_URL: string = (import.meta.env.VITE_WS_URL as string | undefined) ?? 'ws://127.0.0.1:50051';

export class DesktopRpc {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  private handlers = new Set<(n: RpcNotification) => void>();
  connected = false;

  constructor(private readonly url: string = DEFAULT_WS_URL) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => {
        this.connected = true;
        resolve();
      };
      ws.onerror = () => {
        this.connected = false;
        reject(new Error(`无法连接 infuture server (${this.url})。先运行: npm run server`));
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.id !== undefined && msg.id !== null) {
            const entry = this.pending.get(Number(msg.id));
            if (entry) {
              this.pending.delete(Number(msg.id));
              if (msg.error) entry.reject(new Error(msg.error.message));
              else entry.resolve(msg.result);
            }
          } else if (msg.method) {
            for (const h of this.handlers) h(msg as RpcNotification);
          }
        } catch {
          // ignore
        }
      };
      ws.onclose = () => {
        this.connected = false;
      };
    });
  }

  onNotification(handler: (n: RpcNotification) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('server 未连接'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (r) => resolve(r as T), reject });
      this.ws!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  dispose(): void {
    this.ws?.close();
  }
}
