import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateWidth, fitText } from '../src/typography.mjs';

test('estimateWidth: 中文按 1 字宽、ASCII 更窄', () => {
  const cjk = estimateWidth('中文标题', 50);
  const ascii = estimateWidth('abcdef', 50);
  assert.equal(cjk, 4 * 50);
  assert.ok(ascii < cjk);
});

test('fitText: 短标题保持最大字号', () => {
  const r = fitText('你好', { width: 1080, maxFontSize: 76 });
  assert.equal(r.fontSize, 76);
  assert.deepEqual(r.lines, ['你好']);
});

test('fitText: 长标题自动缩小字号直到放得下', () => {
  const r = fitText('DeepSeek 帮我改了一行代码', { width: 1080, maxFontSize: 76 });
  assert.ok(r.fontSize < 76, `应缩小，实际 ${r.fontSize}`);
  assert.ok(estimateWidth(r.lines.join(''), r.fontSize) <= 1080 * 0.88 + 1);
});

test('fitText: 缩到最小仍放不下时折行且不超过 maxLines', () => {
  const long = '这是一句非常非常长的字幕用来测试折行逻辑是否正常工作以及是否会超过最大行数限制';
  const r = fitText(long, { width: 1080, maxFontSize: 76, minFontSize: 40, maxLines: 2 });
  assert.ok(r.lines.length >= 1);
  assert.ok(r.lines.length <= 2);
  assert.equal(r.fontSize, 40);
});

test('fitText: 空文本返回空行不崩', () => {
  const r = fitText('   ', { width: 1080 });
  assert.deepEqual(r.lines, []);
});
