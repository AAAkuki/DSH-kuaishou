// Vibe 知识大赏 风格的纯逻辑：拆屏、阅读时长、卡点、大字对齐。
// 规则来自 Win-Hao/knowledge-video 的 references/notes.md：
//   单屏 ≤20 字；阅读时间 ≈ 0.6 秒 + 每 6 个字 1 秒。
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitScreens, readingSeconds, planScenes, syntheticBeats, CHARS_PER_SCREEN } from '../src/vibe.mjs';

test('长句按句末标点拆屏，每屏不超过 20 字', () => {
  const out = splitScreens(['今天 AI 会「自己学」，这思路源自哪一年？']);
  assert.ok(out.length >= 1);
  for (const s of out) assert.ok(s.text.length <= CHARS_PER_SCREEN * 1.3, s.text);
  assert.ok(out.every((s) => typeof s.src === 'number'), '每屏要记住来自第几句');
});

test('以连接词开头的碎句并回上一屏，不单独成屏', () => {
  const out = splitScreens(['他没有回答「能」还是「不能」，而是换了个问法。']);
  assert.ok(!out.some((s) => /^而是/.test(s.text)), out.map((s) => s.text).join(' / '));
});

test('超长句硬切也不超太多字', () => {
  const long = '这是一句非常非常长的话'.repeat(6);
  const out = splitScreens([long]);
  assert.ok(out.length >= 3);
  for (const s of out) assert.ok(s.text.length <= CHARS_PER_SCREEN, s.text);
});

test('阅读时长符合“0.6 秒 + 每 6 字 1 秒”', () => {
  assert.equal(readingSeconds('一二三四五六'), 1.6);
  assert.equal(readingSeconds('一二三四五六七八九十一二'), 2.6); // 12 字 → 0.6+2
  assert.equal(readingSeconds(''), 0.6);
});

test('planScenes：一屏一幕，总时长等于各幕之和', () => {
  const plan = planScenes({ lines: ['第一句话。', '第二句话。'] });
  assert.equal(plan.scenes.length, 2);
  const sum = plan.scenes.reduce((a, s) => a + s.seconds, 0);
  assert.ok(Math.abs(sum - plan.totalSec) < 0.05, `${sum} vs ${plan.totalSec}`);
  for (const s of plan.scenes) assert.ok(s.seconds >= 1.2, `每幕至少 1.2 秒：${s.seconds}`);
});

test('planScenes：指定总时长会按比例缩放', () => {
  const plan = planScenes({ lines: ['一二三四五六七八九十', '一二三四五六七八九十'], totalSec: 20 });
  assert.ok(Math.abs(plan.totalSec - 20) < 0.1, String(plan.totalSec));
});

test('卡点：给了拍子就把切点吸到拍子上（挪动不超过 0.35 秒）', () => {
  const beats = syntheticBeats(10, 120).beats; // 每 0.5 秒一拍
  const plan = planScenes({ lines: ['一二三四五六', '七八九十十一'], beats, totalSec: 5 });
  let t = 0;
  for (const s of plan.scenes) {
    t += s.seconds;
    const near = beats.reduce((b, x) => (Math.abs(x - t) < Math.abs(b - t) ? x : b), beats[0]);
    assert.ok(Math.abs(near - t) <= 0.36, `切点 ${t} 离最近拍子 ${near} 太远`);
  }
});

test('syntheticBeats：120BPM 每 0.5 秒一拍', () => {
  const b = syntheticBeats(2, 120);
  assert.deepEqual(b.beats.slice(0, 3), [0.5, 1, 1.5]);
  assert.equal(b.bpm, 120);
});
