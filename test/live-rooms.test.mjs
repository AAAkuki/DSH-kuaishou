// 直播相关的纯逻辑：房间解析 + 链接修复（快手页面里的 href 经常是残的）
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLiveRooms, normalizeLiveUrl } from '../src/live.mjs';

test('链接修复：www 域名拼在残缺链接前面（线上真实情况）', () => {
  const fixed = normalizeLiveUrl('https://www.kuaishou.comhttps//live.kuaishou.com/u/3x69ef9srrxyct6');
  assert.equal(fixed, 'https://live.kuaishou.com/u/3x69ef9srrxyct6');
});

test('链接修复：// 开头的协议相对链接也要能拼', () => {
  assert.equal(normalizeLiveUrl('//live.kuaishou.com/u/3x7cff8hm8b9uwi'), 'https://live.kuaishou.com/u/3x7cff8hm8b9uwi');
});

test('链接修复：/live/ 形式保持 /live/', () => {
  assert.equal(normalizeLiveUrl('https://live.kuaishou.com/live/abcdefg'), 'https://live.kuaishou.com/live/abcdefg');
});

test('链接修复：不是直播页就返回空（不瞎猜）', () => {
  assert.equal(normalizeLiveUrl('https://www.kuaishou.com/short-video/123'), '');
  assert.equal(normalizeLiveUrl(''), '');
});

test('房间列表：残缺链接能修好，并且去重', () => {
  const rooms = parseLiveRooms([
    { url: 'https://www.kuaishou.comhttps//live.kuaishou.com/u/3x69ef9srrxyct6', title: '大厅历险记' },
    { url: '//live.kuaishou.com/u/3x69ef9srrxyct6', title: '同一间再来一次' }
  ]);
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].url, 'https://live.kuaishou.com/u/3x69ef9srrxyct6');
});

test('直播间列表：limit 生效，空标题空作者跳过', () => {
  const raw = [{ url: 'https://live.kuaishou.com/u/empty1', title: '', author: '' }];
  for (let i = 0; i < 10; i++) raw.push({ url: `https://live.kuaishou.com/u/room${i}`, title: `房间${i}`, author: '' });
  const rooms = parseLiveRooms(raw, { limit: 3 });
  assert.equal(rooms.length, 3);
  assert.equal(rooms[0].url, 'https://live.kuaishou.com/u/room0');
});
