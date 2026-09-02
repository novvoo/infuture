/**
 * Feishu REST 客户端 — 获取 tenant_access_token、发消息。
 * 对应 future-os `channels/feishu/feishu_rest.rs`。
 */
export interface FeishuTokenResponse {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
}

export interface FeishuSendMessageResponse {
  code: number;
  msg: string;
  data?: { message_id?: string };
}

export class FeishuRestClient {
  private token: string | null = null;
  private tokenExpiry = 0;
  private readonly base = 'https://open.feishu.cn/open-apis';

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
  ) {}

  private async ensureToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiry) return this.token;
    const resp = await fetch(`${this.base}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const json = (await resp.json()) as FeishuTokenResponse;
    if (json.code !== 0 || !json.tenant_access_token) {
      throw new Error(`feishu token failed: ${json.code} ${json.msg}`);
    }
    this.token = json.tenant_access_token;
    this.tokenExpiry = Date.now() + (json.expire ? (json.expire - 60) * 1000 : 60 * 60 * 1000);
    return this.token;
  }

  private async request<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
    const token = await this.ensureToken();
    const resp = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    });
    return (await resp.json()) as T;
  }

  /** 发送文本消息。 */
  async sendText(receiveId: string, receiveIdType: 'open_id' | 'chat_id' | 'user_id', text: string): Promise<FeishuSendMessageResponse> {
    return await this.request<FeishuSendMessageResponse>('/im/v1/messages', {
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    });
  }

  /** 发送卡片消息。 */
  async sendCard(receiveId: string, receiveIdType: string, card: unknown): Promise<FeishuSendMessageResponse> {
    return await this.request<FeishuSendMessageResponse>('/im/v1/messages', {
      receive_id: receiveId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    });
  }
}
