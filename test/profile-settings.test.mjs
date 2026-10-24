import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, readProfileSettings, DEFAULTS } from '../src/config.mjs';

function fakeDsh(entries) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-dsh-'));
  const dir = path.join(home, 'profiles', 'desktop');
  fs.mkdirSync(dir, { recursive: true });
  const yamlText = entries.map((e) => JSON.stringify(e)).join('\n');
  // 手写 YAML（比 JSON 更像真实的 patch）
  const lines = [];
  for (const op of entries) {
    if (Array.isArray(op.insert)) {
      lines.push('- insert:');
      for (const entry of op.insert) {
        lines.push(`    - id: ${entry.id}`);
        if (entry.config) {
          lines.push('      config:');
          for (const [k, v] of Object.entries(entry.config)) lines.push(`        ${k}: ${JSON.stringify(v)}`);
        }
      }
    } else {
      lines.push(`- id: ${op.id}`);
      if (op.config) {
        lines.push('  config:');
        for (const [k, v] of Object.entries(op.config)) lines.push(`    ${k}: ${JSON.stringify(v)}`);
      }
    }
  }
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), `${lines.join('\n')}\n`, 'utf8');
  return home;
}

test('readProfileSettings: 读顶层 override（设置页写下去的形状）', () => {
  const home = fakeDsh([
    { id: 'ui-theme', config: { preference: 'system' } },
    { id: 'kuaishou', config: { scrollPerRun: 7, videoVoice: 'VoiceA' } }
  ]);
  const got = readProfileSettings({ dshHome: home, profile: 'desktop' });
  assert.deepEqual(got, { scrollPerRun: 7, videoVoice: 'VoiceA' });
});

test('readProfileSettings: 也能读 bundle insert 里的 base 配置', () => {
  const home = fakeDsh([
    { insert: [{ id: 'mcp-kuaishou' }, { id: 'kuaishou', config: { mode: 'web' } }] }
  ]);
  assert.deepEqual(readProfileSettings({ dshHome: home, profile: 'desktop' }), { mode: 'web' });
});

test('readProfileSettings: 后出现的覆盖先出现的', () => {
  const home = fakeDsh([
    { insert: [{ id: 'kuaishou', config: { mode: 'adb', scrollPerRun: 5 } }] },
    { id: 'kuaishou', config: { scrollPerRun: 9 } }
  ]);
  assert.deepEqual(readProfileSettings({ dshHome: home, profile: 'desktop' }), { mode: 'adb', scrollPerRun: 9 });
});

test('readProfileSettings: 文件不存在/坏 YAML 返回空对象不抛', () => {
  assert.deepEqual(readProfileSettings({ dshHome: path.join(os.tmpdir(), 'nope-ksops'), profile: 'desktop' }), {});
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-bad-'));
  const dir = path.join(home, 'profiles', 'desktop');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- id: [broken\n', 'utf8');
  assert.deepEqual(readProfileSettings({ dshHome: home, profile: 'desktop' }), {});
});

test('loadConfig: 设置页的值优先级高于 config.json', () => {
  const home = fakeDsh([{ id: 'kuaishou', config: { scrollPerRun: 3, mode: 'web' } }]);
  const cfg = loadConfig({ file: path.join(os.tmpdir(), 'no-such-config.json'), env: {}, dshHome: home, profile: 'desktop' });
  assert.equal(cfg.quotas.scrollPerRun, 3);
  assert.equal(cfg.mode, 'web');
  assert.deepEqual(cfg.__settingsMerged.sort(), ['mode', 'scrollPerRun']);
});

test('loadConfig: 没有覆盖层时回到默认值', () => {
  const cfg = loadConfig({ file: path.join(os.tmpdir(), 'no-such-config.json'), env: {}, dshHome: path.join(os.tmpdir(), 'nope2-ksops') });
  assert.equal(cfg.quotas.scrollPerRun, DEFAULTS.quotas.scrollPerRun);
  assert.equal(cfg.mode, 'auto');
});
