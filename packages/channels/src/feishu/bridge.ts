/**
 * Feishu 桥接器 — 把 IM 消息路由到 Engine 会话，回复回发为卡片/文本。
 * 对应 future-os `channels/feishu/bridge.rs` + `prompt_loop.rs`。
 */
import type { Engine } from '@infuture/core';
import { FeishuRestClient } from './feishu_rest.js';
import { FeishuWsClient, type FeishuMessageEvent } from './feishu_ws.js';
import { textCard, approvalCard } from './card.js';

export interface FeishuBridgeOptions {
  appId: string;
  appSecret: string;
  engine: Engine;
  useWebSocket?: boolean;
  /** 测试注入用；默认按 appId/appSecret 创建真实客户端。 */
  rest?: FeishuRestClient;
}

export class FeishuBridge {
  private readonly rest: FeishuRestClient;
  private readonly ws: FeishuWsClient | null = null;
  private readonly engine: Engine;

  constructor(options: FeishuBridgeOptions) {
    this.rest = options.rest ?? new FeishuRestClient(options.appId, options.appSecret);
    this.engine = options.engine;
    if (options.useWebSocket) {
      this.ws = new FeishuWsClient(options.appId, options.appSecret, (ev) => this.onMessage(ev));
    }
  }

  async start(): Promise<void> {
    if (this.ws) {
      await this.ws.start();
    }
  }

  stop(): void {
    this.ws?.stop();
  }

  private async onMessage(event: FeishuMessageEvent): Promise<void> {
    const message = event.event?.message;
    const sender = event.event?.sender;
    if (!message || !sender) return;

    // 仅处理文本消息
    if (message.message_type !== 'text') return;
    let text = '';
    try {
      const content = JSON.parse(message.content ?? '{}') as { text?: string };
      text = content.text ?? '';
    } catch {
      text = message.content ?? '';
    }
    if (!text.trim()) return;

    const openId = sender.sender_id?.open_id ?? '';
    if (!openId) return;

    // 每用户一个固定 id 会话（保证多轮上下文连续）
    const sessionId = `feishu_${openId}`;
    let session = await this.engine.sessions.load(sessionId);
    if (!session) {
      session = await this.engine.sessions.create(`Feishu ${openId.slice(0, 6)}`, { id: sessionId });
    }

    // IM 文本命令：/approve <id> /reject <id> 响应审批
    const cmdMatch = /^\/(approve|reject)\s+(\S+)/.exec(text.trim());
    if (cmdMatch) {
      this.engine.approval.resolveApproval(cmdMatch[2], cmdMatch[1] === 'approve');
      await this.rest.sendText(openId, 'open_id', `审批 ${cmdMatch[1] === 'approve' ? '已批准' : '已拒绝'} ${cmdMatch[2]}`);
      return;
    }

    try {
      const outcome = await this.engine.run(session, text.trim(), {
        onEvent: (ev) => {
          if (ev.type === 'approval_requested') {
            void this.rest.sendCard(openId, 'open_id', approvalCard('审批请求', ev.requestId, ev.toolName, ev.args));
          }
        },
      });
      const reply = outcome.reply || '(no reply)';
      await this.rest.sendCard(openId, 'open_id', textCard('infuture', reply));
    } catch (err) {
      await this.rest.sendText(openId, 'open_id', `❌ ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 外部调用以响应卡片审批。 */
  resolveApproval(requestId: string, approved: boolean): void {
    this.engine.approval.resolveApproval(requestId, approved);
  }
}
