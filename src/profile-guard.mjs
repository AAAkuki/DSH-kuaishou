// profile 配置保险：DSH 崩溃循环会把 cordis.patch.yml 重置成 []，插件注册跟着丢。
//
// 2026-10-25 真发生过：4782B（16 个条目，含 kuaishou）→ 217B（[]），
// 表现就是"插件好像坏了、MCP 工具全没了"。
//
// 最保守的做法：
//   · 只**读** DSH 的文件，只在"当前文件健康"时才刷新快照（绝不用坏文件覆盖好快照）
//   · 绝不自动改 DSH 的配置；恢复必须由人或脚本显式执行，且先备份当前文件
//   · 快照放在项目里（state/cordis.patch.yml.good），不依赖 Documents 下的临时文件
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function patchPath({ profile = process.env.KSOPS_PROFILE || 'desktop' } = {}) {
  return path.join(dshHome(), 'profiles', profile, 'cordis.patch.yml');
}

export function snapshotPath(root) {
  return path.join(root, 'state', 'cordis.patch.yml.good');
}

/** 数一下顶层条目（一行 `- id: xxx` 或 `- insert:`），并看 kuaishou 在不在。 */
export function parsePatch(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const ids = [];
  for (const line of lines) {
    const m = /^-\s+id:\s*(\S+)/.exec(line);
    if (m) ids.push(m[1]);
    else if (/^-\s+insert:/.test(line)) ids.push('(insert)');
  }
  return {
    entries: ids.length,
    ids,
    hasKuaishou: ids.includes('kuaishou'),
    isReset: ids.length === 0 || String(text).replace(/[\s\[\]]/g, '').length === 0
  };
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/**
 * 体检 + 必要时刷新快照。
 * @param {object} opts
 * @param {string} opts.root 项目根
 * @param {boolean} [opts.ensureSnapshot] 当前文件健康且快照缺失/变旧时，刷新快照
 */
export function inspectProfile({ root, profile, ensureSnapshot = true } = {}) {
  const file = patchPath({ profile });
  const snap = snapshotPath(root);
  const text = readText(file);
  const snapText = readText(snap);

  const cur = text === null
    ? { exists: false, bytes: 0, entries: 0, ids: [], hasKuaishou: false, isReset: false }
    : { exists: true, bytes: Buffer.byteLength(text), ...parsePatch(text) };
  const good = snapText === null
    ? { exists: false, bytes: 0, entries: 0, ids: [], hasKuaishou: false, isReset: false }
    : { exists: true, bytes: Buffer.byteLength(snapText), ...parsePatch(snapText) };

  const healthy = cur.exists && cur.entries >= 10 && cur.hasKuaishou;
  let snapshotRefreshed = false;
  if (ensureSnapshot && healthy) {
    // 只在"比快照更好或一样好"时刷新，避免把一次坏状态固化进快照
    if (!good.exists || cur.entries >= good.entries) {
      try {
        fs.mkdirSync(path.dirname(snap), { recursive: true });
        fs.writeFileSync(snap, text, 'utf8');
        snapshotRefreshed = !good.exists || text !== snapText;
      } catch {}
    }
  }

  const dropped = good.exists && cur.entries < good.entries;
  const problem = !cur.exists
    ? 'patch 文件不存在（DSH 可能被重置过）'
    : cur.isReset
      ? 'patch 被清成 []（插件注册全丢）'
      : !cur.hasKuaishou
        ? 'patch 里没有 kuaishou 条目（插件不会被加载）'
        : dropped
          ? `条目比快照少（${cur.entries} < ${good.entries}）`
          : '';

  return {
    file,
    snapshot: snap,
    current: cur,
    good,
    healthy,
    dropped,
    problem,
    ok: problem === '',
    snapshotRefreshed
  };
}

/**
 * 从快照恢复。会先把当前文件备份成 .bak-<时间戳>。
 * 只在快照本身健康时才动手；--dry 只报告。
 */
export function restoreProfile({ root, profile, dry = false } = {}) {
  const file = patchPath({ profile });
  const snap = snapshotPath(root);
  const snapText = readText(snap);
  if (snapText === null) return { ok: false, error: `没有快照：${snap}` };
  const g = parsePatch(snapText);
  if (g.entries < 10 || !g.hasKuaishou) {
    return { ok: false, error: `快照本身不像健康配置（${g.entries} 个条目，kuaishou=${g.hasKuaishou}），拒绝恢复` };
  }
  const before = inspectProfile({ root, profile, ensureSnapshot: false });
  const afterShape = { exists: true, bytes: Buffer.byteLength(snapText), ...g };
  if (dry) return { ok: true, dry: true, would: { from: snap, to: file, before: before.current, after: afterShape } };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.bak-${stamp}`;
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, backup);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, snapText, 'utf8');
  } catch (error) {
    return { ok: false, error: error.message, backup };
  }
  const after = inspectProfile({ root, profile, ensureSnapshot: false });
  return { ok: after.ok, backup, before: before.current, after: after.current };
}
