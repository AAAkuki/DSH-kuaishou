// 思维链 + 停止按钮的契约测试。
//
// 这两个接口之前是坏的：
//   · /autopilot/stop 永远 503（AssetServer 构造函数根本没接 stopProvider）
//   · 设置页没有停止按钮，stopAuto 是死代码
// 这里把「宿主给出什么形状」钉死，前端再按这个形状渲染。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AssetServer } from '../src/assets.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-trace-'));

async function withServer(opts, fn) {
  const s = new AssetServer({ dir: tmp(), port: 0, log: () => {}, ...opts });
  const port = await s.start();
  try { return await fn(port, s); } finally { await s.stop(); }
}

test('/autopilot/stop 在接了 stopProvider 之后必须返回 200，而不是 503', async () => {
  await withServer({ stopProvider: () => ({ stopped: true, running: true, saved: true }) }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/autopilot/stop`, { method: 'POST' });
    assert.equal(res.status, 200, '之前这里恒 503：构造函数漏了 stopProvider');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.stopped, true);
    assert.equal(body.running, true);
  });
});

test('/autopilot/stop 没接 provider 时给 503，而且不能把进程打挂', async () => {
  await withServer({}, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/autopilot/stop`, { method: 'POST' });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /stop/);
  });
});

test('/autopilot/stop：provider 抛错 → 500 + 可读错误', async () => {
  await withServer({ stopProvider: () => { throw new Error('磁盘写不进去'); } }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/autopilot/stop`, { method: 'POST' });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /磁盘/);
  });
});

test('/autopilot/trace：带 running/startedAt/events/now，前端靠这些算「运行中·已运行 N 秒」', async () => {
  const events = [
    { at: new Date().toISOString(), seq: 1, phase: 'start', message: '开始全自动' },
    { at: new Date().toISOString(), seq: 2, phase: 'think', message: '先刷 10 条看看' }
  ];
  await withServer({ traceProvider: () => ({ running: true, startedAt: Date.now() - 5000, events, result: null }) }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/autopilot/trace`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.running, true);
    assert.ok(Number.isFinite(body.startedAt));
    assert.ok(Number.isFinite(body.now), 'now 必须有，否则前端只能拿本机时间去减（时钟不同源）');
    assert.ok(body.now >= body.startedAt);
    assert.equal(body.events.length, 2);
    assert.equal(body.events[1].phase, 'think');
  });
});

test('/autopilot/trace：跑完 running=false，但 events 仍然保留（前端要能把完整链条留在屏幕上）', async () => {
  await withServer({ traceProvider: () => ({ running: false, startedAt: 1, events: [{ phase: 'end', message: '本轮结束' }], result: { summary: '刷 10 / 赞 3 / 回 2' } }) }, async (port) => {
    const body = await (await fetch(`http://127.0.0.1:${port}/autopilot/trace`)).json();
    assert.equal(body.running, false);
    assert.equal(body.events.length, 1);
    assert.equal(body.result.summary, '刷 10 / 赞 3 / 回 2');
  });
});

test('停止之后 trace 里要能看到 stop 事件，而不是静默消失', async () => {
  const events = [];
  const stopProvider = () => {
    events.push({ at: new Date().toISOString(), seq: events.length + 1, phase: 'stop', message: '收到停止指令' });
    return { stopped: true, running: true };
  };
  await withServer({ stopProvider, traceProvider: () => ({ running: true, startedAt: Date.now(), events, result: null }) }, async (port) => {
    await fetch(`http://127.0.0.1:${port}/autopilot/stop`, { method: 'POST' });
    const body = await (await fetch(`http://127.0.0.1:${port}/autopilot/trace`)).json();
    assert.equal(body.events.at(-1).phase, 'stop');
  });
});

test('GET 不该能触发停止（避免浏览器预取/刷新页面把任务停掉）', async () => {
  let called = 0;
  await withServer({ stopProvider: () => { called += 1; return { stopped: true }; } }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/autopilot/stop`);
    assert.equal(called, 0);
    assert.notEqual(res.status, 200);
  });
});
