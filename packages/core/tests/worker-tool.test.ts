import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnWorkersTool, listWorkersTool } from '../src/tools/worker.js';

test('spawn_workers 工具：委托 spawner 并返回 worker 信息', async () => {
  let called: { goal: string; tasks: { title: string; prompt: string }[]; isolate: boolean } | undefined;
  const tool = spawnWorkersTool(async (goal, tasks, isolate) => {
    called = { goal, tasks, isolate };
    return [{ id: 'w1', title: 'a' }, { id: 'w2', title: 'b' }];
  });
  const res = await tool.handler(
    { goal: 'g', tasks: [{ title: 'a', prompt: 'x' }, { title: 'b', prompt: '反思 {w1}' }], isolate: false },
    {},
  );
  assert.equal(res.is_error, false);
  assert.ok(String(res.result).includes('w1'), '返回应含 worker 信息');
  assert.equal(called?.goal, 'g');
  assert.equal(called?.tasks.length, 2);
  assert.equal(called?.tasks[1].prompt, '反思 {w1}', 'tasks 应原样传递（依赖由 worker 运行时解析）');
  assert.equal(called?.isolate, false);
});

test('spawn_workers 工具：未注入运行时 → 明确报错而非静默成功', async () => {
  const tool = spawnWorkersTool();
  const res = await tool.handler({ goal: 'g', tasks: [{ title: 'a', prompt: 'x' }] }, {});
  assert.equal(res.is_error, true);
  assert.ok(String(res.result).includes('未注入'), '应提示运行时未注入');
});

test('spawn_workers 工具：缺参/空 tasks → 校验失败', async () => {
  const tool = spawnWorkersTool(async () => []);
  const noGoal = await tool.handler({ tasks: [{ title: 'a', prompt: 'x' }] }, {});
  assert.equal(noGoal.is_error, true);
  const noTasks = await tool.handler({ goal: 'g' }, {});
  assert.equal(noTasks.is_error, true);
  const empty = await tool.handler({ goal: 'g', tasks: [] }, {});
  assert.equal(empty.is_error, true);
  const noPrompt = await tool.handler({ goal: 'g', tasks: [{ title: 'a' }] }, {});
  assert.equal(noPrompt.is_error, true);
});

test('spawn_workers 工具：spawner 抛错 → 返回错误结果', async () => {
  const tool = spawnWorkersTool(async () => {
    throw new Error('boom');
  });
  const res = await tool.handler({ goal: 'g', tasks: [{ title: 'a', prompt: 'x' }] }, {});
  assert.equal(res.is_error, true);
  assert.ok(String(res.result).includes('boom'));
});


test('spawn_workers 工具：透传 model/thinking 到 spawner', async () => {
  let called: { tasks: { title: string; prompt: string; model?: string; thinking?: number }[] } | undefined;
  const tool = spawnWorkersTool(async (_g, tasks) => {
    called = { tasks };
    return [{ id: 'w1' }];
  });
  await tool.handler(
    { goal: 'g', tasks: [{ title: 'a', prompt: 'x', model: 'glm-5.3-flash', thinking: 2 }] },
    {},
  );
  assert.equal(called?.tasks[0].model, 'glm-5.3-flash');
  assert.equal(called?.tasks[0].thinking, 2);
});

test('list_workers 工具：委托 lister 并返回 JSON', async () => {
  let goalArg: string | undefined;
  const tool = listWorkersTool(async (goal) => {
    goalArg = goal;
    return [{ id: 'w1', status: 'done', result: 'ok' }];
  });
  const res = await tool.handler({ goal: 'g' }, {});
  assert.equal(res.is_error, false);
  assert.ok(String(res.result).includes('"done"'));
  assert.equal(goalArg, 'g');
});

test('list_workers 工具：未注入运行时 → 明确报错', async () => {
  const tool = listWorkersTool();
  const res = await tool.handler({}, {});
  assert.equal(res.is_error, true);
  assert.ok(String(res.result).includes('未注入'));
});

test('list_workers 工具：wait 模式阻塞直到全部 worker 终态后返回', async () => {
  let calls = 0;
  const tool = listWorkersTool(async () => {
    calls++;
    if (calls < 3) return [{ id: 'w1', status: 'running' }, { id: 'w2', status: 'running' }];
    return [
      { id: 'w1', status: 'done', result: '结论A' },
      { id: 'w2', status: 'error', error: '失败' },
    ];
  });
  const res = await tool.handler({ goal: 'g', wait: true, timeoutSec: 10 }, {});
  assert.equal(res.is_error, false);
  assert.ok(String(res.result).includes('结论A'), 'wait 结束应包含 worker 最终结果');
  assert.ok(calls >= 3, '应轮询多次直到终态');
  assert.ok(!String(res.result).includes('超时'), '不应超时');
});

test('list_workers 工具：wait 模式超时返回当前状态并标注', async () => {
  const tool = listWorkersTool(async () => [{ id: 'w1', status: 'running' }]);
  const res = await tool.handler({ goal: 'g', wait: true, timeoutSec: 1 }, {});
  assert.equal(res.is_error, false);
  assert.ok(String(res.result).includes('超时'), '超时应明确标注');
  assert.ok(String(res.result).includes('running'));
});

test('list_workers 工具：wait 模式收到取消信号提前返回', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const tool = listWorkersTool(async () => [{ id: 'w1', status: 'running' }]);
  const res = await tool.handler({ goal: 'g', wait: true, timeoutSec: 10 }, { signal: ctrl.signal });
  assert.equal(res.is_error, false);
  assert.ok(String(res.result).includes('取消'), '取消时应立即返回');
});
