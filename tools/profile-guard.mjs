// 命令行：看 / 拍快照 / 恢复 DSH 的 profile 配置（cordis.patch.yml）。
//
// 用法：
//   node tools/profile-guard.mjs check            # 只看（健康时会顺手刷新快照）
//   node tools/profile-guard.mjs snapshot         # 强制把当前健康配置存成快照
//   node tools/profile-guard.mjs restore --dry    # 只看会怎么恢复
//   node tools/profile-guard.mjs restore          # 真恢复（先备份当前文件）
//
// 什么时候用：DSH 崩溃/打不开之后，插件设置页不见了、ks_* 工具全没了 ——
// 大概率是 patch 被重置成 []，跑 restore 就行。改完要重启 DSH 才生效。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectProfile, restoreProfile, patchPath, snapshotPath } from '../src/profile-guard.mjs';
import { projectRoot } from '../src/config.mjs';

const root = projectRoot();
const cmd = process.argv[2] || 'check';
const dry = process.argv.includes('--dry');

const show = (label, c) => `${label}: ${c.exists ? `${c.entries} 个条目 / ${c.bytes}B / kuaishou=${c.hasKuaishou}` : '不存在'}`;

if (cmd === 'check') {
  const r = inspectProfile({ root });
  console.log(show('当前', r.current));
  console.log(show('快照', r.good));
  console.log(`路径：${r.file}`);
  console.log(`快照：${r.snapshot}`);
  if (r.snapshotRefreshed) console.log('（已刷新快照）');
  if (r.ok) {
    console.log('✅ 配置正常：kuaishou 条目在，条目数没下降');
  } else {
    console.log(`❌ ${r.problem}`);
    console.log('恢复：node tools/profile-guard.mjs restore   （会先备份当前文件）');
    process.exitCode = 1;
  }
} else if (cmd === 'snapshot') {
  const r = inspectProfile({ root, ensureSnapshot: true });
  if (!r.healthy) {
    console.log(`❌ 当前配置不健康（${r.problem || '条目太少'}），不拿它当快照`);
    process.exitCode = 1;
  } else {
    console.log(`✅ 快照已更新：${snapshotPath(root)}（${r.current.entries} 个条目 / ${r.current.bytes}B）`);
  }
} else if (cmd === 'restore') {
  const r = restoreProfile({ root, dry });
  if (!r.ok) {
    console.log(`❌ ${r.error}`);
    process.exitCode = 1;
  } else if (r.dry) {
    console.log(`（dry）会把 ${r.would.from} → ${r.would.to}`);
    console.log(show('当前', r.would.before));
    console.log(show('恢复后', r.would.after));
  } else {
    console.log(`✅ 已恢复：${show('恢复后', r.after)}`);
    console.log(`当前文件已备份：${r.backup}`);
    console.log('重启 DSH 后生效（插件设置页和 ks_* 工具会回来）');
  }
} else {
  console.log(`未知命令：${cmd}（可用：check / snapshot / restore [--dry]）`);
  process.exitCode = 1;
}
