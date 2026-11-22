import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function startServer(env) {
  const child = spawn(process.execPath, ['src/mcp.mjs'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, KSOPS_MODE: 'adb', KSOPS_DRY: '1', ...env }
  });
  let buf = '';
  const waiters = new Map();
  child.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
    }
  });
  const rpc = (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout ${method}`)), 120000);
      waiters.set(id, (m) => { clearTimeout(t); res(m); });
    });
  };
  return { child, rpc };
}

const textOf = (r) => r?.result?.content?.[0]?.text ?? '';

test('ks_make_video：只给主题就能出片，且字幕不含模板残留', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-make-'));
  fs.mkdirSync(path.join(home, 'profiles', 'desktop'), { recursive: true });
  const { child, rpc } = startServer({ DSH_HOME: home });
  let made = null;
  try {
    await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const res = await rpc(2, 'tools/call', { name: 'ks_make_video', arguments: { topic: '今晚刷到的几条视频', lineCount: 4 } });
    made = JSON.parse(textOf(res));

    assert.ok(made.file && fs.existsSync(made.file), '应该真的产出视频文件');
    assert.ok(made.durationSec > 3, `时长太短：${made.durationSec}`);
    assert.ok(Array.isArray(made.lines) && made.lines.length >= 2, '至少两句字幕');

    for (const l of made.lines) {
      assert.ok(!/\{\{/.test(l), `字幕里不该有未替换的变量：${l}`);
      assert.ok(!/^(主题|平台|目标时长|账号人设)[:：]/.test(l), `字幕里不该有模板说明行：${l}`);
      assert.ok(l.length > 0);
    }
    // 背景应该来自设置（当前是图片）
    assert.ok(made.background?.type, '应返回背景配置');
  } finally {
    child.kill();
    if (made?.file) fs.rmSync(made.file, { force: true });
    if (made?.cover) fs.rmSync(made.cover, { force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
