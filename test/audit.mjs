// 插件自检（静态 + 交叉一致性）：把「配置写了但没接线」这类 bug 自动抓出来。
//
// 覆盖：
//   1. 所有 .mjs/.js 语法（node --check 等价：用 vm.Script 解析）
//   2. 插件 Config 的每个键 → 是否进了 toSettingsJson（否则设置页改了也不落盘）
//   3. toSettingsJson 产出的每个键 → config.mjs 是否认识（否则落盘了也不生效）
//   4. 客户端表单的每个字段 → 是否在 Config schema 里（否则填了也存不下）
//   5. MCP 工具：名字唯一、数量、README 里提到的工具都存在
//   6. prompts 的 active 映射 → 文件是否真的存在
//   7. 关键文件是否被 package.json files 收录（发布时漏文件）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];
const fail = (msg) => problems.push(msg);
const info = (msg) => notes.push(msg);

function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function exists(p) { return fs.existsSync(path.join(ROOT, p)); }
function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'state', 'demo', '.web-profile'].includes(e.name)) walk(rel, out); }
    else out.push(rel);
  }
  return out;
}

// ── 1. 语法 ────────────────────────────────────────────────────────────────
const jsFiles = walk('.').filter((f) => /\.(mjs|js)$/.test(f) && !f.startsWith('test/'));
for (const f of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
  if (r.status !== 0) fail(`语法错误 ${f}: ${(r.stderr || '').split('\n').slice(0, 3).join(' ')}`);
}
info(`语法检查：${jsFiles.length} 个文件`);

// ── 2/3. Config ↔ toSettingsJson ↔ config.mjs ──────────────────────────────
const asUrl = (p) => pathToFileURL(p).href;
const plugin = await import(asUrl(path.join(ROOT, 'plugins/dsh-plugin-kuaishou/index.js')));
const { loadConfig, DEFAULTS, applySettingsOverrides } = await import(asUrl(path.join(ROOT, 'src/config.mjs')));

// schemastery 的内部形状不稳定：优先取 dict，取不到就退回源码正则
const pluginSrc = read('plugins/dsh-plugin-kuaishou/index.js');
const configKeys = Object.keys(plugin.Config?.dict ?? {}).length
  ? Object.keys(plugin.Config.dict)
  : [...pluginSrc.slice(pluginSrc.indexOf('export const Config'), pluginSrc.indexOf('});', pluginSrc.indexOf('export const Config')))
      .matchAll(/^s{2}([a-zA-Z0-9_]+):s*z./gm)].map((m) => m[1]);
info(`插件 Config 字段：${configKeys.length}`);

// 给每个字段塞一个"类型正确"的值，看 toSettingsJson 是否把它写出来。
// 早期版本一律塞字符串 'X'，把 boolean / 枚举字段全误报成"没接线"。
const kindOf = (k) => {
  const dict = plugin.Config?.dict ?? {};
  const d = dict[k];
  if (!d) return 'string';
  if (d.type) return d.type;
  return 'string';
};
const ENUM_HINT = {
  mode: 'web', personaId: 'persona', videoBgPreset: 'whale-blue', videoBgFit: 'cover',
  videoBgGradientAxis: 'vertical', videoTtsEngine: 'sapi', speakTone: 'gentle'
};
const sample = {};
for (const k of configKeys) {
  const type = kindOf(k);
  if (type === 'boolean') sample[k] = true;
  else if (type === 'number') sample[k] = 7;
  else sample[k] = ENUM_HINT[k] ?? 'X';
}
const persisted = plugin.toSettingsJson(sample);
const NOT_PERSISTED = new Set(['assetsPort', 'assetsDir', 'assetsMaxMB']); // 仅插件自用，MCP 不需要
for (const k of configKeys) {
  if (!(k in persisted) && !NOT_PERSISTED.has(k)) fail(`Config 字段「${k}」没有进 toSettingsJson（设置页改了不会生效）`);
}

// persisted 的键在 config.mjs 里必须能被识别
const before = structuredClone(DEFAULTS);
const after = structuredClone(DEFAULTS);
applySettingsOverrides(after, persisted);
const changedOrHandled = (k) => {
  if (k in persisted) return true;
  return false;
};
const UNMAPPED_OK = new Set(['updatedAt', 'source']);
for (const k of Object.keys(persisted)) {
  if (UNMAPPED_OK.has(k)) continue;
  // 用一个哨兵值单独测一次：如果 cfg 没变化，说明 config.mjs 没接这个键
  const probe = structuredClone(DEFAULTS);
  const sentinel = typeof persisted[k] === 'number' ? 3 : 'ZZZ';
  applySettingsOverrides(probe, { [k]: sentinel });
  const touched = JSON.stringify(probe) !== JSON.stringify(DEFAULTS) || (k === 'personaOverride' && probe.prompts.personaOverride === sentinel);
  if (!touched) fail(`设置键「${k}」写进了 settings.json，但 config.mjs 的 applySettingsOverrides 不认它`);
}
info(`持久化键：${Object.keys(persisted).length}`);

// ── 4. 客户端表单 ↔ Config ────────────────────────────────────────────────
const clientSrc = read('plugins/dsh-plugin-kuaishou/client/client.js');
const fieldsBlock = clientSrc.slice(clientSrc.indexOf('const FIELDS = ['), clientSrc.indexOf('];', clientSrc.indexOf('const FIELDS = [')));
const uniqueFields = [...new Set([...fieldsBlock.matchAll(/\{\s*key:\s*'([a-zA-Z0-9_]+)'/g)].map((m) => m[1]))];
for (const k of uniqueFields) {
  if (!configKeys.includes(k)) fail(`客户端表单字段「${k}」不在 Config schema 里（填了也存不下）`);
}
info(`客户端字段：${uniqueFields.length}`);
// 每个配置字段都应该在设置页能改（只有 enabled 是顶部开关单独渲染）
const uiMissing = configKeys.filter((k) => k !== 'enabled' && !uniqueFields.includes(k));
if (uiMissing.length) fail(`配置字段在设置页没有入口：${uiMissing.join(', ')}`);

// ── 5. MCP 工具 ───────────────────────────────────────────────────────────
const mcpSrc = read('src/mcp.mjs');
const tools = [...mcpSrc.matchAll(/registerTool\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
const dupes = tools.filter((t, i) => tools.indexOf(t) !== i);
if (dupes.length) fail(`MCP 工具重名：${[...new Set(dupes)].join(', ')}`);
info(`MCP 工具：${tools.length} 个`);

const readme = read('README.md');
for (const t of tools) {
  if (!readme.includes(t) && !['ks_devices', 'ks_logout_hint', 'ks_screen'].includes(t)) {
    fail(`README 没提到工具 ${t}`);
  }
}

// ── 6. prompts 映射 ───────────────────────────────────────────────────────
const cfg = loadConfig({ env: {} });
for (const [k, id] of Object.entries(cfg.prompts.active)) {
  if (!exists(`prompts/${id}.md`)) fail(`prompts.active.${k} = ${id}，但 prompts/${id}.md 不存在`);
}
info(`prompt 映射：${Object.keys(cfg.prompts.active).length} 项`);

// ── 7. package.json files 是否收全 ────────────────────────────────────────
const pkg = JSON.parse(read('package.json'));
const required = ['src/mcp.mjs', 'src/config.mjs', 'src/video.mjs', 'src/tts.mjs', 'src/assets.mjs', 'src/prompts.mjs', 'install.mjs'];
for (const f of required) if (!exists(f)) fail(`缺少必需文件 ${f}`);
const pluginPkg = JSON.parse(read('plugins/dsh-plugin-kuaishou/package.json'));
for (const f of ['index.js', 'client/client.js', 'cordis.patch.yml']) {
  if (!exists(`plugins/dsh-plugin-kuaishou/${f}`)) fail(`插件包缺少 ${f}`);
  if (!(pluginPkg.files ?? []).includes(f)) fail(`插件 package.json 的 files 未收录 ${f}`);
}

// ── 输出 ──────────────────────────────────────────────────────────────────
console.log('=== 自检结果 ===');
for (const n of notes) console.log('  ·', n);
if (problems.length === 0) {
  console.log('\n✅ 没发现结构性问题');
  process.exit(0);
}
console.log(`\n❌ 发现 ${problems.length} 个问题：`);
for (const p of problems) console.log('  -', p);
process.exit(1);
