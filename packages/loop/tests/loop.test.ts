/**
 * Loop 测试：无人值守审批策略（auto / timeout / deny）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { LoopPlanner } from '../src/planner.js';
import { LoopStore } from '../src/store.js';
import { LoopControl } from '../src/control.js';
import { DefaultApprovalGate, type ApprovalDecision } from '@infuture/core';
import type { Engine } from '@infuture/core';

/** stub engine：每次 run 真实发起一次审批请求并等待决议。 */
function makeStubEngine(gate: DefaultApprovalGate, decisions: ApprovalDecision[]) {
  let idc = 0;
  return {
    sessions: {
      create: async () => ({ id: `s_${++idc}` }),
    },
    approval: gate,
    run: async (_session: unknown, _prompt: string, opts: { onEvent?: (e: unknown) => void }) => {
      const requestId = `ap_${++idc}`;
      // 与真实 run-loop 一致：先发起审批（同步进入 pending map），再发事件供 planner 决议
      const requestP = gate.request({ requestId, toolName: 'bash', args: {}, sessionId: 's' });
      opts.onEvent?.({
        type: 'approval_requested',
        requestId,
        toolName: 'bash',
        args: { command: 'echo ok' },
        runId: `r_${idc}`,
      });
      const decision = await requestP;
      decisions.push(decision);
      return { reply: 'ok', cancelled: false, error: undefined, turns: 1 };
    },
  };
}

function makePlanner(approvalMode: 'auto' | 'timeout' | 'deny', timeoutMs = 2000) {
  const gate = new DefaultApprovalGate({ tier: 'manual', timeoutMs });
  const decisions: ApprovalDecision[] = [];
  const engine = makeStubEngine(gate, decisions) as unknown as Engine;
  const planner = new LoopPlanner({ engine, approvalMode });
  return { planner, gate, decisions };
}

test('loop approvalMode=auto: 审批被自动批准', async () => {
  const { planner, decisions } = makePlanner('auto');
  const goal = planner.createGoal('g', '跑一个任务', []);
  planner.addTodo(goal.id, '执行命令');
  await planner.driveOnce();
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].approved, true);
});

test('loop approvalMode=deny: 审批被快速拒绝', async () => {
  const { planner, decisions } = makePlanner('deny');
  const goal = planner.createGoal('g', '跑一个任务', []);
  planner.addTodo(goal.id, '执行命令');
  await planner.driveOnce();
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].approved, false);
});

test('loop approvalMode=timeout: 不干预，等待审批门超时自动拒绝', async () => {
  const { planner, decisions } = makePlanner('timeout', 120);
  const goal = planner.createGoal('g', '跑一个任务', []);
  planner.addTodo(goal.id, '执行命令');
  const t0 = Date.now();
  await planner.driveOnce();
  const elapsed = Date.now() - t0;
  // 依赖超时（120ms）自动拒绝，而非立即决议
  assert.ok(elapsed >= 90, `timeout 模式应等待超时（elapsed=${elapsed}ms）`);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].approved, false);
  assert.equal(decisions[0].reason, 'approval timeout');
});

test('loop 事件源：driveOnce 记录 goal 与 todo 状态', async () => {
  const { planner } = makePlanner('auto');
  const goal = planner.createGoal('g2', '持久化目标', []);
  planner.addTodo(goal.id, 'todo1');
  await planner.driveOnce();
  assert.equal(planner.store.goalsFor().length, 1);
  assert.equal(planner.store.goalsFor()[0].id, goal.id);
});

test('loop removeGoal：清除目标全部状态与事件历史，磁盘同步过滤且不影响其他 goal', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'infuture-loop-test-'));
  const file = path.join(dir, 'events.jsonl');
  const store = new LoopStore(file);
  const now = Date.now();

  // goal-1：完整状态（todo / gate / worker / lease，含 worker_removed 与 lease_expired 墓碑）
  store.addGoal({ id: 'goal-1', title: 'g1', objective: 'o', acceptanceCriteria: [], status: 'active', createdAt: now, updatedAt: now });
  store.setTodo({ id: 'todo-1', goalId: 'goal-1', title: 'td', status: 'pending', dependencies: [], evidence: [], createdAt: now, updatedAt: now });
  store.setGate({ id: 'gate-1', goalId: 'goal-1', kind: 'evidence', check: 'c', evidenceFloor: 1, passed: false }, false);
  store.addWorker({ id: 'worker-1', goalId: 'goal-1', title: 'w', status: 'done', sessionId: 's-1', runId: 'r-1', cwd: '/tmp/x', createdAt: now, updatedAt: now });
  store.acquireLease({ id: 'lease-1', goalId: 'goal-1', acquiredAt: now, expiresAt: now + 100_000, holder: 'h' });
  store.removeWorker('worker-1');
  store.releaseLease('lease-1');

  // goal-2：不受影响
  store.addGoal({ id: 'goal-2', title: 'g2', objective: 'o', acceptanceCriteria: [], status: 'active', createdAt: now, updatedAt: now });
  store.addWorker({ id: 'worker-2', goalId: 'goal-2', title: 'w2', status: 'done', sessionId: 's-2', runId: 'r-2', cwd: '/tmp/y', createdAt: now, updatedAt: now });
  await store.persist();

  const { removedEvents } = await store.removeGoal('goal-1');
  assert.ok(removedEvents > 0, '应移除 goal-1 的事件');
  assert.equal(store.goalsFor('goal-1').length, 0);
  assert.equal(store.todosFor('goal-1').length, 0);
  assert.equal(store.gatesFor('goal-1').length, 0);
  assert.equal(store.workersFor('goal-1').length, 0);
  assert.equal(store.activeLease('goal-1'), undefined);
  // 其他 goal 保持完整
  assert.equal(store.goalsFor('goal-2').length, 1);
  assert.equal(store.workersFor('goal-2').length, 1);

  // 磁盘重放：goal-1 相关事件（含墓碑）已过滤
  const store2 = new LoopStore(file);
  await store2.restore();
  assert.equal(store2.goalsFor('goal-1').length, 0);
  assert.equal(store2.workersFor('goal-1').length, 0);
  assert.equal(store2.goalsFor('goal-2').length, 1);
  assert.equal(store2.workersFor('goal-2').length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test('loop removeGoal：控制层封装，goal 不存在时抛错', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'infuture-loop-test-'));
  const file = path.join(dir, 'events.jsonl');
  const store = new LoopStore(file);
  store.addGoal({ id: 'goal-x', title: 'x', objective: 'o', acceptanceCriteria: [], status: 'active', createdAt: 1, updatedAt: 1 });
  const ctl = new LoopControl(store);
  const r = await ctl.removeGoal('goal-x');
  assert.equal(r.goalTitle, 'x');
  assert.equal(ctl.status().length, 0);
  await assert.rejects(() => ctl.removeGoal('goal-x'), /not found/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('loop clearHistory：清运行历史但保留 goal 与事项/门禁，磁盘同步', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'infuture-loop-test-'));
  const file = path.join(dir, 'events.jsonl');
  const store = new LoopStore(file);
  const now = Date.now();

  store.addGoal({ id: 'goal-h', title: 'gh', objective: 'o', acceptanceCriteria: [], status: 'active', createdAt: now, updatedAt: now });
  store.setTodo({ id: 'todo-h', goalId: 'goal-h', title: 'td', status: 'done', dependencies: [], evidence: ['e1'], createdAt: now, updatedAt: now });
  store.setGate({ id: 'gate-h', goalId: 'goal-h', kind: 'evidence', check: 'c', evidenceFloor: 1, passed: true, lastRun: now }, true);
  store.addWorker({ id: 'worker-h', goalId: 'goal-h', title: 'w', status: 'done', sessionId: 's-1', runId: 'r-1', cwd: '/tmp/x', createdAt: now, updatedAt: now });
  store.acquireLease({ id: 'lease-h', goalId: 'goal-h', acquiredAt: now, expiresAt: now + 100_000, holder: 'h' });
  await store.persist();

  const { removedEvents } = await store.clearHistory('goal-h');
  assert.ok(removedEvents > 0, '应移除历史事件');
  // 保留 goal / todo / gate
  assert.equal(store.goalsFor('goal-h').length, 1);
  assert.equal(store.todosFor('goal-h').length, 1);
  assert.equal(store.gatesFor('goal-h').length, 1);
  // 清除 worker / lease
  assert.equal(store.workersFor('goal-h').length, 0);
  assert.equal(store.activeLease('goal-h'), undefined);

  // 磁盘重放：一致
  const store2 = new LoopStore(file);
  await store2.restore();
  assert.equal(store2.goalsFor('goal-h').length, 1);
  assert.equal(store2.todosFor('goal-h').length, 1);
  assert.equal(store2.workersFor('goal-h').length, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test('loop 控制层 todos / events / clearHistory：目标菜单数据源', async () => {
  const store = new LoopStore();
  const ctl = new LoopControl(store);
  const now = Date.now();
  store.addGoal({ id: 'goal-v', title: 'gv', objective: 'o', acceptanceCriteria: [], status: 'active', createdAt: now, updatedAt: now });
  store.setTodo({ id: 'todo-v', goalId: 'goal-v', title: 'td', status: 'pending', dependencies: [], evidence: [], createdAt: now, updatedAt: now });
  store.addWorker({ id: 'worker-v', goalId: 'goal-v', title: 'w', status: 'done', sessionId: 's-1', runId: 'r-1', cwd: '/tmp/x', createdAt: now, updatedAt: now });

  const todos = ctl.todos('goal-v');
  assert.equal(todos.length, 1);
  assert.equal(todos[0].title, 'td');

  const events = ctl.events('goal-v');
  assert.ok(events.length >= 2, '应有 goal 创建 + todo + worker 事件');
  assert.ok(events.some((e) => e.text.includes('目标创建')));
  assert.ok(events.some((e) => e.text.includes('worker 启动')));

  const r = await ctl.clearHistory('goal-v');
  assert.equal(r.goalTitle, 'gv');
  assert.equal(ctl.todos('goal-v').length, 1, '清理历史后事项仍在');
  assert.equal(ctl.events('goal-v').filter((e) => e.text.includes('worker')).length, 0, '清理历史后 worker 事件消失');
  await assert.rejects(() => ctl.clearHistory('goal-none'), /not found/);
});
