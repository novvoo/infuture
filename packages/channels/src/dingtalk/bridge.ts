/**
 * DingTalk 桥接器 — 与 Feishu 桥接同构。对应 future-os `channels/dingtalk/*`。
 * 简化实现：REST 拉取 + 回发文本；WebSocket 长连结构保留。
 */
import type { Engine } from '@infuture/core';

export interface DingTalkBridgeOptions {
  appKey: string;
  appSecret: string;
  engine: Engine;
  useWebSocket?: boolean;
}

interface AccessTokenResp {
  errcode: number;
  access_token?: string;
  expires_in?: number;
}

interface RobotSendResp {
  errcode: number;
  errmsg?: string;
}

export class DingTalkBridge {
  private token: string | null = null;
  private tokenExpiry = 0;
  private readonly engine: Engine;

  constructor(private readonly options: DingTalkBridgeOptions) {
    this.engine = options.engine;
  }

  private async ensureToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiry) return this.token;
    const resp = await fetch(
      `https://oapi.dingtalk.com/gettoken?appkey=${this.options.appKey}&appsecret=${this.options.appSecret}`,
    );
    const json = (await resp.json()) as AccessTokenResp;
    if (json.errcode !== 0 || !json.access_token) throw new Error(`dingtalk token failed: ${json.errcode}`);
    this.token = json.access_token;
    this.tokenExpiry = Date.now() + (json.expires_in ? (json.expires_in - 60) * 1000 : 60 * 60 * 1000);
    return this.token;
  }

  async sendText(conversationId: string, text: string): Promise<void> {
    const token = await this.ensureToken();
    const resp = await fetch(`https://oapi.dingtalk.com/robot/groupmessages/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        msgParam: JSON.stringify({ content: text }),
        msgKey: 'sampleText',
        openConversationId: conversationId,
      }),
    });
    const json = (await resp.json()) as RobotSendResp;
    if (json.errcode !== 0) throw new Error(`dingtalk send failed: ${json.errcode} ${json.errmsg}`);
  }

  async handleIncoming(conversationId: string, staffId: string, text: string): Promise<void> {
    if (!text.trim()) return;
    // IM 文本命令：/approve <id> /reject <id> 响应审批
    const cmdMatch = /^\/(approve|reject)\s+(\S+)/.exec(text.trim());
    if (cmdMatch) {
      this.engine.approval.resolveApproval(cmdMatch[2], cmdMatch[1] === 'approve');
      await this.sendText(conversationId, `审批 ${cmdMatch[1] === 'approve' ? '已批准' : '已拒绝'} ${cmdMatch[2]}`);
      return;
    }
    // 每用户一个固定 id 会话（保证多轮上下文连续）
    const sessionId = `ding_${staffId}`;
    let session = await this.engine.sessions.load(sessionId);
    if (!session) session = await this.engine.sessions.create(`DingTalk ${staffId.slice(0, 6)}`, { id: sessionId });
    try {
      const outcome = await this.engine.run(session, text.trim());
      await this.sendText(conversationId, outcome.reply || '(no reply)');
    } catch (err) {
      await this.sendText(conversationId, `❌ ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
