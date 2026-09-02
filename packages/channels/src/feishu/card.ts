/**
 * Feishu 卡片渲染 — 把 agent 回复渲染成可交互卡片。
 * 对应 future-os `channels/feishu/card.rs`。
 */
export interface FeishuCard {
  schema: string;
  header?: { title: { tag: string; content: string } };
  elements: unknown[];
}

export function textCard(title: string, body: string): FeishuCard {
  const lines = body.split('\n').map((line) => line.trim());
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: title } },
    elements: [
      {
        tag: 'markdown',
        content: lines.join('\n'),
      },
    ],
  };
}

export function approvalCard(title: string, requestId: string, toolName: string, args: unknown): FeishuCard {
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: title } },
    elements: [
      { tag: 'markdown', content: `工具 **${toolName}** 请求审批` },
      { tag: 'markdown', content: '```json\n' + JSON.stringify(args, null, 2).slice(0, 1500) + '\n```' },
      {
        tag: 'action',
        actions: [
          { tag: 'button', text: { tag: 'plain_text', content: '✅ 批准' }, value: { requestId, decision: 'approve' } },
          { tag: 'button', text: { tag: 'plain_text', content: '⛔ 拒绝' }, value: { requestId, decision: 'reject' } },
        ],
      },
      {
        tag: 'markdown',
        content: `也可直接回复：\`/approve ${requestId}\` 或 \`/reject ${requestId}\``,
      },
    ],
  };
}

/** 解析卡片回调中的审批决策。 */
export function parseCardAction(payload: { action?: Array<{ value?: { requestId?: string; decision?: string } }> }) {
  const action = payload.action?.[0];
  if (!action?.value) return null;
  return { requestId: action.value.requestId ?? '', approved: action.value.decision === 'approve' };
}
