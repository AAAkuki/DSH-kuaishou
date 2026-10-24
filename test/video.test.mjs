import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseProbe, planSubtitles, toSrt, pickFont, escapeFontPath, resolveTools, VideoStudio, VideoError, backgroundKind, parseColor, BACKGROUND_PRESETS } from '../src/video.mjs';

test('parseProbe: 从 ffprobe JSON 抽关键字段', () => {
  const p = parseProbe({
    format: { duration: '17.4', size: '328532' },
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, r_frame_rate: '30/1' },
      { codec_type: 'audio', codec_name: 'aac' }
    ]
  });
  assert.equal(p.durationSec, 17.4);
  assert.equal(p.width, 1080);
  assert.equal(p.height, 1920);
  assert.equal(p.fps, 30);
  assert.equal(p.videoCodec, 'h264');
  assert.equal(p.audioCodec, 'aac');
  assert.equal(p.hasAudio, true);
});

test('parseProbe: 没有音轨时 hasAudio=false，时长回落到视频流', () => {
  const p = parseProbe({
    format: {},
    streams: [{ codec_type: 'video', codec_name: 'h264', width: 720, height: 1280, r_frame_rate: '25/1', duration: '5.5' }]
  });
  assert.equal(p.hasAudio, false);
  assert.equal(p.durationSec, 5.5);
  assert.equal(p.fps, 25);
});

test('planSubtitles: 按字数分配、首尾相接、不越界', () => {
  const items = planSubtitles(['短句', '这一句明显长很多很多字'], 10);
  assert.equal(items.length, 2);
  assert.ok(items[0].start === 0);
  assert.ok(items[0].end <= 10);
  assert.ok(items[1].start >= items[0].end, '第二句应在上句之后（含间隔）');
  assert.ok(items[1].end <= 10.001);
  assert.ok(items[1].end - items[1].start > items[0].end - items[0].start, '长句应占更久');
});

test('planSubtitles: 空输入与零时长返回空数组', () => {
  assert.deepEqual(planSubtitles([], 10), []);
  assert.deepEqual(planSubtitles(['x'], 0), []);
  assert.deepEqual(planSubtitles(['  ', ''], 10), []);
});

test('planSubtitles: 时长够时每句至少 minSec，不够时按比例压低而不是挤成 0 秒', () => {
  const wide = planSubtitles(['一', '二', '三'], 5, { minSec: 1.2, gapSec: 0 });
  for (const it of wide) assert.ok(it.end - it.start >= 1.2 - 1e-6);

  const tight = planSubtitles(['一', '二', '三'], 1.5, { minSec: 1.2, gapSec: 0 });
  for (const it of tight) assert.ok(it.end - it.start > 0.1, '再挤也不能是 0 秒');
  assert.ok(tight.at(-1).end <= 1.5 + 1e-6);
});

test('toSrt: 时间码格式与序号正确', () => {
  const srt = toSrt([{ text: '你好', start: 0, end: 1.5 }, { text: '世界', start: 1.6, end: 3.25 }]);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,500\n你好\n/);
  assert.match(srt, /2\n00:00:01,600 --> 00:00:03,250\n世界/);
});

test('pickFont: 能找到系统中文字体', () => {
  const f = pickFont();
  assert.ok(f && fs.existsSync(f), `没找到字体：${f}`);
});

test('escapeFontPath: 转义冒号与反斜杠（ffmpeg 路径要求）', () => {
  assert.equal(escapeFontPath('C:\\Windows\\Fonts\\msyh.ttc'), 'C\\:/Windows/Fonts/msyh.ttc');
});

test('resolveTools: 能解析出可用二进制', () => {
  const t = resolveTools({});
  assert.ok(t.ffmpeg && fs.existsSync(t.ffmpeg));
  assert.ok(t.ffprobe && fs.existsSync(t.ffprobe));
});

test('VideoStudio: 不可用时报可操作错误', async () => {
  const s = new VideoStudio({ cfg: { video: { ffmpegPath: 'C:\\nope\\ffmpeg.exe', ffprobePath: 'C:\\nope\\ffprobe.exe' } } });
  // resolveTools 会回落到 npm 内置二进制，所以这里能用的机器上 available 应为 true
  if (!s.available) {
    await assert.rejects(() => s.version(), /找不到 ffmpeg/);
  } else {
    assert.ok((await s.version()).includes('ffmpeg version'));
  }
});

test('VideoStudio.probe: 文件不存在时报错', async () => {
  const s = new VideoStudio({});
  await assert.rejects(() => s.probe(path.join('C:', 'nope', 'x.mp4')), /文件不存在/);
});

test('VideoStudio.tts: 空文本被拒', async () => {
  const s = new VideoStudio({});
  await assert.rejects(() => s.tts({ text: '   ' }), /需要 text/);
});

test('VideoError 保留 stderr 尾部', () => {
  const e = new VideoError('boom', { cmd: 'ffmpeg -i x', stderr: 'Invalid data found' });
  assert.equal(e.name, 'VideoError');
  assert.match(e.stderr, /Invalid data/);
});

test('resolveStyle: 参数 > 配置 > 默认值', () => {
  const s = new VideoStudio({ cfg: { video: { background: { color: '0x222222' }, typography: { fontSize: 60 }, audio: { voice: 'V-A' } } } });
  const merged = s.resolveStyle({ fontSize: 72, bgImage: 'D:/bg.png', bgDim: 0.5, voice: 'V-B' });
  assert.equal(merged.bg.color, '0x222222');
  assert.equal(merged.bg.image, 'D:/bg.png');
  assert.equal(merged.bg.dim, 0.5);
  assert.equal(merged.ty.fontSize, 72);
  assert.equal(merged.au.voice, 'V-B');
});

test('resolveStyle: 空值不覆盖（空字符串等于没传）', () => {
  const s = new VideoStudio({ cfg: { video: { audio: { voice: 'V-A' }, background: { color: '0x333333' } } } });
  const merged = s.resolveStyle({ voice: '', bgColor: '' });
  assert.equal(merged.au.voice, 'V-A');
  assert.equal(merged.bg.color, '0x333333');
});

test('resolveStyle: 嵌套 background/typography/audio 也能覆盖', () => {
  const s = new VideoStudio({ cfg: { video: {} } });
  const merged = s.resolveStyle({
    background: { color: '0xabcabc', fit: 'contain' },
    typography: { fontColor: 'yellow' },
    audio: { rate: 3, bgmGainDb: -30 }
  });
  assert.equal(merged.bg.color, '0xabcabc');
  assert.equal(merged.bg.fit, 'contain');
  assert.equal(merged.ty.fontColor, 'yellow');
  assert.equal(merged.au.rate, 3);
  assert.equal(merged.au.bgmGainDb, -30);
});

test('validateConfig: 越界的样式值被收敛而不是抛错', async () => {
  const { validateConfig } = await import('../src/config.mjs');
  const cfg = structuredClone((await import('../src/config.mjs')).DEFAULTS);
  cfg.video.typography.fontSize = 9999;
  cfg.video.background.dim = -5;
  cfg.video.audio.rate = 99;
  cfg.video.background.fit = 'weird';
  validateConfig(cfg);
  assert.equal(cfg.video.typography.fontSize, 200);
  assert.equal(cfg.video.background.dim, 0);
  assert.equal(cfg.video.audio.rate, 10);
  assert.equal(cfg.video.background.fit, 'cover');
});

test('backgroundKind: 视频 > 图片 > 渐变 > 纯色', () => {
  assert.equal(backgroundKind({ video: 'a.mp4', image: 'b.png' }), 'video');
  assert.equal(backgroundKind({ image: 'b.png' }), 'image');
  assert.equal(backgroundKind({ gradientFrom: '0x111111', gradientTo: '0x222222' }), 'gradient');
  assert.equal(backgroundKind({ color: '0x333333' }), 'color');
  assert.equal(backgroundKind({}), 'color');
});

test('parseColor: 0x / # / 裸十六进制都认，坏值返回 null', () => {
  assert.deepEqual(parseColor('0xFFE066'), { r: 255, g: 224, b: 102 });
  assert.deepEqual(parseColor('#0b1020'), { r: 11, g: 16, b: 32 });
  assert.deepEqual(parseColor('1b3a5c'), { r: 27, g: 58, b: 92 });
  assert.equal(parseColor('white'), null);
  assert.equal(parseColor(''), null);
});

test('BACKGROUND_PRESETS: 每个预设都是合法双色', () => {
  for (const [name, p] of Object.entries(BACKGROUND_PRESETS)) {
    assert.ok(parseColor(p.from), `${name}.from 非法`);
    assert.ok(parseColor(p.to), `${name}.to 非法`);
  }
});

test('resolveStyle: preset 展开成渐变端点', () => {
  const s = new VideoStudio({ cfg: { video: { background: { preset: 'whale-blue' } } } });
  const style = s.resolveStyle({});
  assert.equal(style.bg.gradientFrom, BACKGROUND_PRESETS['whale-blue'].from);
  assert.equal(style.bg.gradientTo, BACKGROUND_PRESETS['whale-blue'].to);
});

test('resolveStyle: 显式渐变端点覆盖预设', () => {
  const s = new VideoStudio({ cfg: { video: { background: { preset: 'whale-blue' } } } });
  const style = s.resolveStyle({ bgGradientFrom: '0x000000', bgGradientTo: '0xFFFFFF' });
  assert.equal(style.bg.gradientFrom, '0x000000');
  assert.equal(style.bg.gradientTo, '0xFFFFFF');
});

test('resolveStyle: 视频背景与模糊', () => {
  const s = new VideoStudio({ cfg: { video: {} } });
  const style = s.resolveStyle({ bgVideo: 'D:/bg.mp4', bgBlur: 12, bgDim: 0.5 });
  assert.equal(style.bg.video, 'D:/bg.mp4');
  assert.equal(style.bg.blur, 12);
  assert.equal(backgroundKind(style.bg), 'video');
});
