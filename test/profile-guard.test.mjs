// profile 配置保险：快照 / 检测 / 恢复，全程用临时 DSH_HOME，不碰真配置。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectProfile, restoreProfile, parsePatch, patchPath, snapshotPath } from '../src/profile-guard.mjs';

const HEALTHY = `# DSH profile 补丁
- id: ui-settings-account
  disabled: false
- id: ui-chat
- id: ui-settings
- insert:
  - id: a
- insert:
  - id: b
- id: dsh-purge
- id: dsh-purge-redteam
- id: dsh-purge-presets
- id: ui-theme
- id: agent-default-model
- id: kuaishou
`;

function sandbox(patchText = HEALTHY) {
  const dsh = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-dsh-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-root-'));
  fs.mkdirSync(path.join(dsh, 'profiles', 'desktop'), { recursive: true });
  if (patchText !== null) fs.writeFileSync(path.join(dsh, 'profiles', 'desktop', 'cordis.patch.yml'), patchText, 'utf8');
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dsh;
  return {
    root,
    dsh,
    file: patchPath({ profile: 'desktop' }),
    snap: snapshotPath(root),
    done: () => { if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev; }
  };
}

test('parsePatch：数条目、认 kuaishou、识别被清成 []', () => {
  const h = parsePatch(HEALTHY);
  assert.equal(h.entries, 11);
  assert.equal(h.hasKuaishou, true);
  assert.equal(h.isReset, false);
  const r = parsePatch('[]\n');
  assert.equal(r.entries, 0);
  assert.equal(r.isReset, true);
  assert.equal(r.hasKuaishou, false);
});

test('健康配置 → ok，并自动生成快照', () => {
  const s = sandbox();
  try {
    const r = inspectProfile({ root: s.root });
    assert.equal(r.ok, true, r.problem);
    assert.equal(r.current.entries, 11);
    assert.equal(r.current.hasKuaishou, true);
    assert.ok(fs.existsSync(s.snap), '快照应该被创建');
    assert.equal(fs.readFileSync(s.snap, 'utf8'), HEALTHY);
  } finally { s.done(); }
});

test('配置被重置成 [] → 判红，且不拿坏文件覆盖好快照', () => {
  const s = sandbox();
  try {
    inspectProfile({ root: s.root });              // 先拍健康快照
    fs.writeFileSync(s.file, '\uFEFF[]\n', 'utf8'); // 模拟崩溃后被重置
    const r = inspectProfile({ root: s.root });
    assert.equal(r.ok, false);
    assert.match(r.problem, /\[\]|不存在|没有 kuaishou/);
    assert.equal(r.current.entries, 0);
    assert.equal(fs.readFileSync(s.snap, 'utf8'), HEALTHY, '快照必须保持健康版本');
  } finally { s.done(); }
});

test('恢复：--dry 不动文件，真恢复会先备份再写回', () => {
  const s = sandbox();
  try {
    inspectProfile({ root: s.root });
    fs.writeFileSync(s.file, '[]\n', 'utf8');

    const dry = restoreProfile({ root: s.root, dry: true });
    assert.equal(dry.ok, true);
    assert.equal(dry.dry, true);
    assert.equal(fs.readFileSync(s.file, 'utf8'), '[]\n', 'dry 不能改文件');

    const r = restoreProfile({ root: s.root });
    assert.equal(r.ok, true, r.error);
    assert.ok(fs.existsSync(r.backup), '要先备份当前文件');
    const after = inspectProfile({ root: s.root });
    assert.equal(after.ok, true);
    assert.equal(after.current.entries, 11);
    assert.equal(after.current.hasKuaishou, true);
  } finally { s.done(); }
});

test('没有快照时恢复会明确拒绝，不动任何文件', () => {
  const s = sandbox('[]\n');
  try {
    const r = restoreProfile({ root: s.root });
    assert.equal(r.ok, false);
    assert.match(r.error, /没有快照/);
    assert.equal(fs.readFileSync(s.file, 'utf8'), '[]\n');
  } finally { s.done(); }
});

test('快照本身不健康（条目少/没 kuaishou）时拒绝用它恢复', () => {
  const s = sandbox('[]\n');
  try {
    fs.mkdirSync(path.dirname(s.snap), { recursive: true });
    fs.writeFileSync(s.snap, '- id: ui-chat\n', 'utf8');
    const r = restoreProfile({ root: s.root });
    assert.equal(r.ok, false);
    assert.match(r.error, /不像健康配置/);
  } finally { s.done(); }
});

test('patch 文件不存在 → 判红并给出恢复提示依据', () => {
  const s = sandbox(null);
  try {
    const r = inspectProfile({ root: s.root });
    assert.equal(r.ok, false);
    assert.match(r.problem, /不存在/);
    assert.equal(r.current.exists, false);
  } finally { s.done(); }
});
