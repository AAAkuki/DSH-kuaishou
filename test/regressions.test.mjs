// 回归：这一轮审计修掉的 bug，逐个钉住，防止改回去
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Adb } from '../src/adb.mjs';
import { Kuaishou } from '../src/ks.mjs';
import { VideoStudio, backgroundKind, BACKGROUND_PRESETS } from '../src/video.mjs';
import { AdbBackend, WebBackend } from '../src/driver.mjs';
import { freshConfig } from './helpers.mjs';
import { COMMENT_XML, makeExecImpl } from './fixtures.mjs';

function makeKs() {
  const { execImpl } = makeExecImpl({ xml: () => COMMENT_XML });
  const adb = new Adb({ adbPath: 'adb', execImpl });
  return new Kuaishou({ adb, cfg: freshConfig(), sleep: async () => {}, random: () => 0.5 });
}

// BUG 1：preset 抢掉显式背景
test('背景优先级：显式 bgColor 不被 preset 覆盖', () => {
  const s = new VideoStudio({ cfg: { video: { background: { preset: '' } } } });
  const st = s.resolveStyle({ bgPreset: 'whale-blue', bgColor: '0x112233' });
  assert.equal(backgroundKind(st.bg), 'color');
  assert.equal(st.bg.color, '0x112233');
});

test('背景优先级：只给 preset 时仍走渐变', () => {
  const s = new VideoStudio({ cfg: { video: {} } });
  const st = s.resolveStyle({ bgPreset: 'whale-blue' });
  assert.equal(backgroundKind(st.bg), 'gradient');
  assert.equal(st.bg.gradientFrom, BACKGROUND_PRESETS['whale-blue'].from);
});

test('背景优先级：cfg 里的 preset 也不该压过显式 bgColor', () => {
  const s = new VideoStudio({ cfg: { video: { background: { preset: 'deep-sea' } } } });
  const st = s.resolveStyle({ bgColor: '0x445566' });
  assert.equal(backgroundKind(st.bg), 'color');
});

test('背景优先级：显式 bgImage / bgVideo 同样压过 preset', () => {
  const s = new VideoStudio({ cfg: { video: {} } });
  assert.equal(backgroundKind(s.resolveStyle({ bgPreset: 'mint', bgImage: 'a.png' }).bg), 'image');
  assert.equal(backgroundKind(s.resolveStyle({ bgPreset: 'mint', bgVideo: 'a.mp4' }).bg), 'video');
});

// BUG 2：回评论重复开合面板
test('replyToComment(openPanel:false) 不再打开评论面板', async () => {
  const ks = makeKs();
  let opened = 0;
  const originOpen = ks.openComments.bind(ks);
  ks.openComments = async () => { opened++; return originOpen(); };
  const r = await ks.replyToComment({ match: '这个怎么做的', content: '我也在试', openPanel: false });
  assert.equal(opened, 0, 'openPanel=false 时不该调 openComments');
  assert.equal(r.matched, '这个怎么做的？');
});

test('replyToComment(默认) 仍然自己开面板', async () => {
  const ks = makeKs();
  let opened = 0;
  const originOpen = ks.openComments.bind(ks);
  ks.openComments = async () => { opened++; return originOpen(); };
  await ks.replyToComment({ match: '这个怎么做的', content: '我也在试' });
  assert.equal(opened, 1);
});

// BUG 3：driver 丢 openPanel / 网页版 pushOnly 静默发布
test('AdbBackend.reply 透传 openPanel', async () => {
  const cfg = freshConfig();
  const b = new AdbBackend({ cfg, log: () => {} });
  const seen = [];
  b.ks = { replyToComment: async (args) => { seen.push(args); return {}; } };
  await b.reply({ match: 'x', content: 'y', openPanel: false });
  assert.deepEqual(seen[0], { match: 'x', content: 'y', openPanel: false });
});

test('WebBackend.reply 透传 openPanel', async () => {
  const cfg = freshConfig();
  const b = new WebBackend({ cfg, log: () => {} });
  const seen = [];
  b.web = { replyToComment: async (args) => { seen.push(args); return {}; } };
  await b.reply({ match: 'x', content: 'y', openPanel: false });
  assert.equal(seen[0].openPanel, false);
});

test('WebBackend.publish(pushOnly) 必须明确拒绝，而不是照发', async () => {
  const cfg = freshConfig();
  const b = new WebBackend({ cfg, log: () => {} });
  b.web = { publishVideo: async () => ({ published: true }) };
  await assert.rejects(() => b.publish({ file: 'x.mp4', pushOnly: true }), /pushOnly 不支持/);
});

// BUG 6：临时 textfile 清理
test('flushTemps 会删掉登记的临时文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-tmp-'));
  const a = path.join(dir, 'line-1-0.txt');
  const b = path.join(dir, 'title-1-abc.txt');
  fs.writeFileSync(a, 'x');
  fs.writeFileSync(b, 'y');
  const s = new VideoStudio({ cfg: { video: {} } });
  s._tmpFiles.push(a, b);
  s.flushTemps();
  assert.equal(fs.existsSync(a), false);
  assert.equal(fs.existsSync(b), false);
  assert.deepEqual(s._tmpFiles, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('workDir 首次调用会清扫历史遗留的 line/title txt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-sweep-'));
  fs.writeFileSync(path.join(dir, 'line-123-0.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'title-123-abc.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'keep.mp4'), 'x');
  const s = new VideoStudio({ cfg: { video: { workDir: dir } } });
  const out = s.workDir();
  assert.equal(path.resolve(out), path.resolve(dir));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['keep.mp4']);
  fs.rmSync(dir, { recursive: true, force: true });
});
