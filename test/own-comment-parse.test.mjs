// 评论管理页「一行」的解析：正文里也有数字和"回复"两个字，最容易解析错。
// 这三个坑都是实测踩出来的：
//   1) 正文 "我回复了他 3 次" 被截成 "我回复了他"，3 被当成赞数
//   2) 正文 "这个 100 回复量好高" 被截成 "这个"
//   3) "展开查看1条回复" 被当成回复作者，真正回复反而读不到
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOwnCommentText } from '../src/web.mjs';

test('普通一行：作者/时间/正文/赞数', () => {
  const p = parseOwnCommentText('鱿鱼的江苏入 4小时前 这个视频到底是真人做的还是由AI做的 0 回复 删除 举报 置顶');
  assert.equal(p.author, '鱿鱼的江苏入');
  assert.equal(p.when, '4小时前');
  assert.equal(p.text, '这个视频到底是真人做的还是由AI做的');
  assert.equal(p.likes, 0);
  assert.deepEqual(p.replies, []);
});

test('正文里有数字+“回复”也不能截断', () => {
  const p = parseOwnCommentText('小明 5分钟前 我回复了他 3 次 0 回复 删除 举报 置顶');
  assert.equal(p.text, '我回复了他 3 次');
  assert.equal(p.likes, 0);
});

test('正文里带 “100 回复量” 也一样', () => {
  const p = parseOwnCommentText('B 刚刚 这个 100 回复量好高 5 回复 删除 举报');
  assert.equal(p.text, '这个 100 回复量好高');
  assert.equal(p.likes, 5);
});

test('“3 天前” 出现在正文里时，时间要取真正的时间', () => {
  const p = parseOwnCommentText('A 昨天 3 天前才发的 2 回复 删除');
  assert.equal(p.when, '昨天');
  assert.equal(p.text, '3 天前才发的');
  assert.equal(p.likes, 2);
});

test('“展开查看1条回复” 不能当成回复作者', () => {
  const p = parseOwnCommentText('B 刚刚 这个 100 回复量好高 5 回复 删除 举报 展开查看1条回复 天晴瞪胖鱼回复B: 刚刚 确实 0 回复 删除 收起回复');
  assert.equal(p.text, '这个 100 回复量好高');
  assert.equal(p.likes, 5);
  assert.equal(p.replies.length, 1, JSON.stringify(p.replies));
  assert.deepEqual(p.replies[0], { author: '天晴瞪胖鱼', to: 'B', when: '刚刚', text: '确实' });
});

test('子回复：作者/对象/时间/内容都对', () => {
  const p = parseOwnCommentText('C 2小时前 说得好 12 回复 删除 举报 天晴瞪胖鱼回复C: 2小时前 谢谢 0 回复 删除');
  assert.equal(p.text, '说得好');
  assert.equal(p.likes, 12);
  assert.deepEqual(p.replies, [{ author: '天晴瞪胖鱼', to: 'C', when: '2小时前', text: '谢谢' }]);
});

test('两条子回复都读得到', () => {
  const p = parseOwnCommentText(
    'D 1小时前 有道理 7 回复 删除 举报 ' +
    '天晴瞪胖鱼回复D: 1小时前 谢谢 0 回复 删除 ' +
    '路人甲回复D: 30分钟前 同感 0 回复 删除'
  );
  assert.equal(p.replies.length, 2, JSON.stringify(p.replies));
  assert.equal(p.replies[0].author, '天晴瞪胖鱼');
  assert.equal(p.replies[1].author, '路人甲');
});

test('认不出来的一行不会崩，原样塞进 rowText', () => {
  const p = parseOwnCommentText('完全不像评论的一行文字');
  assert.equal(p.text, '完全不像评论的一行文字');
  assert.equal(p.likes, 0);
  assert.ok(p.rowText);
});
