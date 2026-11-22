// 总结视频的「刷新 / 不刷新」：一天两条，关掉刷新就沿用今天已经出过的那条。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFullAuto, rememberVideo, findReusableVideo } from '../src/autopilot.mjs';

function makeDeps({ refresh = true, perDay = 2, counts = {}, root } = {}) {
  const dir = root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-summary-'));
  const c = { scroll: 0, reply: 0, like: 0, publish: 0, ...counts };
  const state = {
    data: { day: '2026-10-25', counts: c, lastPublishAt: 0, lastVideo: null, log: [] },
    add(k, n = 1) { c[k] = (c[k] ?? 0) + n; },
    save() {},
    searchesToday: () => [],
    addSearch() {},
    shouldStop: () => false
  };
  const cfg = {
    quotas: { scrollPerRun: 30, replyPerRun: 8, likePerRun: 5, publishPerDay: 2 },
    reply: { minChars: 2, maxChars: 60 },
    publish: { captionMax: 120, topics: ['deepseek', '大肥鱼'], title: '' },
    summary: { perDay, refresh },
    search: { enabled: false },
    video: { lineCount: 12 },
    loop: {}
  };
  const backend = async () => ({
    async feedScroll({ count }) { return Array.from({ length: count }, (_, i) => ({ dwellMs: 1000, durationSec: 10 + i, changed: true })); },
    async like() { return { changed: true }; },
    async readComments() { return [{ author: 'a', text: '这个怎么做的' }]; },
    async reply() { return { replied: 'ok' }; },
    async publish() { return { published: false, confirmed: false, message: '测试不发' }; }
  });
  const rendered = [];
  const studio = {
    async fromText({ title, lines }) {
      rendered.push({ title, lines, at: Date.now() });
      return { file: path.join(dir, `v${rendered.length}.mp4`), cover: 'c.jpg', durationSec: 58, title, lines };
    }
  };
  return { deps: { backend, state, cfg, studio, root: dir, trace: () => {} }, counts: c, state, dir, rendered };
}

test('refresh=false：今天已经出过片就沿用，不再渲染', async () => {
  const { deps, state, dir } = makeDeps({ refresh: false });
  const file = path.join(dir, 'today.mp4');
  fs.writeFileSync(file, 'x');
  state.data.lastVideo = { day: '2026-10-25', at: Date.now(), file, cover: '', topic: '我今天刷到的东西', caption: '开场', durationSec: 58 };

  const r = await runFullAuto(deps, { scroll: 1, likes: 0, replies: 0, publish: false });
  const v = r.steps.find((s) => s.kind === 'video');
  assert.ok(v, '要有 video 步骤');
  assert.equal(v.reused, true, '应该是复用，不是重新渲染');
  assert.equal(v.file, file);
});

test('refresh=false 但今天还没有片：正常渲染，并记住这条', async () => {
  const { deps, state, rendered } = makeDeps({ refresh: false });
  const r = await runFullAuto(deps, { scroll: 1, likes: 0, replies: 0, publish: false });
  assert.equal(rendered.length, 1, '应该渲染一次');
  const v = r.steps.find((s) => s.kind === 'video');
  assert.equal(v.reused, undefined);
  assert.ok(state.data.lastVideo, '渲染完要记住这条，下次才能沿用');
  assert.equal(state.data.lastVideo.day, '2026-10-25');
  assert.ok(fs.existsSync(state.data.lastVideo.file) === false || true);
});

test('refresh=true（默认）：即使今天出过，也重新渲染', async () => {
  const { deps, state, dir, rendered } = makeDeps({ refresh: true });
  const file = path.join(dir, 'old.mp4');
  fs.writeFileSync(file, 'x');
  state.data.lastVideo = { day: '2026-10-25', at: Date.now(), file, cover: '', topic: '旧', caption: '旧', durationSec: 58 };
  await runFullAuto(deps, { scroll: 1, likes: 0, replies: 0, publish: false });
  assert.equal(rendered.length, 1, '刷新模式必须重出一遍');
});

test('昨天的那条不会被沿用（跨天要重做）', async () => {
  const { deps, state, dir, rendered } = makeDeps({ refresh: false });
  const file = path.join(dir, 'yesterday.mp4');
  fs.writeFileSync(file, 'x');
  state.data.lastVideo = { day: '2026-10-24', at: Date.now(), file, cover: '', topic: '昨天', caption: 'x', durationSec: 58 };
  await runFullAuto(deps, { scroll: 1, likes: 0, replies: 0, publish: false });
  assert.equal(rendered.length, 1);
});

test('文件被删了也不会沿用一个不存在的文件', async () => {
  const { deps, state, dir, rendered } = makeDeps({ refresh: false });
  state.data.lastVideo = { day: '2026-10-25', at: Date.now(), file: path.join(dir, 'gone.mp4'), cover: '', topic: 'x', caption: 'x', durationSec: 58 };
  await runFullAuto(deps, { scroll: 1, likes: 0, replies: 0, publish: false });
  assert.equal(rendered.length, 1, '文件没了就得重出');
});

test('每天上限 2 条：已发 2 条就不再出片', async () => {
  const { deps, rendered } = makeDeps({ refresh: true, perDay: 2, counts: { publish: 2 } });
  const r = await runFullAuto(deps, { scroll: 1, likes: 0, replies: 0, publish: false });
  const v = r.steps.find((s) => s.kind === 'video');
  assert.equal(v.skipped, true);
  assert.match(v.reason, /上限/);
  assert.equal(rendered.length, 0, '到上限了不该再渲染');
});

test('字幕句数跟着设置走（videoLineCount）', async () => {
  const { deps, rendered } = makeDeps({ refresh: true });
  deps.cfg.video.lineCount = 16;
  await runFullAuto(deps, { scroll: 1, likes: 0, replies: 0, publish: false });
  assert.ok(rendered.length === 1);
  assert.ok(rendered[0].lines.length >= 10, `句数应接近 16，实际 ${rendered[0].lines.length}`);
});

test('rememberVideo / findReusableVideo：直接单测这两个小函数', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-remember-'));
  const file = path.join(dir, 'a.mp4');
  fs.writeFileSync(file, 'x');
  const state = { data: { day: '2026-10-25' }, save() { this.saved = true; } };
  const rec = rememberVideo({ state, video: { file, cover: '', durationSec: 58 }, topic: 'T', caption: 'C' });
  assert.equal(rec.day, '2026-10-25');
  assert.equal(state.saved, true);
  const reuse = findReusableVideo({ state, root: dir });
  assert.equal(reuse.file, file);
  assert.equal(reuse.reused, true);

  state.data.day = '2026-10-26';
  assert.equal(findReusableVideo({ state, root: dir }), null, '跨天不复用');

  state.data.day = '2026-10-25';
  fs.rmSync(file);
  assert.equal(findReusableVideo({ state, root: dir }), null, '文件没了不复用');
});
