import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AssetServer, sanitizeName, isAllowedExt, assetKind, ASSET_EXT } from '../src/assets.mjs';

test('sanitizeName: 去掉路径穿越与分隔符（断言性质，不锁死下划线个数）', () => {
  for (const raw of ['../../etc/passwd', 'a/b\\c.mp3', 'C:\\Windows\\evil.mp3', '..\\..\\x.mp3']) {
    const out = sanitizeName(raw);
    assert.ok(!out.includes('/'), `不该有 /：${out}`);
    assert.ok(!out.includes('\\'), `不该有反斜杠：${out}`);
    assert.ok(!out.includes('..'), `不该有 ..：${out}`);
    assert.ok(out.length > 0);
    assert.equal(path.isAbsolute(out), false, '结果不能是绝对路径');
  }
  assert.equal(sanitizeName('a/b.mp3'), 'a_b.mp3');
  assert.ok(sanitizeName('').startsWith('upload-'));
  assert.ok(sanitizeName('   ').startsWith('upload-'));
  assert.ok(sanitizeName('x'.repeat(300)).length <= 120);
  assert.equal(sanitizeName('my-bgm.mp3'), 'my-bgm.mp3', '正常文件名不该被改');
});

test('isAllowedExt: 音频/图片/视频/字体放行，可执行文件拒绝', () => {
  for (const ext of ['.mp3', '.wav', '.png', '.jpg', '.mp4', '.mov', '.ttf', '.ttc']) {
    assert.equal(isAllowedExt(`a${ext}`), true, ext);
  }
  for (const ext of ['.exe', '.bat', '.js', '.ps1', '.dll', '']) {
    assert.equal(isAllowedExt(`a${ext}`), false, ext || '(无扩展名)');
  }
});

test('assetKind: 按扩展名归类', () => {
  assert.equal(assetKind('bgm.mp3'), 'audio');
  assert.equal(assetKind('bg.PNG'), 'image');
  assert.equal(assetKind('clip.MP4'), 'video');
  assert.equal(assetKind('font.ttc'), 'font');
  assert.equal(assetKind('x.exe'), '');
});

test('ASSET_EXT 四类都不为空', () => {
  for (const [kind, list] of Object.entries(ASSET_EXT)) {
    assert.ok(Array.isArray(list) && list.length > 0, `${kind} 空`);
  }
});

test('AssetServer: 上传→落盘→list，路径正确', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-assets-'));
  const s = new AssetServer({ dir, port: 0, log: () => {} });
  const port = await s.start();
  try {
    const payload = Buffer.from('audio-bytes-here');
    const res = await fetch(`http://127.0.0.1:${port}/upload?name=my-bgm.mp3`, { method: 'POST', body: payload });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.kind, 'audio');
    assert.equal(body.bytes, payload.length);
    assert.ok(fs.existsSync(body.path), '文件应真的写到磁盘');
    assert.equal(fs.readFileSync(body.path, 'utf8'), 'audio-bytes-here');

    const list = await fetch(`http://127.0.0.1:${port}/list`).then((r) => r.json());
    assert.equal(list.files.length, 1);
    assert.equal(list.files[0].name, 'my-bgm.mp3');
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AssetServer: 非法扩展名被拒（415），不落盘', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-assets-'));
  const s = new AssetServer({ dir, port: 0, log: () => {} });
  const port = await s.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/upload?name=evil.exe`, { method: 'POST', body: Buffer.from('x') });
    assert.equal(res.status, 415);
    assert.equal(fs.readdirSync(dir).length, 0);
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AssetServer: 超过大小上限被拒，临时文件被清掉', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-assets-'));
  const s = new AssetServer({ dir, port: 0, maxBytes: 16, log: () => {} });
  const port = await s.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/upload?name=big.mp3`, { method: 'POST', body: Buffer.alloc(64) }).catch((e) => ({ status: 0, json: async () => ({ error: e.message }) }));
    assert.notEqual(res.status, 200);
    const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith('.upload-'));
    assert.equal(leftovers.length, 0, '不应留下临时文件');
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AssetServer: 未知路由 404', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-assets-'));
  const s = new AssetServer({ dir, port: 0, log: () => {} });
  const port = await s.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(res.status, 404);
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
