import test from 'node:test';
import assert from 'node:assert/strict';
import { STICKER_POSITIONS, STICKER_SIZES, detectEmotion, pickSticker, scanStickerFiles, loadStickerEmotions } from '../src/sticker.mjs';
import { loadConfig } from '../src/config.mjs';

test('贴纸位置是看得懂的名字，不是坐标', () => {
  const keys = Object.keys(STICKER_POSITIONS);
  assert.ok(keys.includes('beside-box'));
  for (const k of keys) {
    const p = STICKER_POSITIONS[k];
    assert.ok(p.label && p.label.length > 1, `${k} 缺中文名`);
    assert.ok(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1, `${k} 坐标越界`);
  }
  assert.equal(STICKER_POSITIONS['beside-box'].label, '字幕框左边');
});

test('贴纸大小只有 小/中/大 三档', () => {
  assert.deepEqual(Object.keys(STICKER_SIZES), ['small', 'medium', 'large']);
  assert.equal(STICKER_SIZES.small.label, '小');
  assert.ok(STICKER_SIZES.small.scale < STICKER_SIZES.medium.scale);
});

test('情绪识别：开心/难过/疑惑/平淡', () => {
  assert.equal(detectEmotion('今天刷到好玩的，笑死我了'), 'happy');
  assert.equal(detectEmotion('这个结局有点遗憾，挺难受的'), 'sad');
  assert.equal(detectEmotion('为什么评论区都在吵'), 'thinking');
  assert.equal(detectEmotion('今天刷了 35 条视频'), 'calm');
});

test('多张贴纸时按情绪挑对应的那张', () => {
  const files = ['a/开心.png', 'a/难过.png', 'a/疑惑.png'];
  assert.match(pickSticker({ emotion: 'happy', files }).file, /开心/);
  assert.match(pickSticker({ emotion: 'sad', files }).file, /难过/);
  assert.match(pickSticker({ emotion: 'thinking', files }).file, /疑惑/);
});

test('没有对应情绪的贴纸时退回第一张，不报错', () => {
  const files = ['a/x1.png', 'a/x2.png'];
  const r = pickSticker({ emotion: 'happy', files });
  assert.equal(r.matched, false);
  assert.equal(r.file, 'a/x1.png');
});

test('配置默认：位置=字幕框左边、大小=中、情绪自动', () => {
  const cfg = loadConfig({});
  const a = cfg.video.audio;
  assert.equal(a.stickerPos, 'beside-box');
  assert.equal(a.stickerSizeName, 'medium');
  assert.equal(a.stickerAutoEmotion, true);
  assert.equal(a.stickerFile, '', '默认不指定单张，交给自动挑');
});

test('scanStickerFiles 只认图片、忽略说明文件（表情由用户提供，可以为空）', () => {
  const files = scanStickerFiles(process.cwd());
  assert.ok(Array.isArray(files));
  for (const f of files) {
    assert.match(f, /\.(png|jpe?g|webp|gif)$/i, `只应扫到图片：${f}`);
    assert.ok(!/README/i.test(f), '说明文件不该被当成贴纸');
  }
});

test('用户表情用 emotions.json 映射挑（微信默认文件名也能对上）', () => {
  const mapping = { 'a.jpg': 'happy', 'b.jpg': 'sad', 'c.jpg': 'thinking' };
  const files = ['x/a.jpg', 'x/b.jpg', 'x/c.jpg'];
  assert.equal(pickSticker({ emotion: 'happy', files, mapping }).file, 'x/a.jpg');
  assert.equal(pickSticker({ emotion: 'sad', files, mapping }).file, 'x/b.jpg');
  assert.equal(pickSticker({ emotion: 'thinking', files, mapping }).file, 'x/c.jpg');
});

test('情绪词典不重复：离谱只归生气', () => {
  assert.equal(detectEmotion('评论区真的太离谱了，有点气'), 'angry');
  assert.equal(detectEmotion('居然还有这种操作'), 'surprised');
});
