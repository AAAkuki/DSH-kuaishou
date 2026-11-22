// 把第二版打成"网页上传用"的压缩包（解压后直接拖进 GitHub）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outDir = path.join(root, 'state', 'release');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// 按 .gitignore 收集
const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
  .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  .map((l) => l.replace(/\\/g, '/'));
const ignored = (rel) => {
  const p = rel.replace(/\\/g, '/');
  return ignore.some((rule) => {
    const r = rule.replace(/\/$/, '');
    if (r.startsWith('*')) return p.endsWith(r.slice(1));
    if (r.includes('/')) return p === r || p.startsWith(`${r}/`);
    return p.split('/').includes(r) || p.endsWith(`/${r}`);
  });
};

const stage = path.join(outDir, `DSH-kuaishou-v${pkg.version}`);
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (ignored(rel)) continue;
    if (e.isDirectory()) { walk(full); continue; }
    files.push(rel);
    const dst = path.join(stage, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(full, dst);
  }
})(root);

// 顺带给个"删哪些文件"的清单：第一版里有、第二版没有的
let stale = [];
try {
  const H = { authorization: `Bearer ${process.env.GH_TOKEN || ''}`, accept: 'application/vnd.github+json', 'user-agent': 'release' };
  const r = await fetch('https://api.github.com/repos/AAAkuki/DSH-kuaishou/git/trees/main?recursive=1', { headers: H });
  if (r.ok) {
    const tree = await r.json();
    const remote = new Set((tree.tree || []).filter((t) => t.type === 'blob').map((t) => t.path));
    const local = new Set(files);
    stale = [...remote].filter((p) => !local.has(p)).sort();
  }
} catch { /* 没网/没 token 就算了 */ }

const zip = path.join(outDir, `DSH-kuaishou-v${pkg.version}.zip`);
execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zip}' -Force`], { stdio: 'inherit' });

const bytes = files.reduce((a, f) => a + fs.statSync(path.join(root, f)).size, 0);
const report = {
  version: pkg.version,
  files: files.length,
  bytes,
  zip,
  zipMB: +(fs.statSync(zip).size / 1048576).toFixed(2),
  stale
};
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));
