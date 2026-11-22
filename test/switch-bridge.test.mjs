// 开关"到不到得了运行时"：每个布尔 schema 键都必须能被 toSettingsJson 写出去，
// 并且 applySettingsOverrides 真的改到 cfg 上。
// 用户反馈"插件的开关一点用都没有"——这一层就是开关与运行时之间的桥。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { toSettingsJson } from '../plugins/dsh-plugin-kuaishou/index.js';
import { applySettingsOverrides, DEFAULTS } from '../src/config.mjs';

const plugin = fs.readFileSync(path.resolve('plugins/dsh-plugin-kuaishou/index.js'), 'utf8');
// schema 里的布尔键：`  key: z.boolean()`
const boolKeys = [...plugin.matchAll(/^\s{2}(\w+):\s*z\.boolean\(\)/gm)].map((m) => m[1]);

test('schema 里确实有一堆布尔开关', () => {
  assert.ok(boolKeys.length >= 10, `只有 ${boolKeys.length} 个布尔键，太少了`);
});

test('每个布尔键：true / false 都能被 toSettingsJson 写出去（false 不能丢）', () => {
  const lost = [];
  for (const k of boolKeys) {
    const on = toSettingsJson({ [k]: true });
    const off = toSettingsJson({ [k]: false });
    if (on[k] !== true) lost.push(`${k}(true)`);
    if (off[k] !== false) lost.push(`${k}(false)`);
  }
  assert.deepEqual(lost, [], `这些开关的状态传不出去：${lost.join(', ')}`);
});

test('关键开关改完真的落到 cfg 上（抽查几个）', () => {
  const probes = [
    ['loopEnabled', (c) => c.loop.enabled],
    ['loopResetQuota', (c) => c.loop.resetQuotaOnExhaust],
    ['searchEnabled', (c) => c.search.enabled],
    ['summaryRefresh', (c) => c.summary.refresh],
    ['videoTyping', (c) => c.video.typing],
    ['videoStickerAutoEmotion', (c) => c.video.audio.stickerAutoEmotion ?? c.video.audio.stickerKey !== 'off'],
    ['webPersist', (c) => c.web.persist],
    ['replyIncludeOwn', (c) => c.reply.includeOwn],
    ['enabled', (c) => c.enabled]
  ];
  for (const [key, read] of probes) {
    const cfg = structuredClone(DEFAULTS);
    applySettingsOverrides(cfg, { [key]: false });
    assert.equal(read(cfg), false, `${key} = false 没生效（读到 ${read(cfg)}）`);
    const cfg2 = structuredClone(DEFAULTS);
    applySettingsOverrides(cfg2, { [key]: true });
    assert.equal(read(cfg2), true, `${key} = true 没生效`);
  }
});

test('数值开关也过桥：replyPerRun=0（不限）与 publishPerDay', () => {
  const cfg = structuredClone(DEFAULTS);
  applySettingsOverrides(cfg, { replyPerRun: 0, publishPerDay: 3 });
  assert.equal(cfg.quotas.replyPerRun, 0);
  assert.equal(cfg.quotas.publishPerDay, 3);
});
