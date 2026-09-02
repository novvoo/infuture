/**
 * LLM 适配器测试：SSE 解析、openai_chat / openai_responses / anthropic 流事件解析，
 * 以及 anthropic 的 wire 消息转换（role:tool → user+tool_result / tool_calls → tool_use）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiChatProvider } from '../src/adapters/openai_chat.js';
import { OpenAiResponsesProvider } from '../src/adapters/openai_responses.js';
import { AnthropicProvider } from '../src/adapters/anthropic.js';
import { newUserMessage, newAssistantMessage, newToolMessage } from '@infuture/types';

/** 构造一个可直接喂给 consume 的 SSE 流。 */
function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const text = lines.map((l) => `data: ${l}\n\n`).join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

const route = {
  providerId: 'test',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'k',
  auth: 'bearer' as const,
  headers: {},
};

const fakeModel = {
  id: 'test',
  name: 'Test',
  provider: 'test',
  api: 'openai-completions',
  baseUrl: route.baseUrl,
  contextWindow: 128000,
  maxTokens: 4096,
  reasoning: false,
};

async function collect(gen: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

test('openai_chat: 文本流式 + 工具增量 + usage', async () => {
  const provider = new OpenAiChatProvider(route, fakeModel as never);
  const stream = sseStream([
    JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
    JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'shell', arguments: '{"command":"' } }] } }],
    }),
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'echo hi"}' } }] } }],
    }),
    JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }),
  ]);
  const consume = (provider as unknown as { consume(b: ReadableStream<Uint8Array>): AsyncIterable<unknown> }).consume;
  const events = (await collect(consume(stream))) as Array<{ type: string; text?: string; name?: string; arguments?: string }>;
  const texts = events.filter((e) => e.type === 'text').map((e) => e.text);
  const calls = events.filter((e) => e.type === 'tool_call');
  assert.deepEqual(texts, ['Hello']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'shell');
  assert.equal(calls[0].arguments, '{"command":"echo hi"}');
});

test('openai_chat: reasoning_content 也流式透传', async () => {
  const provider = new OpenAiChatProvider(route, fakeModel as never);
  const stream = sseStream([
    JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking text' } }] }),
    JSON.stringify({ choices: [{ delta: { content: 'answer' } }] }),
  ]);
  const consume = (provider as unknown as { consume(b: ReadableStream<Uint8Array>): AsyncIterable<unknown> }).consume;
  const events = (await collect(consume(stream))) as Array<{ type: string; text?: string }>;
  assert.ok(events.some((e) => e.type === 'reasoning' && (e.text ?? '').includes('thinking')));
  assert.ok(events.some((e) => e.type === 'text' && e.text === 'answer'));
});

test('openai_chat: GLM wire — 不发送 thinking.disabled（GLM-5 会 400），thinkingLevel=off→reasoning_effort low', async () => {
  let captured: Record<string, unknown> | null = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    captured = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
    return { ok: true, status: 200, body: sseStream([JSON.stringify({})]), text: async () => '' };
  }) as typeof fetch;
  try {
    const glmRoute = { ...route, baseUrl: 'https://open.bigmodel.cn/api/paas/v4' };
    const glmModel = { ...fakeModel, id: 'glm-5.3-flash', baseUrl: glmRoute.baseUrl, reasoning: false };
    const provider = new OpenAiChatProvider(glmRoute, glmModel as never);
    await collect(await provider.streamModel({ model: 'glm-5.3-flash', systemPrompt: '', messages: [], tools: [], thinkingBudget: 0, thinkingLevel: 'off' } as never));
    assert.ok(captured, '应捕获请求 body');
    assert.equal('thinking' in captured, false, 'GLM-5 不支持 disabled，不应发 thinking.disabled');
    assert.equal(captured['reasoning_effort'], 'low', 'off 档应映射 reasoning_effort=low');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('openai_chat: GLM wire — thinkingLevel medium/high → reasoning_effort high/max', async () => {
  const glmRoute = { ...route, baseUrl: 'https://open.bigmodel.cn/api/paas/v4' };
  const glmModel = { ...fakeModel, id: 'glm-5.3-flash', baseUrl: glmRoute.baseUrl, reasoning: false };
  async function capture(level: string) {
    let captured: Record<string, unknown> | null = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      captured = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      return { ok: true, status: 200, body: sseStream([JSON.stringify({})]), text: async () => '' };
    }) as typeof fetch;
    try {
      const provider = new OpenAiChatProvider(glmRoute, glmModel as never);
      await collect(await provider.streamModel({ model: 'glm-5.3-flash', systemPrompt: '', messages: [], tools: [], thinkingLevel: level } as never));
    } finally {
      globalThis.fetch = origFetch;
    }
    return captured;
  }
  assert.equal((await capture('medium'))?.['reasoning_effort'], 'high', 'medium 档应映射 reasoning_effort=high');
  assert.equal((await capture('high'))?.['reasoning_effort'], 'max', 'high 档应映射 reasoning_effort=max');
});

test('openai_chat: GLM wire — thinkingBudget>0 发送 thinking enabled + budget_tokens', async () => {
  let captured: Record<string, unknown> | null = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    captured = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
    return { ok: true, status: 200, body: sseStream([JSON.stringify({})]), text: async () => '' };
  }) as typeof fetch;
  try {
    const glmRoute = { ...route, baseUrl: 'https://open.bigmodel.cn/api/paas/v4' };
    const glmModel = { ...fakeModel, id: 'glm-5.3-flash', baseUrl: glmRoute.baseUrl, reasoning: false };
    const provider = new OpenAiChatProvider(glmRoute, glmModel as never);
    const req = {
      model: 'glm-5.3-flash',
      systemPrompt: '',
      messages: [],
      tools: [],
      thinkingBudget: 2000,
    };
    await collect(await provider.streamModel(req as never));
    assert.deepEqual(captured?.['thinking'], { type: 'enabled', budget_tokens: 2000 });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('openai_chat: 非 GLM 且未配置 reasoning_effort 时不发 thinking/reasoning_effort', async () => {
  let captured: Record<string, unknown> | null = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    captured = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
    return { ok: true, status: 200, body: sseStream([JSON.stringify({})]), text: async () => '' };
  }) as typeof fetch;
  try {
    const provider = new OpenAiChatProvider(route, fakeModel as never);
    await collect(await provider.streamModel({ model: 'test', systemPrompt: '', messages: [], tools: [], thinkingBudget: 0 } as never));
    assert.ok(captured);
    assert.equal('thinking' in captured, false, '非 GLM 不应发 thinking');
    assert.equal('reasoning_effort' in captured, false, '未启用 reasoning_effort 不应发');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('openai_responses: output_item.done 只 yield 一次工具调用且 id 用 call_id', async () => {
  const provider = new OpenAiResponsesProvider(route, fakeModel as never);
  const stream = sseStream([
    JSON.stringify({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_x', name: 'bash', arguments: '{}' } }),
    JSON.stringify({ type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_x', name: 'bash', arguments: '{}' } }),
    JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' }),
  ]);
  const consume = (provider as unknown as { consume(b: ReadableStream<Uint8Array>): AsyncIterable<unknown> }).consume;
  const events = (await collect(consume(stream))) as Array<{ type: string; text?: string; name?: string; id?: string }>;
  const calls = events.filter((e) => e.type === 'tool_call');
  assert.equal(calls.length, 1, '工具调用不应重复');
  assert.equal(calls[0].id, 'call_x');
  assert.equal(calls[0].name, 'bash');
  assert.ok(events.some((e) => e.type === 'text' && e.text === 'ok'));
});

test('openai_responses: 只发 added 不发 done 时末尾兜底补发一次', async () => {
  const provider = new OpenAiResponsesProvider(route, fakeModel as never);
  const stream = sseStream([
    JSON.stringify({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_y', name: 'bash', arguments: '{}' } }),
  ]);
  const consume = (provider as unknown as { consume(b: ReadableStream<Uint8Array>): AsyncIterable<unknown> }).consume;
  const events = (await collect(consume(stream))) as Array<{ type: string; id?: string }>;
  const calls = events.filter((e) => e.type === 'tool_call');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'call_y');
});

test('anthropic: 工具增量解析且不重复', async () => {
  const provider = new AnthropicProvider(route, fakeModel as never);
  const stream = sseStream([
    JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'shell', input: {} } }),
    JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"cmd":"echo' } }),
    JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ' hi"}' } }),
    JSON.stringify({ type: 'message_stop' }),
  ]);
  const consume = (provider as unknown as { consume(b: ReadableStream<Uint8Array>): AsyncIterable<unknown> }).consume;
  const events = (await collect(consume(stream))) as Array<{ type: string; name?: string; arguments?: string }>;
  const calls = events.filter((e) => e.type === 'tool_call');
  assert.equal(calls.length, 1, '工具调用不应重复');
  assert.equal(calls[0].name, 'shell');
  assert.equal(calls[0].arguments, '{"cmd":"echo hi"}');
});

test('anthropic: tool_result / tool_calls 消息转换为 Anthropic wire 格式', async () => {
  let capturedBody: { messages: unknown[] } | null = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    capturedBody = JSON.parse(init?.body ?? '{}') as { messages: unknown[] };
    return {
      ok: true,
      status: 200,
      body: sseStream([JSON.stringify({ type: 'message_stop' })]),
      text: async () => '',
    };
  }) as typeof fetch;

  try {
    const provider = new AnthropicProvider(route, fakeModel as never);
    const user = newUserMessage('user', '算一下');
    const assistant = newAssistantMessage();
    assistant.content.push({ type: 'text', text: '我来调用' });
    assistant.content.push({ type: 'tool_call', id: 'toolu_1', name: 'shell', args: { command: 'echo hi' } });
    const toolResult = newToolMessage('toolu_1', 'hi', false);

    const req = {
      model: 'test',
      systemPrompt: '',
      messages: [user, assistant, toolResult],
      tools: [{ type: 'function', function: { name: 'shell', description: 'run', parameters: { type: 'object' } } }] as never[],
    };
    const stream = await provider.streamModel(req as never);
    await collect(stream);

    const messages = capturedBody?.messages as Array<{ role: string; content: unknown }>;
    assert.ok(messages, '应捕获请求 body');
    // 第一轮 user
    assert.equal(messages[0].role, 'user');
    // assistant 的 tool_call 必须转成 tool_use 块
    const asst = messages[1];
    assert.equal(asst.role, 'assistant');
    const blocks = asst.content as Array<{ type: string; name?: string; input?: unknown }>;
    assert.ok(blocks.some((b) => b.type === 'tool_use' && b.name === 'shell'));
    assert.ok(!('tool_calls' in asst), '不应出现 OpenAI 的 tool_calls 字段');
    // tool 消息必须转成 role=user + tool_result
    const toolMsg = messages[2];
    assert.equal(toolMsg.role, 'user', 'tool_result 必须包在 user 消息里');
    const tContent = toolMsg.content as Array<{ type: string; tool_use_id?: string; content?: string }>;
    assert.equal(tContent[0].type, 'tool_result');
    assert.equal(tContent[0].tool_use_id, 'toolu_1');
    assert.equal(tContent[0].content, 'hi');
  } finally {
    globalThis.fetch = origFetch;
  }
});
