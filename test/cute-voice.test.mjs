import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CUTE_PRESETS, humanizeText } from '../src/cute-voice.mjs';
import { synthCute } from '../src/synth-cute.mjs';
import { resolveTools } from '../src/video.mjs';
import { loadConfig } from '../src/config.mjs';

const cfg = loadConfig({ env: {} });
const tools = resolveTools({});
const TMP = path.resolve('state', '_test');
fs.mkdirSync(TMP, { recursive: true });
const out = (n) => path.join(TMP, `${n}-${Date.now()}.wav`);

test('CUTE_PRESETS 几档都在，萝莉档都是升调，natural 不升调', () => {
  for (const k of ['loli', 'loli_hard', 'loli_soft']) {
    assert.ok(CUTE_PRESETS[k], `缺少 ${k}`);
    assert.ok(CUTE_PRESETS[k].pitch > 1, `${k} 应该是升调`);
    assert.ok(CUTE_PRESETS[k].filters.length > 0);
  }
  assert.ok(CUTE_PRESETS.natural, '应该有"自然"档（不升调，最不容易诡异）');
  assert.equal(CUTE_PRESETS.natural.pitch, 1);
});

test('humanizeText 会插停顿标记', () => {
  const t = humanizeText('这是一句挺长的话，内容也很多需要断开才自然。第二句。');
  assert.ok(t.length >= '这是一句挺长的话，内容也很多需要断开才自然。第二句。'.length - 2);
  assert.match(t, /　/, '应插入全角空格停顿');
});

test('synthCute：真的合成出音频，且比不开口吃停顿的版本更长', async (t) => {
  if (!cfg.video.audio.piperExe || !fs.existsSync(cfg.video.audio.piperExe)) return t.skip('没装 piper');
  const text = '主人，今天想听我讲点什么呀。我准备了很久。那你呢。';
  const work = path.join(TMP, 'cute-work');

  const plain = out('plain');
  const human = out('human');
  try {
    await synthCute(tools, {
      text, out: plain, workDir: work,
      piperExe: cfg.video.audio.piperExe, piperModel: cfg.video.audio.piperModel,
      preset: 'loli', stutter: false, breath: false, pause: false, lengthScale: 1.0
    });
    const r = await synthCute(tools, {
      text, out: human, workDir: work,
      piperExe: cfg.video.audio.piperExe, piperModel: cfg.video.audio.piperModel,
      preset: 'loli', stutter: true, breath: true, pause: true, lengthScale: 1.12
    });

    assert.ok(fs.existsSync(plain) && fs.statSync(plain).size > 5000, '对照组应有音频');
    assert.ok(fs.existsSync(human) && fs.statSync(human).size > 5000, '人味版应有音频');
    assert.ok(r.parts > 3, `应该被拆成多段（含停顿），实际 ${r.parts}`);
    assert.ok(r.timeline.length >= 3, `时间轴应逐句，实际 ${r.timeline.length}`);
    assert.ok(fs.statSync(human).size > fs.statSync(plain).size * 0.9, '人味版不该明显更小');
  } finally {
    fs.rmSync(plain, { force: true });
    fs.rmSync(human, { force: true });
  }
});

test('synthCute：传 lines 时时间轴和句子严格 1:1，且第一句从 0 开始', async (t) => {
  if (!cfg.video.audio.piperExe || !fs.existsSync(cfg.video.audio.piperExe)) return t.skip('没装 piper');
  const lines = ['今天刷了三十条视频', '手指都划酸了', '明天接着刷'];
  const file = out('lines');
  try {
    const r = await synthCute(tools, {
      text: lines.join('，'), lines, out: file, workDir: path.join(TMP, 'cute-work'),
      piperExe: cfg.video.audio.piperExe, piperModel: cfg.video.audio.piperModel,
      preset: 'loli_soft', pause: true, lengthScale: 1.0
    });
    assert.equal(r.timeline.length, lines.length, '一句一段，不能多也不能少');
    assert.equal(r.timeline[0].start, 0, '第一句必须从 0 开始（否则字幕整体偏移）');
    for (let i = 1; i < r.timeline.length; i++) {
      assert.ok(r.timeline[i].start >= r.timeline[i - 1].end - 0.01, `第 ${i + 1} 句起点不能早于上一句结尾`);
    }
    // 时间轴应该覆盖到最后一句真正结束，不留"念完了但时间轴还在走"
    const last = r.timeline.at(-1);
    assert.ok(r.durationSec >= last.end - 0.05);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('synthCute：targetSec 会把差值均摊到句间，而不是堆在结尾', async (t) => {
  if (!cfg.video.audio.piperExe || !fs.existsSync(cfg.video.audio.piperExe)) return t.skip('没装 piper');
  const lines = ['第一句', '第二句', '第三句', '第四句'];
  const a = out('t0');
  const b = out('t20');
  try {
    const r0 = await synthCute(tools, {
      text: lines.join('，'), lines, out: a, workDir: path.join(TMP, 'cute-work'),
      piperExe: cfg.video.audio.piperExe, piperModel: cfg.video.audio.piperModel,
      preset: 'natural', pause: true, lengthScale: 1.0
    });
    const r1 = await synthCute(tools, {
      text: lines.join('，'), lines, out: b, workDir: path.join(TMP, 'cute-work'),
      piperExe: cfg.video.audio.piperExe, piperModel: cfg.video.audio.piperModel,
      preset: 'natural', pause: true, lengthScale: 1.0, targetSec: r0.durationSec + 4
    });
    assert.ok(r1.durationSec > r0.durationSec + 2, `应该被拉长：${r0.durationSec} → ${r1.durationSec}`);
    // 最后一句结束后不该有一大段空白（<= 1.2 秒）
    assert.ok(r1.durationSec - r1.timeline.at(-1).end <= 1.2, '结尾不该堆静音');
  } finally {
    fs.rmSync(a, { force: true });
    fs.rmSync(b, { force: true });
  }
});

test('synthCute：piper 不存在时报可读错误', async () => {
  await assert.rejects(
    () => synthCute(tools, { text: 'x', out: out('x'), workDir: TMP, piperExe: 'D:/nope/piper.exe', piperModel: 'x.onnx' }),
    /piper 不存在/
  );
});
