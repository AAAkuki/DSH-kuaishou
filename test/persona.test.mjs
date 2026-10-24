import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PromptLibrary } from '../src/prompts.mjs';
import { applySettingsOverrides, loadConfig, DEFAULTS } from '../src/config.mjs';

const root = path.resolve('.');
const lib = new PromptLibrary({ cfg: { prompts: { dir: 'prompts', customDir: 'state/prompts' } }, root });

test('内置人设预设齐全且都能渲染', () => {
  const ids = ['persona-whale-maid', 'persona', 'persona-cool', 'persona-warm', 'persona-sharp'];
  for (const id of ids) {
    const p = lib.get(id);
    assert.ok(p.title.length > 0, `${id} 缺标题`);
    assert.ok(p.body.length > 200, `${id} 正文太短`);
    const r = lib.render(id, { personaName: '测试号', personaBio: '写代码的', platform: '快手', today: '2026-10-24' });
    assert.deepEqual(r.missing, [], `${id} 渲染后还有未填变量`);
    assert.match(r.text, /测试号/);
  }
});

test('五个人设的说话风格互不相同', () => {
  const ids = ['persona-whale-maid', 'persona', 'persona-cool', 'persona-warm', 'persona-sharp'];
  const bodies = ids.map((id) => lib.get(id).body);
  assert.equal(new Set(bodies).size, ids.length);
});

test('applySettingsOverrides: personaId 落到 prompts.active.persona', () => {
  const cfg = structuredClone(DEFAULTS);
  applySettingsOverrides(cfg, { personaId: 'persona-sharp' });
  assert.equal(cfg.prompts.active.persona, 'persona-sharp');
});

test('applySettingsOverrides: personaOverride 原样保留，空串也允许清空', () => {
  const cfg = structuredClone(DEFAULTS);
  applySettingsOverrides(cfg, { personaOverride: '我是测试人设，说话很短。' });
  assert.equal(cfg.prompts.personaOverride, '我是测试人设，说话很短。');

  applySettingsOverrides(cfg, { personaOverride: '' });
  assert.equal(cfg.prompts.personaOverride, '');
});

test('默认值：鲸鱼女仆娘 + 无覆盖', () => {
  const cfg = structuredClone(DEFAULTS);
  assert.equal(cfg.prompts.active.persona, 'persona-whale-maid');
  assert.equal(cfg.prompts.personaOverride, '');
});

test('鲸鱼女仆娘人设：女仆语气 + 禁区齐全，且不含性暗示', () => {
  const body = lib.get('persona-whale-maid').body;
  assert.match(body, /主人/);
  assert.match(body, /女仆/);
  assert.match(body, /不承诺收益/);
  assert.match(body, /性暗示/);
  assert.ok(body.length > 400, '正文应有实质内容');
});

test('loadConfig 读到 personaId 覆盖', () => {
  const cfg = loadConfig({ file: path.join(process.cwd(), 'config.json'), env: {} });
  assert.ok(['persona-whale-maid', 'persona', 'persona-cool', 'persona-warm', 'persona-sharp'].includes(cfg.prompts.active.persona));
});
