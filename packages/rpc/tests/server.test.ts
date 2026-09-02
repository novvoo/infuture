/**
 * RPC server 测试：session / model / settings / auth / model.custom。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Engine } from '@infuture/core';
import { ServerSession } from '../src/server.js';
import { METHODS, type RpcRequest } from '../src/protocol.js';

let dir: string;
let engine: Engine;
let server: ServerSession;

test.before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'infuture-rpc-'));
  engine = new Engine({ configDir: dir, sandboxTier: 'off' });
  await engine.init();
  server = new ServerSession(engine);
});

test.after(async () => {
  engine.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

function req(id: number, method: string, params?: unknown): RpcRequest {
  return { jsonrpc: '2.0', id, method, params };
}

test('session.create → list → messages 往返', async () => {
  const created = await server.handle(req(1, METHODS.SessionCreate, { name: 'RPC 会话' }));
  assert.equal(created.error, undefined, JSON.stringify(created.error));
  const sid = (created.result as { id: string }).id;
  const list = await server.handle(req(2, METHODS.SessionList));
  const found = (list.result as Array<{ id: string; name: string }>).find((s) => s.id === sid);
  assert.ok(found);
  assert.equal(found?.name, 'RPC 会话');
  const msgs = await server.handle(req(3, METHODS.SessionMessages, { id: sid }));
  assert.deepEqual(msgs.result, []);
});

test('attachRunEvents 广播事件带 sessionId（前端会话隔离依据）', () => {
  const seen: unknown[] = [];
  server.setNotificationHandler((n) => seen.push(n));
  const cb = (server as unknown as { attachRunEvents: (s?: string) => (e: unknown) => void }).attachRunEvents('session-abc');
  cb({ type: 'text_delta', runId: 'run-1', text: 'hi' });
  assert.equal(seen.length, 1);
  const n = seen[0] as { method: string; params: { sessionId?: string; event: unknown } };
  assert.equal(n.method, 'event');
  assert.equal(n.params.sessionId, 'session-abc');
  assert.deepEqual(n.params.event, { type: 'text_delta', runId: 'run-1', text: 'hi' });
});

test('model.list 返回用户配置的模型（无内置）', async () => {
  // 模型由用户配置：注入测试模型
  engine.models.add({ id: 'deepseek-chat', name: 'DeepSeek', provider: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', contextWindow: 64000, maxTokens: 8192, reasoning: false });
  engine.models.add({ id: 'glm-4.7', name: 'GLM', provider: 'glm', api: 'openai-completions', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', contextWindow: 200000, maxTokens: 128000, reasoning: false });
  const res = await server.handle(req(4, METHODS.ModelList));
  const models = res.result as Array<{ id: string }>;
  assert.ok(models.some((m) => m.id === 'deepseek-chat'));
  assert.ok(models.some((m) => m.id === 'glm-4.7'));
});

test('model.select 切换并持久化', async () => {
  const res = await server.handle(req(5, METHODS.ModelSelect, { id: 'deepseek-chat' }));
  assert.equal((res.result as { ok: boolean }).ok, true);
  assert.equal(engine.settings.defaultModel, 'deepseek-chat');
  // 持久化到文件
  const disk = JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf-8'));
  assert.equal(disk.defaultModel, 'deepseek-chat');
});

test('model.select 未知模型报错', async () => {
  const res = await server.handle(req(6, METHODS.ModelSelect, { id: 'no-such-model' }));
  assert.ok(res.error);
  assert.ok(res.error.message.includes('unknown model'));
});

test('settings.get / settings.set 白名单过滤', async () => {
  const res = await server.handle(req(7, METHODS.SettingsSet, { maxTurns: 4, evilField: 'x' }));
  assert.equal((res.result as { maxTurns: number }).maxTurns, 4);
  assert.equal((res.result as { evilField?: string }).evilField, undefined, '非法字段不应写入');
  const got = await server.handle(req(8, METHODS.SettingsGet));
  assert.equal((got.result as { maxTurns: number }).maxTurns, 4);
});

test('auth.set → auth.get 往返', async () => {
  const res = await server.handle(req(9, METHODS.AuthSet, { providerId: 'openai', key: 'sk-test', baseUrl: 'https://api.openai.com/v1' }));
  assert.equal((res.result as { ok: boolean }).ok, true);
  const got = await server.handle(req(10, METHODS.AuthGet));
  const entries = got.result as Record<string, { baseUrl: string; hasKey: boolean }>;
  assert.equal(entries.openai.hasKey, true);
  assert.equal(entries.openai.baseUrl, 'https://api.openai.com/v1');
});

test('auth.set 缺 providerId 报错', async () => {
  const res = await server.handle(req(11, METHODS.AuthSet, { key: 'x' }));
  assert.ok(res.error);
});

test('model.custom 添加自定义模型并持久化', async () => {
  const res = await server.handle(req(12, METHODS.ModelCustom, {
    id: 'local-m', name: 'Local', provider: 'local', api: 'openai-completions', baseUrl: 'http://127.0.0.1:11434/v1',
  }));
  assert.equal((res.result as { ok: boolean }).ok, true);
  assert.ok(engine.models.get('local-m'));
  const disk = JSON.parse(await fs.readFile(path.join(dir, 'models.json'), 'utf-8')) as { providers?: Record<string, { models?: Array<{ id: string }> }> };
  const customModels = disk.providers?.local?.models ?? [];
  assert.ok(customModels.some((m) => m.id === 'local-m'));
});

test('model.remove 删除自定义模型并持久化', async () => {
  await server.handle(req(15, METHODS.ModelCustom, {
    id: 'local-m2', name: 'Local2', provider: 'local', api: 'openai-completions', baseUrl: 'http://127.0.0.1:11434/v1',
  }));
  assert.ok(engine.models.get('local-m2'));

  const res = await server.handle(req(16, METHODS.ModelRemove, { id: 'local-m2' }));
  assert.equal((res.result as { ok: boolean; removed: boolean }).removed, true);
  assert.ok(!engine.models.get('local-m2'));

  // models.json 持久化同步删除
  const disk = JSON.parse(await fs.readFile(path.join(dir, 'models.json'), 'utf-8')) as { providers?: Record<string, { models?: Array<{ id: string }> }> };
  assert.ok(!(disk.providers?.local?.models ?? []).some((m) => m.id === 'local-m2'));
});

test('model.remove 删除不存在的模型返回 removed=false', async () => {
  const res = await server.handle(req(17, METHODS.ModelRemove, { id: 'no-such-model' }));
  assert.equal((res.result as { removed: boolean }).removed, false);
});

test('doctor 返回能力状态', async () => {
  const res = await server.handle(req(13, METHODS.Doctor));
  const d = res.result as { programming: boolean; tools: number; codingTools: number };
  assert.ok(d.tools >= 6);
  assert.ok(d.codingTools >= 40);
});

test('未知方法返回错误', async () => {
  const res = await server.handle(req(14, 'no.such.method'));
  assert.ok(res.error);
});
