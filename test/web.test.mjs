import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCount, parseCommentText, planDwell } from '../src/web.mjs';

test('normalizeCount: 万 / w / k / 原样', () => {
  assert.equal(normalizeCount('3243'), 3243);
  assert.equal(normalizeCount('1.7万'), 17000);
  assert.equal(normalizeCount('1.2w'), 12000);
  assert.equal(normalizeCount('3.5k'), 3500);
  assert.equal(normalizeCount('1亿'), 100000000);
  assert.equal(normalizeCount(''), null);
  assert.equal(normalizeCount('赞'), null);
});

test('parseCommentText: 按「时间行」锚点解出作者/内容/赞数', () => {
  const raw = [
    '评论',
    'TA 的作品',
    '共 1129 条评论',
    '小米',
    '一|777777777777777',
    '16 分钟前',
    '0',
    '灰烬',
    '@樱花雨.',
    '21 分钟前',
    '3',
    '峖某人',
    '把碟换成露娜他能坐一下午',
    '2 小时前',
    '12'
  ].join('\n');
  const list = parseCommentText(raw);
  assert.equal(list.length, 3);
  assert.deepEqual(list[0], { author: '小米', text: '一|777777777777777', when: '16 分钟前', likes: 0 });
  assert.equal(list[1].text, '@樱花雨.');
  assert.equal(list[2].likes, 12);
});

test('parseCommentText: 跳过表头与空行，不把「共 N 条评论」当评论', () => {
  const list = parseCommentText('评论\n共 2 条评论\n刚刚\n5\n');
  assert.equal(list.length, 0);
});

test('parseCommentText: 支持「刚刚」与日期格式', () => {
  const raw = ['张三', '来了', '刚刚', '1', '李四', '哈哈', '2026-10-01', '2'].join('\n');
  const list = parseCommentText(raw);
  assert.equal(list.length, 2);
  assert.equal(list[0].when, '刚刚');
  assert.equal(list[1].when, '2026-10-01');
});

test('planDwell: 有真实时长时等「播完 + 余量」并夹在区间内', () => {
  const d = planDwell({ durationSec: 30, minMs: 6000, maxMs: 22000, random: () => 0.5 });
  assert.equal(d, 22000, '30s 的视频被上限 22s 截住');
  const d2 = planDwell({ durationSec: 10, minMs: 1000, maxMs: 30000, random: () => 0 });
  assert.equal(d2, 8500, '10s * 0.85');
});

test('planDwell: 读不到时长时落在区间内', () => {
  const d = planDwell({ durationSec: 0, minMs: 6000, maxMs: 22000, random: () => 0.25 });
  assert.equal(d, 10000);
});

test('planDwell: 极短视频也至少等 minMs', () => {
  const d = planDwell({ durationSec: 1, minMs: 6000, maxMs: 22000, random: () => 0 });
  assert.equal(d, 6000);
});
