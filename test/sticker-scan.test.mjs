// 贴纸扫描的两条规矩：同名优先 PNG；白底没抠干净的直接跳过。
// 这两条都是用户反馈"表情包不透明"的直接原因。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanStickerFiles } from '../src/sticker.mjs';

function tmpStickers(files = [], matte = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-stk-'));
  const dir = path.join(root, 'state', 'assets', 'stickers');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'x');
  if (matte) fs.writeFileSync(path.join(dir, 'matte.json'), JSON.stringify(matte), 'utf8');
  return { root, dir };
}

test('同名 PNG 和 JPG 并存时只用 PNG（PNG 是抠好的，JPG 是白底原图）', () => {
  const { root } = tmpStickers(['a.png', 'a.jpg', 'b.jpg', 'c.webp']);
  const files = scanStickerFiles(root).map((f) => path.basename(f));
  assert.deepEqual(files.sort(), ['a.png', 'b.jpg', 'c.webp'].sort());
  assert.ok(!files.includes('a.jpg'), 'a.jpg 应被 a.png 顶掉');
});

test('matte.json 里透明区不足 10% 的贴纸直接跳过（否则画面上是个白方块）', () => {
  const { root } = tmpStickers(['good.png', 'bad.png'], { 'good.png': 0.35, 'bad.png': 0.02 });
  const files = scanStickerFiles(root).map((f) => path.basename(f));
  assert.deepEqual(files, ['good.png']);
});

test('没有 matte.json 时不过滤（向后兼容：用户刚拖进来的图还没测过）', () => {
  const { root } = tmpStickers(['x.png', 'y.png']);
  assert.equal(scanStickerFiles(root).length, 2);
});

test('matte.json 里没列出的新图也放行', () => {
  const { root } = tmpStickers(['old.png', 'new.png'], { 'old.png': 0.4 });
  const files = scanStickerFiles(root).map((f) => path.basename(f));
  assert.deepEqual(files.sort(), ['new.png', 'old.png']);
});

test('目录不存在时返回空数组，不抛', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-stk-empty-'));
  assert.deepEqual(scanStickerFiles(root), []);
});
