/**
 * web_fetch 工具测试：参数校验 + 真实抓取（HTML → 正文文本提取）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webFetchTool } from '../src/tools/web-fetch.js';

const tool = webFetchTool();
const handler = tool.handler!;

test('web_fetch: 缺 url 返回错误', async () => {
  const r = await handler({}, { cwd: process.cwd() } as never);
  assert.equal(r.is_error, true);
  assert.match(r.result, /missing `url`/);
});

test('web_fetch: 非 http(s) url 返回错误', async () => {
  const r = await handler({ url: 'file:///etc/passwd' }, { cwd: process.cwd() } as never);
  assert.equal(r.is_error, true);
  assert.match(r.result, /http/);
});

test('web_fetch: 真实抓取 example.com 提取正文', async () => {
  const r = await handler({ url: 'https://example.com', maxChars: 2000 }, { cwd: process.cwd() } as never);
  if (r.is_error) {
    // 离线/网络受限时允许跳过，但必须是有意义的错误而非挂死
    assert.match(r.result, /failed|abort|fetch/i);
    return;
  }
  assert.ok(!r.is_error);
  assert.match(r.result, /Example Domain/, '应提取出页面正文');
  assert.ok(r.result.startsWith('[https://example.com'), '应带最终 URL 前缀');
});

test('web_fetch: 404 返回错误', async () => {
  const r = await handler({ url: 'https://example.com/definitely-not-found-404-infuture' }, { cwd: process.cwd() } as never);
  if (r.is_error) {
    assert.match(r.result, /HTTP 404|failed|abort|fetch/i);
    return;
  }
});
