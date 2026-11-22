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
      const t = setTimeout(() => rej(new Error(`timeout ${method}`)), 30000);
      waiters.set(id, (m) => { clearTimeout(t); res(m); });
    });
  };
  return { child, rpc };
}

const textOf = (r) => r?.result?.content?.[0]?.text ?? '';

test('新工具都在：ks_make_video / ks_voice_list / ks_style_preview / ks_env', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-tools-'));
  fs.mkdirSync(path.join(home, 'profiles', 'desktop'), { recursive: true });
  const { child, rpc } = startServer({ DSH_HOME: home });
  try {
    await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const list = await rpc(2, 'tools/list', {});
    const names = (list?.result?.tools ?? []).map((t) => t.name);
    for (const want of ['ks_make_video', 'ks_voice_list', 'ks_style_preview', 'ks_env', 'ks_publish_video']) {
      assert.ok(names.includes(want), `缺少工具 ${want}；现有：${names.join(', ')}`);
    }
    assert.ok(names.length >= 29, `工具数偏少：${names.length}`);
  } finally {
    child.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ks_voice_list 能列出语音（真读系统）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-tools-'));
  fs.mkdirSync(path.join(home, 'profiles', 'desktop'), { recursive: true });
  const { child, rpc } = startServer({ DSH_HOME: home });
  try {
    await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const r = await rpc(2, 'tools/call', { name: 'ks_voice_list', arguments: {} });
    const txt = textOf(r);
    assert.match(txt, /sapi/i, `应返回语音列表：${txt.slice(0, 200)}`);
  } finally {
    child.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
