import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderTemplateVideo } from '../src/render-template.mjs';
import { resolveTools } from '../src/video.mjs';

const tools = resolveTools({});
const TMP = path.resolve('state', '_test');
fs.mkdirSync(TMP, { recursive: true });
const TPL = path.resolve('state/assets/template-talking-box.jpg');
const FONT = 'C:/Windows/Fonts/msyh.ttc';

const stickers = fs.existsSync('state/assets/stickers')
  ? fs.readdirSync('state/assets/stickers').filter((f) => /\.png$/i.test(f)).slice(0, 3)
      .map((f) => path.resolve('state/assets/stickers', f))
  : [];

test('中途换表情：多段 stickerPlan 会按时间段叠加', (t) => {
  if (!tools.ffmpeg || !fs.existsSync(TPL) || stickers.length < 2) return t.skip('缺素材');
  const out = path.join(TMP, `plan-${Date.now()}.mp4`);
  try {
    const r = renderTemplateVideo(tools, {
      template: TPL, out, workDir: path.join(TMP, 'plan'), font: FONT,
      lines: ['第一句', '第二句'],
      timings: [{ text: '第一句', start: 0, end: 2 }, { text: '第二句', start: 2, end: 4 }],
      stickerPlan: [
        { file: stickers[0], start: 0, end: 2 },
        { file: stickers[1], start: 2, end: 4 }
      ],
      typing: false
    });
    assert.ok(fs.existsSync(out), '应出片');
    assert.equal(r.plan.length, 2, `应有 2 段表情，实际 ${r.plan.length}`);
    assert.equal(r.plan[0].start, 0);
    assert.equal(r.plan[1].start, 2);
  } finally {
    fs.rmSync(out, { force: true });
  }
});

test('单张贴纸（没有 plan）仍然正常', (t) => {
  if (!tools.ffmpeg || !fs.existsSync(TPL) || !stickers.length) return t.skip('缺素材');
  const out = path.join(TMP, `one-${Date.now()}.mp4`);
  try {
    const r = renderTemplateVideo(tools, {
      template: TPL, out, workDir: path.join(TMP, 'one'), font: FONT,
      lines: ['单张'], stickerFile: stickers[0], typing: false
    });
    assert.ok(fs.existsSync(out));
    assert.equal(r.plan.length, 1);
    assert.equal(r.plan[0].start, 0, '单张从 0 开始铺到结尾');
  } finally {
    fs.rmSync(out, { force: true });
  }
});
