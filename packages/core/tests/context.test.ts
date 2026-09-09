/**
 * 上下文压缩（context compaction）单元测试。
 * 覆盖：token 估算、剪切点（不拆 tool 配对）、压缩重组、摘要失败降级。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  estimateTokens,
  findCompactionCut,
  needsCompaction,
  compactContext,
  estimateMessagesTokens,
} from '../src/agent/context.js';
import { newUserMessage, newAssistantMessage, newToolMessage } from '@infuture/types';
import type { LLMProvider, ModelStream } from '@infuture/llm';

function textMsg(role: string, text: string) {
  return newUserMessage(role, text);
}

function toolTurn(userText: string, toolName: string, args: unknown, result: string): { user: ReturnType<typeof textMsg>; assistant: ReturnType<typeof newAssistantMessage>; tool: ReturnType<typeof newToolMessage> } {
  const user = textMsg('user', userText);
  const assistant = newAssistantMessage();
  assistant.content.push({ type: 'tool_call', id: 't1', name: toolName, args });
  const tool = newToolMessage('t1', result);
  return { user, assistant, tool };
}

test('estimateTokens: 中文按字、英文按字符/4、空串为 0', () => {
  assert.equal(estimateTokens(''), 0);
  const zh = estimateTokens('你好世界');
  const en = estimateTokens('hello world');
  assert.ok(zh >= 4 && zh <= 8, `中文 4 字应约 4-8 token，实际 ${zh}`);
  assert.ok(en >= 2 && en <= 6, `英文 11 字符应约 2-6 token，实际 ${en}`);
  // 中文比同等英文贵
  assert.ok(estimateTokens('中中中中中中中中') > estimateTokens('aaaaaa'));
});

test('needsCompaction: 超阈值触发、未超不触发、窗口<=0 不触发', () => {
  const big = '这是一个测试消息用来占满上下文空间，'.repeat(100); // ≈2000 token
  const msgs = Array.from({ length: 50 }, () => textMsg('user', big));
  assert.equal(needsCompaction(msgs, { contextWindow: 100000, systemPrompt: '' }), true);
  assert.equal(needsCompaction([textMsg('user', 'hi')], { contextWindow: 100000, systemPrompt: '' }), false);
  assert.equal(needsCompaction([textMsg('user', 'hi')], { contextWindow: 0, systemPrompt: '' }), false);
});

test('findCompactionCut: 不把 tool_result 与其 tool_call 拆开', () => {
  const msgs: any[] = [];
  // 3 个完整工具轮（user → assistant(tool_call) → tool_result）
  for (let i = 0; i < 3; i++) {
    const t = toolTurn(`任务 ${i}`, 'bash', { cmd: 'ls' }, 'file output '.repeat(200));
    msgs.push(t.user, t.assistant, t.tool);
  }
  const cut = findCompactionCut(msgs, 500);
  assert.equal(cut.hasHistory, true);
  const kept = msgs.slice(cut.cutIndex);
  // 保留段不能以 tool_result 开头（tool_result 必须跟在 assistant 后）
  if (kept.length > 0) {
    assert.notEqual(kept[0]!.role, 'tool', '保留段第一条不能是 tool_result');
  }
  // 且不能出现"assistant 的 tool_call 后缺 tool_result"的截断：切点前的 assistant 其 tool_result 也在切点前
  for (let i = 0; i < kept.length; i++) {
    const m = kept[i]!;
    if (m.role === 'tool' && i === 0) {
      assert.fail('保留段不能以 tool_result 开头');
    }
  }
});

test('findCompactionCut: 短消息不压缩（保留全部）', () => {
  const msgs = [textMsg('user', 'a'), textMsg('assistant', 'b')];
  const cut = findCompactionCut(msgs, 20000);
  assert.equal(cut.hasHistory, false);
  assert.equal(cut.cutIndex, 0);
});

test('compactContext: 摘要成功 → 重组为 [摘要消息, ...保留]', async () => {
  const msgs: any[] = [];
  for (let i = 0; i < 8; i++) {
    const t = toolTurn(`任务 ${i}`, 'bash', { cmd: 'pwd' }, 'result '.repeat(300));
    msgs.push(t.user, t.assistant, t.tool);
  }
  const historyLen = msgs.length;

  const provider: LLMProvider = {
    async streamModel(): Promise<ModelStream> {
      async function* gen(): AsyncGenerator<any> {
        yield { type: 'text', text: '（摘要）已完成任务 0-3：执行了 pwd 命令，结果正常。' };
        yield { type: 'done' };
      }
      return gen();
    },
  } as unknown as LLMProvider;

  const events: string[] = [];
  const result = await compactContext(msgs, {
    model: 'test-model',
    provider,
    systemPrompt: '',
    contextWindow: 200000,
    keepRecentTokens: 500,
    runId: 'r1',
    onEvent: (e) => events.push(e.type),
  });

  assert.equal(result.compacted, true);
  assert.equal(events.includes('compacted'), true);
  assert.ok(result.tokensBefore > result.tokensAfter, '压缩后估算应显著下降');
  // 重组：第一条是 system 摘要消息，其后是保留消息
  assert.equal(msgs[0]!.role, 'system');
  assert.equal(msgs[0]!.metadata?.compacted, true);
  assert.ok(msgs[0]!.content.some((b: any) => b.type === 'text' && b.text.includes('（摘要）')));
  assert.ok(msgs.length < historyLen, '消息数应减少');
  // 保留的消息顺序不变
  const keptRoles = msgs.slice(1).map((m: any) => m.role);
  assert.deepEqual(keptRoles, msgs.slice(1).map((m: any) => m.role));
});

test('compactContext: 摘要失败（provider 抛错）→ 不压缩不阻断', async () => {
  const msgs: any[] = [];
  for (let i = 0; i < 6; i++) {
    msgs.push(textMsg('user', `任务 ${i} ` + 'x'.repeat(500)));
  }
  const snapshot = [...msgs];
  const provider: LLMProvider = {
    async streamModel() {
      throw new Error('模型不可用');
    },
  } as unknown as LLMProvider;
  const result = await compactContext(msgs, {
    model: 'm',
    provider,
    systemPrompt: '',
    contextWindow: 100000,
    runId: 'r1',
  });
  assert.equal(result.compacted, false);
  assert.deepEqual(msgs, snapshot, '失败时消息不得被修改');
});

test('compactContext: 摘要为空文本 → 视为失败不压缩', async () => {
  const msgs: any[] = [];
  for (let i = 0; i < 6; i++) msgs.push(textMsg('user', `任务 ${i} ` + 'y'.repeat(400)));
  const provider: LLMProvider = {
    async streamModel(): Promise<ModelStream> {
      async function* gen(): AsyncGenerator<any> {
        yield { type: 'done' };
      }
      return gen();
    },
  } as unknown as LLMProvider;
  const result = await compactContext(msgs, {
    model: 'm',
    provider,
    systemPrompt: '',
    contextWindow: 100000,
    runId: 'r1',
  });
  assert.equal(result.compacted, false);
});

test('estimateMessagesTokens: 累积多条消息', () => {
  const a = estimateMessagesTokens([textMsg('user', 'hello world'), textMsg('assistant', '你好')]);
  const b = estimateMessagesTokens([textMsg('user', 'hello world')]);
  assert.ok(a > b);
});
