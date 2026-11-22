// 发布前体检：按 .gitignore 规则算出"真正会进仓库的文件"，检查私密信息和超大文件
//   node tools/release-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 读 .gitignore（只支持常见的几类写法，够用）
const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => l.replace(/\\/g, '/'));

function ignored(rel) {
  const p = rel.replace(/\\/g, '/');
  // .git 自身永远不进仓库（GitHub 会拒绝 .git 作为路径组件）
  if (p === '.git' || p.startsWith('.git/')) return true;
  return ignore.some((rule) => {
    const r = rule.replace(/\/$/, '');
    if (r.startsWith('*')) return p.endsWith(r.slice(1));
    if (r.includes('/')) return p === r || p.startsWith(`${r}/`);
    // 不带斜杠：任意层级的同名文件或目录
    return p.split('/').includes(r) || p.endsWith(`/${r}`);
  });
}

const SECRET_PATTERNS = [
  { re: /sk-[A-Za-z0-9]{20,}/g, name: '疑似 API key' },
  { re: /["']?(token|secret|password|apiKey|tokenKey)["']?\s*[:=]\s*["'][^"']{8,}["']/gi, name: '疑似硬编码凭据' }
];
// 测试里故意用的假值不算
const ALLOW = /sk-test|sk-fake|test-invalid|example|x{6,}|\*{3,}/i;

const problems = [];
const stats = { files: 0, bytes: 0, skippedDirs: 0 };

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (ignored(rel)) { if (entry.isDirectory()) stats.skippedDirs += 1; continue; }
    if (entry.isDirectory()) { walk(full); continue; }
    const st = fs.statSync(full);
    stats.files += 1;
    stats.bytes += st.size;
    if (st.size > 5 * 1024 * 1024) problems.push(`${rel}: ${(st.size / 1048576).toFixed(1)} MB（超过 5MB，GitHub 会警告）`);
    if (st.size > 100 * 1024 * 1024) problems.push(`${rel}: 超过 GitHub 100MB 硬上限`);
    if (!/\.(mjs|js|json|md|yml|yaml|txt|html|css|py|ps1)$/i.test(entry.name)) continue;
    let text = '';
    try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
    for (const { re, name } of SECRET_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        if (ALLOW.test(m[0])) continue;
        problems.push(`${rel}: ${name} → ${m[0].slice(0, 40)}`);
      }
    }
  }
}
walk(root);

console.log(`将上传：${stats.files} 个文件 / ${(stats.bytes / 1048576).toFixed(1)} MB（跳过 ${stats.skippedDirs} 个被忽略的目录）`);
if (!problems.length) console.log('✅ 没有发现问题，可以推送');
else {
  console.log(`❌ 发现 ${problems.length} 个问题：`);
  for (const p of problems.slice(0, 40)) console.log('  -', p);
  if (problems.length > 40) console.log(`  …还有 ${problems.length - 40} 条`);
}
process.exit(problems.length ? 1 : 0);
