import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AssetServer } from '../src/assets.mjs';
import { loadConfig } from '../src/config.mjs';
import { VideoStudio } from '../src/video.mjs';

const cfg = loadConfig({ env: {} });

async function withServer(fn, { withVoice = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-voice-'));
  const studio = new VideoStudio({ cfg });
  const s = new AssetServer({
    dir,
    port: 0,
    log: () => {},
    voiceProvider: withVoice ? async () => studio.voices() : null,
    ttsProvider: withVoice
      ? async (o) => studio.tts({ ...o, out: path.join(os.tmpdir(), `prev-${Date.now()}.wav`) })
      : null
  });
  const port = await s.start();
  try {
    return await fn(port, studio);
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('/voices 返回系统语音列表与引擎状态', async () => {
  await withServer(async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/voices`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.ok(Array.isArray(j.sapi) && j.sapi.length >= 1, '至少要有一个语音');
    assert.ok(j.sapi.every((v) => typeof v.name === 'string' && v.name.length > 0));
    assert.ok(['sapi', 'piper'].includes(j.engine));
    assert.equal(typeof j.piper?.ready, 'boolean');
  });
});

test('/voices 未启用时 503（而不是 404 或崩）', async () => {
  await withServer(async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/voices`);
    assert.equal(r.status, 503);
  }, { withVoice: false });
});

test('/tts-preview 返回真 wav（audio/wav + 有体积）', async () => {
  await withServer(async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/tts-preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '换声音试听', engine: 'sapi' })
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /audio\/wav/);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.ok(buf.length > 5000, `wav 太小：${buf.length}`);
    // RIFF 头
    assert.equal(buf.slice(0, 4).toString(), 'RIFF');
    assert.equal(buf.slice(8, 12).toString(), 'WAVE');
  });
});

test('/tts-preview 未知语音名返回 500 且带可读原因', async () => {
  await withServer(async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/tts-preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x', engine: 'sapi', voice: 'Nobody Voice' })
    });
    assert.equal(r.status, 500);
    const j = await r.json();
    assert.match(j.error, /没有这个语音/);
  });
});

test('/tts-preview 请求体非法 JSON 不崩', async () => {
  await withServer(async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/tts-preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json'
    });
    assert.equal(r.status, 500);
    const j = await r.json();
    assert.equal(j.ok, false);
  });
});
