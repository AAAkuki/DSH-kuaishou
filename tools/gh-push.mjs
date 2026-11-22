// 用 GitHub Git Data API 推送源码（不需要本地 git）。
// token 从环境变量 GH_TOKEN 读，不落盘。
//
//   node tools/gh-push.mjs --dry        只算不推
//   node tools/gh-push.mjs              推送到默认分支
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = process.env.GH_TOKEN || '';
const REPO = process.env.GH_REPO || 'AAAkuki/DSH-kuaishou';
const dry = process.argv.includes('--dry');
const message = process.env.GH_MESSAGE || `chore: 更新到 v${JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version}`;

if (!token) { console.error('缺 GH_TOKEN'); process.exit(2); }
const H = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'kuaishou-ops-release', 'content-type': 'application/json' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body) {
  const r = await fetch(`https://api.github.com${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 200) }; }
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${json.message || ''} ${json.errors ? JSON.stringify(json.errors).slice(0, 200) : ''}`);
  return json;
}

// 限速友好的调用：403 二级限流 / 429 / 5xx 时指数退避重试
async function apiRetry(method, p, body, tries = 6) {
  let wait = 4000;
  for (let i = 0; i < tries; i += 1) {
    try {
      const out = await api(method, p, body);
      await sleep(120);
      return out;
    } catch (e) {
      const msg = String(e.message || '');
      const retriable = /→ (403|429|500|502|503|504)/.test(msg) && /rate limit|secondary|abuse|try again/i.test(msg) || /→ (429|500|502|503|504)/.test(msg);
      if (!retriable || i === tries - 1) throw e;
      console.log(`  ⏳ 限流/瞬时错误，${wait}ms 后重试 (${i + 1}/${tries - 1})`);
      await sleep(wait);
      wait = Math.min(wait * 2, 60000);
    }
  }
}

/* ---------- 1. 按 .gitignore 收集要上传的文件 ---------- */
const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
  .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  .map((l) => l.replace(/\\/g, '/'));

function ignored(rel) {
  const p = rel.replace(/\\/g, '/');
  // .git 自身永远不进仓库（GitHub 会拒绝 .git 作为路径组件）
  if (p === '.git' || p.startsWith('.git/')) return true;
  return ignore.some((rule) => {
    const r = rule.replace(/\/$/, '');
    if (r.startsWith('*')) return p.endsWith(r.slice(1));
    if (r.includes('/')) return p === r || p.startsWith(`${r}/`);
    return p.split('/').includes(r) || p.endsWith(`/${r}`);
  });
}

const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (ignored(rel)) continue;
    if (e.isDirectory()) { walk(full); continue; }
    files.push(rel);
  }
}
walk(root);
files.sort();
const totalBytes = files.reduce((a, f) => a + fs.statSync(path.join(root, f)).size, 0);
console.log(`待上传 ${files.length} 个文件 / ${(totalBytes / 1048576).toFixed(2)} MB`);
if (dry) { console.log(files.slice(0, 20).join('\n')); console.log('…'); process.exit(0); }

/* ---------- 2. 读默认分支与当前提交 ---------- */
const info = await api('GET', `/repos/${REPO}`);
const branch = info.default_branch || 'main';
let baseSha = '';
try {
  const ref = await api('GET', `/repos/${REPO}/git/ref/heads/${branch}`);
  baseSha = ref.object.sha;
} catch (e) {
  console.log(`分支 ${branch} 还不存在，将创建首个提交`);
}
console.log(`仓库 ${REPO} / 分支 ${branch} / base ${baseSha ? baseSha.slice(0, 8) : '(空)'}`);

/* ---------- 3. 逐文件建 blob（并发 3，带退避） ---------- */
const blobs = [];
let done = 0;
async function worker(queue) {
  while (queue.length) {
    const rel = queue.shift();
    const content = fs.readFileSync(path.join(root, rel));
    const b = await apiRetry('POST', `/repos/${REPO}/git/blobs`, { content: content.toString('base64'), encoding: 'base64' });
    blobs.push({ path: rel, mode: '100644', type: 'blob', sha: b.sha });
    done += 1;
    if (done % 40 === 0) console.log(`  已建 blob ${done}/${files.length}`);
  }
}
const queue = files.slice();
await Promise.all(Array.from({ length: 3 }, () => worker(queue)));
console.log(`blob 完成: ${blobs.length}`);

/* ---------- 4. 建 tree / commit / 更新 ref ---------- */
const tree = await api('POST', `/repos/${REPO}/git/trees`, { tree: blobs });
const commit = await api('POST', `/repos/${REPO}/git/commits`, {
  message, tree: tree.sha, parents: baseSha ? [baseSha] : []
});
if (baseSha) {
  await api('PATCH', `/repos/${REPO}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
} else {
  await api('POST', `/repos/${REPO}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
}
console.log(`\n✅ 推送完成`);
console.log(`commit: ${commit.sha}`);
console.log(`tree:   ${tree.sha}`);
console.log(`分支:   ${branch}`);
console.log(`文件:   ${blobs.length} 个 / ${(totalBytes / 1048576).toFixed(2)} MB`);
console.log(`地址:   https://github.com/${REPO}`);
fs.writeFileSync(path.join(root, 'state', 'last-push.json'), JSON.stringify({ repo: REPO, branch, commit: commit.sha, files: blobs.length, bytes: totalBytes, at: new Date().toISOString(), message }, null, 2), 'utf8');
