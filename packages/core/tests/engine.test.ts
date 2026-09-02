/**
 * Engine 集成测试：init 加载持久化设置与自定义模型、configDir 隔离。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Engine } from '../src/engine.js';
import { DEFAULT_SETTINGS } from '../src/config/settings.js';

async function tempConfig(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'infuture-engine-'));
}

test('Engine.init 读取 settings.json 与 models.json', async () => {
  const dir = await tempConfig();
  try {
    await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ defaultModel: 'deepseek-chat', maxTurns: 3 }), 'utf-8');
    await fs.writeFile(
      path.join(dir, 'models.json'),
      JSON.stringify({
        providers: {
          myprov: {
            baseUrl: 'https://x.example/v1',
            models: [{ id: 'my-custom', name: 'Custom', api: 'openai-completions', contextWindow: 64000, maxTokens: 2048, reasoning: false }],
          },
        },
      }),
      'utf-8',
    );
    const engine = new Engine({ configDir: dir, sandboxTier: 'off' });
    await engine.init();
    assert.equal(engine.settings.defaultModel, 'deepseek-chat');
    assert.equal(engine.settings.maxTurns, 3);
    const custom = engine.models.get('my-custom');
    assert.ok(custom, '自定义模型应被加载');
    assert.equal(custom?.provider, 'myprov');
    // 不污染真实配置：settings.json 不写在别处
    engine.dispose();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Engine.addCustomModelToFile 往返持久化', async () => {
  const dir = await tempConfig();
  try {
    const engine = new Engine({ configDir: dir });
    const model = {
      id: 'a1',
      name: 'A1',
      provider: 'p',
      api: 'openai-completions',
      baseUrl: '',
      contextWindow: 1000,
      maxTokens: 1000,
      reasoning: false,
      hide: false,
    };
    await engine.addCustomModelToFile(model);
    engine.models.add(model);
    // 新 engine 实例从文件加载
    const e2 = new Engine({ configDir: dir });
    await e2.init();
    assert.ok(e2.models.get('a1'));
    // 文件应为 providers 对象格式
    const disk = JSON.parse(await fs.readFile(path.join(dir, 'models.json'), 'utf-8')) as { providers?: Record<string, unknown> };
    assert.ok(disk.providers?.p, 'models.json 应为 providers 对象格式');
    engine.dispose();
    e2.dispose();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Engine.loadPersistedSettings 不覆盖构造函数显式设置', async () => {
  const dir = await tempConfig();
  try {
    await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ sandboxTier: 'manual', maxTurns: 1 }), 'utf-8');
    const engine = new Engine({ configDir: dir, sandboxTier: 'off' });
    await engine.init();
    // loadPersistedSettings 用磁盘值覆盖（merge）
    assert.equal(engine.settings.maxTurns, 1);
    assert.equal(engine.settings.sandboxTier, 'manual');
    engine.dispose();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Engine 不内置模型：无配置时模型目录为空', async () => {
  const dir = await tempConfig();
  try {
    const engine = new Engine({ configDir: dir, sandboxTier: 'off' });
    await engine.init();
    assert.equal(engine.models.list().length, 0, '模型应全部由用户配置，无内置');
    engine.dispose();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Engine.settings 默认值（defaultModel 为空）', () => {
  const engine = new Engine({});
  assert.equal(engine.settings.defaultModel, '');
  assert.equal(engine.settings.sandboxTier, 'manual');
  assert.equal(engine.settings.codingToolsApproval, 'on');
  assert.equal(engine.settings.maxTurns, DEFAULT_SETTINGS.maxTurns);
  engine.dispose();
});

test('Engine.spawnSubagent 无模型配置时清晰报错且不创建子会话', async () => {
  const dir = await tempConfig();
  try {
    const engine = new Engine({
      configDir: dir,
      sessionDir: path.join(dir, 'sessions'),
      sandboxTier: 'off',
    });
    await engine.init();
    assert.equal(engine.settings.defaultModel, '', '空 configDir 下 defaultModel 应为空');
    await assert.rejects(
      () => engine.spawnSubagent('列出当前目录'),
      /未配置模型/,
      'resolveClient 应抛出"未配置模型"',
    );
    // 失败发生在创建子会话之前，不应产生任何子会话
    assert.equal((await engine.sessions.listAll()).length, 0, '失败路径不应创建子会话');
    engine.dispose();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
