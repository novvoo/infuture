/**
 * Worker 测试：store worker CRUD + 持久化 + WorkerRuntime 错误路径 + 隔离目录。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Engine } from '@infuture/core';
import { LoopStore } from '../src/store.js';
import { WorkerRuntime } from '../src/worker.js';
import type { Worker } from '../src/types.js';

function mkWorker(id = 'w1'): Worker {
  return {
    id,
    goalId: 'g1',
    title: 'explorer',
    status: 'idle',
    sessionId: 's1',
    runId: '',
    cwd: '/tmp/w1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

test('LoopStore worker CRUD + 事件源持久化/恢复', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-w-'));
  try {
    const file = path.join(dir, 'events.jsonl');
    const store = new LoopStore(file);
    store.addWorker(mkWorker('w1'));
    store.updateWorker({ ...mkWorker('w1'), status: 'running' });
    await store.persist();

    const restored = new LoopStore(file);
    await restored.restore();
    const w = restored.worker('w1');
    assert.ok(w, '恢复后 worker 应存在');
    assert.equal(w?.status, 'running');
    assert.equal(restored.workersFor('g1').length, 1);

    restored.removeWorker('w1');
    assert.equal(restored.workersFor().length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('WorkerRuntime 无模型配置：worker 进入 error 而非挂死', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-e-'));
  try {
    const engine = new Engine({ configDir: dir, sessionDir: path.join(dir, 'sessions'), sandboxTier: 'off' });
    await engine.init();
    const store = new LoopStore();
    const rt = new WorkerRuntime({ engine, store });
    const workers = await rt.spawn('g1', [{ title: 'w1', prompt: 'hello' }]);
    assert.equal(workers.length, 1);
    // 等待异步 run 结束（无模型 → 未配置模型错误 → worker error）
    await new Promise((r) => setTimeout(r, 500));
    const w = store.worker(workers[0].id);
    assert.equal(w?.status, 'error');
    assert.match(w?.error ?? '', /未配置模型/);
    // worker 会话已绑定（WorkerSessionBound）
    assert.ok(w?.sessionId, 'worker 应绑定 agent 会话');
    engine.dispose();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('WorkerRuntime 隔离模式：worker 目录为独立临时目录且会话 cwd 指向它', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-i-'));
  try {
    const engine = new Engine({ configDir: dir, sessionDir: path.join(dir, 'sessions'), sandboxTier: 'off' });
    await engine.init();
    const store = new LoopStore();
    const rt = new WorkerRuntime({ engine, store, isolate: true, baseDir: dir });
    const workers = await rt.spawn('g1', [{ title: 'iso', prompt: 'x' }]);
    const w = workers[0];
    // 非 git 仓库 fallback：worker cwd 应是临时目录
    assert.ok(path.isAbsolute(w.cwd));
    assert.ok(await fs.stat(w.cwd).then(() => true, () => false), 'worker 工作目录应存在');
    const sess = await engine.sessions.load(w.sessionId);
    assert.equal(sess?.meta.cwd, w.cwd, 'worker 会话 cwd 应指向隔离目录');
    engine.dispose();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('WorkerRuntime.remove: 删除 worker 记录（含运行中先停）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-rm-'));
  try {
    const engine = new Engine({ configDir: dir, sessionDir: path.join(dir, 'sessions'), sandboxTier: 'off' });
    await engine.init();
    const store = new LoopStore();
    const rt = new WorkerRuntime({ engine, store });
    const workers = await rt.spawn('g1', [{ title: 'w1', prompt: 'hello' }]);
    const wid = workers[0].id;
    assert.ok(store.worker(wid), 'spawn 后 worker 存在');
    const removed = await rt.remove(wid);
    assert.equal(removed, true, '删除成功返回 true');
    assert.equal(store.worker(wid), undefined, '删除后 store 无此 worker');
    assert.equal(store.workersFor('g1').length, 0, 'goal 下无残留');
    assert.equal(await rt.remove(wid), false, '重复删除返回 false');
    engine.dispose();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** stub 引擎：记录 run 的 prompt，返回可控 reply（用于验证 worker 依赖注入）。 */
class StubEngine {
  workspace = '/tmp';
  runs: { sessionId: string; prompt: string; model?: string; thinking?: number }[] = [];
  sessions = {
    create: async (_name: string) => ({ id: 's-' + Math.random().toString(36).slice(2, 8), meta: {} }),
  };
  async run(
    sessionId: string,
    prompt: string,
    opts?: { model?: string; thinkingBudget?: number },
  ): Promise<{ reply: string; runId: string; cancelled: boolean }> {
    this.runs.push({ sessionId, prompt, model: opts?.model, thinking: opts?.thinkingBudget });
    return { reply: `OUT:${prompt.slice(0, 12)}`, runId: 'r-' + this.runs.length, cancelled: false };
  }
  async stop(): Promise<void> {}
}

async function waitRuns(stub: StubEngine, n: number, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (stub.runs.length < n) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待 ${n} 个 run 超时（实际 ${stub.runs.length}）`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('WorkerRuntime {wN} 依赖：前序 worker 输出注入后续 worker prompt 且串行等待', async () => {
  const stub = new StubEngine();
  const store = new LoopStore();
  const rt = new WorkerRuntime({ engine: stub as never, store });
  const workers = await rt.spawn('g-dep', [
    { title: 'solve', prompt: '解决目标' },
    { title: 'reflect', prompt: '反思 {w1} 的输出并给出改进建议' },
  ]);
  assert.equal(workers.length, 2);
  await waitRuns(stub, 2);
  // worker2 的 prompt 应已注入 worker1 的最终输出
  const p2 = stub.runs[1].prompt;
  assert.ok(p2.includes('OUT:解决目标'), `worker2 prompt 应注入 worker1 输出，实际: ${p2}`);
  assert.ok(!p2.includes('{w1}'), '占位符 {w1} 应被替换');
  // worker1 保持原 prompt
  assert.equal(stub.runs[0].prompt, '解决目标');
  // 无占位符时并行，依赖时顺序已由编排保证（worker2 一定在 worker1 之后）
  assert.ok(stub.runs[1].prompt.includes('反思'), 'worker2 应运行反思任务');
});

test('WorkerRuntime 无占位符：并行启动互不等待', async () => {
  const stub = new StubEngine();
  const store = new LoopStore();
  const rt = new WorkerRuntime({ engine: stub as never, store });
  await rt.spawn('g-para', [
    { title: 'a', prompt: '任务A' },
    { title: 'b', prompt: '任务B' },
  ]);
  await waitRuns(stub, 2);
  assert.equal(stub.runs[0].prompt, '任务A');
  assert.equal(stub.runs[1].prompt, '任务B');
});


test('WorkerRuntime per-worker model/thinking：透传给 engine.run', async () => {
  const stub = new StubEngine();
  const store = new LoopStore();
  const rt = new WorkerRuntime({ engine: stub as never, store });
  await rt.spawn('g-mt', [
    { title: 'a', prompt: '任务A', model: 'glm-5.3-flash', thinking: 1 },
    { title: 'b', prompt: '任务B' },
  ]);
  await waitRuns(stub, 2);
  assert.equal(stub.runs[0].model, 'glm-5.3-flash', 'worker1 模型应透传');
  assert.equal(stub.runs[0].thinking, 1, 'worker1 思考强度应透传');
  assert.equal(stub.runs[1].model, undefined, '未指定模型的 worker 用默认');
  assert.equal(stub.runs[1].thinking, undefined, '未指定思考强度的 worker 用默认');
});
