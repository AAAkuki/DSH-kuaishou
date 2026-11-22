// 回复策略的回归测试：一人一次、追评才再回、文案有活人感、@主人前缀
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFullAuto } from '../src/autopilot.mjs';
import { OpsState, pickReply, replyKey } from '../src/ops.mjs';
import { projectRoot } from '../src/config.mjs';

function deps({ feedComments = [], own = [], atOwner = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-once-'));
  const st = new OpsState({ file: path.join(dir, 'ops-state.json') });
  st.data.day = '2026-10-25';
  const cfg = {
    quotas: { scrollPerRun: 30, replyPerRun: 0, likePerRun: 5, publishPerDay: 2 },
    reply: { minChars: 2, maxChars: 60, blacklist: [], whitelist: [], tagWhitelist: [], videoTagWhitelist: [], includeOwn: false, atOwner },
    publish: { captionMax: 120, topics: ['x'], title: '' },
    summary: { perDay: 0, refresh: true },
    search: { enabled: false },
    video: { lineCount: 5 },
    loop: {}
  };
  const sent = [];
  const backend = async () => ({
    async feedScroll() { return []; },
    async like() { return { changed: false }; },
    async readComments() { return feedComments; },
    async reply({ match, content }) { sent.push({ match, content }); return { verified: true }; },
    async publish() { return { published: false }; },
    async listOwnComments() { return own; },
    async replyOwnComment({ content }) { sent.push({ own: true, content }); return { verified: true }; }
  });
  const studio = { async fromText({ title, lines }) { return { file: 'x.mp4', cover: '', durationSec: 5, title, lines }; } };
  return { deps: { backend, state: st, cfg, studio, root: '.', trace: () => {} }, sent, st };
}

test('同一个人同一句话只回一次（第二轮回不再回）', async () => {
  const comment = { author: '小明', text: '这个怎么做的' };
  const { deps: d, sent } = deps({ feedComments: [comment] });
  await runFullAuto(d, { rounds: 1, likes: 0, replies: 5, publish: false });
  assert.equal(sent.length, 1, '第一轮应该回一条');
  await runFullAuto(d, { rounds: 1, likes: 0, replies: 5, publish: false });
  assert.equal(sent.length, 1, '第二轮不该再回同一句');
});

test('追评（同一个人换了内容）会再回一次', async () => {
  const { deps: d, sent } = deps({ feedComments: [{ author: '小明', text: '这个怎么做的' }] });
  await runFullAuto(d, { rounds: 1, likes: 0, replies: 5, publish: false });
  // 换成他追评后的新评论
  const d2 = d;
  d2.backend = async () => ({
    async feedScroll() { return []; },
    async like() { return { changed: false }; },
    async readComments() { return [{ author: '小明', text: '我试了还是不行，你用的哪个版本' }]; },
    async reply({ content }) { sent.push({ content }); return { verified: true }; },
    async publish() { return { published: false }; }
  });
  await runFullAuto(d2, { rounds: 1, likes: 0, replies: 5, publish: false });
  assert.equal(sent.length, 2, '追评是新内容 → 应该再回');
});

test('replyKey：作者 + 内容前 20 字（空白不影响）', () => {
  assert.equal(replyKey('小明', '这个 怎么 做'), replyKey('小明', '这个怎么做'));
  assert.notEqual(replyKey('小明', 'a'), replyKey('小红', 'a'));
});

test('回复文案有活人感：池子够大且不会连着重复', () => {
  const seen = new Set();
  for (let i = 0; i < 30; i++) seen.add(pickReply('这个怎么做的'));
  assert.ok(seen.size >= 5, `问题类应该有多句可选，实际 ${seen.size}`);
  const a = pickReply('说得太对了');
  const b = pickReply('说得太对了');
  assert.notEqual(a, b, '连着两次不该一模一样');
});

test('人设文件存在且写明了"我是AI"', () => {
  const p = path.join(projectRoot(), 'prompts', 'persona-cetacea.md');
  const text = fs.readFileSync(p, 'utf8');
  assert.match(text, /鲸鱼/);
  assert.match(text, /尾鳍/);
  assert.match(text, /米饭/);
  assert.match(text, /不是真人|AI/);
});

test('配了 @主人 时回复会带上前缀', async () => {
  const { deps: d, sent } = deps({ feedComments: [{ author: 'a', text: '这个怎么做的' }], atOwner: '主人' });
  await runFullAuto(d, { rounds: 1, likes: 0, replies: 2, publish: false });
  assert.match(sent[0].content, /^@主人 /, `实际：${sent[0].content}`);
});

test('没配 @ 时不乱 @ 人', async () => {
  const { deps: d, sent } = deps({ feedComments: [{ author: 'a', text: '这个怎么做的' }] });
  await runFullAuto(d, { rounds: 1, likes: 0, replies: 2, publish: false });
  assert.ok(!sent[0].content.startsWith('@'), sent[0].content);
});
