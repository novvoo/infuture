/**
 * 核心冒烟测试 — 验证 RunControl 状态机、消息转换、工具、loop kernel。
 * 运行：npx tsx --test packages/core/tests/smoke.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunControl } from '../src/runtime/run-control.js';
import { parseBusyPolicy } from '../src/runtime/run-request.js';
import {
  convertToLlm,
  convertFromLlm,
  newUserMessage,
  newToolMessage,
  messageText,
  displayText,
} from '@infuture/types';
import { ToolRegistry } from '../src/tools/registry.js';
import { readTool, writeTool } from '../src/tools/fs.js';
import { shellTool } from '../src/tools/shell.js';
import { shouldRun } from '@infuture/loop';
import { Engine } from '../src/engine.js';
import { DefaultApprovalGate } from '../src/sandbox/gate.js';
import { shellTool } from '../src/tools/shell.js';
import { ToolRegistry } from '../src/tools/registry.js';

test('RunControl: begin → running → complete 释放会话', () => {
  const rc = new RunControl();
  assert.equal(rc.isStreaming, false);
  const lease = rc.begin('run-1', 'req-1');
  assert.equal(rc.isStreaming, true);
  assert.equal(rc.snapshot()?.phase, 'starting');
  rc.installCancellation(lease, () => {});
  assert.equal(rc.snapshot()?.phase, 'running');
  rc.finalizing(lease);
  rc.complete(lease, true);
  assert.equal(rc.isStreaming, false);
  assert.equal(rc.snapshot(), null);
});

test('RunControl: 忙时拒绝第二个 run，同 clientRequestId 幂等', () => {
  const rc = new RunControl();
  rc.begin('run-1', 'req-1');
  assert.throws(() => rc.begin('run-2', 'req-1'), /already accepted/);
  assert.throws(() => rc.begin('run-2', 'req-2'), /wait for it to finish/);
});

test('RunControl: cancellation_stuck 在下次 begin 自愈释放', () => {
  const rc = new RunControl();
  const lease = rc.begin('run-1', 'req-1');
  rc.markCancellationStuck(lease);
  // 同 clientRequestId 重试必须放行
  const lease2 = rc.begin('run-2', 'req-1');
  assert.equal(lease2.runId, 'run-2');
});

test('BusyPolicy: 解析与默认', () => {
  assert.equal(parseBusyPolicy(''), 'enqueue_if_busy');
  assert.equal(parseBusyPolicy('supersede_session'), 'supersede_session');
  assert.throws(() => parseBusyPolicy('frobnicate'), /unknown busy policy/);
});

test('消息转换: AgentMessage → LLM wire → AgentMessage 往返', () => {
  const msgs = [newUserMessage('user', '你好')];
  const wire = convertToLlm(msgs);
  assert.equal(wire[0].role, 'user');
  assert.deepEqual((wire[0].content as Array<{ type: string }>)[0].type, 'text');

  const back = convertFromLlm(wire);
  assert.equal(messageText(back[0]), '你好');
});

test('工具调用块: to_llm 保留 tool_call 与 tool_result', () => {
  const assistant = {
    role: 'assistant',
    content: [
      { type: 'text', text: '让我看看' },
      { type: 'tool_call', id: 'c1', name: 'shell', args: { command: 'ls' } },
    ],
  };
  const wire = convertToLlm([assistant as never]);
  assert.ok(wire[0].tool_calls && wire[0].tool_calls.length === 1);
  assert.equal(wire[0].tool_calls[0].function.name, 'shell');

  const tool = newToolMessage('c1', 'output', false);
  const wireTool = convertToLlm([tool]);
  assert.equal(wireTool[0].role, 'tool');
  assert.equal(wireTool[0].tool_call_id, 'c1');
});

test('displayText 只取第一个 text 块', () => {
  const msg = {
    role: 'user',
    content: [
      { type: 'text', text: '识别' },
      { type: 'text', text: 'attachment manifest' },
    ],
  };
  assert.equal(displayText(msg as never), '识别');
});

test('工具注册表: write → read 往返', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs/promises');
  const tmp = path.default.join(os.default.tmpdir(), `infuture-test-${Date.now()}.txt`);
  const reg = new ToolRegistry();
  reg.registerAll([readTool(tmp), writeTool(tmp)]);
  const w = await reg.execute('write', { path: tmp, content: 'hello infuture' });
  assert.equal(w.is_error, false);
  const r = await reg.execute('read', { path: tmp });
  assert.equal(r.result, 'hello infuture');
  await fs.default.rm(tmp, { force: true });
});

test('shell 工具: 执行命令', async () => {
  const reg = new ToolRegistry();
  reg.register(shellTool());
  const res = await reg.execute('shell', { command: 'echo infuture-ok' });
  assert.equal(res.result.includes('infuture-ok'), true);
  assert.equal(res.is_error, false);
});

test('loop kernel: 依赖满足时 todo 可推进', () => {
  const now = Date.now();
  const goal = {
    id: 'g1',
    title: 't',
    objective: 'o',
    acceptanceCriteria: [],
    status: 'active' as const,
    createdAt: now,
    updatedAt: now,
  };
  const d = shouldRun({
    goal,
    todos: [
      { id: 't1', goalId: 'g1', title: 'a', status: 'done' as const, dependencies: [], evidence: [], createdAt: now, updatedAt: now },
      { id: 't2', goalId: 'g1', title: 'b', status: 'pending' as const, dependencies: ['t1'], evidence: [], createdAt: now, updatedAt: now },
    ],
    gates: [],
    now,
  });
  assert.equal(d.shouldRun, true);
  assert.equal(d.runnableTodos.length, 1);
  assert.equal(d.runnableTodos[0].id, 't2');
});

test('busy 策略: 运行中 enqueue_if_busy 排队而非抛错', async () => {
  const engine = new Engine({ sandboxTier: 'off' });
  const session = await engine.sessions.create('busy-test');
  // 模拟一个进行中的 run（acquire 租约）
  session.control.begin('run-busy', 'busy');
  const outcome = await engine.run(session, 'second prompt', { busyPolicy: 'enqueue_if_busy' });
  assert.equal(outcome.reply, '(queued)');
  assert.equal(session.queueLength, 1);
  engine.dispose();
});

test('审批门: 挂起 → resolveApproval 决议', async () => {
  const gate = new DefaultApprovalGate({ tier: 'manual', timeoutMs: 2000 });
  const p = gate.request({ requestId: 'a1', toolName: 'shell', args: {}, sessionId: 's' });
  setTimeout(() => gate.resolveApproval('a1', true), 50);
  const d = await p;
  assert.equal(d.approved, true);
});

test('审批门: 超时自动拒绝', async () => {
  const gate = new DefaultApprovalGate({ tier: 'manual', timeoutMs: 100 });
  const d = await gate.request({ requestId: 'a2', toolName: 'shell', args: {}, sessionId: 's' });
  assert.equal(d.approved, false);
  assert.equal(d.reason, 'approval timeout');
});

test('shell 工具: 取消信号中断长命令并杀进程组', async () => {
  const reg = new ToolRegistry();
  reg.register(shellTool());
  const ac = new AbortController();
  const started = Date.now();
  const p = reg.execute('shell', { command: 'sleep 30' }, { signal: ac.signal });
  // 等命令启动
  await new Promise((r) => setTimeout(r, 300));
  ac.abort();
  const res = await p;
  assert.equal(res.is_error, true);
  assert.ok(res.result.includes('cancelled'));
  assert.ok(Date.now() - started < 5000, '应在 5s 内取消，而非等 sleep 30 结束');
});
