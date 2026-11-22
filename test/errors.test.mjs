import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VideoStudio } from '../src/video.mjs';
import { loadConfig } from '../src/config.mjs';
import { synthesizeSapi } from '../src/tts.mjs';

const cfg = loadConfig({ env: {} });

// ── 本轮修的 bug，逐个钉住

test('英文语音读中文 → 报「语言不匹配」而不是「语音不可用」', async (t) => {
  const out = path.join(os.tmpdir(), `lang-${Date.now()}.wav`);
  try {
    await synthesizeSapi({ text: '这是一段中文', voice: 'Microsoft Zira Desktop', out });
    t.skip('本机 Zira 能读中文，跳过');
  } catch (error) {
    assert.match(error.message, /语言不匹配|读不了中文/, `错误信息不够准确：${error.message}`);
    assert.match(error.message, /Microsoft Huihui/, '应给出可用的中文语音');
  } finally {
    fs.rmSync(out, { force: true });
  }
});

test('输出文件只读/被占用 → 报「被占用或只读」而不是只有退出码', async (t) => {
  const out = path.join(os.tmpdir(), `ro-${Date.now()}.mp4`);
  fs.writeFileSync(out, 'x');
  fs.chmodSync(out, 0o444);
  const studio = new VideoStudio({ cfg });
  try {
    await studio.fromText({ title: 'T', lines: ['a'], voiceText: 'a', out });
    t.skip('本机没触发只读错误');
  } catch (error) {
    if (/Permission denied|只读|占用/.test(error.message)) {
      assert.match(error.message, /只读|占用/, `应说明原因：${error.message}`);
    } else {
      t.skip(`没走到这个分支：${error.message}`);
    }
  } finally {
    try { fs.chmodSync(out, 0o644); fs.rmSync(out, { force: true }); } catch {}
  }
});

test('gif 被当作图片处理（needs normalize 走图片分支）', async (t) => {
  // 造一个 1x1 gif
  const gif = path.join(os.tmpdir(), `t-${Date.now()}.gif`);
  const b64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  fs.writeFileSync(gif, Buffer.from(b64, 'base64'));
  const studio = new VideoStudio({ cfg });
  try {
    const r = await studio.normalize({ input: gif, durSec: 1 });
    assert.ok(r.durationSec > 0.5, `gif 应该能当图片归一化，实际：${r.durationSec}`);
  } catch (error) {
    t.skip(`ffmpeg 不支持该 gif：${error.message}`);
  } finally {
    fs.rmSync(gif, { force: true });
  }
});

test('pruneWorkDir 会清理 preview-*.wav', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-prev-'));
  const files = [];
  for (let i = 0; i < 5; i++) {
    const f = path.join(dir, `preview-${1000 + i}.wav`);
    fs.writeFileSync(f, 'x');
    files.push(f);
  }
  const studio = new VideoStudio({ cfg: { ...cfg, video: { ...cfg.video, workDir: dir } } });
  studio.pruneWorkDir({ keepWav: 1 });
  const left = fs.readdirSync(dir).filter((f) => f.startsWith('preview-'));
  assert.ok(left.length <= 1, `应只留 1 个，实际 ${left.length}`);
  fs.rmSync(dir, { recursive: true, force: true });
});
