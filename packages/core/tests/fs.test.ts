/**
 * 文件工具测试：write / read / edit / list。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { readTool, writeTool, editTool, listTool } from '../src/tools/fs.js';

let dir: string;
let cwd: string;

test.before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'infuture-fs-'));
  cwd = path.join(dir, 'cwd');
  await fs.mkdir(cwd);
});

test.after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

test('write → read 往返（相对路径基于 cwd）', async () => {
  const w = writeTool(cwd);
  const r = readTool(cwd);
  const res = await w.handler({ path: 'hello.txt', content: 'hi 你好' });
  assert.equal(res.is_error, false);
  const data = await r.handler({ path: 'hello.txt' });
  assert.equal(data.is_error, false);
  assert.equal(data.result, 'hi 你好');
});

test('write 自动创建父目录', async () => {
  const w = writeTool(cwd);
  const res = await w.handler({ path: 'a/b/c.txt', content: 'deep' });
  assert.equal(res.is_error, false);
  const stat = await fs.stat(path.join(cwd, 'a', 'b', 'c.txt'));
  assert.ok(stat.isFile());
});

test('read 不存在返回错误', async () => {
  const r = readTool(cwd);
  const res = await r.handler({ path: 'nope.txt' });
  assert.equal(res.is_error, true);
  assert.ok(res.result.includes('read failed'));
});

test('edit: 单次替换', async () => {
  const w = writeTool(cwd);
  const e = editTool(cwd);
  await w.handler({ path: 'e.txt', content: 'foo bar baz' });
  const res = await e.handler({ path: 'e.txt', old_string: 'foo', new_string: 'FOO' });
  assert.equal(res.is_error, false);
  const r = readTool(cwd);
  const data = await r.handler({ path: 'e.txt' });
  assert.equal(data.result, 'FOO bar baz');
});

test('edit: 多匹配无 replace_all 拒绝', async () => {
  const w = writeTool(cwd);
  const e = editTool(cwd);
  await w.handler({ path: 'm.txt', content: 'x x x' });
  const res = await e.handler({ path: 'm.txt', old_string: 'x', new_string: 'y' });
  assert.equal(res.is_error, true);
  assert.ok(res.result.includes('replace_all'));
});

test('edit: replace_all 替换全部', async () => {
  const w = writeTool(cwd);
  const e = editTool(cwd);
  await w.handler({ path: 'm2.txt', content: 'x x x' });
  const res = await e.handler({ path: 'm2.txt', old_string: 'x', new_string: 'y', replace_all: true });
  assert.equal(res.is_error, false);
  const r = readTool(cwd);
  const data = await r.handler({ path: 'm2.txt' });
  assert.equal(data.result, 'y y y');
});

test('edit: old_string 未找到报错且不改文件', async () => {
  const w = writeTool(cwd);
  const e = editTool(cwd);
  await w.handler({ path: 'nf.txt', content: 'keep' });
  const res = await e.handler({ path: 'nf.txt', old_string: 'zzz', new_string: 'q' });
  assert.equal(res.is_error, true);
  const r = readTool(cwd);
  assert.equal((await r.handler({ path: 'nf.txt' })).result, 'keep');
});

test('list: 目录条目带类型标记', async () => {
  const w = writeTool(cwd);
  await fs.mkdir(path.join(cwd, 'sub'));
  await w.handler({ path: 'file.txt', content: '' });
  const l = listTool(cwd);
  const res = await l.handler({ path: '.' });
  assert.equal(res.is_error, false);
  assert.ok(res.result.includes('d sub'));
  assert.ok(res.result.includes('- file.txt'));
});

test('缺参数返回明确错误', async () => {
  const w = writeTool(cwd);
  const r = readTool(cwd);
  const e = editTool(cwd);
  assert.equal((await w.handler({ path: 'x' })).is_error, true);
  assert.equal((await r.handler({})).is_error, true);
  assert.equal((await e.handler({ path: 'x', old_string: 'a', new_string: undefined })).is_error, true);
});
