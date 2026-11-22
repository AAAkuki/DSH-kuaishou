// 直播台（直播 overlay）的设计约束：简洁 + 跟游戏同一套配色
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../src/config.mjs';

const read = (name) => {
  const raw = fs.readFileSync(path.join(projectRoot(), 'state/live', name), 'utf8');
  return raw.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
};

test('直播台：四枚胶囊都在，且不铺弹幕墙', () => {
  const html = read('stage.html');
  assert.match(html, /id="live"/);
  assert.match(html, /id="clock"/);
  assert.match(html, /id="dm"/);
  assert.match(html, /id="bal"/);
  assert.doesNotMatch(html, /danmaku"|class="dm"/); // 不再有弹幕列表
});

test('直播台：配色跟游戏一致（米白底 + 白卡 + 深褐字），不许再出现深色主题', () => {
  const html = read('stage.html');
  assert.match(html, /#F2F0E9/i);            // 游戏本体底色
  assert.match(html, /rgba\(255,255,255,\.7/i); // 半透明白卡
  assert.match(html, /#2C2C2A/i);            // 游戏主文字色
  assert.doesNotMatch(html, /#0B0E14|放射光|vignette/i); // 旧的深色直播台残留
});

test('直播台和纯净版都要有：角色气泡 + 说话接口 + 等比缩放', () => {
  for (const name of ['stage.html', 'stage-bare.html']) {
    const html = read(name);
    assert.match(html, /pet-cutout\.png/, name);
    assert.match(html, /__pet/, name);
    assert.match(html, /__voice/, name);
    assert.match(html, /scale\(' \+ k \+ '\)/, name);
  }
});

test('游戏本体文件在，且被注入了驱动口', () => {
  const html = fs.readFileSync(path.join(projectRoot(), 'state/live/jump-jump.html'), 'utf8');
  assert.match(html, /window\.__jj/);
  assert.match(html, /read: function/);
});
