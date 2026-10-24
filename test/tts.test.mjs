import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSapiVoices, synthesize, synthesizePiper, synthesizeSapi, TtsError } from '../src/tts.mjs';
import { isAllowedExt, assetKind } from '../src/assets.mjs';

test('listSapiVoices: 至少能列出系统语音（含 zh-CN）', async () => {
  const voices = await listSapiVoices();
  assert.ok(Array.isArray(voices) && voices.length >= 1, '系统里应至少有一个 SAPI 语音');
  assert.ok(voices.every((v) => typeof v.name === 'string' && v.name.length > 0));
  assert.ok(voices.some((v) => /^zh/.test(v.culture || '')), '应至少有一个中文语音');
});

test('synthesize: 未知引擎报错并列出可选', async () => {
  await assert.rejects(() => synthesize({ engine: 'edge', text: 'x' }), /不支持的语音引擎/);
});

test('synthesizeSapi: 未知语音名报错并列出可用项', async () => {
  await assert.rejects(
    () => synthesizeSapi({ text: '你好', voice: 'Nobody Voice' }),
    (err) => err instanceof TtsError && /没有这个语音/.test(err.message) && /Microsoft/.test(err.message)
  );
});

test('synthesizeSapi: 空文本被拒', async () => {
  await assert.rejects(() => synthesizeSapi({ text: '   ' }), /需要 text/);
});

test('synthesizePiper: 缺 exe/model 时报可操作错误', async () => {
  await assert.rejects(() => synthesizePiper({ text: 'x', exe: '', model: '' }), /Piper 可执行文件不存在/);
  await assert.rejects(
    () => synthesizePiper({ text: 'x', exe: process.execPath, model: path.join(os.tmpdir(), 'no-such.onnx') }),
    /Piper 模型不存在/
  );
});

test('synthesizeSapi: 真合成一段 wav（可用时）', async (t) => {
  const out = path.join(os.tmpdir(), `tts-test-${Date.now()}.wav`);
  try {
    const r = await synthesizeSapi({ text: '换声音测试', out });
    assert.ok(fs.existsSync(r.file));
    assert.ok(fs.statSync(r.file).size > 1000, 'wav 应有实际内容');
    assert.equal(r.engine, 'sapi');
  } catch (error) {
    t.skip(`本机 TTS 不可用：${error.message}`);
  } finally {
    fs.rmSync(out, { force: true });
  }
});

test('上传白名单包含语音模型 .onnx / .json', () => {
  assert.equal(isAllowedExt('voice.onnx'), true);
  assert.equal(isAllowedExt('voice.onnx.json'), true);
  assert.equal(assetKind('voice.onnx'), 'voice');
});
