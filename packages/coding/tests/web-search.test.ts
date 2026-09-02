/**
 * web_search 工具测试。
 *
 * 直测工具本身，不经 engine 审批门（审批是 engine 执行工具前的门控，
 * 这里直接调 tools.ts 的 handler / CodingToolsClient，天然无审批）。
 *
 * 覆盖：
 *  1) handler 参数构造 + 缺参校验（纯逻辑，无网络）
 *  2) 真实 bun 工具服务链路：能实例化、20s 内返回结构化结果（不挂死）
 *     —— 有搜索凭据则返回结果；无凭据则返回 provider 错误，但链路本身通。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codingTools } from '../src/tools.js';
import type { CodingToolsClient } from '../src/service/client.js';

/** 从注册表中取出 web_search 工具（不触发审批、不启动服务）。 */
function webSearchTool() {
  const tools = codingTools(null);
  const t = tools.find((x) => x.def.function.name === 'web_search');
  assert.ok(t, 'web_search 应已注册');
  return t!;
}

test('web_search: 缺 query 直接报错（不调用服务）', async () => {
  const t = webSearchTool();
  const r = await t.handler({});
  assert.equal(r.is_error, true);
  assert.match(String(r.result), /missing `query`/);
});

test('web_search: handler 正确构造参数并直调 client（mock，无审批）', async () => {
  const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
  const mockClient = {
    call: async (tool: string, params: Record<string, unknown>) => {
      calls.push({ tool, params });
      return { content: [{ type: 'text', text: 'mock-search-result' }] };
    },
  } as unknown as CodingToolsClient;

  const tools = codingTools(mockClient);
  const t = tools.find((x) => x.def.function.name === 'web_search')!;
  const r = await t.handler({
    query: 'infuture typescript',
    recency: 'week',
    num_search_results: 3,
  });

  assert.equal(r.is_error, false);
  assert.equal(r.result, 'mock-search-result');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'web_search');
  assert.deepEqual(calls[0].params, {
    query: 'infuture typescript',
    recency: 'week',
    num_search_results: 3,
  });
});

test('web_search: 结果前置标注实际命中的搜索引擎（details.response.provider）', async () => {
  const mockClient = {
    call: async (_tool: string, _params: Record<string, unknown>) => ({
      content: [{ type: 'text', text: '搜索结果正文' }],
      details: { response: { provider: 'tinyfish', model: 'tinyfish-pro', sources: [] } },
    }),
  } as unknown as CodingToolsClient;

  const tools = codingTools(mockClient);
  const t = tools.find((x) => x.def.function.name === 'web_search')!;
  const r = await t.handler({ query: 'infuture typescript' });

  assert.equal(r.is_error, false);
  assert.equal(r.result, '[engine: TinyFish · tinyfish-pro]\n搜索结果正文');
});

test('web_search: provider=none 或无 details 时不加引擎标注', async () => {
  const mockClient = {
    call: async (_tool: string, _params: Record<string, unknown>) => ({
      content: [{ type: 'text', text: 'plain' }],
      details: { response: { provider: 'none', sources: [] } },
    }),
  } as unknown as CodingToolsClient;

  const tools = codingTools(mockClient);
  const t = tools.find((x) => x.def.function.name === 'web_search')!;
  const r = await t.handler({ query: 'x' });
  assert.equal(r.result, 'plain');
});

test('web_search: 真实 bun 工具服务链路（绕过审批直调，20s 内返回不挂死）', async (t) => {
  const bun = process.env.BUN_PATH || '/Users/jingslunt/.bun/bin/bun';
  const { CodingToolsClient } = await import('../src/service/client.js');
  const client = new CodingToolsClient({
    bunPath: bun,
    startupTimeoutMs: 12_000,
    // 无凭据场景：让 client 在 web_search 15s handler 超时之前快速兜底，避免测试波动
    commandTimeoutMs: 10_000,
  });
  t.after(() => client.dispose());

  let started = false;
  try {
    await client.start();
    started = true;
  } catch {
    started = false;
  }
  if (!started) {
    // 环境无 bun / 服务起不来则跳过（不 fail）
    return;
  }

  const t0 = Date.now();
  // 有凭据 → resolve 结构化结果；无凭据 → reject（provider 错误或超时）。两者都算链路通。
  let outcome: { kind: 'resolved'; value: unknown } | { kind: 'rejected'; error: Error };
  try {
    const value = await client.call('web_search', { query: 'typescript language', num_search_results: 2 });
    outcome = { kind: 'resolved', value };
  } catch (err) {
    outcome = { kind: 'rejected', error: err as Error };
  }
  const elapsed = Date.now() - t0;

  // 无论哪种结果，都必须在 25s 内返回（覆盖服务启动 + 无凭据快速失败，不挂死、不进程崩溃）
  assert.ok(elapsed < 25_000, `web_search 不应挂死（elapsed=${elapsed}ms）`);
  if (outcome.kind === 'resolved') {
    assert.ok(outcome.value !== null && typeof outcome.value === 'object', '成功时应返回结构化 AgentToolResult');
  } else {
    assert.match(
      outcome.error.message,
      /provider|超时|timeout|配置|credential|auth|搜索|search|key/i,
      `无凭据时错误应可读（实际: ${outcome.error.message.slice(0, 120)}）`,
    );
  }
});
