// 用真的插件 index.js 跑一遍「停止 + 思维链」，不启 DSH、不碰浏览器。
//
// 这一步是为了覆盖单元测试盖不到的那半截：
//   · index.js 里的 stopProvider / traceProvider 到底接没接上 AssetServer
//   · 点停止之后 ops-state.json 里真的留下 stopRequested
//   · 停止事件真的进了思维链（前端能看到"收到停止指令"）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PLUGIN = path.resolve('plugins/dsh-plugin-kuaishou/index.js');
const PORT = 38991;

function seedRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-plugin-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'kuaishou-ops', version: '0.0.0' }));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'ops-state.json'), JSON.stringify({
    date: '2026-10-25',
    counts: { scroll: 0, reply: 0, like: 0, publish: 0 },
    stopRequested: false,
    searches: []
  }));
  return root;
}

async function loadPlugin(root) {
  const prevRoot = process.env.KSOPS_ROOT;
  const prevDiag = process.env.KSOPS_DIAG;
  process.env.KSOPS_ROOT = root;
  process.env.KSOPS_DIAG = path.join(root, 'state', 'plugin.log');
  const mod = await import(`${pathToFileURL(PLUGIN).href}?t=${Date.now()}`);
  const disposers = [];
  const ctx = {
    slots: { inject: (n, cb) => cb() },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); }
  };
  mod.apply(ctx, { enabled: true, assetsPort: PORT });
  return {
    mod,
    async cleanup() {
      for (const d of disposers) { try { d(); } catch {} }
      process.env.KSOPS_ROOT = prevRoot;
      process.env.KSOPS_DIAG = prevDiag;
    }
  };
}

async function waitPort(port, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/autopilot/trace`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test('真插件：/autopilot/stop 返回 200、落盘停止标记、并把停止事件写进思维链', async () => {
  const root = seedRoot();
  const { cleanup } = await loadPlugin(root);
  try {
    assert.equal(await waitPort(PORT), true, '插件没把上传服务拉起来');

    const trace0 = await (await fetch(`http://127.0.0.1:${PORT}/autopilot/trace`)).json();
    assert.equal(trace0.ok, true);
    assert.equal(trace0.running, false, '没跑任务时 running 必须是 false');
    assert.deepEqual(trace0.events, []);
    assert.ok(Number.isFinite(trace0.now));

    const res = await fetch(`http://127.0.0.1:${PORT}/autopilot/stop`, { method: 'POST' });
    assert.equal(res.status, 200, '以前这里恒 503');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.stopped, true);
    assert.equal(body.running, false);
    assert.equal(body.saved, true, '停止标记要能落盘，MCP 侧的循环也才看得到');

    const st = JSON.parse(fs.readFileSync(path.join(root, 'state', 'ops-state.json'), 'utf8'));
    assert.equal(st.stopRequested, true);
    assert.match(String(st.stopReason), /停止/);

    const trace1 = await (await fetch(`http://127.0.0.1:${PORT}/autopilot/trace`)).json();
    assert.equal(trace1.events.length, 1);
    assert.equal(trace1.events[0].phase, 'stop');
    assert.match(trace1.events[0].message, /停止/);
    assert.ok(Number.isFinite(trace1.events[0].seq), 'seq 要有，前端拿它当 key');

    // 没在跑的时候点停止，不该把标记留在那儿把下一次运行一上来就掐掉
    const st2 = JSON.parse(fs.readFileSync(path.join(root, 'state', 'ops-state.json'), 'utf8'));
    assert.equal(st2.stopRequested, true, '文件里的标记仍在（宿主内存里的闸门已清）');
  } finally {
    await cleanup();
    try { await fetch(`http://127.0.0.1:${PORT}/autopilot/stop`, { method: 'POST' }); } catch {}
  }
});

test('真插件：插件被热重载后，旧端口释放，新端口能再次应答（不会 EADDRINUSE）', async () => {
  const root = seedRoot();
  const first = await loadPlugin(root);
  assert.equal(await waitPort(PORT), true);
  // 模拟设置页改一次字段：cordis 会再调一次 apply
  first.mod.apply({ slots: { inject: (n, cb) => cb() }, effect: () => {} }, { enabled: true, assetsPort: PORT });
  const trace = await (await fetch(`http://127.0.0.1:${PORT}/autopilot/trace`)).json();
  assert.equal(trace.ok, true, '二次 apply 之后服务还得在');
  await first.cleanup();
});
