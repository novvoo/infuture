/**
 * 消息 wire 转换测试：toLlm / convertToLlm / convertFromLlm 往返、reasoning-only 丢弃、tool_result 折叠。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newUserMessage,
  newAssistantMessage,
  newToolMessage,
  addText,
  toolCallBlock,
  reasoningBlock,
  toLlm,
  convertToLlm,
  convertFromLlm,
  displayText,
  toolCalls,
  messageText,
} from '../src/index.js';

test('toLlm: assistant 消息的 text + tool_call 结构', () => {
  const a = newAssistantMessage();
  addText(a, 'hi');
  a.content.push(toolCallBlock('c1', 'shell', { command: 'ls' }));
  const m = toLlm(a);
  assert.equal(m.role, 'assistant');
  assert.deepEqual(m.content, [{ type: 'text', text: 'hi' }]);
  assert.equal(m.tool_calls?.length, 1);
  assert.equal(m.tool_calls?.[0].id, 'c1');
  assert.equal(m.tool_calls?.[0].function.name, 'shell');
});

test('convertToLlm / convertFromLlm 往返保留工具调用', () => {
  const a = newAssistantMessage();
  addText(a, '调用');
  a.content.push(toolCallBlock('c1', 'bash', { command: 'echo hi' }));
  const t = newToolMessage('c1', 'hi', false);

  const msgs = convertToLlm([a, t]);
  assert.equal(msgs[0].role, 'assistant');
  assert.equal(msgs[1].role, 'tool');
  assert.equal(msgs[1].tool_call_id, 'c1');
  assert.equal((msgs[1].content[0] as { text: string }).text, 'hi');

  const back = convertFromLlm(msgs);
  assert.equal(back.length, 2);
  assert.equal(toolCalls(back[0]).length, 1);
  // tool 消息：displayText 只取首个 text 块 → ''；messageText 拼接 tool_result → 'hi'
  assert.equal(displayText(back[1]), '');
  assert.equal(messageText(back[1]), 'hi');
});

test('convertToLlm: 仅 reasoning 的 assistant 空消息被丢弃', () => {
  const a = newAssistantMessage();
  a.content.push(reasoningBlock('只思考'));
  const u = newUserMessage('user', 'x');
  const msgs = convertToLlm([a, u]);
  assert.equal(msgs.length, 1, '仅 reasoning 的 assistant 应被丢弃');
  assert.equal(msgs[0].role, 'user');
});

test('messageText 拼接 text 与 tool_result', () => {
  const a = newAssistantMessage();
  addText(a, '答案是');
  a.content.push({ type: 'tool_result', tool_use_id: 'x', content: 'ignored', is_error: false });
  assert.equal(messageText(a), '答案是ignored');
});

test('displayText 只取首个 text 块（不含 tool_result）', () => {
  const a = newAssistantMessage();
  addText(a, '看：');
  a.content.push({ type: 'tool_result', tool_use_id: 'x', content: '42', is_error: false });
  assert.equal(displayText(a), '看：');
});

test('newToolMessage 错误标志透传', () => {
  const err = newToolMessage('c2', 'boom', true);
  const tr = err.content.find((b) => b.type === 'tool_result');
  assert.ok(tr && tr.type === 'tool_result');
  assert.equal((tr as { is_error: boolean }).is_error, true);
  assert.equal((tr as { content: string }).content, 'boom');
});

test('reasoning 块与 toLlm 的 reasoning_content 透传', () => {
  const a = newAssistantMessage();
  a.content.push(reasoningBlock('思考中'));
  addText(a, '答案');
  const m = toLlm(a);
  assert.equal(m.reasoning_content, '思考中');
});

test('newUserMessage 字符串/数组内容归一', () => {
  const u1 = newUserMessage('user', '你好');
  assert.deepEqual(u1.content, [{ type: 'text', text: '你好' }]);
});
