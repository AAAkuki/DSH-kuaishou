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

// 这些是"学习参考视频"后加的装饰，必须有对应渲染步骤
test('参考视频装饰：栏目名 / AI标识 / 名字标签 / 打字光标 都能渲染', (t) => {
  if (!tools.ffmpeg || !fs.existsSync(TPL)) return t.skip('缺 ffmpeg 或模板');
  const out = path.join(TMP, `decor-${Date.now()}.mp4`);
  try {
    const r = renderTemplateVideo(tools, {
      template: TPL, out, workDir: path.join(TMP, 'decor'), font: FONT,
      lines: ['人类给我发了三条视频', '我学到了四个细节'],
      titleBar: '大肥鱼的生活日记',
      aiBadge: '大肥鱼 (AI) 生成内容',
      speakerName: '大肥鱼',
      typing: true
    });
    assert.ok(fs.existsSync(out), '应出片');
    assert.ok(r.durationSec > 2);
    assert.deepEqual(r.decorations, {
      titleBar: '大肥鱼的生活日记',
      aiBadge: '大肥鱼 (AI) 生成内容',
      speakerName: '大肥鱼',
      typing: true
    });
  } finally {
    fs.rmSync(out, { force: true });
  }
});

test('不传装饰时也能正常出片（向后兼容）', (t) => {
  if (!tools.ffmpeg || !fs.existsSync(TPL)) return t.skip('缺 ffmpeg 或模板');
  const out = path.join(TMP, `plain-${Date.now()}.mp4`);
  try {
    const r = renderTemplateVideo(tools, {
      template: TPL, out, workDir: path.join(TMP, 'plain'), font: FONT, lines: ['只有一句话']
    });
    assert.ok(fs.existsSync(out));
    assert.equal(r.durationSec > 0, true);
  } finally {
    fs.rmSync(out, { force: true });
  }
});

test('typing=false 时不应出现光标文本文件', (t) => {
  if (!tools.ffmpeg || !fs.existsSync(TPL)) return t.skip('缺 ffmpeg 或模板');
  const workDir = path.join(TMP, 'nocaret');
  const out = path.join(TMP, `nocaret-${Date.now()}.mp4`);
  try {
    renderTemplateVideo(tools, {
      template: TPL, out, workDir, font: FONT, lines: ['测试'], typing: false, speakerName: '大肥鱼'
    });
    const runs = fs.existsSync(workDir) ? fs.readdirSync(workDir) : [];
    // workDir 下每次一个 run-* 子目录
    const found = runs.some((d) => {
      const p = path.join(workDir, d);
      return fs.statSync(p).isDirectory() && fs.readdirSync(p).some((f) => f.includes('caret'));
    });
    assert.equal(found, false, 'typing=false 不该写 caret 文件');
  } finally {
    fs.rmSync(out, { force: true });
  }
});
