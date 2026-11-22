// 防崩溃：状态文件损坏自愈、原子写、看门狗、上传服务不把宿主带走。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic, readJsonSafe, withTimeout, recentCrashes, installCrashGuard, bestEffort } from '../src/safety.mjs';
import { AssetServer } from '../src/assets.mjs';
import { OpsState, todayKey } from '../src/ops.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-safety-'));

test('原子写：写完能读回来，并且留下 .bak', () => {
  const dir = tmp();
  const file = path.join(dir, 'x.json');
  writeJsonAtomic(file, { a: 1 });
  writeJsonAtomic(file, { a: 2 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).a, 2);
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).a, 1, '上一版要留档');
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')).length, 0, '不该留临时文件');
});

test('损坏自愈：主文件坏了 → 从 .bak 救回来，并且坏文件留档', () => {
  const dir = tmp();
  const file = path.join(dir, 'x.json');
  writeJsonAtomic(file, { a: 1 });
  writeJsonAtomic(file, { a: 2 });       // .bak = {a:1}
  fs.writeFileSync(file, '{"a": 2');     // 模拟写到一半被杀
  const r = readJsonSafe(file, { a: 0 });
  assert.equal(r.recovered, true);
  assert.equal(r.source, 'bak');
  assert.equal(r.value.a, 1);
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('.corrupt-')), '坏文件要留档，别直接覆盖');
});

test('损坏自愈：文件不存在不是"恢复"，直接给兜底值', () => {
  const r = readJsonSafe(path.join(tmp(), 'nope.json'), { a: 9 });
  assert.equal(r.recovered, false);
  assert.equal(r.source, 'missing');
  assert.equal(r.value.a, 9);
});

test('OpsState：状态文件坏了也不会把当日配额清零（清 0 = 重复发视频）', () => {
  const dir = tmp();
  const file = path.join(dir, 'ops-state.json');
  const st = new OpsState({ file });
  st.data.counts = { scroll: 30, reply: 5, like: 4, publish: 2 };
  st.data.day = st.data.day || todayKey();   // 别写死日期：跨天会让 rollDay 把计数清零
  st.save();                       // 建立 .bak
  st.data.counts.publish = 3;
  st.save();                       // .bak 里是 publish=2 那份
  fs.writeFileSync(file, 'not json at all');
  const again = new OpsState({ file }).load();
  assert.equal(again.recovered, true);
  assert.equal(again.data.counts.publish, 2, '应该从 .bak 救回来，而不是变成 0');
});

test('看门狗：超时就抛，不无限等', async () => {
  const t0 = Date.now();
  await assert.rejects(
    () => withTimeout(new Promise((r) => setTimeout(r, 600)), 120, '慢动作'),
    /慢动作 超时/
  );
  assert.ok(Date.now() - t0 < 2000, '必须是 120ms 左右就返回');
});

test('看门狗：按时完成不误杀', async () => {
  const v = await withTimeout(Promise.resolve('ok'), 500, '快动作');
  assert.equal(v, 'ok');
});

test('crash guard：记一条进 crash.log，recentCrashes 能读出来', () => {
  const dir = tmp();
  const guard = installCrashGuard({ root: dir, tag: 'test' });
  guard.record(new Error('boom-1'), 'unit');
  const c = recentCrashes({ root: dir });
  assert.equal(c.exists, true);
  assert.equal(c.total, 1);
  assert.equal(c.recent, 1);
  assert.match(c.last[0], /boom-1/);
  assert.ok(fs.existsSync(guard.file));
});

test('crash guard：进程活着（没被 exit 掉）', () => {
  const dir = tmp();
  installCrashGuard({ root: dir, tag: 'test2' });
  assert.equal(typeof process.listenerCount, 'function');
  assert.ok(process.listenerCount('uncaughtException') >= 1, '必须挂上 uncaughtException');
  assert.ok(process.listenerCount('unhandledRejection') >= 1, '必须挂上 unhandledRejection');
});

test('bestEffort：出错也不往外抛', async () => {
  const hit = [];
  const r = await bestEffort(() => { throw new Error('x'); }, { onError: (e, l) => hit.push(l), label: 'step' });
  assert.equal(r.ok, false);
  assert.deepEqual(hit, ['step']);
});

test('上传服务：请求处理里抛异常 → 500，进程不倒', async () => {
  const s = new AssetServer({ dir: tmp(), port: 0, log: () => {} });
  const port = await s.start();
  try {
    s.handle = () => { throw new Error('handler 炸了'); };
    const res = await fetch(`http://127.0.0.1:${port}/list`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /handler 炸了/);
    // 服务还得继续可用
    const again = await fetch(`http://127.0.0.1:${port}/list`);
    assert.equal(again.status, 500, 'handle 还被替换着，但服务没死');
  } finally { await s.stop(); }
});

test('上传服务：端口被占用时自动换一个（以前直接起不来）', async () => {
  const first = new AssetServer({ dir: tmp(), port: 0, log: () => {} });
  const takenPort = await first.start();
  const second = new AssetServer({ dir: tmp(), port: takenPort, log: () => {} });
  try {
    const port2 = await second.startWithFallback(3);
    assert.notEqual(port2, takenPort, '应该换到别的端口');
    const res = await fetch(`http://127.0.0.1:${port2}/list`);
    assert.equal(res.status, 200);
  } finally {
    await second.stop();
    await first.stop();
  }
});
