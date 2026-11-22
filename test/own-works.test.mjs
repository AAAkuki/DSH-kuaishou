// 「作品管理」页表格解析：以前按"状态词前一段当标题"抓，结果把整行数字和页面菜单
// 都塞进标题里（实测 ks_own_works 返回 "中心 成长中心 创作服务…" 这种垃圾）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOwnWorksText } from '../src/web.mjs';

const PAGE = '16 天晴瞪肥鱼 发布作品 首页 内容管理 作品管理 合集管理 互动管理 数据中心 成长中心 创作服务 其他服务 '
  + '视频管理 时间范围 ~ 共365天 全部作品 已发布 待发布 未通过 共12个作品 00:45 # DeepSeek #github #大肥鱼 #ai 插件名称DSH-kuaishou 置顶 '
  + '已发布 2026-10-26 01:49 4,035 2 13 00:58 - '
  + '已发布 2026-10-27 19:17 236 0 0 00:58 今天刷了六条，回了两句，发了一条。 '
  + '已发布 2026-10-27 18:58 45 0 1 00:58 -';

test('一行一条：状态/时间/播放/赞/评论/时长', () => {
  const rows = parseOwnWorksText(PAGE);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    { status: rows[0].status, at: rows[0].at, plays: rows[0].plays, likes: rows[0].likes, comments: rows[0].comments, duration: rows[0].duration },
    { status: '已发布', at: '2026-10-26 01:49', plays: 4035, likes: 2, comments: 13, duration: '00:58' }
  );
});

test('置顶那一行：标题在统计块前面，也要抓对，不能带页面菜单', () => {
  const rows = parseOwnWorksText(PAGE);
  assert.equal(rows[0].title, '# DeepSeek #github #大肥鱼 #ai 插件名称DSH-kuaishou');
  assert.ok(!/首页|内容管理|共365天|个作品/.test(rows[0].title), rows[0].title);
});

test('常规行：标题在统计块后面', () => {
  const rows = parseOwnWorksText(PAGE);
  assert.equal(rows[1].title, '今天刷了六条，回了两句，发了一条。');
});

test('标题是 “-” 时留空，不继承上一行', () => {
  const rows = parseOwnWorksText(PAGE);
  assert.equal(rows[2].title, '');
});

test('逗号数字要解析成数字', () => {
  const rows = parseOwnWorksText('已发布 10-26 00:54 4,103 1 9 00:58 刷 35 条，回 8 条');
  assert.equal(rows[0].plays, 4103);
  assert.equal(rows[0].at, '10-26 00:54');
  assert.equal(rows[0].title, '刷 35 条，回 8 条');
});

test('未通过/待发布 这些状态也要认', () => {
  const rows = parseOwnWorksText('未通过 2026-10-25 16:38 4,010 0 6 00:10 - 待发布 2026-10-25 16:40 0 0 0 00:58 草稿');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, '未通过');
  assert.equal(rows[1].status, '待发布');
});

test('空文本返回空数组', () => {
  assert.deepEqual(parseOwnWorksText(''), []);
  assert.deepEqual(parseOwnWorksText('乱七八糟没有表格'), []);
});
