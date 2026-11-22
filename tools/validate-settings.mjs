// 设置体检：把「插件 schema / 客户端字段 / config.json 默认值 / 已保存的 settings.json」
// 四边对齐，找出"存了但没人读"和"能改但存不下"的键。
//
// 为什么要这个：settings.json 里留着一个 videoStickerSize（早就改名叫 videoStickerSizeName），
// 这种陈旧键会让 DSH 的 profile 补丁越来越脏，也是"改了半天没生效"的常见来源。
//
// 用法：
//   node tools/validate-settings.mjs            # 只看（发现问题时退出码 1）
//   node tools/validate-settings.mjs --fix      # 把陈旧键剪掉（先备份成 .bak-时间戳）
//   node tools/validate-settings.mjs --json     # 机器可读
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot } from '../src/config.mjs';

const root = projectRoot();
const args = process.argv.slice(2);
const fix = args.includes('--fix');
const asJson = args.includes('--json');

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/** schema 里声明的键：`  keyName: z.xxx` */
export function schemaKeys(pluginSource) {
  return [...pluginSource.matchAll(/^\s{2}(\w+):\s*z\./gm)].map((m) => m[1]);
}

/** 客户端真正给出输入框的键：`{ key: 'xxx', group: 'yyy'` */
export function clientKeys(clientSource) {
  return [...clientSource.matchAll(/\{\s*key:\s*'(\w+)',\s*group:/g)].map((m) => m[1]);
}

/**
 * config.mjs 里真正被读的扁平键。
 * 两种写法都要认：`flat.videoLineCount` 和 `for (const k of ['scrollPerRun', ...])`（引号形式）。
 */
export function appliedKeys(configSource) {
  const dotted = [...configSource.matchAll(/flat\.(\w+)/g)].map((m) => m[1]);
  const quoted = [...configSource.matchAll(/'([a-zA-Z_][\w]*)'/g)].map((m) => m[1]);
  return [...new Set([...dotted, ...quoted])];
}

/**
 * 读 DSH profile 补丁里 kuaishou 那一层的配置。
 *
 * 这层**优先级最高**（loadConfig 最后才叠加它），所以只改 state/settings.json
 * 会出现"改了不生效"——我踩过一次：把 cute_breath 关掉写进 settings.json，
 * 结果 profile 里还是 true，成片里照旧有杂音。
 */
export function profileLayer({ dshHome, profile = 'desktop' } = {}) {
  const home = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const file = path.join(home, 'profiles', profile, 'cordis.patch.yml');
  const out = { file, exists: false, values: {} };
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  out.exists = true;
  const lines = text.split(/\r?\n/);
  let inKuaishou = false;
  let indent = -1;
  for (const line of lines) {
    const idm = /^(\s*)-\s+id:\s*(\S+)\s*$/.exec(line);
    if (idm) { inKuaishou = idm[2] === 'kuaishou'; indent = idm[1].length; continue; }
    if (!inKuaishou) continue;
    // 到了同级的下一项就退出
    if (/^\s*-\s+\w+:/.test(line) && line.search(/\S/) <= indent) { inKuaishou = false; continue; }
    const m = /^\s+([a-zA-Z_]\w*):\s*(.+?)\s*$/.exec(line);
    if (m) out.values[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

export function audit({ root: base = root, dshHome, profile } = {}) {
  const plugin = fs.readFileSync(path.join(base, 'plugins', 'dsh-plugin-kuaishou', 'index.js'), 'utf8');
  const client = fs.readFileSync(path.join(base, 'plugins', 'dsh-plugin-kuaishou', 'client', 'client.js'), 'utf8');
  const config = fs.readFileSync(path.join(base, 'src', 'config.mjs'), 'utf8');
  const settingsFile = path.join(base, 'state', 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch {}
  const saved = Object.keys(settings).filter((k) => !['updatedAt', 'source'].includes(k));

  const schema = new Set(schemaKeys(plugin));
  const clientSet = new Set(clientKeys(client));
  const applied = new Set(appliedKeys(config));
  // 动态键：config.mjs 里 `flat[`cute_${k}`]` 这种模板拼接，字面量里搜不到
  const dynamicPrefixes = [...config.matchAll(/flat\[`([\w]+?)\$\{/g)].map((m) => m[1]).filter(Boolean);
  const isApplied = (k) => applied.has(k) || config.includes(k) || dynamicPrefixes.some((p) => k.startsWith(p));

  const stale = saved.filter((k) => !schema.has(k) && !isApplied(k)); // 存了，但 schema 和 config 都不认
  const noInput = [...schema].filter((k) => !clientSet.has(k) && k !== 'enabled');
  const notSaveable = [...clientSet].filter((k) => !schema.has(k));
  const savedNoEffect = saved.filter((k) => schema.has(k) && !isApplied(k));

  // profile 层（优先级最高）和 settings.json 打架的地方：这会导致"改了不生效"
  const layer = profileLayer({ dshHome, profile });
  const conflicts = [];
  for (const [k, v] of Object.entries(layer.values)) {
    if (!(k in settings)) continue;
    const a = String(settings[k]).trim();
    const b = String(v).trim();
    if (a !== b) conflicts.push({ key: k, settings: a, profile: b, effective: b });
  }

  return {
    counts: { schema: schema.size, client: clientSet.size, applied: applied.size, saved: saved.length },
    stale,
    noInput,
    notSaveable,
    savedNoEffect,
    conflicts,
    profile: { file: layer.file, exists: layer.exists, keys: Object.keys(layer.values).length },
    settingsFile,
    settings
  };
}

/** 剪掉陈旧键（只动 settings.json，先备份）。返回 { removed, backup } */
export function prune({ root: base = root } = {}) {
  const a = audit({ root: base });
  if (a.stale.length === 0) return { removed: [], backup: '' };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${a.settingsFile}.bak-${stamp}`;
  fs.copyFileSync(a.settingsFile, backup);
  for (const k of a.stale) delete a.settings[k];
  fs.writeFileSync(a.settingsFile, `${JSON.stringify(a.settings, null, 2)}\n`, 'utf8');
  return { removed: a.stale, backup };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const report = audit({ root });
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`schema ${report.counts.schema} 键 / 客户端 ${report.counts.client} 键 / config 认 ${report.counts.applied} 键 / 已保存 ${report.counts.saved} 键`);
    const line = (label, list) => {
      console.log(`\n${label}（${list.length}）`);
      for (const k of list) console.log('  -', k);
    };
    line('❌ 存了但没人认（建议 --fix 剪掉）', report.stale);
    line('⚠️ schema 有、客户端没输入框（用户改不到）', report.noInput);
    line('❌ 客户端有输入框、schema 没有（保存会丢）', report.notSaveable);
    line('⚠️ 存了但 config 没读（改了不生效）', report.savedNoEffect);
    if (report.profile.exists) {
      console.log(`\nprofile 层：${report.profile.file}（${report.profile.keys} 个键，优先级最高）`);
      if (report.conflicts.length) {
        console.log(`⚠️ 和 state/settings.json 打架的键（实际生效的是 profile 那个）：`);
        for (const c of report.conflicts) console.log(`  - ${c.key}: settings=${c.settings} / profile=${c.profile} → 生效 ${c.effective}`);
      } else {
        console.log('两层一致，没有覆盖冲突');
      }
    }
  }
  const bad = report.stale.length + report.notSaveable.length;
  if (fix && report.stale.length) {
    const r = prune({ root });
    console.log(`\n已剪掉 ${r.removed.length} 个陈旧键：${r.removed.join(', ')}`);
    console.log(`备份：${r.backup}`);
  } else if (bad > 0) {
    console.log('\n有问题：加 --fix 自动剪掉陈旧键（会先备份）');
  } else {
    console.log('\n✅ 设置对齐正常');
  }
  process.exitCode = bad > 0 && !fix ? 1 : 0;
}
