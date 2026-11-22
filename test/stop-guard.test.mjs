// 停止闸门：点了停止之后，所有对外动作都必须停下。
// 真实事故：22:04 用户在设置页点了停止，22:04:56 还在点赞、22:05:19 还在回评论 ——
// 因为只有脚本循环看 stopRequested，单步工具根本没看。
import test from 'node:test';
import assert from 'node:assert/strict';
import { stopBlocker } from '../src/ops.mjs';

test('没点停止 → 放行（返回空串）', () => {
  assert.equal(stopBlocker({ data: { stopRequested: false } }, '点赞'), '');
  assert.equal(stopBlocker({ data: {} }, '点赞'), '');
  assert.equal(stopBlocker(null, '点赞'), '');
});

test('点了停止 → 拦住，并说清怎么恢复', () => {
  const msg = stopBlocker({ data: { stopRequested: true, stopReason: '用户在设置页点了停止' } }, '点赞');
  assert.ok(msg.includes('点了停止'), msg);
  assert.ok(msg.includes('点赞'), msg);
  assert.ok(msg.includes('ks_stop'), msg);
});

test('没有原因时也有默认说明', () => {
  const msg = stopBlocker({ data: { stopRequested: true } }, '回评论');
  assert.ok(msg.includes('用户停止'), msg);
});
