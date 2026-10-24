// 回归：MCP 必须"每次工具调用前重读配置"——设置页改了（写进 profile patch）不用重启 DSH 就生效
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve('.');

/** 造一个隔离的 DSH_HOME，里面只有 desktop profile 的 patch（就是设置页写下去的地方） */
function makeFakeDshHome(bgImage) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-hot-'));
  const dir = path.join(home, 'profiles', 'desktop');
  fs.mkdirSync(dir, { recursive: true });
  writePatch(dir, bgImage);
  return { home, dir };
}

function writePatch(dir, bgImage, blur = 12) {
  const yaml = [
    '# fake profile patch',
    '- insert:',
    '    - id: mcp-kuaishou',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: kuaishou',
    '- id: kuaishou',
    '  config:',
    `    videoBgImage: '${bgImage.replace(/'/g, "''")}'`,
    `    videoBgBlur: ${blur}`,
    ''
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), yaml, 'utf8');
}

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
      const t = setTimeout(() => rej(new Error(`timeout ${method}`)), 20000);
      waiters.set(id, (m) => { clearTimeout(t); res(m); });
    });
  };
  return { child, rpc };
}

const textOf = (r) => r?.result?.content?.[0]?.text ?? '';

test('设置改了之后（profile patch 变化），MCP 下一次调用就读到，无需重启', async () => {
  const { home, dir } = makeFakeDshHome('C:/tmp/first-bg.png');
  const { child, rpc } = startServer({ DSH_HOME: home });
  try {
    await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'hot', version: '0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const before = textOf(await rpc(2, 'tools/call', { name: 'ks_video_style', arguments: {} }));
    assert.ok(before.includes('first-bg.png'), `首次应读到 first-bg.png：${before.slice(0, 200)}`);

    // 模拟用户在设置页保存：改 patch（等一会，保证 mtime 不同）
    await new Promise((r) => setTimeout(r, 60));
    writePatch(dir, 'C:/tmp/second-bg.png', 33);

    const after = textOf(await rpc(3, 'tools/call', { name: 'ks_video_style', arguments: {} }));
    assert.ok(after.includes('second-bg.png'), `应读到新背景图 second-bg.png，实际：${after.slice(0, 300)}`);
    assert.ok(/"blur": 33/.test(after), '应读到新的模糊值 33');
  } finally {
    child.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('总开关也能热生效（关掉后动作工具立刻拒绝）', async () => {
  const { home, dir } = makeFakeDshHome('C:/tmp/x.png');
  fs.appendFileSync(path.join(dir, 'cordis.patch.yml'), '    enabled: false\n', 'utf8');
  const { child, rpc } = startServer({ DSH_HOME: home });
  try {
    await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'hot2', version: '0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const res = await rpc(2, 'tools/call', { name: 'ks_feed_scroll', arguments: { count: 1 } });
    assert.equal(res?.result?.isError, true, '关掉开关后刷视频应被拒绝');
    assert.match(textOf(res), /总开关已关闭/);
  } finally {
    child.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
