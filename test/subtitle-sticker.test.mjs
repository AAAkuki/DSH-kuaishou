import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderTemplateVideo } from '../src/render-template.mjs';
import { resolveTools } from '../src/video.mjs';
import { loadConfig } from '../src/config.mjs';

const tools = resolveTools({});
const TMP = path.resolve('state', '_test');
fs.mkdirSync(TMP, { recursive: true });
const TPL = path.resolve('state/assets/template-talking-box.jpg');
const FONT = 'C:/Windows/Fonts/msyh.ttc';
const STICKER = path.resolve('state/assets/stickers/whale.png');

// 用户反馈「字幕有问题」的真因：语音句数 ≠ 字幕句数时，第 1 句占满全片
test('字幕：timings 条数少于 lines 时按字数铺满，不能一句占满全片', (t) => {
  if (!tools.ffmpeg || !fs.existsSync(TPL)) return t.skip('缺 ffmpeg 或模板');
  const out = path.join(TMP, `spans-${Date.now()}.mp4`);
  try {
    const r = renderTemplateVideo(tools, {
      template: TPL, out, workDir: path.join(TMP, 'spans'), font: FONT,
      lines: ['第一句话测试字幕', '第二句也要对上', '第三句收尾'],
      // 语音只有 1 段（voiceText 只有一个句号）
      timings: [{ text: '第一句话测试字幕第二句也要对上第三句收尾', start: 0, end: 6 }],
      typing: false
    });
    assert.equal(r.spans.length, 3, '每句字幕都要有时间段');
    // 第一句不能占满全片
    assert.ok(r.spans[0].end < 6, `第一句结束时间 ${r.spans[0].end} 不该等于总时长`);
    // 依次递增、无重叠
    for (let i = 1; i < r.spans.length; i++) {
      assert.ok(r.spans[i].start >= r.spans[i - 1].end - 0.05, `第 ${i} 句起点不能早于上一句终点`);
    }
    // 最后一句结束应接近总时长
    assert.ok(Math.abs(r.spans.at(-1).end - 6) < 0.3, `最后一句应铺到结尾：${r.spans.at(-1).end}`);
  } finally {
    fs.rmSync(out, { force: true });
  }
});

test('字幕：timings 条数与 lines 一致时用真实时间', (t) => {
  if (!tools.ffmpeg || !fs.existsSync(TPL)) return t.skip('缺 ffmpeg 或模板');
  const out = path.join(TMP, `spans2-${Date.now()}.mp4`);
  try {
    const timings = [
      { text: 'a', start: 0, end: 2 },
      { text: 'b', start: 2.5, end: 5 }
    ];
    const r = renderTemplateVideo(tools, {
      template: TPL, out, workDir: path.join(TMP, 'spans2'), font: FONT,
      lines: ['第一句', '第二句'], timings, typing: false
    });
    // 0.5s 的句间空档会被填平（避免字幕闪没），所以第一句延到 2.5
    assert.deepEqual(r.spans, [{ start: 0, end: 2.5 }, { start: 2.5, end: 5 }]);
  } finally {
    fs.rmSync(out, { force: true });
  }
});

test('贴纸：自定义图片按给定位置与大小叠加', (t) => {
  if (!tools.ffmpeg || !fs.existsSync(TPL) || !fs.existsSync(STICKER)) return t.skip('缺素材');
  const out = path.join(TMP, `stk-${Date.now()}.mp4`);
  try {
    const r = renderTemplateVideo(tools, {
      template: TPL, out, workDir: path.join(TMP, 'stk'), font: FONT,
      lines: ['贴纸测试'],
      stickerFile: STICKER, stickerX: 0.25, stickerY: 0.30, stickerScale: 0.28,
      typing: false
    });
    assert.ok(fs.existsSync(out));
    assert.ok(r.sticker, '应返回贴纸几何信息');
    assert.equal(r.sticker.w, Math.round(1080 * 0.28));
    assert.ok(Math.abs(r.sticker.cx - 270) <= 2, `贴纸 X 应为 270，实际 ${r.sticker.cx}`);
    assert.ok(Math.abs(r.sticker.cy - 576) <= 2, `贴纸 Y 应为 576，实际 ${r.sticker.cy}`);
  } finally {
    fs.rmSync(out, { force: true });
  }
});

test('默认配置：左右上角文字默认关闭（用户要求）', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.video.titleBar, '', '栏目名默认应为空');
  assert.equal(cfg.video.aiBadge, '', 'AI 标识默认应为空');
});

test('字幕：小于 1.5 秒的句间空档被填平，长空档保留', (t) => {
  if (!tools.ffmpeg || !fs.existsSync(TPL)) return t.skip('缺 ffmpeg 或模板');
  const out = path.join(TMP, `gap-${Date.now()}.mp4`);
  try {
    const timings = [
      { text: 'a', start: 0, end: 2 },
      { text: 'b', start: 2.4, end: 3.5 },   // 0.4s 空档 → 填平
      { text: 'c', start: 6, end: 7.5 }      // 2.5s 空档 → 保留
    ];
    const r = renderTemplateVideo(tools, {
      template: TPL, out, workDir: path.join(TMP, 'gap'), font: FONT,
      lines: ['第一句', '第二句', '第三句'], timings, typing: false
    });
    assert.equal(r.spans[0].end, 2.4, '短空档应填平');
    assert.equal(r.spans[1].end, 3.5, '第二句保持原结束');
  } finally {
    fs.rmSync(out, { force: true });
  }
});
