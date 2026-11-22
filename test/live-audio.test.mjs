// 直播音频：游戏音效素材 + wav 时长读取（混音排期依赖它）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../src/config.mjs';
import { wavDuration } from '../src/live-voice.mjs';

test('游戏音效素材在（跳跃/落地/完美），且不是空文件', () => {
  for (const n of ['jump.wav', 'land.wav', 'perfect.wav']) {
    const p = path.join(projectRoot(), 'state', 'live', 'sfx', n);
    assert.ok(fs.existsSync(p), `缺 ${n}`);
    assert.ok(fs.statSync(p).size > 1000, `${n} 太小`);
  }
});

test('wavDuration 能读出真实时长（之前 ESM 里用 require 会静默返回 0）', () => {
  const p = path.join(projectRoot(), 'state', 'live', 'sfx', 'jump.wav');
  const d = wavDuration(p);
  assert.ok(d > 0.05 && d < 1.5, `时长不对：${d}`);
});

test('游戏注入口里有音频唤醒（直播时没人点页面，不唤醒就没声音）', () => {
  const html = fs.readFileSync(path.join(projectRoot(), 'state', 'live', 'jump-jump.html'), 'utf8');
  assert.match(html, /audio: function\(\)/);
  assert.match(html, /actx\.resume\(\)/);
  assert.match(html, /sound: function\(on\)/);
});
