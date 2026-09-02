/**
 * Feishu 桥接测试：固定 id 会话连续、/approve 文本命令响应审批。
 * rest 用 mock 注入，不触网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Engine } from '@infuture/core';
import { FeishuBridge } from '../src/feishu/bridge.js';
import type { FeishuRestClient } from '../src/feishu/feishu_rest.js';

async function makeFixture(sandboxTier: 'off' | 'manual' = 'off') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'infuture-bridge-'));
  const engine = new Engine({ configDir: dir, sessionDir: path.join(dir, 'sessions'), sandboxTier });
  await engine.init();
  const sent: Array<{ kind: string; openId: string; text?: string }> = [];
  const rest = {
    sendText: async (openId: string, _receiveIdType: string, text: string) => {
      sent.push({ kind: 'text', openId, text });
    },
    sendCard: async (openId: string, _receiveIdType: string, _card: unknown) => {
      sent.push({ kind: 'card', openId });
    },
  } as unknown as FeishuRestClient;
  const bridge = new FeishuBridge({ appId: 'a', appSecret: 's', engine, rest });
  const event = (openId: string, text: string) => ({
    header: { event_type: 'im.message.receive_v1' },
    event: {
      message: { message_type: 'text', content: JSON.stringify({ text }) },
      sender: { sender_id: { open_id: openId } },
    },
  });
  return { engine, bridge, sent, event, dir };
}

test('同 openId 复用固定会话（多轮上下文连续）', async () => {
  const { engine, bridge, event, dir } = await makeFixture();
  try {
    await (bridge as unknown as { onMessage(e: unknown): Promise<void> }).onMessage(event('ou_123', '你好'));
    // 会话已创建
    const s1 = await engine.sessions.load('feishu_ou_123');
    assert.ok(s1, '应创建 feishu_ou_123 固定会话');
    // 第二条消息复用同一会话（不新建）
    const before = (await engine.sessions.listAll()).length;
    await (bridge as unknown as { onMessage(e: unknown): Promise<void> }).onMessage(event('ou_123', '再聊'));
    const after = (await engine.sessions.listAll()).length;
    assert.equal(after, before, '同用户不应新建会话');
    // 每次 run 追加 1 条 user 消息（无 key 时无 assistant 回复），两次共 2 条，均在会话内
    assert.equal(s1!.messages().length, 2, '两条消息应进同一会话');
  } finally {
    engine.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('/approve <id> 文本命令决议审批且不触发 run', async () => {
  const { engine, bridge, event, dir } = await makeFixture('manual');
  try {
    // 模拟一个挂起的审批
    const pending = engine.approval.request({ requestId: 'ap_1', toolName: 'shell', args: {}, sessionId: 's' });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(engine.approval.pendingCount() >= 1, '审批应挂起');
    await (bridge as unknown as { onMessage(e: unknown): Promise<void> }).onMessage(event('ou_456', '/approve ap_1'));
    const decision = await pending;
    assert.equal(decision.approved, true, '/approve 应批准审批');
    assert.equal(engine.approval.pendingCount(), 0);
  } finally {
    engine.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('/reject <id> 拒绝审批', async () => {
  const { engine, bridge, event, dir } = await makeFixture('manual');
  try {
    const pending = engine.approval.request({ requestId: 'ap_2', toolName: 'shell', args: {}, sessionId: 's' });
    await new Promise((r) => setTimeout(r, 20));
    await (bridge as unknown as { onMessage(e: unknown): Promise<void> }).onMessage(event('ou_789', '/reject ap_2'));
    const decision = await pending;
    assert.equal(decision.approved, false);
  } finally {
    engine.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
