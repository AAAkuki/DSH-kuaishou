import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderTemplateVideo, DEFAULT_BOX } from '../src/render-template.mjs';
import { EMOJI_PRESETS, listStickers, planSticker } from '../src/sticker.mjs';
import { resolveTools } from '../src/video.mjs';

const tools = resolveTools({});
const TMP = path.resolve('state', '_test');
fs.mkdirSync(TMP, { recursive: true });
const TPL = path.resolve('state/assets/template-talking-box.jpg');
const FONT = 'C:/Windows/Fonts/msyh.ttc';

test('表情预设齐全且有中文标签', () => {
  assert.ok(Object.keys(EMOJI_PRESETS).length >= 8);
  for (const [k, v] of Object.entries(EMOJI_PRESETS)) {
    assert.ok(v.emoji && v.label, `${k} 缺 emoji 或 label`);
  }
});

test('planSticker 把表情放在左侧空白区', () => {
  const p = planSticker({ width: 1080, height: 1920, slot: 'left' });
  assert.ok(p.cx < 1080 * 0.4, `左侧表情 cx 太靠右：${p.cx}`);
  assert.ok(p.size > 100 && p.size < 400);
});

test('listStickers 包含内置表情', () => {
  const list = listStickers({ root: process.cwd() });
  assert.ok(list.some((s) => s.kind === 'emoji' && s.emoji === '🐳'));
  assert.ok(list.some((s) => s.id.startsWith('emoji:') || s.kind === 'emoji'));
});

test('模板渲染：不贴表情也能出片', (t) => {
  if (!tools.ffmpeg || !fs.existsSync(TPL)) return t.skip('缺 ffmpeg 或模板');
  const out = path.join(TMP, `tpl-${Date.now()}.mp4`);
  try {
    const r = renderTemplateVideo(tools, {
      template: TPL, out, workDir: path.join(TMP, 'w1'), font: FONT,
      lines: ['第一句', '第二句']
    });
    assert.ok(fs.existsSync(out));
    assert.ok(r.durationSec > 2);
    assert.ok(r.box.textW > 100 && r.box.textH > 50);
  } finally {
    fs.rmSync(out, { force: true });
  }
});

test('模板渲染：贴表情后仍然成功，且表情在左侧', (t) => {
  if (!tools.ffmpeg || !fs.existsSync(TPL)) return t.skip('缺 ffmpeg 或模板');
  const out = path.join(TMP, `tpl-s-${Date.now()}.mp4`);
  try {
    const r = renderTemplateVideo(tools, {
      template: TPL, out, workDir: path.join(TMP, 'w2'), font: FONT,
      lines: ['测试'], stickerText: '🐳', stickerSize: 0.26, stickerColor: '0x2b4a7d'
    });
    assert.ok(fs.existsSync(out), '贴表情后应仍能出片');
    assert.ok(fs.statSync(out).size > 10000);
  } finally {
    fs.rmSync(out, { force: true });
  }
});

test('模板文件不存在时报可读错误', () => {
  assert.throws(
    () => renderTemplateVideo(tools, { template: 'D:/nope/x.jpg', out: path.join(TMP, 'x.mp4'), workDir: TMP, font: FONT, lines: ['a'] }),
    /模板不存在/
  );
});

test('DEFAULT_BOX 坐标都在 0~1 内', () => {
  for (const k of ['x0', 'y0', 'x1', 'y1']) {
    assert.ok(DEFAULT_BOX[k] >= 0 && DEFAULT_BOX[k] <= 1, `${k} 越界`);
  }
  assert.ok(DEFAULT_BOX.x1 > DEFAULT_BOX.x0);
  assert.ok(DEFAULT_BOX.y1 > DEFAULT_BOX.y0);
});
