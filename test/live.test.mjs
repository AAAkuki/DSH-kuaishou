// 直播（插件内功能）的纯逻辑：弹幕解析、余额格式化、推流参数校验。
// 和 Vibe 视频无关；这些函数都不碰浏览器/网络，方便单测。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDanmakuLines, formatBalance, pushStage } from '../src/live.mjs';

test('弹幕解析：冒号分隔、空格分隔都认', () => {
  const out = parseDanmakuLines(['小鱼干：这AI手真稳', '阿蓝: 跳啊别站着', '小红 这力度可以']);
  assert.deepEqual(out.map((x) => x.who), ['小鱼干', '阿蓝', '小红']);
  assert.deepEqual(out.map((x) => x.text), ['这AI手真稳', '跳啊别站着', '这力度可以']);
});

test('弹幕解析：系统消息和占位符要过滤掉', () => {
  const out = parseDanmakuLines([
    '说点什么...', '发送', '进入直播间', '关注了主播', '小红：抱抱',
    '欢迎 某某 来到直播间', '送出了 爱心'
  ]);
  assert.deepEqual(out.map((x) => x.text), ['抱抱']);
});

test('弹幕解析：超长行和空行跳过，只留最后 limit 条', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(`用户${i}：第 ${i} 句`);
  rows.push('这一行特别特别特别长'.repeat(10));
  rows.push('');
  const out = parseDanmakuLines(rows, { limit: 3 });
  assert.equal(out.length, 3);
  assert.equal(out[2].text, '第 9 句');
});

test('余额格式化：没 key 就说没 key，不编数字', () => {
  const r = formatBalance({ ok: false, reason: '没有 key（设置里填 live.tokenKey，或设 DEEPSEEK_API_KEY）' });
  assert.equal(r.value, '—');
  assert.match(r.note, /key/);
});

test('余额格式化：有钱时显示总额 + 赠送/充值', () => {
  const r = formatBalance({ ok: true, total: 12.3456, currency: 'CNY', granted: 2, toppedUp: 10.3456 });
  assert.equal(r.value, '12.35 CNY');
  assert.match(r.note, /赠送 2\.00/);
});

test('推流：没有地址/密钥就明确拒绝，不假装在播', () => {
  const r = pushStage({ ffmpeg: 'ffmpeg', rtmpUrl: '', streamKey: '' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /推流地址|密钥/);
});

test('推流：没有源文件也拒绝', () => {
  const r = pushStage({ ffmpeg: 'ffmpeg', rtmpUrl: 'rtmp://x/live', streamKey: 'k', videoFile: 'C:/nope.mp4' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /推流源|不存在/);
});

test('纯净版：只显示游戏，不叠任何卡片/弹幕', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { projectRoot } = await import('../src/config.mjs');
  const raw = fs.readFileSync(path.join(projectRoot(), 'state/live/stage-bare.html'), 'utf8');
  const bare = raw.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(bare, /jump-jump\.html/);
  assert.doesNotMatch(bare, /__stage|pushDanmaku|setBalance/); // 没有大叠加层
  assert.doesNotMatch(bare, /TOKEN|SCORE|dmCount|id="side"/);  // 没有信息卡
  // 右下角角色 + 它的气泡是允许的（用户要的就是这个）
  assert.match(bare, /id="pet"/);
  assert.match(bare, /pet-cutout\.png/);
  assert.match(bare, /__pet/);
  assert.equal((bare.match(/<iframe/g) || []).length, 1);
});

test('回弹幕：按内容挑话，长度能塞进气泡', async () => {
  const { pickLiveReply, fitBubble } = await import('../src/live-reply.mjs');
  assert.match(pickLiveReply('它是AI吧'), /AI 在玩|片子是 AI|不是人/);
  assert.match(pickLiveReply('这AI也太稳了'), /诶嘿|基本操作|稳是应该的/);
  assert.match(pickLiveReply('快跳啊别停'), /别催|这就跳|排队/);
  assert.match(pickLiveReply('token 还剩多少'), /余额|省着点/);
  const long = fitBubble('这句话特别特别特别长根本塞不进气泡里');
  assert.ok(long.length <= 14);
  assert.ok(long.endsWith('…'));
});
