import test from 'node:test';
import assert from 'node:assert/strict';
import { composeSpeakingGuide, applySpeakingGuide, parseList, STYLE_DEFAULTS } from '../src/style.mjs';
import { loadConfig, applySettingsOverrides, DEFAULTS } from '../src/config.mjs';

test('默认设置也能产出指南（称呼/自称/语气/字数/打字习惯/禁区）', () => {
  const g = composeSpeakingGuide({});
  assert.match(g, /称呼对方「主人」/);
  assert.match(g, /自称「我」/);
  assert.match(g, /一次回复不超过 40 字/);
  assert.match(g, /打字习惯/);
  assert.match(g, /不做：/);
});

test('改称呼/自称会出现在指南里', () => {
  const g = composeSpeakingGuide({ callUser: '老板', callSelf: '小的' });
  assert.match(g, /称呼对方「老板」/);
  assert.match(g, /自称「小的」/);
  assert.ok(!g.includes('主人'), '不该残留旧称呼');
});

test('五种语气各有对应描述', () => {
  const map = { gentle: /语气软/, calm: /冷静/, sharp: /先怼一句/, lively: /活泼/, pro: /专业/ };
  for (const [tone, re] of Object.entries(map)) {
    assert.match(composeSpeakingGuide({ tone }), re, tone);
  }
});

test('口头禅/禁区支持中英文逗号与分号分隔', () => {
  assert.deepEqual(parseList('啧，懂了;这就去办\n好'), ['啧', '懂了', '这就去办', '好']);
  const g = composeSpeakingGuide({ catchphrases: '啧,懂了懂了', forbid: '不刷量，不导流' });
  assert.match(g, /`啧` `懂了懂了`/);
  assert.match(g, /不做：不刷量、不导流/);
});

test('打字习惯开关能分别关闭', () => {
  const off = composeSpeakingGuide({ useEmoji: false, useTilde: false, usePeriod: true, useParticles: false });
  assert.match(off, /不用 emoji/);
  assert.match(off, /不用「～」/);
  assert.match(off, /句末正常用「。」/);
  assert.match(off, /不带语气词/);
});

test('字数上限可调，非法值忽略', () => {
  assert.match(composeSpeakingGuide({ maxChars: 15 }), /不超过 15 字/);
  assert.ok(!composeSpeakingGuide({ maxChars: 0 }).includes('不超过'));
  assert.ok(!composeSpeakingGuide({ maxChars: 'abc' }).includes('不超过'));
});

test('applySpeakingGuide 接在原文后面，保留原文', () => {
  const out = applySpeakingGuide('# 鲸鱼女仆娘\n\n主线：软。', { callUser: '主人' });
  assert.ok(out.startsWith('# 鲸鱼女仆娘'));
  assert.match(out, /说话与打字/);
});

test('把能关的都关掉后，只剩打字习惯一节（不会凭空多出称呼/语气）', () => {
  const g = composeSpeakingGuide({ callUser: '', callSelf: '', tone: '', catchphrases: '', maxChars: 0, useEmoji: false, useTilde: false, usePeriod: false, useParticles: false, forbid: '' });
  assert.match(g, /打字习惯/);
  assert.ok(!g.includes('称呼对方'), '不该有称呼');
  assert.ok(!g.includes('先怼一句'), '不该有语气描述');
  assert.ok(!g.includes('不做：'), '不该有禁区');
});

test('config.DEFAULTS.style 与 STYLE_DEFAULTS 对齐', () => {
  for (const [k, v] of Object.entries(STYLE_DEFAULTS)) {
    assert.ok(k in DEFAULTS.style, `config 缺少 style.${k}`);
    assert.deepEqual(DEFAULTS.style[k], v, `默认值不一致：${k}`);
  }
});

test('设置页 flat 键能覆盖 cfg.style（含布尔与别名）', () => {
  const cfg = structuredClone(DEFAULTS);
  applySettingsOverrides(cfg, {
    speakCallUser: '老板', speakCallSelf: '本鲸', speakTone: 'sharp',
    speakCatchphrases: '啧,懂了', speakMaxChars: 22, speakForbid: '不导流',
    typeEmoji: false, typeTilde: false, typePeriod: true, typeParticles: false
  });
  assert.equal(cfg.style.callUser, '老板');
  assert.equal(cfg.style.callSelf, '本鲸');
  assert.equal(cfg.style.tone, 'sharp');
  assert.equal(cfg.style.maxChars, 22);
  assert.equal(cfg.style.useEmoji, false);
  assert.equal(cfg.style.useTilde, false);
  assert.equal(cfg.style.usePeriod, true);
  assert.equal(cfg.style.useParticles, false);
  assert.equal(cfg.style.forbid, '不导流');
});

test('非法语气回落到默认，字数越界被夹住', () => {
  const cfg = structuredClone(DEFAULTS);
  applySettingsOverrides(cfg, { speakTone: 'evil', speakMaxChars: 9999 });
  assert.equal(cfg.style.tone, 'gentle');
  assert.equal(cfg.style.maxChars, 500);
});

test('loadConfig 里 style 一定有值', () => {
  const cfg = loadConfig({ env: {} });
  assert.equal(typeof cfg.style.callUser, 'string');
  assert.equal(typeof cfg.style.useEmoji, 'boolean');
});
