import test from 'node:test';
import assert from 'node:assert/strict';
import { Adb } from '../src/adb.mjs';
import { Kuaishou } from '../src/ks.mjs';
import { freshConfig } from './helpers.mjs';
import { makeExecImpl } from './fixtures.mjs';
import { runFullAuto } from '../src/autopilot.mjs';

function makeKs(over = {}) {
  const { execImpl } = makeExecImpl({ xml: () => '' });
  const adb = new Adb({ adbPath: 'adb', execImpl });
  const cfg = freshConfig();
  Object.assign(cfg.reply, over);
  return new Kuaishou({ adb, cfg, sleep: async () => {}, random: () => 0.5 });
}

test('shouldReply：标签白名单命中即可回（即使不含互动词）', () => {
  const ks = makeKs({ tagWhitelist: ['#deepseek'], whitelist: ['怎么', '求'] });
  assert.equal(ks.shouldReply('这个 #deepseek 出的东西不错'), true, '命中标签应可回');
  assert.equal(ks.shouldReply('随便说一句'), false, '既没标签也没互动词 → 不回');
});

test('shouldReply：黑名单优先于标签白名单', () => {
  const ks = makeKs({ tagWhitelist: ['#deepseek'], whitelist: [] });
  assert.equal(ks.shouldReply('#deepseek 加微信领资料'), false, '黑名单应该一票否决');
});

test('shouldReply：没配标签白名单时行为不变', () => {
  const ks = makeKs({ tagWhitelist: [], whitelist: ['怎么', '求'] });
  assert.equal(ks.shouldReply('这个怎么做的'), true);
  assert.equal(ks.shouldReply('好看'), false);
});

test('autopilot：回评走白名单，广告被跳过且原因可查', async () => {
  const counts = { scroll: 0, reply: 0, like: 0, publish: 0 };
  const state = { data: { counts, lastPublishAt: 0 }, add(k, n = 1) { counts[k] = (counts[k] ?? 0) + n; }, save() {} };
  const cfg = {
    quotas: { scrollPerRun: 30, replyPerRun: 8, likePerRun: 5, publishPerDay: 2 },
    reply: { minChars: 2, maxChars: 60, blacklist: ['加微信'], whitelist: ['怎么', '求'], tagWhitelist: ['#deepseek'] },
    publish: { captionMax: 120, topics: [], title: '' }
  };
  const backend = async () => ({
    async feedScroll({ count }) { return Array.from({ length: count }, () => ({ dwellMs: 100, durationSec: 10, changed: true })); },
    async like() { return { changed: true }; },
    async readComments() {
      return [
        { author: 'a', text: '这个怎么做的？' },        // 关键词命中
        { author: 'b', text: '#deepseek 真不错' },      // 标签命中
        { author: 'c', text: '加微信领资料 #deepseek' }, // 黑名单
        { author: 'd', text: '哈' }                      // 太短
      ];
    },
    async reply() { return { replied: 'ok' }; },
    async publish() { return { published: true, confirmed: true }; }
  });
  const studio = { async fromText({ title, lines }) { return { file: 'x.mp4', cover: 'c.jpg', durationSec: 5, title, lines }; } };

  const r = await runFullAuto({ backend, state, cfg, studio, root: '.' }, { scroll: 1, likes: 1, replies: 5, publish: false });
  const round = r.steps.find((s) => s.kind === 'round');
  assert.equal(round.reply, 2, `应回 2 条，实际 ${round.reply}`);
  // 跳过原因在 roundsStat 里
  const skipped = (r.roundsStat?.[0]?.skipped) ?? [];
  assert.ok(skipped.some((s) => s.why === '命中黑名单'), `黑名单应被记录：${JSON.stringify(skipped)}`);
  assert.ok(skipped.some((s) => s.why === '太短'), '太短应被记录');
});

test('autopilot：回评失败会记在 failures 里（不再静默）', async () => {
  const counts = { scroll: 0, reply: 0, like: 0, publish: 0 };
  const state = { data: { counts, lastPublishAt: 0 }, add(k, n = 1) { counts[k] = (counts[k] ?? 0) + n; }, save() {} };
  const cfg = {
    quotas: { scrollPerRun: 30, replyPerRun: 8, likePerRun: 5, publishPerDay: 2 },
    reply: { minChars: 2, maxChars: 60, blacklist: [], whitelist: [], tagWhitelist: [] },
    publish: { captionMax: 120, topics: [], title: '' }
  };
  const backend = async () => ({
    async feedScroll({ count }) { return Array.from({ length: count }, () => ({ dwellMs: 100, durationSec: 10, changed: true })); },
    async like() { return { changed: true }; },
    async readComments() { return [{ author: 'a', text: '这个怎么做的' }]; },
    async reply() { throw new Error('点不到发送按钮'); },
    async publish() { return { published: false }; }
  });
  const studio = { async fromText({ title, lines }) { return { file: 'x.mp4', cover: 'c.jpg', durationSec: 5, title, lines }; } };

  const r = await runFullAuto({ backend, state, cfg, studio, root: '.' }, { scroll: 1, likes: 1, replies: 3, publish: false });
  const round = r.steps.find((s) => s.kind === 'round');
  assert.equal(round.reply, 0, '全失败应记 0 条');
  assert.match(r.summary, /回评论全部失败/, `报告里应说明失败：${r.summary}`);
});
