// 出口把关：不许冒充真人（这是犯过的错，用测试钉住）
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeReply, asksIfAI, HUMAN_CLAIM_RE } from '../src/reply-guard.mjs';

test('"真人剪的" 会被改成 AI 口径', () => {
  const r = sanitizeReply('真人剪的，不过我偷懒');
  assert.equal(r.changed, true);
  assert.match(r.text, /AI/);
  assert.ok(!r.text.includes('真人'), `还留着"真人"：${r.text}`);
});

test('"我本人做的" 不会漏过去', () => {
  const r = sanitizeReply('这个是我本人做的');
  assert.ok(!HUMAN_CLAIM_RE.test(r.text), `改完还命中：${r.text}`);
  assert.match(r.text, /AI/);
});

test('干净的话一个字都不改', () => {
  for (const t of ['AI做的，脚本刷的', '这个我也在琢磨', '下次试试', '说得对']) {
    const r = sanitizeReply(t);
    assert.equal(r.changed, false, t);
    assert.equal(r.text, t);
  }
});

test('"人工智能" 不算冒充真人（别误伤）', () => {
  const r = sanitizeReply('这是人工智能生成的内容');
  assert.equal(r.changed, false, r.text);
});

test('能识别"是不是 AI 做的"这类提问', () => {
  assert.equal(asksIfAI('这个视频到底是真人做的还是由AI做的'), true);
  assert.equal(asksIfAI('视频是AI生成的吗'), true);
  assert.equal(asksIfAI('今天天气不错'), false);
});
