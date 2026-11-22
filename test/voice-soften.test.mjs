import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { softenAudio, SOFT_PRESETS } from '../src/voice-soften.mjs';
const require = createRequire(import.meta.url);
const { spawnSync } = require('node:child_process');
import { resolveTools, VideoStudio } from '../src/video.mjs';
import { loadConfig } from '../src/config.mjs';

const tools = resolveTools({});
const canFfmpeg = Boolean(tools.ffmpeg && fs.existsSync(tools.ffmpeg));
// 注意：这台机器上 ffmpeg 写系统 %TEMP% 会被拦（Permission denied），测试统一用项目内目录
const TMP = path.resolve('state', '_test');
fs.mkdirSync(TMP, { recursive: true });
const tmpFile = (name) => path.join(TMP, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`);

/** 直接写一个 1 秒 440Hz 的 16bit 单声道 WAV，不依赖 ffmpeg。 */
function makeWav() {
  const out = tmpFile('tone');
  const rate = 22050;
  const n = rate; // 1 秒
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000);
    data.writeInt16LE(v, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);           // PCM
  header.writeUInt16LE(1, 22);           // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(out, Buffer.concat([header, data]));
  return out;
}

test('SOFT_PRESETS 含五个档位', () => {
  for (const k of ['none', 'clean', 'soft', 'softer', 'mellow']) {
    assert.ok(SOFT_PRESETS[k], `缺少 ${k}`);
    assert.ok(typeof SOFT_PRESETS[k].label === 'string');
  }
});

test('none 档位原样复制（不改内容）', (t) => {
  if (!canFfmpeg) return t.skip('没有 ffmpeg');
  const input = makeWav();
  const out = tmpFile('copy');
  try {
    softenAudio(tools, { input, out, preset: 'none' });
    assert.ok(fs.existsSync(out));
    assert.ok(fs.statSync(out).size > 1000);
  } finally {
    fs.rmSync(input, { force: true });
    fs.rmSync(out, { force: true });
  }
});

test('soft/softer/mellow 都能处理出有效音频，且时长基本不变', (t) => {
  if (!canFfmpeg) return t.skip('没有 ffmpeg');
  const input = makeWav();
  try {
    for (const preset of ['soft', 'softer', 'mellow']) {
      const out = tmpFile(preset);
      const r = softenAudio(tools, { input, out, preset });
      assert.ok(fs.existsSync(out), `${preset} 没有产出`);
      assert.ok(fs.statSync(out).size > 1000, `${preset} 输出太小`);
      assert.ok(r.pitch < 1, `${preset} 应该降调：${r.pitch}`);
      assert.ok(r.filters.length > 0, `${preset} 应有滤镜链`);
      fs.rmSync(out, { force: true });
    }
  } finally {
    fs.rmSync(input, { force: true });
  }
});

test('未知 preset 回落到 soft（不崩）', (t) => {
  if (!canFfmpeg) return t.skip('没有 ffmpeg');
  const input = makeWav();
  const out = tmpFile('fallback');
  try {
    const r = softenAudio(tools, { input, out, preset: 'nonsense' });
    assert.equal(r.preset, 'soft');
    assert.ok(fs.existsSync(out));
  } finally {
    fs.rmSync(input, { force: true });
    fs.rmSync(out, { force: true });
  }
});

test('配置里的 soften 会被 tts 用上（softenPreset 回填）', async (t) => {
  const cfg = loadConfig({ env: {} });
  cfg.video.audio.soften = 'soft';
  const studio = new VideoStudio({ cfg });
  const out = tmpFile('tts-soft');
  try {
    const r = await studio.tts({ text: '试一下柔化', out });
    assert.equal(r.softenPreset, 'soft', `应标记柔化档位，实际 ${r.softenPreset}`);
  } catch (error) {
    t.skip(`本机 TTS 不可用：${error.message}`);
  } finally {
    fs.rmSync(out, { force: true });
    for (const f of fs.readdirSync(TMP)) {
      if (f.startsWith('tts-soft-')) fs.rmSync(path.join(TMP, f), { force: true });
    }
  }
});
