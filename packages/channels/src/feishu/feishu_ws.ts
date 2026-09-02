/**
 * Feishu WebSocket 长连接客户端 — 接收消息事件。
 * 对应 future-os `channels/feishu/feishu_ws.rs`。
 * 端点：GET /open-apis/bot/v2/ws/endpoint → wss 长连。
 * Node 20 无全局 WebSocket，使用 `ws` 包。
 */
import WebSocket from 'ws';

export interface WsEndpointResponse {
  code: number;
  msg: string;
  data?: { url?: string };
}

export interface FeishuMessageEvent {
  schema?: string;
  header?: {
    event_id?: string;
    event_type?: string;
    token?: string;
    create_time?: string;
  };
  event?: {
    message?: {
      message_id?: string;
      chat_id?: string;
      message_type?: string;
      content?: string;
      create_time?: string;
    };
    sender?: {
      sender_id?: { open_id?: string; user_id?: string };
      sender_type?: string;
    };
    operator?: unknown;
  };
}

export type MessageHandler = (event: FeishuMessageEvent) => Promise<void> | void;

export class FeishuWsClient {
  private ws: WebSocket | null = null;
  private running = false;

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly onMessage: MessageHandler,
  ) {}

  private async getEndpoint(): Promise<string> {
    const tokenResp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const tokenJson = (await tokenResp.json()) as FeishuTokenJson;
    const endpointResp = await fetch('https://open.feishu.cn/open-apis/bot/v2/ws/endpoint', {
      headers: { authorization: `Bearer ${tokenJson.tenant_access_token}` },
    });
    const json = (await endpointResp.json()) as WsEndpointResponse;
    if (json.code !== 0 || !json.data?.url) throw new Error(`feishu ws endpoint failed: ${json.code} ${json.msg}`);
    return json.data.url;
  }

  async start(): Promise<void> {
    this.running = true;
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    try {
      const url = await this.getEndpoint();
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.on('message', (data) => {
        try {
          const json = JSON.parse(String(data)) as FeishuMessageEvent;
          if (json.header?.event_type === 'im.message.receive_v1') {
            void this.onMessage(json);
          }
        } catch {
          // 忽略非 JSON
        }
      });
      ws.on('close', () => {
        this.ws = null;
        // 自动重连
        setTimeout(() => void this.connect(), 3000);
      });
      ws.on('error', () => {
        ws.close();
      });
    } catch (err) {
      console.error('[feishu] ws connect failed:', err);
      setTimeout(() => void this.connect(), 5000);
    }
  }

  stop(): void {
    this.running = false;
    this.ws?.close();
    this.ws = null;
  }
}

interface FeishuTokenJson {
  code: number;
  tenant_access_token?: string;
}
