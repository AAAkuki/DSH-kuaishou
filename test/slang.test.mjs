// 学梗：从刷到的文案里抽梗、并进词库、在回评/视频里低频用出去
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractMemes, learnMemes, loadSlang, saveSlang, pickSlang, slangFile } from '../src/slang.mjs';
import { pickReply } from '../src/ops.mjs';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-slang-'));

test('从文案里抽梗：已知梗 / 话题 / 引号 / 构词', () => {
  const got = extractMemes('#抽象 这波直接破防了「情绪价值拉满」#整活 一眼丁真');
  for (const want of ['破防', '抽象', '整活', '一眼丁真', '情绪价值拉满']) {
    assert.ok(got.includes(want), `没抽到 ${want}（实际 ${got.join('/')}）`);
  }
});

test('不抽垃圾：纯数字、纯标点、超长串都不算梗', () => {
  const got = extractMemes('12345 ，。！ 啊啊啊啊啊啊啊啊啊啊啊啊啊啊');
  assert.ok(!got.includes('12345'));
  assert.ok(!got.some((t) => t.length > 12));
});

test('学梗：重复出现会累加次数，不重复存两份', () => {
  const store = { version: 1, items: [] };
  learnMemes(store, ['破防', '破防', '整活'], { now: '2026-10-26T01:00:00Z' });
  learnMemes(store, ['破防'], { now: '2026-10-26T02:00:00Z' });
  assert.equal(store.items.length, 2);
  const hit = store.items.find((x) => x.term === '破防');
  assert.equal(hit.count, 3);
  assert.equal(hit.lastAt, '2026-10-26T02:00:00Z');
});

test('词库有上限（不会无限涨）', () => {
  const store = { version: 1, items: [] };
  for (let i = 0; i < 400; i++) learnMemes(store, [`梗${i}`], { max: 300 });
  assert.ok(store.items.length <= 300, `实际 ${store.items.length}`);
});

test('存盘 + 读回：原子写，坏文件当空词库不抛', () => {
  const root = tmpRoot();
  const store = { version: 1, items: [{ term: '破防', count: 2, firstAt: 'x', lastAt: 'y', used: 0 }] };
  saveSlang(root, store);
  assert.ok(fs.existsSync(slangFile(root)));
  assert.equal(loadSlang(root).items[0].term, '破防');

  fs.writeFileSync(slangFile(root), '{坏掉的 json', 'utf8');
  const recovered = loadSlang(root);
  assert.deepEqual(recovered.items, [], '坏文件应当当空词库，而不是抛');
});

test('挑梗：优先没用过的', () => {
  const store = { items: [{ term: 'a1', used: 0 }, { term: 'b2', used: 5 }] };
  const picks = new Set(Array.from({ length: 10 }, () => pickSlang(store)));
  assert.ok(picks.has('a1'), `应该优先挑没用过的，实际 ${[...picks]}`);
});

test('回评里掺梗是低频的，而且不会超过长度上限', () => {
  const slang = { items: [{ term: '破防', used: 0 }] };
  let hits = 0;
  for (let i = 0; i < 200; i++) {
    const t = pickReply('这个怎么做的', { slang, slangRate: 0.2 });
    if (t.includes('破防')) hits++;
    assert.ok(t.length <= 26, `太长了：${t}`);
  }
  assert.ok(hits > 10 && hits < 90, `掺梗次数应在 5%~45%，实际 ${hits}/200`);
});

test('没有梗词库时，回复不含任何梗后缀', () => {
  const t = pickReply('这个怎么做的', { slang: { items: [] } });
  assert.ok(!t.includes('，破防'));
});
