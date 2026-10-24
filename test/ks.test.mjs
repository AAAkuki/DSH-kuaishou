import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Adb } from '../src/adb.mjs';
import { Kuaishou, StepError } from '../src/ks.mjs';
import { DEFAULTS, deepMergeSafe } from './helpers.mjs';
import { makeExecImpl, HOME_XML, COMMENT_XML, PUBLISH_XML } from './fixtures.mjs';

function makeKs({ xml = () => HOME_XML, focus = 'com.smile.gifmaker', random = () => 0.5, sleeps = [] } = {}) {
  const { execImpl, calls } = makeExecImpl({ xml, focus });
  const adb = new Adb({ adbPath: 'adb', execImpl });
  const cfg = deepMergeSafe(DEFAULTS, {});
  const sleep = async (ms) => { sleeps.push(ms); };
  const ks = new Kuaishou({ adb, cfg, sleep, random });
  return { ks, adb, calls, sleeps, cfg };
}

test('screenSize 解析 wm size', async () => {
  const { ks } = makeKs();
  assert.deepEqual(await ks.screenSize(), { width: 1080, height: 2400 });
});

test('ensureForeground: 已在前台不启动', async () => {
  const { ks, calls } = makeKs();
  assert.equal(await ks.ensureForeground(), false);
  assert.ok(!calls.some((c) => c.includes('am start')));
});

test('ensureForeground: 不在前台会 am start', async () => {
  let focus = 'com.tencent.mm';
  const { execImpl, calls } = makeExecImpl({ xml: () => HOME_XML, focus: 'x' });
  const adb = new Adb({
    adbPath: 'adb',
    execImpl: async (cmd) => {
      if (cmd.join(' ').includes('shell dumpsys window')) {
        return { stdout: `mCurrentFocus=Window{1 u0 ${focus}/X}\n`, stderr: '', status: 0 };
      }
      if (cmd.join(' ').includes('shell am start')) focus = 'com.smile.gifmaker';
      return await execImpl(cmd);
    }
  });
  const ks = new Kuaishou({ adb, cfg: DEFAULTS, sleep: async () => {} });
  assert.equal(await ks.ensureForeground(), true);
  assert.ok(calls.some((c) => c.includes('am start')));
});

test('feedScroll 刷 N 条：停留时长在区间内、每条都上滑', async () => {
  const { ks, calls, sleeps } = makeKs({ random: () => 0.5 });
  const steps = await ks.feedScroll({ count: 3 });
  assert.equal(steps.length, 3);
  // random 恒 0.5 → dwell = 6000 + 0.5*(22000-6000) = 14000
  assert.equal(steps[0].dwellMs, 14000);
  assert.ok(sleeps.includes(14000));
  assert.equal(calls.filter((c) => c.includes('input swipe')).length, 3);
});

test('feedScroll 支持自定义 dwell 区间', async () => {
  const { ks } = makeKs({ random: () => 0 });
  const steps = await ks.feedScroll({ count: 1, dwell: { minMs: 1000, maxMs: 2000 } });
  assert.equal(steps[0].dwellMs, 1000);
});

test('swipeUp 坐标在屏幕范围内且上滑', async () => {
  const { ks } = makeKs({ random: () => 0.5 });
  const r = await ks.swipeUp({ durationMs: 300 });
  assert.ok(r.y1 > r.y2, '起点应在下方');
  assert.ok(r.x > 0 && r.x < 1080);
});

test('like 双击屏幕中部', async () => {
  const { ks, calls } = makeKs();
  const { x, y } = await ks.like();
  assert.ok(x > 400 && x < 700);
  assert.ok(y > 900 && y < 1400);
  assert.equal(calls.filter((c) => c.includes('input tap')).length, 2);
});

test('readComments 过滤掉「回复/展开」类噪声', async () => {
  const { ks } = makeKs({ xml: () => COMMENT_XML });
  const list = await ks.readComments();
  const texts = list.map((c) => c.text);
  assert.ok(texts.includes('这个怎么做的？'));
  assert.ok(texts.includes('加微信领资料'));
});

test('shouldReply: 广告词被拦，提问被放行', () => {
  const { ks } = makeKs();
  assert.equal(ks.shouldReply('这个怎么做的？'), true);
  assert.equal(ks.shouldReply('加微信领资料'), false);
  assert.equal(ks.shouldReply('好'), false); // 短于 minChars=2? 单字被拦
  assert.equal(ks.shouldReply('太牛了'), false); // 不含互动意图，不主动搭话
  assert.equal(ks.shouldReply('求推荐几个'), true);
});

test('assertReplyText: 长度与拉黑词红线', () => {
  const { ks } = makeKs();
  assert.throws(() => ks.assertReplyText('x'), /太短/);
  assert.throws(() => ks.assertReplyText('加微信聊'), /拉黑词/);
  assert.throws(() => ks.assertReplyText('a'.repeat(200)), /太长/);
  assert.equal(ks.assertReplyText('这个我也在试'), '这个我也在试');
});

test('replyToComment: 全链路点开 → 输入 → 发送', async () => {
  const { ks, calls } = makeKs({ xml: () => COMMENT_XML });
  const r = await ks.replyToComment({ match: '这个怎么做的', content: '我这边也在试' });
  assert.equal(r.matched, '这个怎么做的？');
  assert.ok(calls.some((c) => c.includes('input text') || c.includes('ADB_INPUT')));
  assert.ok(calls.some((c) => c.includes('input tap')));
  assert.ok(calls.at(-1).includes('input keyevent 4'), '最后应该返回');
});

test('replyToComment: 找不到评论时抛 StepError 并附屏幕摘要', async () => {
  const { ks } = makeKs({ xml: () => COMMENT_XML });
  await assert.rejects(
    () => ks.replyToComment({ match: '不存在的评论内容', content: '测试' }),
    (e) => e instanceof StepError && /找不到包含/.test(e.message) && Array.isArray(e.screen)
  );
});

test('replyToComment: content 违规时在点屏前就拒绝', async () => {
  const { ks, calls } = makeKs({ xml: () => COMMENT_XML });
  const before = calls.length;
  await assert.rejects(() => ks.replyToComment({ match: '这个怎么做的', content: '加微信' }), /拉黑词/);
  assert.equal(calls.length, before, '不该产生任何 adb 调用');
});

test('publishVideo: 文件校验（不存在/扩展名/文案过长/话题过多）', async () => {
  const { ks, cfg } = makeKs();
  const tmp = path.join(os.tmpdir(), `ks-${Date.now()}.mp4`);
  assert.throws(() => ks.assertPublishInput({ file: 'C:\\nope\\x.mp4', caption: '' }), /不存在/);
  fs.writeFileSync(tmp, Buffer.alloc(16));
  assert.throws(() => ks.assertPublishInput({ file: tmp.replace('.mp4', '.txt'), caption: '' }), /扩展名|不存在/);
  assert.throws(() => ks.assertPublishInput({ file: tmp, caption: 'x'.repeat(cfg.publish.captionMax + 1) }), /文案超过/);
  assert.throws(() => ks.assertPublishInput({ file: tmp, caption: '#a #b #c #d #e #f' }), /话题数/);
  assert.equal(ks.assertPublishInput({ file: tmp, caption: '#a #b' }).size, 16);
  fs.unlinkSync(tmp);
});

test('publishVideo: push 后走完整发布链', async () => {
  const tmp = path.join(os.tmpdir(), `ks-${Date.now()}.mp4`);
  fs.writeFileSync(tmp, Buffer.alloc(32));
  const { ks, calls } = makeKs({ xml: () => PUBLISH_XML });
  const r = await ks.publishVideo({ file: tmp, caption: '今天的日常' });
  assert.equal(r.published, true);
  assert.ok(calls.some((c) => c.startsWith('push ')));
  assert.ok(calls.some((c) => c.includes('MEDIA_SCANNER_SCAN_FILE')));
  assert.ok(calls.some((c) => c.includes('ADB_INPUT') || c.includes('input text')));
  fs.unlinkSync(tmp);
});

test('publishVideo: pushOnly 只推文件', async () => {
  const tmp = path.join(os.tmpdir(), `ks-${Date.now()}.mp4`);
  fs.writeFileSync(tmp, Buffer.alloc(8));
  const { ks, calls } = makeKs({ xml: () => PUBLISH_XML });
  const r = await ks.publishVideo({ file: tmp, caption: '', dryPushOnly: true });
  assert.equal(r.published, false);
  assert.ok(calls.at(-1).includes('MEDIA_SCANNER') || calls.some((c) => c.startsWith('push ')));
  assert.ok(!calls.some((c) => c.includes('am start')));
  fs.unlinkSync(tmp);
});

test('status 汇总前台、尺寸与屏幕文本', async () => {
  const { ks } = makeKs();
  const s = await ks.status();
  assert.equal(s.kuaishouForeground, true);
  assert.deepEqual(s.screenSize, { width: 1080, height: 2400 });
  assert.ok(s.screen.some((n) => n.text === '评论'));
});

test('dryRun 下不睡眠、不做前台校验，但命令照记', async () => {
  const { execImpl, calls } = makeExecImpl({ focus: 'x' });
  const adb = new Adb({ adbPath: 'adb', execImpl, dryRun: true });
  const ks = new Kuaishou({ adb, cfg: DEFAULTS, random: () => 0.5 });
  const steps = await ks.feedScroll({ count: 2 });
  assert.equal(steps.length, 2);
  assert.ok(calls.some((c) => c.includes('input swipe')));
  assert.ok(!calls.some((c) => c.includes('dumpsys window')), '干跑不该去查前台');
});
