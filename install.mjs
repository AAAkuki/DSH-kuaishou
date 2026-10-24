// 把 kuaishou-ops 完整装进 DSH 的某个 profile（幂等；只改自己那一条，不动别人的）。
//
// 装两样东西：
//   ① MCP 工具面：cordis.patch.yml 里一条 `id: mcp-kuaishou`（模型侧 ks_* 工具）
//   ② 设置页：bundle dsh-plugin-kuaishou（junction 进 profile node_modules + 注册进 bundles）。
//      它的 entry id 是 `kuaishou`，所以「设置 → kuaishou」这一页会出现。
//      注意 entry 由 **bundle 自己的** cordis.patch.yml 提供，不能写进 home patch，
//      否则 DSH 会认为该命名空间被 patch 覆盖 → 设置页不可写。
//
// ⚠️ 关键：DSH 会把「设置页改过的值」以 `- id: kuaishou / config: {...}` 的形式
//   追加写进**同一个** cordis.patch.yml。所以本脚本不能整文件重写/裁剪标记区，
//   必须按 YAML 结构做「只删自己那条 insert」的编辑，否则会把用户的设置一起删掉。
//
//   node install.mjs                 # 默认 desktop profile
//   node install.mjs --profile web
//   node install.mjs --remove        # 两样一起摘掉
//   node install.mjs --mcp-only      # 只装工具面
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as yamlNs from 'js-yaml';

// js-yaml 4 是 CJS：ESM 下 default 与命名空间两种形状都可能出现，统一取一次
const yaml = yamlNs.default ?? yamlNs;
import { projectRoot } from './src/config.mjs';

const args = process.argv.slice(2);
const getFlag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const profile = getFlag('--profile', 'desktop');
const remove = args.includes('--remove');
const mcpOnly = args.includes('--mcp-only');

const ROOT = projectRoot();
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const profileDir = path.join(DSH_HOME, 'profiles', profile);
const patchFile = path.join(profileDir, 'cordis.patch.yml');
const profilePkg = path.join(profileDir, 'package.json');
const BUNDLE = 'dsh-plugin-kuaishou';
const MCP_ENTRY_ID = 'mcp-kuaishou';

if (!/^[A-Za-z0-9._-]+$/.test(profile)) {
  console.error(`profile 名不合法：${profile}`);
  process.exit(1);
}
if (!fs.existsSync(profileDir)) {
  console.error(`找不到 profile 目录：${profileDir}\n先用 DSH 启动一次 ${profile} profile，或换 --profile`);
  process.exit(1);
}

const toPosix = (p) => p.replace(/\\/g, '/');

function mcpInsertOp() {
  return {
    insert: [{
      id: MCP_ENTRY_ID,
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        serverName: 'kuaishou',
        transport: 'stdio',
        command: toPosix(process.execPath),
        args: [toPosix(path.join(ROOT, 'src', 'mcp.mjs'))],
        toolCallTimeoutMs: 600000
      }
    }]
  };
}

/** 从任意 patch op 里摘掉 id=mcp-kuaishou 的条目；只剩空 insert 的 op 整个丢掉。 */
function stripMcpEntry(doc) {
  const out = [];
  for (const op of doc) {
    if (!op || typeof op !== 'object') continue;
    if (Array.isArray(op.insert)) {
      const kept = op.insert.filter((e) => e?.id !== MCP_ENTRY_ID);
      if (kept.length === 0 && Object.keys(op).length === 1) continue;
      out.push({ ...op, insert: kept });
      continue;
    }
    if (op.id === MCP_ENTRY_ID) continue;
    out.push(op);
  }
  return out;
}

function patchYaml() {
  const original = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '[]\n';
  let doc;
  try {
    doc = yaml.load(original.replace(/^\uFEFF/, '')) ?? [];
  } catch (error) {
    console.error(`cordis.patch.yml 解析失败，未做任何修改：${error.message}`);
    process.exit(1);
  }
  if (!Array.isArray(doc)) {
    console.error('cordis.patch.yml 根节点不是数组，未做任何修改');
    process.exit(1);
  }

  let next = stripMcpEntry(doc);
  if (!remove) next = [...next, mcpInsertOp()];

  const text = yaml.dump(next, { lineWidth: -1, noRefs: true });
  if (text === original) {
    console.log('cordis.patch.yml 已是最新，无需改动');
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(patchFile, `${patchFile}.bak-${stamp}`);
  console.log(`已备份：${patchFile}.bak-${stamp}`);
  fs.writeFileSync(patchFile, text, 'utf8');
  console.log(`${remove ? '已摘除' : '已写入'} MCP 挂载：${patchFile}`);
}

// ── ② 的 bundle 物化：junction + profile dependencies/bundles ────────────────
function ensureJunction(linkPath, target) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  let existing = null;
  try { existing = fs.lstatSync(linkPath); } catch {}
  if (existing) {
    if (existing.isSymbolicLink()) {
      const real = fs.realpathSync(linkPath);
      if (path.resolve(real) === path.resolve(target)) {
        console.log(`junction 已就绪：${linkPath}`);
        return;
      }
    }
    fs.rmSync(linkPath, { recursive: true, force: true });
  }
  fs.symlinkSync(target, linkPath, 'junction');
  console.log(`junction 已创建：${linkPath} → ${target}`);
}

function installBundle() {
  const pluginDir = path.join(ROOT, 'plugins', BUNDLE);
  if (!fs.existsSync(pluginDir)) throw new Error(`插件目录不存在：${pluginDir}`);
  const homeLink = path.join(DSH_HOME, 'plugins', BUNDLE);
  ensureJunction(homeLink, pluginDir);
  ensureJunction(path.join(profileDir, 'node_modules', BUNDLE), homeLink);

  let pkg = { name: `dsh-profile-${profile}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
  if (fs.existsSync(profilePkg)) {
    try { pkg = JSON.parse(fs.readFileSync(profilePkg, 'utf8')); } catch (error) {
      throw new Error(`profile package.json 解析失败：${error.message}`);
    }
  }
  pkg.dependencies = pkg.dependencies ?? {};
  pkg.dsh = pkg.dsh ?? {};
  pkg.dsh.profile = pkg.dsh.profile ?? {};
  pkg.dsh.profile.bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  const linkVal = `link:${toPosix(homeLink)}`;
  if (pkg.dependencies[BUNDLE] !== linkVal) {
    pkg.dependencies[BUNDLE] = linkVal;
    console.log(`profile dependency：${BUNDLE} -> ${linkVal}`);
  }
  if (!pkg.dsh.profile.bundles.includes(BUNDLE)) {
    pkg.dsh.profile.bundles.push(BUNDLE);
    console.log(`profile bundle 已注册：${BUNDLE}`);
  }
  fs.writeFileSync(profilePkg, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

function removeBundle() {
  try {
    const pkg = JSON.parse(fs.readFileSync(profilePkg, 'utf8'));
    if (pkg.dependencies) delete pkg.dependencies[BUNDLE];
    if (Array.isArray(pkg.dsh?.profile?.bundles)) {
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== BUNDLE);
    }
    fs.writeFileSync(profilePkg, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    console.log(`profile 已摘除 bundle：${BUNDLE}`);
  } catch {}
  for (const p of [path.join(profileDir, 'node_modules', BUNDLE), path.join(DSH_HOME, 'plugins', BUNDLE)]) {
    try { fs.rmSync(p, { recursive: true, force: true }); console.log(`已删除 junction：${p}`); } catch {}
  }
}

function dshPluginInstall() {
  const r = spawnSync('dsh.cmd', ['plugin', '--profile', profile, 'install'], {
    encoding: 'utf8', timeout: 180000, windowsHide: true, shell: true
  });
  if (r.error) {
    console.log(`自动 dsh plugin install 未执行（${r.error.code ?? r.error.message}）。若启动报 bundle 解析失败，手动跑：dsh plugin --profile ${profile} install`);
    return;
  }
  console.log(r.status === 0 ? 'dsh plugin install: OK' : `dsh plugin install 退出码 ${r.status}`);
}

patchYaml();
if (remove) {
  removeBundle();
} else if (!mcpOnly) {
  installBundle();
  dshPluginInstall();
}

console.log('重启 DSH（或重新加载 profile）后生效：');
console.log('  · 模型侧出现 ks_* 工具');
if (!mcpOnly) console.log('  · 「设置」里出现 kuaishou 一页（后端 / 配额 / 配音 / 提示词映射）');
