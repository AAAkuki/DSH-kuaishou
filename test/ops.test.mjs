import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Adb } from '../src/adb.mjs';
import { Kuaishou } from '../src/ks.mjs';
import { OpsState, EMPTY_STATE, makePlan, runPlan, pickReply, todayKey } from '../src/ops.mjs';
import { HOME_XML, COMMENT_XML, makeExecImpl } from './fixtures.mjs';
import { freshConfig } from './helpers.mjs';

function tmpStateFile() {
  return path.join(os.tmpdir(), `ksops-state-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
}

function makeKs({ random = () => 0.5 } = {}) {
  const { execImpl, calls } = makeExecImpl({ xml: () => COMMENT_XML });
  const adb = new Adb({ adbPath: 'adb', execImpl });
  return { ks: new Kuaishou({ adb, cfg: freshConfig(), sleep: async () => {}, random }), calls };
}

test('todayKey 用本地日期', () => {
  const k = todayKey(new Date('2026-10-24T05:00:00Z'), -new Date().getTimezoneOffset());
  assert.match(k, /^\d{4}-\d{2}-\d{2}$/);
});

test('OpsState 首次加载给空状态并写 day', () => {
  const file = tmpStateFile();
  const s = new OpsState({ file }).load();
  assert.deepEqual(s.data.counts, { scroll: 0, reply: 0, like: 0, publish: 0 });
  assert.equal(typeof s.data.day, 'string');
  assert.equal(fs.existsSync(file), false); // load 不落盘
});

test('OpsState 跨天自动清零计数', () => {
  const file = tmpStateFile();
  fs.writeFileSync(file, JSON.stringify({ ...EMPTY_STATE, day: '2000-01-01', counts: { scroll: 99, reply: 9, like: 9, publish: 2 } }));
  const s = new OpsState({ file }).load();
  assert.deepEqual(s.data.counts, { scroll: 0, reply: 0, like: 0, publish: 0 });
  if (fs.existsSync(file)) fs.unlinkSync(file);
});

test('OpsState 损坏文件也能从零开始', () => {
  const file = tmpStateFile();
  fs.writeFileSync(file, '{not json');
  const s = new OpsState({ file }).load();
  assert.equal(s.data.counts.scroll, 0);
  if (fs.existsSync(file)) fs.unlinkSync(file);
});

test('OpsState add/remaining/save 往返', () => {
  const file = tmpStateFile();
  const s = new OpsState({ file }).load();
  s.add('reply', 2);
  s.save();
  const again = new OpsState({ file }).load();
  assert.equal(again.data.counts.reply, 2);
  assert.equal(again.remaining('reply', 8), 6);
  assert.equal(again.remaining('reply', 1), 0);
  if (fs.existsSync(file)) fs.unlinkSync(file);
});

test('OpsState 日志有上限，不会无限增长', () => {
  const file = tmpStateFile();
  const s = new OpsState({ file }).load();
  for (let i = 0; i < 260; i++) s.add('scroll', 1);
  assert.ok(s.data.log.length <= 200);
});

test('makePlan 按剩余配额生成，超额不生成', () => {
  const file = tmpStateFile();
  const s = new OpsState({ file }).load();
  const cfg = freshConfig();
  let plan = makePlan({ quotas: cfg.quotas, state: s, random: () => 0.9 });
  assert.deepEqual(plan.map((p) => p.kind), ['scroll', 'reply', 'like']);
  s.add('scroll', cfg.quotas.scrollPerRun);
  plan = makePlan({ quotas: cfg.quotas, state: s, random: () => 0.9 });
  assert.deepEqual(plan.map((p) => p.kind), ['reply', 'like']);
  if (fs.existsSync(file)) fs.unlinkSync(file);
});

test('makePlan 发布只在 wantPublish 且今日未发时出现', () => {
  const file = tmpStateFile();
  const s = new OpsState({ file }).load();
  const cfg = freshConfig({ quotas: { ...freshConfig().quotas, publishPerDay: 1 } });
  assert.ok(!makePlan({ quotas: cfg.quotas, state: s, wantPublish: false }).some((p) => p.kind === 'publish'));
  assert.ok(makePlan({ quotas: cfg.quotas, state: s, wantPublish: true }).some((p) => p.kind === 'publish'));
  s.add('publish', 1);
  assert.ok(!makePlan({ quotas: cfg.quotas, state: s, wantPublish: true }).some((p) => p.kind === 'publish'));
  if (fs.existsSync(file)) fs.unlinkSync(file);
});

test('pickReply 按意图选不同模板', () => {
  const q = pickReply('这个怎么做？', { random: () => 0 });
  const g = pickReply('今天天气不错', { random: () => 0 });
  assert.notEqual(q, g);
  assert.ok(q.length > 0 && g.length > 0);
});

test('runPlan 执行 scroll/reply/like 并记账', async () => {
  const { ks } = makeKs();
  const file = tmpStateFile();
  const state = new OpsState({ file }).load();
  const plan = [
    { kind: 'scroll', count: 2 },
    { kind: 'like', count: 1 },
    { kind: 'reply', count: 1 }
  ];
  const result = await runPlan({ ks, state, plan, sleep: async () => {}, random: () => 0.5 });
  assert.equal(result.counts.scroll, 2);
  assert.equal(result.counts.like, 1);
  assert.equal(result.counts.reply, 1);
  assert.ok(result.events.some((e) => e.kind === 'scroll'));
  if (fs.existsSync(file)) fs.unlinkSync(file);
});

test('runPlan 回评论只挑通过 shouldReply 的候选', async () => {
  const { ks } = makeKs();
  const file = tmpStateFile();
  const state = new OpsState({ file }).load();
  const result = await runPlan({ ks, state, plan: [{ kind: 'reply', count: 5 }], sleep: async () => {}, random: () => 0.5 });
  const replied = result.events.find((e) => e.kind === 'reply');
  assert.ok(replied);
  assert.ok(replied.count <= 1, '当前界面只有 1 条合格评论（另一条是加微信广告）');
  if (fs.existsSync(file)) fs.unlinkSync(file);
});
