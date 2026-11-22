// 设置体检脚本：四边（schema / 客户端 / config / 已保存）必须对齐，
// 否则会出现"改了不生效"或"存了没人读"这种隐性坑。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { audit, prune, schemaKeys, clientKeys, appliedKeys } from '../tools/validate-settings.mjs';
import { projectRoot } from '../src/config.mjs';

const root = projectRoot();

test('解析器：schema / 客户端 / config 三边的键都能抽出来', () => {
  const s = schemaKeys(fs.readFileSync(path.join(root, 'plugins/dsh-plugin-kuaishou/index.js'), 'utf8'));
  const c = clientKeys(fs.readFileSync(path.join(root, 'plugins/dsh-plugin-kuaishou/client/client.js'), 'utf8'));
  const a = appliedKeys(fs.readFileSync(path.join(root, 'src/config.mjs'), 'utf8'));
  assert.ok(s.length > 70, `schema 键太少：${s.length}`);
  assert.ok(c.length > 70, `客户端字段太少：${c.length}`);
  assert.ok(a.length > 70, `config 认的键太少：${a.length}`);
  for (const k of ['kuaishouNoSuchKey']) assert.ok(!s.includes(k));
  for (const want of ['videoLineCount', 'searchLimit', 'summaryRefresh', 'loopMaxRounds']) {
    assert.ok(s.includes(want), `schema 缺 ${want}`);
    assert.ok(c.includes(want), `客户端缺 ${want}`);
  }
});

test('真实仓库：没有"存了没人认""客户端有但存不下""存了不生效"', () => {
  const r = audit({ root });
  assert.deepEqual(r.stale, [], `陈旧键：${r.stale.join(', ')}`);
  assert.deepEqual(r.notSaveable, [], `存不下的字段：${r.notSaveable.join(', ')}`);
  assert.deepEqual(r.savedNoEffect, [], `存了不生效：${r.savedNoEffect.join(', ')}`);
  assert.deepEqual(r.noInput, [], `用户改不到的键：${r.noInput.join(', ')}`);
});

test('prune：剪掉陈旧键并留备份（用临时树跑，不动真文件）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-audit-'));
  for (const rel of ['plugins/dsh-plugin-kuaishou/index.js', 'plugins/dsh-plugin-kuaishou/client/client.js', 'src/config.mjs']) {
    fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
    fs.copyFileSync(path.join(root, rel), path.join(base, rel));
  }
  fs.mkdirSync(path.join(base, 'state'), { recursive: true });
  fs.writeFileSync(path.join(base, 'state', 'settings.json'), JSON.stringify({
    enabled: true,
    videoLineCount: 12,
    thisKeyIsGone: 'x',
    anotherStaleOne: 1
  }, null, 2), 'utf8');

  const before = audit({ root: base });
  assert.deepEqual(before.stale.sort(), ['anotherStaleOne', 'thisKeyIsGone']);

  const r = prune({ root: base });
  assert.deepEqual(r.removed.sort(), ['anotherStaleOne', 'thisKeyIsGone']);
  assert.ok(fs.existsSync(r.backup), '剪之前要备份');
  const after = JSON.parse(fs.readFileSync(path.join(base, 'state', 'settings.json'), 'utf8'));
  assert.equal(after.thisKeyIsGone, undefined);
  assert.equal(after.videoLineCount, 12, '正常键不能被误删');
  assert.equal(audit({ root: base }).stale.length, 0);
});

test('prune：没有陈旧键时不动文件', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-audit-'));
  for (const rel of ['plugins/dsh-plugin-kuaishou/index.js', 'plugins/dsh-plugin-kuaishou/client/client.js', 'src/config.mjs']) {
    fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
    fs.copyFileSync(path.join(root, rel), path.join(base, rel));
  }
  fs.mkdirSync(path.join(base, 'state'), { recursive: true });
  fs.writeFileSync(path.join(base, 'state', 'settings.json'), JSON.stringify({ enabled: true }), 'utf8');
  const r = prune({ root: base });
  assert.deepEqual(r.removed, []);
  assert.equal(r.backup, '');
});
