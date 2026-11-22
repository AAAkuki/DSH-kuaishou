// 去 AI 味：机械清洗 + 提示词渲染。
// 这个功能有两层：
//   1) prompts/de-ai.md（给模型看的改写要求，ks_deai mode=prompt 会渲染它）
//   2) src/deai.mjs 的机械清洗（不经过模型也能去八股，出片前置兜底）
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { deaiClean, deaiText, numbersPreserved } from '../src/deai.mjs';
import { PromptLibrary } from '../src/prompts.mjs';

test('去掉句首八股连接词', () => {
  const r = deaiClean('首先，这个功能好用。其次，它省时间。');
  assert.ok(!r.text.includes('首先'), r.text);
  assert.ok(!r.text.includes('其次'), r.text);
  assert.match(r.text, /这个功能好用/);
});

test('去掉客服腔整句', () => {
  const r = deaiClean('这款插件能刷视频。感谢您的观看，欢迎在评论区留言。');
  assert.match(r.text, /这款插件能刷视频/);
  assert.ok(!r.text.includes('感谢您的观看'), r.text);
  assert.ok(!r.text.includes('欢迎在评论区留言'), r.text);
});

test('大词换人话', () => {
  const r = deaiClean('这个工具赋能日常，颗粒度很细，形成闭环。');
  assert.ok(!r.text.includes('赋能'), r.text);
  assert.ok(!r.text.includes('颗粒度'), r.text);
  assert.ok(!r.text.includes('闭环'), r.text);
});

test('形容词堆料合并：非常非常 → 非常', () => {
  assert.equal(deaiClean('非常非常好用').text, '非常好用');
  assert.equal(deaiClean('十分极其难受').text, '十分难受');
});

test('emoji 最多留一个', () => {
  const r = deaiClean('今天刷了 30 条😀😀😀');
  const emojis = r.text.match(/[\u{1F300}-\u{1FAFF}]/gu) || [];
  assert.equal(emojis.length, 1, r.text);
});

test('数字一个都不能少（事实不动）', () => {
  const before = '首先，今天刷了 30 条视频，回了 4 条评论，涨了 8 个粉丝。';
  const after = deaiText(before);
  assert.equal(numbersPreserved(before, after), true, after);
});

test('承认 AI 身份的话不会被改掉', () => {
  const r = deaiClean('这视频是 AI 做的，素材脚本刷的。');
  assert.match(r.text, /AI/);
  assert.ok(!/真人|本人/.test(r.text));
});

test('原文太短就原样返回，别硬抻', () => {
  assert.equal(deaiText('就这样'), '就这样');
});

test('全删空了要退回原文（宁可留 AI 味也不发空文案）', () => {
  const r = deaiClean('感谢您的观看，希望对您有所帮助。');
  assert.ok(r.text.trim().length > 0, '不能返回空串');
});

test('prompts/de-ai.md 能被渲染，变量都在', () => {
  const lib = new PromptLibrary({ cfg: { prompts: { dir: 'prompts', customDir: 'state/prompts' } }, root: path.resolve('.') });
  const p = lib.get('de-ai');
  assert.ok(p, '缺 prompts/de-ai.md');
  const r = lib.render('de-ai', { personaSummary: '鲸鱼女孩，傲娇又甜', text: '首先，这个真的非常好用。' });
  assert.deepEqual(r.missing, [], `还有未填变量：${r.missing}`);
  assert.match(r.text, /鲸鱼女孩/);
  assert.match(r.text, /首先/);
  assert.ok(!r.text.includes('{{text}}'));
});
