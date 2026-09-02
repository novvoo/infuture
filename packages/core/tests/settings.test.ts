/**
 * Settings 持久化测试：默认值、往返、sandboxTier 校验、坏 JSON。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from '../src/config/settings.js';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'infuture-settings-'));
}

test('无文件时返回默认值', async () => {
  const dir = await tempDir();
  try {
    const s = await loadSettings({ configDir: dir });
    assert.deepEqual(s, DEFAULT_SETTINGS);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('save → load 往返', async () => {
  const dir = await tempDir();
  try {
    await saveSettings({ ...DEFAULT_SETTINGS, maxTurns: 5, codingToolsApproval: 'off' }, { configDir: dir });
    const s = await loadSettings({ configDir: dir });
    assert.equal(s.maxTurns, 5);
    assert.equal(s.codingToolsApproval, 'off');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('非法 sandboxTier 回退 manual', async () => {
  const dir = await tempDir();
  try {
    await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ sandboxTier: 'bogus' }), 'utf-8');
    const s = await loadSettings({ configDir: dir });
    assert.equal(s.sandboxTier, 'manual');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('坏 JSON 返回默认值', async () => {
  const dir = await tempDir();
  try {
    await fs.writeFile(path.join(dir, 'settings.json'), '{ not json', 'utf-8');
    const s = await loadSettings({ configDir: dir });
    assert.deepEqual(s, DEFAULT_SETTINGS);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
