// profile 层（优先级最高）和 settings.json 打架时，必须能被体检出来。
// 背景：我把 cute_breath=false 写进 settings.json，profile 里还是 true，
// 结果成片里照旧有杂音 —— "改了不生效"就是这么来的。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { audit, profileLayer } from '../tools/validate-settings.mjs';
import { projectRoot } from '../src/config.mjs';

const root = projectRoot();

function sandbox(settingsObj, patchText) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-layer-'));
  for (const rel of ['plugins/dsh-plugin-kuaishou/index.js', 'plugins/dsh-plugin-kuaishou/client/client.js', 'src/config.mjs']) {
    fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
    fs.copyFileSync(path.join(root, rel), path.join(base, rel));
  }
  fs.mkdirSync(path.join(base, 'state'), { recursive: true });
  fs.writeFileSync(path.join(base, 'state', 'settings.json'), JSON.stringify(settingsObj, null, 2), 'utf8');

  const dsh = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-dsh-'));
  fs.mkdirSync(path.join(dsh, 'profiles', 'desktop'), { recursive: true });
  fs.writeFileSync(path.join(dsh, 'profiles', 'desktop', 'cordis.patch.yml'), patchText, 'utf8');
  return { base, dsh };
}

const PATCH = `- id: ui-chat
  disabled: false
- id: kuaishou
  enabled: true
  videoBgBlur: 10
  cute_breath: false
  videoLineCount: 12
- id: agent-default-model
  model: x
`;

test('profileLayer 只取 kuaishou 那一层的键，不会串到别的条目', () => {
  const { dsh } = sandbox({}, PATCH);
  const layer = profileLayer({ dshHome: dsh });
  assert.equal(layer.exists, true);
  assert.equal(layer.values.videoBgBlur, '10');
  assert.equal(layer.values.cute_breath, 'false');
  assert.equal(layer.values.model, undefined, '不能把 agent-default-model 的键算进来');
  assert.equal(layer.values.disabled, undefined);
});

test('两层一致时没有冲突', () => {
  const { base, dsh } = sandbox({ videoBgBlur: 10, cute_breath: false, videoLineCount: 12 }, PATCH);
  const r = audit({ root: base, dshHome: dsh });
  assert.deepEqual(r.conflicts, []);
});

test('两层打架时会列出来，并标明实际生效的是 profile 那个', () => {
  const { base, dsh } = sandbox({ videoBgBlur: 30, cute_breath: true, videoLineCount: 12 }, PATCH);
  const r = audit({ root: base, dshHome: dsh });
  const keys = r.conflicts.map((c) => c.key).sort();
  assert.deepEqual(keys, ['cute_breath', 'videoBgBlur']);
  const blur = r.conflicts.find((c) => c.key === 'videoBgBlur');
  assert.equal(blur.settings, '30');
  assert.equal(blur.effective, '10');
});

test('profile 不存在时不影响体检（不是桌面端 / 没装过）', () => {
  const { base } = sandbox({ videoBgBlur: 10 }, PATCH);
  const r = audit({ root: base, dshHome: path.join(os.tmpdir(), 'nope-' + Date.now()) });
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.profile.exists, false);
});
