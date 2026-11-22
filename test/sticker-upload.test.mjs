import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AssetServer } from '../src/assets.mjs';

// 用户要求：贴纸由用户自己导入 → 上传接口必须能收图片并返回可用路径
test('上传贴纸图片后返回项目内路径', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-sticker-'));
  const s = new AssetServer({ dir, port: 0, log: () => {} });
  const port = await s.start();
  try {
    // 1x1 透明 PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const res = await fetch(`http://127.0.0.1:${port}/upload?name=my-sticker.png`, {
      method: 'POST', body: png, headers: { 'content-type': 'application/octet-stream' }
    });
    const body = await res.json();
    assert.equal(res.status, 200, `上传应成功：${JSON.stringify(body)}`);
    assert.equal(body.ok, true);
    assert.match(String(body.path), /\.png$/i, `返回路径应以 .png 结尾：${body.path}`);
    // 文件真的落盘了
    const abs = path.isAbsolute(body.path) ? body.path : path.resolve(process.cwd(), body.path);
    assert.ok(fs.existsSync(abs) || fs.readdirSync(dir).some((f) => f.endsWith('.png')), '图片应保存下来');
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('上传 .exe 仍被拒（贴纸只收图片）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-sticker-'));
  const s = new AssetServer({ dir, port: 0, log: () => {} });
  const port = await s.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/upload?name=bad.exe`, { method: 'POST', body: Buffer.from('x') });
    assert.equal(res.status, 415);
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
