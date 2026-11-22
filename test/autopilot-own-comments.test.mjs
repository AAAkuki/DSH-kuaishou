// 全自动里的"回自己作品评论"：刷到的不够时，去后台评论管理补上
import test from 'node:test';
import assert from 'node:assert/strict';
import { runFullAuto } from '../src/autopilot.mjs';

function makeDeps({ feedComments = [], ownComments = [], includeOwn = true } = {}) {
  const c = { scroll: 0, reply: 0, like: 0, publish: 0 };
  const state = {
    data: { day: '2026-10-25', counts: c, lastPublishAt: 0, lastVideo: null, log: [] },
    add(k, n = 1) { c[k] = (c[k] ?? 0) + n; },
    save() {},
    searchesToday: () => [],
    addSearch() {},
    shouldStop: () => false,
    remaining(kind, quota) {
      if (!(Number(quota) > 0)) return Number.POSITIVE_INFINITY;
      return Math.max(0, Number(quota) - (c[kind] ?? 0));
    }
  };
  const cfg = {
    quotas: { scrollPerRun: 30, replyPerRun: 0, likePerRun: 5, publishPerDay: 2 },
    reply: { minChars: 2, maxChars: 60, blacklist: [], whitelist: [], tagWhitelist: [], includeOwn },
    publish: { captionMax: 120, topics: ['deepseek'], title: '' },
    summary: { perDay: 0, refresh: true },
    search: { enabled: false },
    video: { lineCount: 8 },
    loop: {}
  };
  const ownCalls = [];
  const backend = async () => ({
    async feedScroll() { return []; },
    async like() { return { changed: false }; },
    async readComments() { return feedComments; },
    async reply() { return { replied: 'ok', verified: true }; },
    async publish() { return { published: false, message: '测试不发' }; },
    // 自己作品评论（创作者后台那条路）
    async listOwnComments() { return ownComments; },
    async replyOwnComment({ match, content }) {
      ownCalls.push({ match, content });
      return { verified: true, matched: match, replied: content };
    }
  });
  const studio = { async fromText({ title, lines }) { return { file: 'x.mp4', cover: '', durationSec: 5, title, lines }; } };
  return { deps: { backend, state, cfg, studio, root: '.', trace: () => {} }, counts: c, ownCalls };
}

test('刷到的评论回完后，会去自己作品下接着回', async () => {
  const { deps, ownCalls, counts } = makeDeps({
    feedComments: [{ author: 'a', text: '这个怎么做的' }],
    ownComments: [{ author: '鱿鱼的江苏入', text: '这个视频到底是真人做的还是由AI做的' }]
  });
  const r = await runFullAuto(deps, { scroll: 0, likes: 0, replies: 5, publish: false });
  assert.equal(ownCalls.length, 1, '应该去自己作品下回一条');
  assert.match(ownCalls[0].match, /这个视频到底/);
  assert.equal(counts.reply, 2, '刷到的 1 条 + 自己的 1 条');
  assert.ok(r.steps.some((s) => s.kind === 'round'));
});

test('cfg.reply.includeOwn=false 时不碰自己作品的评论', async () => {
  const { deps, ownCalls } = makeDeps({
    feedComments: [{ author: 'a', text: '这个怎么做的' }],
    ownComments: [{ author: 'x', text: '说得好' }],
    includeOwn: false
  });
  await runFullAuto(deps, { scroll: 0, likes: 0, replies: 5, publish: false });
  assert.equal(ownCalls.length, 0);
});

test('自己作品评论也要过白名单/黑名单（不乱回）', async () => {
  const { deps, ownCalls } = makeDeps({
    feedComments: [],
    ownComments: [{ author: 'x', text: '垃圾东西' }]
  });
  deps.cfg.reply.blacklist = ['垃圾'];
  await runFullAuto(deps, { scroll: 0, likes: 0, replies: 3, publish: false });
  assert.equal(ownCalls.length, 0, '命中黑名单的不该回');
});
