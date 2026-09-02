/**
 * LoopControl 测试：吸收自 future-os `future-loop` 的控制平面命令
 * （status / replan / lease / task-graph / frontier / backup / runs）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { LoopStore } from '../src/store.js';
import { LoopPlanner } from '../src/planner.js';
import { LoopControl } from '../src/control.js';

function makeControl() {
  const store = new LoopStore();
  const planner = new LoopPlanner({ engine: {} as never, approvalMode: 'auto', store });
  const goal = planner.createGoal('g-status', '重构 typescript', ['类型检查通过']);
  const aTodo = planner.addTodo(goal.id, 'a: 建立基础');
  const b = planner.addTodo(goal.id, 'b: 依赖 a', [aTodo.id]);
  const c = planner.addTodo(goal.id, 'c: 依赖 b', [b.id]);
  planner.addTodo(goal.id, 'd: 独立任务');
  planner.addGate(goal.id, 'evidence', 'tsc 0', 1);
  return { store, planner, goal, c };
}

test('control.status: 目标状态总览含进度/计数/next action', () => {
  const { store, goal, c } = makeControl();
  const ctl = new LoopControl(store);
  const [r] = ctl.status(goal.id);
  assert.equal(r.goalId, goal.id);
  assert.equal(r.status, 'active');
  assert.equal(r.todos.total, 4);
  assert.equal(r.progress, 0);
  assert.equal(r.gates.total, 1);
  assert.equal(r.gates.passed, 0);
  assert.equal(r.nextAction, 'a: 建立基础'); // 最早可推进 todo

  // 完成 a → b 依赖满足变为可推进（更早创建），next 应为 b
  const [aTodo] = store.todosFor(goal.id).filter((t) => t.title.startsWith('a'));
  store.setTodo({ ...aTodo, status: 'done', updatedAt: Date.now() });
  const [r2] = ctl.status(goal.id);
  assert.equal(r2.progress, 25);
  assert.equal(r2.nextAction, 'b: 依赖 a');
});

test('control.frontier: 只返回依赖满足的未完成 todo', () => {
  const { store } = makeControl();
  const ctl = new LoopControl(store);
  // 初始：只有 a 和 d 无依赖可推进
  const f = ctl.frontier();
  const titles = f.map((t) => t.title);
  assert.ok(titles.includes('a: 建立基础'));
  assert.ok(titles.includes('d: 独立任务'));
  assert.ok(!titles.includes('b: 依赖 a'));
});

test('control.replan: 依赖未满足 pending→blocked；blocked 且依赖满足→pending', () => {
  const { store, goal, c } = makeControl();
  const ctl = new LoopControl(store);
  const r = ctl.replan(goal.id);
  // b 依赖 a（未完成）→ blocked；c 依赖 b → 也被阻塞
  const bTodo = store.todosFor(goal.id).find((t) => t.title.startsWith('b'))!;
  const cTodo = store.todosFor(goal.id).find((t) => t.title.startsWith('c'))!;
  assert.equal(r.changes.length, 2);
  assert.equal(r.changes[0].todoId, bTodo.id);
  assert.equal(r.changes[0].from, 'pending');
  assert.equal(r.changes[0].to, 'blocked');
  assert.equal(store.todosFor(goal.id).find((t) => t.id === bTodo.id)?.status, 'blocked');
  assert.equal(store.todosFor(goal.id).find((t) => t.id === cTodo.id)?.status, 'blocked');
  // next action 仍是 a（最早可推进）
  assert.equal(r.nextAction, 'a: 建立基础');

  // 完成 a 后 replan：b 变回 pending
  const aTodo = store.todosFor(goal.id).find((t) => t.title.startsWith('a'))!;
  store.setTodo({ ...aTodo, status: 'done', updatedAt: Date.now() });
  const r2 = ctl.replan(goal.id);
  const bAfter = store.todosFor(goal.id).find((t) => t.id === bTodo.id)!;
  assert.equal(bAfter.status, 'pending');
  assert.equal(r2.changes.some((x) => x.todoId === bTodo.id && x.from === 'blocked' && x.to === 'pending'), true);
});

test('control.taskGraph: 依赖图标注 blockedBy', () => {
  const { store, goal } = makeControl();
  const ctl = new LoopControl(store);
  const g = ctl.taskGraph(goal.id);
  assert.equal(g.nodes.length, 4);
  const bNode = g.nodes.find((n) => n.title.startsWith('b'))!;
  assert.equal(bNode.deps.length, 1);
  assert.equal(bNode.blockedBy.length, 1); // 依赖 a 未完成
});

test('control.lease: claim/renew/release/冲突', () => {
  const { store, goal } = makeControl();
  const ctl = new LoopControl(store);
  const l = ctl.claimLease(goal.id, 'alice', 60_000);
  assert.equal(l.holder, 'alice');
  // 他人 claim 冲突
  assert.throws(() => ctl.claimLease(goal.id, 'bob', 60_000), /已被 alice 持有/);
  // 续租（仅持有者）
  const renewed = ctl.renewLease(goal.id, 'alice', 120_000);
  assert.ok(renewed.expiresAt > l.expiresAt);
  // 非持有者 release 拒绝
  assert.throws(() => ctl.releaseLease(goal.id, 'bob'), /holder 不匹配/);
  // 持有者释放
  assert.equal(ctl.releaseLease(goal.id, 'alice'), true);
  assert.equal(ctl.leaseStatus(goal.id).length, 0);
});

test('control.backup: 写事件源备份文件', async () => {
  const { store } = makeControl();
  const ctl = new LoopControl(store);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-bak-'));
  try {
    const file = await ctl.backup(dir);
    const raw = await fs.readFile(file, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 3, '备份应包含 goal/todo/gate 事件');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('control.runs: 从事件源提取 worker 运行历史', () => {
  const { store, goal } = makeControl();
  const ctl = new LoopControl(store);
  store.addWorker({
    id: 'w1',
    goalId: goal.id,
    title: '探索 1',
    status: 'running',
    sessionId: 's1',
    runId: 'r1',
    cwd: '/tmp',
    createdAt: Date.now() - 5000,
    updatedAt: Date.now(),
  });
  store.updateWorker({
    id: 'w1',
    goalId: goal.id,
    title: '探索 1',
    status: 'done',
    sessionId: 's1',
    runId: 'r1',
    cwd: '/tmp',
    createdAt: Date.now() - 5000,
    updatedAt: Date.now(),
    result: '发现 A',
  });
  const recs = ctl.runs(goal.id);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].status, 'done');
  assert.equal(recs[0].result, '发现 A');
});
