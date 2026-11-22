// 环境检查里新增的两个"防崩溃"检查项。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkEnvironment } from '../src/env-check.mjs';
import { DEFAULTS, applySettingsOverrides } from '../src/config.mjs';

const cfgWith = (over = {}) => applySettingsOverrides(structuredClone(DEFAULTS), over);

test('checkEnvironment 带崩溃日志与 DSH Cookie 两项', async () => {
  const report = await checkEnvironment({ cfg: cfgWith({}), assetsPort: 1 });
  const ids = report.checks.map((c) => c.id);
  for (const want of ['crashLog', 'dshCookies']) assert.ok(ids.includes(want), `缺少检查项 ${want}`);
});

test('crashLog：最近 24 小时有记录时判红，并指出去看 state/crash.log', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-env-'));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'crash.log'), `[${new Date().toISOString()}] boom: Error: 测试崩溃\n`);
  const report = await checkEnvironment({ cfg: cfgWith({}), root, assetsPort: 1 });
  const item = report.checks.find((c) => c.id === 'crashLog');
  assert.equal(item.ok, false);
  assert.match(item.detail, /1 条/);
  assert.match(item.hint, /crash\.log/);
});

test('crashLog：没有记录时是绿的', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-env-'));
  const report = await checkEnvironment({ cfg: cfgWith({}), root, assetsPort: 1 });
  const item = report.checks.find((c) => c.id === 'crashLog');
  assert.equal(item.ok, true);
});

test('dshCookies：认证 Cookie 堆到 40 个以上要报警（那就是"DSH 打不开"的原因）', async () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-appdata-'));
  const dir = path.join(appData, '@deepseek-ai', 'dsh-desktop', 'Network');
  fs.mkdirSync(dir, { recursive: true });
  // 只看名字出现次数，不需要真 sqlite
  fs.writeFileSync(path.join(dir, 'Cookies'), Array.from({ length: 55 }, (_, i) => `dsh-auth-${i}\u0000enc`).join('\n'), 'latin1');
  const prev = process.env.APPDATA;
  process.env.APPDATA = appData;
  try {
    const report = await checkEnvironment({ cfg: cfgWith({}), assetsPort: 1 });
    const item = report.checks.find((c) => c.id === 'dshCookies');
    assert.equal(item.ok, false, `应该报警，实际 detail=${item.detail}`);
    assert.match(item.detail, /55 个/);
    assert.match(item.hint, /fix-dsh-auth-cookies/);
  } finally {
    if (prev === undefined) delete process.env.APPDATA; else process.env.APPDATA = prev;
  }
});

test('dshCookies：正常数量（几个）是绿的', async () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-appdata-'));
  const dir = path.join(appData, '@deepseek-ai', 'dsh-desktop', 'Network');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Cookies'), 'dsh-auth-1\u0000enc\ndsh-auth-2\u0000enc\n', 'latin1');
  const prev = process.env.APPDATA;
  process.env.APPDATA = appData;
  try {
    const report = await checkEnvironment({ cfg: cfgWith({}), assetsPort: 1 });
    const item = report.checks.find((c) => c.id === 'dshCookies');
    assert.equal(item.ok, true);
    assert.match(item.detail, /2 个/);
  } finally {
    if (prev === undefined) delete process.env.APPDATA; else process.env.APPDATA = prev;
  }
});
