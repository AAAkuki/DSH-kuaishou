import test from 'node:test';
import assert from 'node:assert/strict';
import { runFullAuto } from '../src/autopilot.mjs';

function makeDeps({ counts = {} } = {}) {
  const c = { scroll: 0, reply: 0, like: 0, publish: 0, ...counts };
  const state = { data: { counts: c, lastPublishAt: 0 }, add(k, n = 1) { c[k] = (c[k] ?? 0) + n; }, save() {} };
  const cfg = {
    quotas: { scrollPerRun: 30, replyPerRun: 8, likePerRun: 5, publishPerDay: 2 },
    reply: { minChars: 2, maxChars: 60, blacklist: [], whitelist: [], tagWhitelist: [] },
    publish: { captionMax: 120, topics: ['deepseek'], title: '' }
  };
  let scrollCalls = 0;
  const backend = async () => ({
    async feedScroll({ count }) { scrollCalls++; return Array.from({ length: count }, () => ({ dwellMs: 100, durationSec: 30, changed: true })); },
    async like() { return { changed: true }; },
    async readComments() { return [{ author: 'a', text: '这个怎么做的' }]; },
    async reply() { return { replied: 'ok', verified: true }; },
    async publish() { return { published: true, confirmed: true }; },
    async tidy() { return { closed: 0 }; }
  });
  const studio = {
    async fromText({ title, lines }) { return { file: 'x.mp4', cover: 'c.jpg', durationSec: 8, title, lines }; }
  };
  return { deps: { backend, state, cfg, studio, root: '.' }, counts: c, scrollCalls: () => scrollCalls };
}

test('多轮：rounds=3 会连刷 3 轮，不是跑一轮就停', async () => {
  const { deps, counts } = makeDeps();
  const r = await runFullAuto(deps, { rounds: 3, scroll: 2, likes: 1, replies: 1, publish: false });
  const rounds = r.steps.filter((s) => s.kind === 'round');
  assert.equal(rounds.length, 3, `应跑 3 轮，实际 ${rounds.length}`);
  assert.equal(counts.scroll, 6, `3 轮 × 2 条 = 6，实际 ${counts.scroll}`);
  assert.equal(counts.reply, 3);
  assert.equal(r.rounds, 3);
});

test('多轮：关闭"配额重置"时，配额用尽会提前结束', async () => {
  const { deps } = makeDeps({ counts: { scroll: 29, reply: 7 } });
  deps.cfg.loop = { resetQuotaOnExhaust: false };
  const r = await runFullAuto(deps, { rounds: 5, scroll: 2, replies: 2, publish: false });
  const rounds = r.steps.filter((s) => s.kind === 'round');
  assert.ok(rounds.length < 5, `配额快满时不该跑满 5 轮，实际 ${rounds.length}`);
});

test('多轮：开着"配额重置"时，用完会自动重置继续刷', async () => {
  const { deps, counts } = makeDeps({ counts: { scroll: 29, reply: 7 } });
  deps.cfg.loop = { resetQuotaOnExhaust: true };
  const r = await runFullAuto(deps, { rounds: 3, scroll: 2, replies: 1, publish: false });
  const rounds = r.steps.filter((s) => s.kind === 'round');
  assert.equal(rounds.length, 3, `应跑满 3 轮，实际 ${rounds.length}`);
  assert.ok(counts.scroll >= 4, `重置后应继续刷，实际 ${counts.scroll}`);
});

test('内容模式 journal：字幕写「我干了什么」，不是「刷到了什么」', async () => {
  const { deps } = makeDeps();
  const r = await runFullAuto(deps, { rounds: 2, scroll: 2, likes: 2, replies: 1, publish: false, contentMode: 'journal' });
  const video = r.steps.find((s) => s.kind === 'video');
  assert.ok(video, '应出片');
  assert.equal(video.lines.some((l) => /点了|回了|跑/.test(l)), true, `journal 模式应提到自己做了什么：${video.lines.join(' | ')}`);
  assert.equal(r.contentMode, 'journal');
});

test('内容模式 scrolled：字幕围绕刷到了什么', async () => {
  const { deps } = makeDeps();
  const r = await runFullAuto(deps, { rounds: 1, scroll: 3, likes: 1, replies: 0, publish: false, contentMode: 'scrolled' });
  const video = r.steps.find((s) => s.kind === 'video');
  assert.equal(video.lines.some((l) => /刷了|分钟|赞/.test(l)), true, `scrolled 模式应提到刷到的内容：${video.lines.join(' | ')}`);
});

test('思维链：trace 会被逐条回调（think / act / round / done）', async () => {
  const events = [];
  const { deps } = makeDeps();
  deps.trace = (e) => events.push(e);
  await runFullAuto(deps, { rounds: 2, scroll: 1, likes: 1, replies: 1, publish: false });
  assert.ok(events.length >= 5, `trace 事件太少：${events.length}`);
  const phases = new Set(events.map((e) => e.phase));
  for (const p of ['think', 'round', 'done']) assert.ok(phases.has(p), `缺 phase ${p}：${[...phases].join(',')}`);
  assert.ok(events.some((e) => e.phase === 'think' && /计划跑/.test(e.message)), '开头应有计划说明');
  assert.ok(events.every((e) => typeof e.message === 'string' && e.message.length > 0));
});
