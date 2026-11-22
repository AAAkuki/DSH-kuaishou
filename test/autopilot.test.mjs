import test from 'node:test';
import assert from 'node:assert/strict';
import { runFullAuto } from '../src/autopilot.mjs';

function makeDeps({ counts = {}, fail = {}, videoOk = true } = {}) {
  const c = { scroll: 0, reply: 0, like: 0, publish: 0, ...counts };
  const state = {
    data: { counts: c, lastPublishAt: 0 },
    add(k, n = 1) { c[k] = (c[k] ?? 0) + n; },
    save() {}
  };
  const cfg = {
    quotas: { scrollPerRun: 30, replyPerRun: 8, likePerRun: 5, publishPerDay: 2 },
    reply: { minChars: 2, maxChars: 60 },
    publish: { captionMax: 120, topics: ['deepseek', '大肥鱼'], title: '' }
  };
  const backend = async () => ({
    async feedScroll({ count }) {
      if (fail.scroll) throw new Error('刷视频炸了');
      return Array.from({ length: count }, (_, i) => ({ dwellMs: 1000, durationSec: 10 + i, likeText: '1万', changed: true }));
    },
    async like() {
      if (fail.like) throw new Error('点赞炸了');
      return { changed: true };
    },
    async readComments() {
      if (fail.comment) throw new Error('读评论炸了');
      return [{ author: 'a', text: '说的太经典了' }, { author: 'b', text: '这个怎么做的' }];
    },
    async reply() {
      if (fail.reply) throw new Error('回评炸了');
      return { replied: 'ok' };
    },
    async publish() {
      if (fail.publish) throw new Error('发布炸了');
      return { published: true, confirmed: true };
    }
  });
  const studio = {
    async fromText({ title, lines }) {
      if (!videoOk) throw new Error('出片炸了');
      return { file: 'x.mp4', cover: 'c.jpg', durationSec: 12, title, lines, style: { background: {} } };
    }
  };
  return { deps: { backend, state, cfg, studio, root: '.' }, counts: c };
}

test('全自动：五步全做完，计数正确', async () => {
  const { deps, counts } = makeDeps();
  const r = await runFullAuto(deps, { scroll: 3, likes: 2, replies: 2, publish: true });
  const kinds = r.steps.map((s) => s.kind);
  // 现在结构是 round（内含刷/赞/回）+ video + publish
  assert.ok(kinds.includes('round'), '应有轮次步骤');
  for (const k of ['video', 'publish']) assert.ok(kinds.includes(k), `缺 ${k}`);
  const round = r.steps.find((s) => s.kind === 'round');
  assert.equal(round.scroll, 3, '轮次里应记录刷了 3 条');
  assert.equal(round.like, 2);
  assert.equal(round.reply, 2);
  assert.ok(r.steps.every((s) => s.ok), `有步骤失败：${JSON.stringify(r.steps.filter((s) => !s.ok))}`);
  assert.equal(counts.scroll, 3);
  assert.equal(counts.like, 2);
  assert.equal(counts.reply, 2);
  assert.equal(counts.publish, 1);
  assert.match(r.summary, /刷了 3 条/);
  assert.match(r.summary, /已发布/);
});

test('某一步炸了不影响其它步（自动降级，不中断）', async () => {
  const { deps, counts } = makeDeps({ fail: { scroll: true, like: true } });
  const r = await runFullAuto(deps, { scroll: 3, likes: 1, replies: 2, publish: true });
  const byKind = Object.fromEntries(r.steps.map((s) => [s.kind, s]));
  const round = byKind.round;
  assert.equal(round.scroll, 0, '刷视频失败应记 0 条');
  assert.equal(round.like, 0, '点赞失败应记 0 个');
  assert.equal(byKind.video.ok, true, '出片不该被影响');
  assert.equal(byKind.publish.ok, true, '发布不该被影响');
  assert.equal(counts.publish, 1);
  assert.match(r.summary, /刷视频失败（已跳过）/);
});

test('出片失败时不做发布，并在报告里说明', async () => {
  const { deps, counts } = makeDeps({ videoOk: false });
  const r = await runFullAuto(deps, { scroll: 2, likes: 1, replies: 1, publish: true });
  const byKind = Object.fromEntries(r.steps.map((s) => [s.kind, s]));
  assert.equal(byKind.video.ok, false);
  assert.ok(!byKind.publish, '没视频就不该尝试发布');
  assert.equal(counts.publish, 0);
  assert.match(r.summary, /出片失败/);
});

test('配额已满时跳过并说明，而不是报错', async () => {
  const { deps } = makeDeps({ counts: { scroll: 30, like: 5, reply: 8, publish: 2 } });
  const r = await runFullAuto(deps, { publish: true });
  const byKind = Object.fromEntries(r.steps.map((s) => [s.kind, s]));
  assert.match(r.summary, /配额已满/);
  assert.equal(byKind.publish.skipped, true, '发布配额满时应跳过');
});

test('发布失败时视频仍保存在本地（不丢产物）', async () => {
  const { deps, counts } = makeDeps({ fail: { publish: true } });
  const r = await runFullAuto(deps, { scroll: 2, likes: 1, replies: 1, publish: true });
  const byKind = Object.fromEntries(r.steps.map((s) => [s.kind, s]));
  assert.equal(byKind.video.ok, true);
  assert.ok(byKind.video.file, '视频文件应还在');
  assert.equal(byKind.publish.ok, false);
  assert.equal(counts.publish, 0);
  assert.match(r.summary, /发布失败/);
});
