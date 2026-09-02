/**
 * shell 工具测试：exit code、stderr、超时杀进程组、输出截断。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { shellTool } from '../src/tools/shell.js';

let dir: string;

test.before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'infuture-shell-'));
});

test.after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

test('shell: 正常输出 + exit code', async () => {
  const t = shellTool({ cwd: dir });
  const res = await t.handler({ command: 'echo hello; exit 0' });
  assert.equal(res.is_error, false);
  assert.equal(res.result.trim(), 'hello');
});

test('shell: stderr 拼接 + 非零退出为错误', async () => {
  const t = shellTool({ cwd: dir });
  const res = await t.handler({ command: 'echo out; echo err >&2; exit 3' });
  assert.equal(res.is_error, true);
  assert.ok(res.result.includes('out'));
  assert.ok(res.result.includes('err'));
});

test('shell: 超时杀掉整个进程组（含子进程）', async () => {
  const t = shellTool({ cwd: dir, maxOutput: 100_000 });
  const t0 = Date.now();
  const res = await t.handler({ command: 'sleep 30 & wait', timeout_ms: 800 });
  const elapsed = Date.now() - t0;
  assert.equal(res.is_error, true);
  assert.ok(res.result.includes('timed out'));
  assert.ok(elapsed < 5000, '应在超时点附近返回，而非等 sleep 30');
});

test('shell: 缺 command 报错', async () => {
  const t = shellTool({ cwd: dir });
  const res = await t.handler({});
  assert.equal(res.is_error, true);
  assert.ok(res.result.includes('missing'));
});

test('shell: 输出截断标记', async () => {
  const t = shellTool({ cwd: dir, maxOutput: 100 });
  const res = await t.handler({ command: 'python3 -c "print(\\"x\\"*500)"' });
  assert.equal(res.is_error, false);
  assert.ok(res.result.includes('[output truncated]'));
});
