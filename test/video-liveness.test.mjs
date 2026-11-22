// 视频"活人感"：用自己账号的真实数据说话（播放量/点赞/涨粉/最新作品/冲一万粉）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFullAuto } from '../src/autopilot.mjs';
import { OpsState, todayKey } from '../src/ops.mjs';
import { parseCreatorStats } from '../src/web.mjs';

const PAGE_TEXT = '13 天晴瞪肥鱼 数据概览 近期作品 时间 近7天 导出数据 播放量 昨日 +1.1万 1.1万 点赞量 昨日 +168 168 净增粉丝量 昨日 +8 8 完播率 21.0 最新作品 # DeepSeek #github 2832 7';

test('解析创作者首页：播放量/点赞/涨粉/完播率/最新作品', () => {
  const s = parseCreatorStats(PAGE_TEXT);
  assert.equal(s.plays, 11000);
  assert.equal(s.likes, 168);
  assert.equal(s.fansDelta, 8);
  assert.equal(s.completion, 21);
  assert.equal(s.last.plays, 2832);
  assert.equal(s.last.likes, 7);
});

test('页面没有数字时不编（全部 0）', () => {
  const s = parseCreatorStats('什么都没有');
  assert.equal(s.plays, 0);
  assert.equal(s.fansDelta, 0);
  assert.equal(s.last, null);
});

function deps({ stats = null, countText = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-live-'));
  const st = new OpsState({ file: path.join(dir, 'ops-state.json') });
  st.data.day = todayKey();
  const cfg = {
    quotas: { scrollPerRun: 30, replyPerRun: 0, likePerRun: 5, publishPerDay: 2 },
    reply: { minChars: 2, maxChars: 60, blacklist: [], whitelist: [], tagWhitelist: [], videoTagWhitelist: [], includeOwn: false, atOwner: '' },
    publish: { captionMax: 120, topics: ['x'], title: '' },
    summary: { perDay: 0, refresh: true },
    search: { enabled: false },
    video: { lineCount: 16, stats: true },
    goal: { fans: 10000 },
    loop: {}
  };
  const backend = async () => ({
    async feedScroll() { return []; },
    async like() { return { changed: false }; },
    async readComments() { return countText ? [{ author: 'a', text: countText }] : []; },
    async reply() { return { verified: true }; },
    async publish() { return { published: false }; },
    async readMyStats() { return stats || { plays: 0, likes: 0, fansDelta: 0, completion: 0, last: null }; }
  });
  const studio = { async fromText({ title, lines }) { return { file: 'x.mp4', cover: '', durationSec: 5, title, lines }; } };
  return { deps: { backend, state: st, cfg, studio, root: '.', trace: () => {} } };
}

test('有真实数据时，字幕里会出现播放量/涨粉/一万粉', async () => {
  const s = parseCreatorStats(PAGE_TEXT);
  const { deps: d } = deps({ stats: s, countText: '这个怎么做的' });
  const r = await runFullAuto(d, { rounds: 1, likes: 0, replies: 2, publish: false });
  const v = r.steps.find((x) => x.kind === 'video');
  const text = (v.lines || []).join(' | ');
  assert.match(text, /1\.1万|11000/, `没提播放量：${text}`);
  assert.match(text, /粉丝|涨了/, `没提涨粉：${text}`);
  assert.match(text, /一万粉|10000/, `没提目标：${text}`);
});

test('没有数据时绝不编数字', async () => {
  const { deps: d } = deps({ stats: null });
  const r = await runFullAuto(d, { rounds: 1, likes: 0, replies: 0, publish: false });
  const text = (r.steps.find((x) => x.kind === 'video').lines || []).join(' ');
  assert.ok(!/播放 \d/.test(text), `不该出现播放数字：${text}`);
});

test('video.stats=false 时不去读数据', async () => {
  const { deps: d } = deps({ stats: parseCreatorStats(PAGE_TEXT) });
  let called = 0;
  const inner = d.backend;
  d.backend = async () => { const b = await inner(); const orig = b.readMyStats; b.readMyStats = async () => { called++; return orig(); }; return b; };
  d.cfg.video.stats = false;
  await runFullAuto(d, { rounds: 1, likes: 0, replies: 0, publish: false });
  assert.equal(called, 0, '关掉后不该调用 readMyStats');
});

test('目标是配置里的数字（5000 就说 5000 粉）', async () => {
  const { deps: d } = deps({ stats: parseCreatorStats(PAGE_TEXT) });
  d.cfg.goal.fans = 5000;
  const r = await runFullAuto(d, { rounds: 1, likes: 0, replies: 0, publish: false });
  const text = (r.steps.find((x) => x.kind === 'video').lines || []).join(' ');
  assert.match(text, /5000 粉/);
});
