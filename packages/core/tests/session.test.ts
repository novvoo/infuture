/**
 * Session 管理测试：固定 id 会话、meta 持久化、listAll 磁盘合并。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { SessionManager } from '../src/session/manager.js';
import { newUserMessage } from '@infuture/types';

async function tempManager(): Promise<{ manager: SessionManager; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'infuture-session-'));
  return { manager: new SessionManager({ sessionDir: dir }), dir };
}

test('固定 id 会话可 load 往返（IM 通道多轮上下文）', async () => {
  const { manager, dir } = await tempManager();
  try {
    const s = await manager.create('Feishu user', { id: 'feishu_abc' });
    assert.equal(s.id, 'feishu_abc');
    await manager.appendMessage(s, newUserMessage('user', '你好'));
    // 用同一 manager load
    const loaded = await manager.load('feishu_abc');
    assert.ok(loaded);
    assert.equal(loaded.messages().length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('会话 meta 持久化：重启后 name/cwd/model 保留', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'infuture-session-meta-'));
  try {
    const m1 = new SessionManager({ sessionDir: dir, defaultModel: 'default', defaultCwd: '/x' });
    const s = await m1.create('我的会话');
    s.meta.name = '重命名会话';
    s.meta.model = 'deepseek-chat';
    s.meta.cwd = '/work';
    await m1.appendMessage(s, newUserMessage('user', 'hi'));
    // 模拟重启：新 manager 实例
    const m2 = new SessionManager({ sessionDir: dir });
    const restored = await m2.load(s.id);
    assert.ok(restored);
    assert.equal(restored.meta.name, '重命名会话');
    assert.equal(restored.meta.model, 'deepseek-chat');
    assert.equal(restored.meta.cwd, '/work');
    assert.equal(restored.messages().length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('listAll 合并磁盘会话', async () => {
  const { manager, dir } = await tempManager();
  try {
    const s1 = await manager.create('A');
    const s2 = await manager.create('B');
    await manager.appendMessage(s1, newUserMessage('user', 'x'));
    await manager.appendMessage(s2, newUserMessage('user', 'y'));
    // 新 manager 只 load 一个，再 listAll 应看到两个
    const fresh = new SessionManager({ sessionDir: dir });
    await fresh.load(s1.id);
    const all = await fresh.listAll();
    assert.equal(all.length, 2);
    const names = new Set(all.map((s) => s.meta.name));
    assert.ok(names.has('A'));
    assert.ok(names.has('B'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('delete 清理会话文件与 meta', async () => {
  const { manager, dir } = await tempManager();
  try {
    const s = await manager.create('X');
    await manager.appendMessage(s, newUserMessage('user', 'hi'));
    await manager.delete(s.id);
    const loaded = await manager.load(s.id);
    assert.equal(loaded, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
