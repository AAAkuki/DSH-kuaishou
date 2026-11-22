// 找茬批次：把直播链路的边角料都戳一遍
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseDanmakuLines, formatBalance, normalizeLiveUrl, parseLiveRooms, tokenBalance, pushStage } from '../src/live.mjs';
import { pickLiveReply, fitBubble } from '../src/live-reply.mjs';
import { projectRoot } from '../src/config.mjs';

test('弹幕：同一个人连续刷屏要被去重（直播间真实情况）', () => {
  const out = parseDanmakuLines([
    '小杏福：这游戏玩得不烧心',
    '小杏福：这游戏玩得不烧心',
    '小杏福：这游戏玩得不烧心',
    '别人：另一个'
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((x) => x.text), ['这游戏玩得不烧心', '另一个']);
});

test('弹幕：只有冒号、只有昵称、纯符号都不该产出空内容', () => {
  const out = parseDanmakuLines(['：', '：没有昵称', '路人甲', '***', '路人乙：正常一句']);
  for (const it of out) assert.ok(it.text && it.who);
  assert.ok(out.some((x) => x.text === '正常一句'));
});

test('弹幕：昵称里的 emoji/特殊符号要能保住', () => {
  const out = parseDanmakuLines(['🌈小杏福🌈：666']);
  assert.equal(out[0].who, '🌈小杏福🌈');
  assert.equal(out[0].text, '666');
});

test('余额：total 是 NaN/undefined 时不能显示 NaN CNY', () => {
  const r = formatBalance({ ok: true, total: Number.NaN, currency: 'CNY', granted: 0, toppedUp: 0 });
  assert.doesNotMatch(r.value, /NaN/);
});

test('余额：401 要说密钥无效，而不是笼统的 HTTP 401', async () => {
  const r = await tokenBalance({ apiKey: 'sk-test-invalid' });
  assert.equal(r.ok, false);
  assert.ok(/无效|HTTP 401|鉴权/.test(r.reason), r.reason);
});

test('直播间链接：id 里带 live 字样时别把 /u/ 误判成 /live/', () => {
  assert.equal(normalizeLiveUrl('https://live.kuaishou.com/u/liveabc'), 'https://live.kuaishou.com/u/liveabc');
  assert.equal(normalizeLiveUrl('https://live.kuaishou.com/live/abcde'), 'https://live.kuaishou.com/live/abcde');
});

test('直播间列表：乱七八糟的东西进来不能崩', () => {
  const rooms = parseLiveRooms([null, undefined, {}, { url: 'javascript:;' }, { url: 'https://live.kuaishou.com/u/ok12345', title: 'ok' }], { limit: 5 });
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].url, 'https://live.kuaishou.com/u/ok12345');
});

test('推流：rtmpUrl 已经带了密钥就不要重复拼', () => {
  const tmp = path.join(projectRoot(), 'state', 'video', '_probe.mp4');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  if (!fs.existsSync(tmp)) fs.writeFileSync(tmp, Buffer.alloc(2048));
  const r = pushStage({ ffmpeg: 'ffmpeg', rtmpUrl: 'rtmp://push.example/live', streamKey: 'k', videoFile: tmp });
  assert.ok(r.ok);
  assert.match(r.target, /\*\*\*/); // 返回里密钥要打码
});

test('回弹幕：空串/纯 emoji/超长都能给出能塞进气泡的句子', () => {
  for (const t of ['', '   ', '😂😂😂', '很长很长'.repeat(20)]) {
    const r = pickLiveReply(t);
    assert.ok(typeof r === 'string' && r.length > 0);
    assert.ok(fitBubble(r).length <= 14);
  }
});

test('回弹幕：同一条弹幕多回几次不能永远同一句', () => {
  const set = new Set();
  for (let i = 0; i < 6; i++) set.add(pickLiveReply('这AI手真稳'));
  assert.ok(set.size >= 2, `永远同一句：${[...set].join('/')}`);
});
