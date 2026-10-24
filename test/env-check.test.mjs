import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkEnvironment } from '../src/env-check.mjs';
import { loadConfig, applySettingsOverrides, DEFAULTS } from '../src/config.mjs';

function cfgWith(over = {}) {
  const cfg = structuredClone(DEFAULTS);
  cfg.assets = { ...cfg.assets, port: 1 }; // 故意指向没人监听的端口，让上传项必然失败（可预测）
  return applySettingsOverrides(cfg, over);
}

test('checkEnvironment: 返回结构化项目，且包含开关/后端/ffmpeg/字体/语音', async () => {
  const report = await checkEnvironment({ cfg: cfgWith({}) });
  assert.ok(Array.isArray(report.checks) && report.checks.length >= 8);
  const ids = report.checks.map((c) => c.id);
  for (const want of ['enabled', 'assets', 'mode', 'ffmpeg', 'font', 'voice']) {
    assert.ok(ids.includes(want), `缺少检查项 ${want}`);
  }
  for (const c of report.checks) {
    assert.equal(typeof c.label, 'string');
    assert.equal(typeof c.ok, 'boolean');
    assert.equal(typeof c.detail, 'string');
  }
});

test('checkEnvironment: 开关关闭时 enabled 项为 false 并给出提示', async () => {
  const report = await checkEnvironment({ cfg: cfgWith({ enabled: false }) });
  const item = report.checks.find((c) => c.id === 'enabled');
  assert.equal(item.ok, false);
  assert.match(item.detail, /已关闭/);
  assert.match(item.hint, /打开开关/);
});

test('checkEnvironment: BGM 配了不存在的文件 → 该项失败并带路径', async () => {
  const report = await checkEnvironment({ cfg: cfgWith({ videoBgmFile: 'D:/nope/bgm.mp3' }) });
  const item = report.checks.find((c) => c.id === 'bgm');
  assert.equal(item.ok, false);
  assert.match(item.detail, /文件不存在/);
});

test('checkEnvironment: BGM 未配置算通过（可选，不算坏）', async () => {
  const report = await checkEnvironment({ cfg: cfgWith({}) });
  assert.equal(report.checks.find((c) => c.id === 'bgm').ok, true);
});

test('checkEnvironment: 上传服务端口连不上 → 失败项带 hint', async () => {
  const report = await checkEnvironment({ cfg: cfgWith({}) });
  const item = report.checks.find((c) => c.id === 'assets');
  assert.equal(item.ok, false);
  assert.ok(item.hint && item.hint.length > 0);
});

test('checkEnvironment: deep=true 时多出 adb 项', async () => {
  const shallow = await checkEnvironment({ cfg: cfgWith({}) });
  const deep = await checkEnvironment({ cfg: cfgWith({}), deep: true });
  assert.ok(!shallow.checks.some((c) => c.id === 'adb'));
  assert.ok(deep.checks.some((c) => c.id === 'adb'));
});

test('登录态：按项目根解析 profile + Cookie 证据（这是用户报的那个 bug）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-root-'));
  const profile = path.join(root, '.web-profile');
  fs.mkdirSync(path.join(profile, 'Default', 'Network'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'Default', 'Network', 'Cookies'), Buffer.alloc(4096, 1));
  const report = await checkEnvironment({ cfg: cfgWith({}), root });
  const item = report.checks.find((c) => c.id === 'webProfile');
  assert.equal(item.ok, true, '有 Cookie 时应判已登录');
  assert.match(item.detail, /Cookie/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('登录态：最近确认过的标记优先（显示确认时间）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-root-'));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'web-login.json'), JSON.stringify({ loggedIn: true, at: new Date().toISOString(), nickname: '小鲸鱼' }));
  const report = await checkEnvironment({ cfg: cfgWith({}), root });
  const item = report.checks.find((c) => c.id === 'webProfile');
  assert.equal(item.ok, true);
  assert.match(item.detail, /已登录/);
  assert.match(item.detail, /小鲸鱼/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('登录态：profile 都没有时判失败并给扫码提示', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-root-'));
  const report = await checkEnvironment({ cfg: cfgWith({}), root });
  const item = report.checks.find((c) => c.id === 'webProfile');
  assert.equal(item.ok, false);
  assert.match(item.hint, /扫码/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: enabled 默认 true，设置页写 false 能覆盖', () => {
  const cfg = structuredClone(DEFAULTS);
  assert.equal(cfg.enabled, true);
  applySettingsOverrides(cfg, { enabled: false });
  assert.equal(cfg.enabled, false);
  applySettingsOverrides(cfg, { enabled: true });
  assert.equal(cfg.enabled, true);
});

test('config: assets 段可被设置页覆盖并收敛', () => {
  const cfg = structuredClone(DEFAULTS);
  applySettingsOverrides(cfg, { assetsPort: 40001, assetsDir: 'D:/assets', assetsMaxMB: 128 });
  assert.equal(cfg.assets.port, 40001);
  assert.equal(cfg.assets.dir, 'D:/assets');
  assert.equal(cfg.assets.maxMB, 128);
});

test('loadConfig: 没有 settings.json 时 enabled 仍是 true', () => {
  const cfg = loadConfig({ env: {} });
  assert.equal(typeof cfg.enabled, 'boolean');
});
