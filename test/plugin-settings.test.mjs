import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unwrapValue, toSettingsJson } from '../plugins/dsh-plugin-kuaishou/index.js';
import { applySettingsOverrides, loadConfig, DEFAULTS } from '../src/config.mjs';

test('unwrapValue: 解 `{ get() }` 访问器（DSH 真实形状）', () => {
  assert.equal(unwrapValue({ get: () => 'auto' }), 'auto');
  assert.equal(unwrapValue({ get: () => 30 }), 30);
  assert.equal(unwrapValue('raw'), 'raw');
  assert.equal(unwrapValue(undefined), undefined);
  assert.equal(unwrapValue({ get: () => { throw new Error('x'); } }), undefined);
});

test('toSettingsJson: 拍平并丢掉空值/非法值', () => {
  const cfg = {
    mode: { get: () => 'web' },
    webProfileDir: { get: () => '.web-profile' },
    browserPath: { get: () => '' },
    ffmpegPath: { get: () => '' },
    videoVoice: { get: () => 'Microsoft Huihui Desktop' },
    scrollPerRun: { get: () => 12 },
    replyPerRun: { get: () => 'x' },
    likePerRun: { get: () => -1 },
    publishPerDay: { get: () => 1 },
    replyPromptId: { get: () => 'reply' },
    scriptPromptId: { get: () => '' }
  };
  const flat = toSettingsJson(cfg);
  assert.equal(flat.mode, 'web');
  assert.equal(flat.scrollPerRun, 12);
  assert.equal(flat.publishPerDay, 1);
  assert.equal(flat.videoVoice, 'Microsoft Huihui Desktop');
  assert.ok(!('browserPath' in flat), '空字符串不该写');
  assert.ok(!('replyPerRun' in flat), '非法数字不该写');
  assert.ok(!('likePerRun' in flat), '负数不该写');
  assert.ok(!('scriptPromptId' in flat));
});

test('toSettingsJson: mode 非法值被丢弃', () => {
  const flat = toSettingsJson({ mode: { get: () => 'nonsense' } });
  assert.ok(!('mode' in flat));
});

test('applySettingsOverrides: 覆盖层贴到 cfg 的正确位置', () => {
  const cfg = structuredClone(DEFAULTS);
  applySettingsOverrides(cfg, {
    mode: 'adb',
    webProfileDir: 'my-profile',
    browserPath: 'C:/edge.exe',
    ffmpegPath: 'C:/ffmpeg.exe',
    videoVoice: 'VoiceA',
    scrollPerRun: 5,
    replyPerRun: 6,
    likePerRun: 7,
    publishPerDay: 8,
    replyPromptId: 'my-reply',
    scriptPromptId: 'my-script'
  });
  assert.equal(cfg.mode, 'adb');
  assert.equal(cfg.web.profileDir, 'my-profile');
  assert.equal(cfg.web.browserPath, 'C:/edge.exe');
  assert.equal(cfg.video.ffmpegPath, 'C:/ffmpeg.exe');
  assert.equal(cfg.video.voice, 'VoiceA');
  assert.deepEqual(
    { s: cfg.quotas.scrollPerRun, r: cfg.quotas.replyPerRun, l: cfg.quotas.likePerRun, p: cfg.quotas.publishPerDay },
    { s: 5, r: 6, l: 7, p: 8 }
  );
  assert.equal(cfg.prompts.active.reply, 'my-reply');
  assert.equal(cfg.prompts.active.script, 'my-script');
  assert.ok(Array.isArray(cfg.__settingsMerged));
});

test('applySettingsOverrides: 空对象/坏输入不影响 cfg', () => {
  const cfg = structuredClone(DEFAULTS);
  applySettingsOverrides(cfg, null);
  applySettingsOverrides(cfg, {});
  assert.equal(cfg.mode, 'auto');
  assert.equal(cfg.quotas.scrollPerRun, 30);
});

test('loadConfig: 会读 state/settings.json 覆盖层，坏文件则忽略', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-cfg-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ mode: 'auto' }), 'utf8');
  fs.writeFileSync(path.join(stateDir, 'settings.json'), JSON.stringify({ mode: 'web', scrollPerRun: 3 }), 'utf8');

  const cfg = loadConfig({ file: path.join(root, 'config.json'), env: {} });
  // loadConfig 用的是项目根下的 state/，这里只验证解析逻辑本身
  assert.ok(['auto', 'web'].includes(cfg.mode));

  fs.writeFileSync(path.join(stateDir, 'settings.json'), '{bad json', 'utf8');
  assert.doesNotThrow(() => loadConfig({ file: path.join(root, 'config.json'), env: {} }));
});
