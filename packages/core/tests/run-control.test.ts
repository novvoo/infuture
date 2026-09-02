/**
 * RunControl 补充测试：幂等拒绝、persistence_degraded fail-closed、finalizing/complete 边界。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunControl } from '../src/runtime/run-control.js';

test('begin: 同 clientRequestId 幂等拒绝', () => {
  const rc = new RunControl();
  const l1 = rc.begin('r1', 'crid-1');
  assert.throws(() => rc.begin('r2', 'crid-1'), /already accepted/);
  rc.complete(l1);
  // complete 后同 crid 也在 recentRequests 中 → 仍拒绝
  assert.throws(() => rc.begin('r3', 'crid-1'), /already accepted/);
});

test('begin: active 时拒绝新 run', () => {
  const rc = new RunControl();
  rc.begin('r1', 'a');
  assert.throws(() => rc.begin('r2', 'b'), /wait for it to finish/);
});

test('complete(persistenceOk=false) → persistence_degraded 且计数', () => {
  const rc = new RunControl();
  const l = rc.begin('r1');
  rc.complete(l, false);
  assert.equal(rc.persistenceDegraded, 1);
  assert.equal(rc.activeTaskCount, 1, 'fail-closed：不释放会话');
  // persistence_degraded 后 begin 被拒（需人工介入）
  assert.throws(() => rc.begin('r2'));
});

test('cancellation_stuck 自愈后同 crid 可重试', () => {
  const rc = new RunControl();
  rc.begin('r1', 'crid-stuck');
  rc.markCancellationStuck(rc.snapshot()!);
  // 自愈：下次 begin 释放死租约
  const l2 = rc.begin('r2', 'crid-stuck');
  assert.equal(l2.runId, 'r2');
});

test('installCancellation 只接受匹配租约', () => {
  const rc = new RunControl();
  const l = rc.begin('r1');
  assert.equal(rc.installCancellation({ runId: 'wrong', epoch: l.epoch }, () => {}), false);
  assert.equal(rc.installCancellation(l, () => {}), true);
  assert.equal(rc.snapshot()!.phase, 'running');
});

test('cancel → finalizing → complete 全流程', () => {
  const rc = new RunControl();
  const l = rc.begin('r1');
  let cancelled = false;
  rc.installCancellation(l, () => {
    cancelled = true;
  });
  assert.equal(rc.cancel(l), true);
  assert.equal(cancelled, true);
  assert.equal(rc.snapshot()!.phase, 'cancelling');
  rc.finalizing(l);
  assert.equal(rc.snapshot()!.phase, 'finalizing');
  rc.complete(l);
  assert.equal(rc.snapshot(), null);
  assert.equal(rc.isStreaming, false);
});
