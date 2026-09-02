/**
 * ToolSelection 测试：动态工具裁剪 —— 核心工具恒在、重型工具按语境按需暴露。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectToolDefs, buildSelectionContext, classifyTaskType, type ToolSelectionOptions } from '../src/tools/selection.js';
import type { AgentTool } from '@infuture/types';

/** 构造代表性工具列表（覆盖 core / web / coding / lsp / dap / github / browser 各组）。 */
function makeTools(): AgentTool[] {
  const names = [
    'read',
    'write',
    'edit',
    'list',
    'shell',
    'grep',
    'glob',
    'code_edit',
    'inspect_image',
    'spawn_workers',
    'list_workers',
    'web_search',
    'web_fetch',
    'browser',
    'execute_code',
    'bash',
    'ast_grep',
    'ast_edit',
    'subagent',
    'review',
    'git_pr',
    'lsp_diagnostics',
    'lsp_rename',
    'dap_launch',
    'dap_continue',
    'github_search_issues',
    'github_pr_create',
  ];
  return names.map((n) => ({
    def: { type: 'function', function: { name: n, description: `tool ${n}`, parameters: { type: 'object' } } },
    handler: async () => ({ result: 'ok', is_error: false }),
    guidelines: [],
  }));
}

function namesOf(tools: AgentTool[], opts: ToolSelectionOptions = {}, ctx = ''): string[] {
  return selectToolDefs(tools, ctx, opts).defs.map((d) => d.function.name);
}

test('核心工具 + worker 工具恒在，重型工具默认裁剪', () => {
  const tools = makeTools();
  const got = namesOf(tools);
  for (const core of ['read', 'write', 'edit', 'list', 'shell', 'grep', 'glob', 'code_edit', 'inspect_image', 'spawn_workers', 'list_workers']) {
    assert.ok(got.includes(core), `核心工具 ${core} 应恒在`);
  }
  assert.ok(got.includes('web_search'), 'web_search 默认暴露');
  // 重型工具默认不暴露
  for (const heavy of ['bash', 'execute_code', 'browser', 'lsp_diagnostics', 'dap_launch', 'github_pr_create']) {
    assert.ok(!got.includes(heavy), `${heavy} 默认不应暴露`);
  }
  // 暴露数量显著小于全量
  assert.ok(got.length <= 13, `默认暴露应精简（实际 ${got.length}）`);
});

test('worker 协作 prompt：spawn_workers 可用，且暴露集保持精简', () => {
  const tools = makeTools();
  const ctx = '启动三个 worker，第一个解题，第二个反思第一个的输出，第三个重新探索';
  const got = namesOf(tools, {}, ctx);
  assert.ok(got.includes('spawn_workers'), 'worker 场景应暴露 spawn_workers');
  assert.ok(got.includes('list_workers'), 'worker 场景应暴露 list_workers');
  assert.ok(!got.includes('dap_launch') && !got.includes('github_pr_create'), '无关重型工具不应暴露');
});

test('编程语境（bash/执行代码）自动启用 execute_code/bash 等', () => {
  const tools = makeTools();
  const got = namesOf(tools, {}, '帮我写一个 python 脚本并运行');
  assert.ok(got.includes('execute_code'));
  assert.ok(got.includes('bash'));
});

test('调试语境启用 dap_*，代码语境启用 lsp_*', () => {
  const tools = makeTools();
  const dap = namesOf(tools, {}, '帮我调试这个断点，看看变量值');
  assert.ok(dap.includes('dap_launch') && dap.includes('dap_continue'), '调试语境应暴露 dap_*');
  const lsp = namesOf(tools, {}, '重构这个函数，重命名符号');
  assert.ok(lsp.includes('lsp_diagnostics') && lsp.includes('lsp_rename'), '代码语境应暴露 lsp_*');
});

test('上下文点名工具名 → 自动暴露（天然按需加载）', () => {
  const tools = makeTools();
  const got = namesOf(tools, {}, '我认为需要用到 subagent 来并行探索');
  assert.ok(got.includes('subagent'), '点名 subagent 应自动暴露');
});

test('forceGroups 强制启用编程组', () => {
  const tools = makeTools();
  const got = namesOf(tools, { forceGroups: ['coding'] }, '');
  assert.ok(got.includes('execute_code') && got.includes('bash') && got.includes('subagent'));
});

test('buildSelectionContext 聚合用户文本 / assistant 推理 / 已调用工具名', () => {
  const history = [
    { role: 'user', content: [{ type: 'text', text: '调试这段代码' }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: '我需要打断点' }, { type: 'tool_call', name: 'dap_launch', id: 'x', args: {} }] },
  ];
  const ctx = buildSelectionContext(history);
  assert.ok(ctx.includes('调试这段代码'));
  assert.ok(ctx.includes('我需要打断点'));
  assert.ok(ctx.includes('dap_launch'));
});

test('classifyTaskType：worker/编程/联网/通用识别', () => {
  assert.equal(classifyTaskType('启动三个 /worker，第一个解题，第二个反思，第三个再探索'), 'worker');
  assert.equal(classifyTaskType('帮我写一个 python 脚本并运行'), 'coding');
  assert.equal(classifyTaskType('搜索一下最新的 AI 新闻'), 'web');
  assert.equal(classifyTaskType('你好，介绍一下你自己'), 'general');
  // 纯提问不应误判为 worker（避免把"解释 worker 是什么"强行路由到 spawn）
  assert.equal(classifyTaskType('解释一下 worker 是什么，和线程有什么区别'), 'general');
});
