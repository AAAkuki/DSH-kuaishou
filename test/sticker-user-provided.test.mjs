import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderTemplateVideo } from '../src/render-template.mjs';
import { resolveTools } from '../src/video.mjs';
import { scanStickerFiles, pickSticker } from '../src/sticker.mjs';

const tools = resolveTools({});
const TMP = path.resolve('state', '_test');
fs.mkdirSync(TMP, { recursive: true });
const TPL = path.resolve('state/assets/template-talking-box.jpg');

test('表情由用户提供：目录为空时 scanStickerFiles 返回空数组', () => {
  const files = scanStickerFiles(process.cwd());
  assert.ok(Array.isArray(files), '必须返回数组');
  // 允许用户已经放了自己的：只要有文件就必须是图片
  for (const f of files) assert.match(f, /\.(png|jpe?g|webp|gif)$/i, '只认图片');
});

test('没有表情时 pickSticker 不报错、返回空文件', () => {
  const r = pickSticker({ emotion: 'happy', files: [] });
  assert.equal(r.file, '');
  assert.equal(r.matched, false);
});

test('没有贴纸也能正常出片（不崩）', (t) => {
  if (!tools.ffmpeg || !fs.existsSync(TPL)) return t.skip('缺 ffmpeg 或模板');
  const out = path.join(TMP, `nostk-${Date.now()}.mp4`);
  try {
    const r = renderTemplateVideo(tools, {
      template: TPL, out, workDir: path.join(TMP, 'nostk'), font: 'C:/Windows/Fonts/msyh.ttc',
      lines: ['没有贴纸也能出片'], stickerFile: '', typing: false
    });
    assert.ok(fs.existsSync(out));
    assert.equal(r.sticker, null, '没贴纸时 sticker 应为 null');
  } finally {
    fs.rmSync(out, { force: true });
  }
});
