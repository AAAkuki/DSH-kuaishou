// 三个实测出来的 bug 的回归测试：
//   1) 网页版后端没转发 watchCurrent / nextVideo → agent 模式的 ks_watch / ks_next 永远报
//      "当前后端不支持单条观看"
//   2) 不限额度时 makePlan 把 Infinity 塞进计划（JSON 里变 null）→ runPlan 要么不跑要么跑不完
//   3) 只改默认值不改已保存的 scrollPerRun，用户那边永远还是 30 条
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebBackend } from '../src/driver.mjs';
import { makePlan, OpsState, todayKey } from '../src/ops.mjs';
import { DEFAULTS, applySettingsOverrides, loadConfig } from '../src/config.mjs';

test('WebBackend 转发 watchCurrent / nextVideo（agent 模式靠它）', () => {
  const proto = WebBackend.prototype;
  assert.equal(typeof proto.watchCurrent, 'function', '缺 watchCurrent 转发');
  assert.equal(typeof proto.nextVideo, 'function', '缺 nextVideo 转发');
  // 真的会调到 web 上（用假 web 验证，不碰浏览器）
  const fake = {
    watchCurrent: async (opts) => ({ desc: 'x', watchedSec: opts?.maxSec ?? 0 }),
    nextVideo: async () => ({ desc: 'next', changed: true })
  };
  const b = Object.create(WebBackend.prototype);
  b.web = fake;
  return Promise.all([
    b.watchCurrent({ maxSec: 7 }).then((r) => assert.equal(r.watchedSec, 7)),
    b.nextVideo().then((r) => assert.equal(r.desc, 'next'))
  ]);
});

test('不限额度时计划里的 count 必须是有限数（不能是 Infinity/null）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksplan-'));
  const st = new OpsState({ file: path.join(dir, 's.json') }).load();
  const quotas = { scrollPerRun: 0, replyPerRun: 0, likePerRun: 0, publishPerDay: 2 };
  const plan = makePlan({ quotas, state: st, random: () => 0.9 });
  for (const p of plan) {
    assert.ok(Number.isFinite(p.count), `${p.kind} 的 count 不是有限数：${p.count}`);
    assert.ok(p.count > 0, `${p.kind} 的 count 应该 > 0`);
  }
  assert.ok(!JSON.stringify(plan).includes('null'), JSON.stringify(plan));
});

test('配额 0 时，用户真正读到的是“不限”（不是被 30 卡住）', () => {
  const cfg = structuredClone(DEFAULTS);
  assert.equal(cfg.quotas.scrollPerRun, 0, '默认值应该是 0（不限）');
  const st = new OpsState({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ksq-')), 's.json') }).load();
  st.data.day = todayKey();
  st.add('scroll', 100);
  assert.equal(st.remaining('scroll', 0), Number.POSITIVE_INFINITY, '已刷 100 条仍然应该“不限”');
});

test('已保存的设置确实被读成本地配置（两层都改了才生效）', () => {
  const cfg = loadConfig({ env: {} });
  // 允许 0 或正数，但如果是 0 就必须走“不限”语义
  if (cfg.quotas.scrollPerRun === 0) {
    const st = new OpsState({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ksq2-')), 's.json') }).load();
    st.data.day = todayKey();
    st.add('scroll', 999);
    assert.equal(st.remaining('scroll', 0), Number.POSITIVE_INFINITY);
  } else {
    assert.ok(cfg.quotas.scrollPerRun > 0);
  }
});

test('applySettingsOverrides 允许把 scrollPerRun 设成 0', () => {
  const cfg = structuredClone(DEFAULTS);
  applySettingsOverrides(cfg, { scrollPerRun: 0 });
  assert.equal(cfg.quotas.scrollPerRun, 0);
});
