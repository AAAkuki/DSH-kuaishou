// 「回自己作品评论」相关的纯逻辑：评论行解析 + 不限额度语义
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOwnCommentText } from '../src/web.mjs';
import { OpsState, todayKey } from '../src/ops.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('解析评论管理页的一行：作者/时间/内容/赞数', () => {
  const r = parseOwnCommentText('鱿鱼的江苏入 4小时前 这个视频到底是真人做的还是由AI做的 0 回复 删除 举报 置顶');
  assert.equal(r.author, '鱿鱼的江苏入');
  assert.equal(r.when, '4小时前');
  assert.equal(r.text, '这个视频到底是真人做的还是由AI做的');
  assert.equal(r.likes, 0);
});

test('解析：分钟前 / 昨天 / 具体日期 都认', () => {
  assert.equal(parseOwnCommentText('a 12分钟前 好看 3 回复').when, '12分钟前');
  assert.equal(parseOwnCommentText('b 昨天 学到了 12 回复').when, '昨天');
  const d = parseOwnCommentText('c 10.25 有道理 8 删除');
  assert.equal(d.when, '10.25');
  assert.equal(d.likes, 8);
});

test('解析：格式不认识时兜底成原文，不抛', () => {
  const r = parseOwnCommentText('乱码一行 没有时间');
  assert.equal(r.text, '乱码一行 没有时间');
  assert.equal(r.author, '');
});

test('配额 0 = 不限：remaining 返回 Infinity，不会把回复卡在第 0 条', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-quota-'));
  const st = new OpsState({ file: path.join(dir, 'ops-state.json') });
  st.data.day = todayKey();   // 用当天 key，别写死日期（跨天会让 rollDay 把计数清零）
  st.data.counts = { scroll: 0, reply: 999, like: 0, publish: 0 };
  assert.equal(st.remaining('reply', 0), Number.POSITIVE_INFINITY);
  assert.equal(st.remaining('reply', 5), 0, '有额度时照旧算剩余');
});

test('发布额度仍然是用户自定义（默认 2，可改）', async () => {
  const { DEFAULTS, applySettingsOverrides } = await import('../src/config.mjs');
  assert.equal(DEFAULTS.quotas.publishPerDay, 2, '默认每天 2 条');
  const cfg = applySettingsOverrides(structuredClone(DEFAULTS), { publishPerDay: 5 });
  assert.equal(cfg.quotas.publishPerDay, 5);
});
