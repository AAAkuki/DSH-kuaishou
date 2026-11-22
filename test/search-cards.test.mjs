// 搜索卡片解析：新搜索页的卡片不是 <a> 链接（全是 div），
// 以前按 a[href*="/short-video/"] 抓，永远是 0 条 —— 实测搜索有 12 条结果、读到 0 条。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchCardText } from '../src/web.mjs';

test('三行卡片：标题 / 作者 / 赞数', () => {
  const c = parseSearchCardText('听说最近大家都在QQ养大肥鱼！🐟不急，现在就教你…\n腾讯QQ\n1.1万');
  assert.equal(c.title, '听说最近大家都在QQ养大肥鱼！🐟不急，现在就教你…');
  assert.equal(c.author, '腾讯QQ');
  assert.equal(c.likes, '1.1万');
});

test('话题开头的标题也能解', () => {
  const c = parseSearchCardText('#DeepSeek登顶全球第一\n美丽浙江\n578');
  assert.equal(c.title, '#DeepSeek登顶全球第一');
  assert.equal(c.author, '美丽浙江');
  assert.equal(c.likes, '578');
});

test('没有赞数：最后一行短就当作者', () => {
  const c = parseSearchCardText('一条没有赞数的卡片\n某作者');
  assert.equal(c.title, '一条没有赞数的卡片');
  assert.equal(c.author, '某作者');
  assert.equal(c.likes, '');
});

test('空文本返回 null（别塞空卡片）', () => {
  assert.equal(parseSearchCardText(''), null);
  assert.equal(parseSearchCardText('\n\n'), null);
});

test('href 拿不到就留空，不编', () => {
  const c = parseSearchCardText('标题一行够长吧\n作者\n12');
  assert.equal(c.href, '');
});
