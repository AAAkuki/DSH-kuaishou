// 发布去重：同一个片子 + 同一段文案 12 小时内不许重复发。
// 真实事故：10-27 同一条视频被发了 4 次（19:11 / 19:13 / 19:15 / 19:17），粉丝眼里就是刷屏。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { publishKey, checkDuplicate, markPublished } from '../src/publish-guard.mjs';

const someFile = path.resolve('package.json');

test('同文件同文案 → 第二次判重', () => {
  const st = { data: {} };
  const key = publishKey({ file: someFile, caption: '今天没怎么刷' });
  assert.equal(checkDuplicate(st, key).duplicate, false);
  markPublished(st, key, { now: 1000 });
  const dup = checkDuplicate(st, key, { now: 60_000 });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.agoMin, 1);
});

test('文案不同就不算重复（改了文案可以重发）', () => {
  const st = { data: {} };
  markPublished(st, publishKey({ file: someFile, caption: 'A' }), { now: 1000 });
  assert.equal(checkDuplicate(st, publishKey({ file: someFile, caption: 'B' }), { now: 2000 }).duplicate, false);
});

test('超过 12 小时可以再发', () => {
  const st = { data: {} };
  const key = publishKey({ file: someFile, caption: 'A' });
  markPublished(st, key, { now: 0 });
  assert.equal(checkDuplicate(st, key, { now: 13 * 3600_000 }).duplicate, false);
});

test('空白差异不影响判重', () => {
  const st = { data: {} };
  markPublished(st, publishKey({ file: someFile, caption: '今天  没怎么刷' }), { now: 0 });
  assert.equal(checkDuplicate(st, publishKey({ file: someFile, caption: '今天 没怎么刷' }), { now: 1 }).duplicate, true);
});

test('记账只留最近 60 条', () => {
  const st = { data: {} };
  for (let i = 0; i < 80; i++) markPublished(st, `k${i}`, { now: i });
  assert.equal(st.data.publishedKeys.length, 60);
  assert.equal(st.data.publishedKeys.at(-1).key, 'k79');
});
