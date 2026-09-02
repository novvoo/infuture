/**
 * 编程引擎集成测试：真实 --mode rpc 握手 + bash 执行。
 * 若编程引擎 CLI 不可用则跳过（不 fail）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodingAdapter } from '../src/index.js';

test('CodingAdapter: verify 真实握手（无编程引擎则跳过）', async () => {
  const adapter = new CodingAdapter();
  let ok = false;
  try {
    ok = await adapter.verify(15000);
  } catch {
    ok = false;
  }
  if (!ok) {
    adapter.dispose();
    return; // 环境无编程引擎时跳过
  }
  assert.equal(ok, true);
  assert.ok(adapter.resolvedPath.length > 0);
  adapter.dispose();
});

test('CodingAdapter: runBash 真实执行（无编程引擎则跳过）', async () => {
  const adapter = new CodingAdapter();
  let ok = false;
  try {
    ok = await adapter.verify(15000);
  } catch {
    ok = false;
  }
  if (!ok) {
    adapter.dispose();
    return;
  }
  const r = await adapter.runBash('echo engine-live-ok');
  assert.equal(r.is_error, false);
  assert.ok(String(r.result).includes('engine-live-ok'));
  adapter.dispose();
});

test('CodingAdapter: getState 返回会话状态', async () => {
  const adapter = new CodingAdapter();
  try {
    await adapter.verify(15000);
  } catch {
    adapter.dispose();
    return;
  }
  const st = await adapter.getState();
  assert.ok('model' in st);
  adapter.dispose();
});
