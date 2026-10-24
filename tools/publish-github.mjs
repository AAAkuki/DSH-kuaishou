#!/usr/bin/env node
// 用 GitHub REST API 把插件上传成仓库（本机没装 git，github.com 的 443 也不通，但 api.github.com 通）。
//
// 用法：
//   set GITHUB_TOKEN=ghp_xxx
//   node tools/publish-github.mjs --dir "C:/Users/wudiw/Documents/deepseek/快手插件" --repo kuaishou-ops --private
//
// 做的事：校验 token → 建仓库（已存在则直接用）→ 一次性 blob/tree/commit 推上去 → 打印地址。
// 全程只调 api.github.com，不依赖 git、不依赖 github.com 网页。
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.github.com';
const EXCLUDE_DIRS = new Set(['node_modules', 'state', '.web-profile', 'demo', '.git', '.github']);
const EXCLUDE_EXT = /\.(mp4|wav|mp3|png|jpg|jpeg|webp)$/i;
const MAX_BLOB_MB = 20;

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || arg('token', '');
if (!token || typeof token !== 'string') {
  console.error('缺少 token：先 set GITHUB_TOKEN=ghp_xxx（或 --token ghp_xxx）');
  process.exit(2);
}
const dir = path.resolve(String(arg('dir', '.')));
const repoName = String(arg('repo', 'kuaishou-ops'));
const isPrivate = arg('private', false) === true;
const description = String(arg('desc', '快手自动化插件：刷视频/回评论/点赞/发布 + 本地视频流水线 + DSH 插件（设置页图形化）'));

async function api(method, endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'kuaishou-ops-publisher',
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.message || res.statusText;
    const err = new Error(`${method} ${endpoint} → ${res.status} ${msg}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function collect(root) {
  const out = [];
  const walk = (dirRel) => {
    const abs = path.join(root, dirRel);
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = dirRel ? path.posix.join(dirRel, e.name) : e.name;
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.has(e.name)) continue;
        walk(rel);
      } else {
        if (e.name === '.gitkeep') continue;
        const full = path.join(root, rel);
        const size = fs.statSync(full).size;
        if (size > MAX_BLOB_MB * 1024 * 1024) { console.log(`跳过（>${MAX_BLOB_MB}MB）：${rel}`); continue; }
        out.push({ rel, full, size });
      }
    }
  };
  walk('');
  return out;
}

const GITIGNORE = `# 运行期数据（含 Edge 登录态、上传素材、成片）
state/
.web-profile*/
demo/
*.mp4
*.wav
*.mp3
*.log
node_modules/
.DS_Store
Thumbs.db
`;

(async () => {
  console.log('1/4 校验 token…');
  const me = await api('GET', '/user');
  const owner = me.login;
  console.log(`   登录为 ${owner}`);

  console.log(`2/4 准备仓库 ${owner}/${repoName}（${isPrivate ? '私有' : '公开'}）…`);
  let repo;
  try {
    repo = await api('POST', '/user/repos', {
      name: repoName, description, private: isPrivate, auto_init: false, has_issues: true, has_wiki: false
    });
    console.log(`   已创建：${repo.html_url}`);
  } catch (error) {
    if (error.status !== 422) throw error;
    repo = await api('GET', `/repos/${owner}/${repoName}`);
    console.log(`   仓库已存在，直接更新：${repo.html_url}`);
  }

  console.log('3/4 上传文件…');
  const files = collect(dir);
  if (!files.length) throw new Error(`目录里没找到要上传的文件：${dir}`);
  const tree = [];
  let done = 0;
  // 并发 6 个 blob，别把 API 打限流
  const queue = [...files];
  async function worker() {
    while (queue.length) {
      const f = queue.shift();
      const content = fs.readFileSync(f.full).toString('base64');
      const blob = await api('POST', `/repos/${owner}/${repoName}/git/blobs`, { content, encoding: 'base64' });
      tree.push({ path: f.rel, mode: '100644', type: 'blob', sha: blob.sha });
      done++;
      if (done % 20 === 0) console.log(`   ${done}/${files.length}`);
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  // .gitignore 一并放进去（排除运行期数据）
  const giBlob = await api('POST', `/repos/${owner}/${repoName}/git/blobs`, { content: Buffer.from(GITIGNORE).toString('base64'), encoding: 'base64' });
  tree.push({ path: '.gitignore', mode: '100644', type: 'blob', sha: giBlob.sha });
  console.log(`   共 ${tree.length} 个文件`);

  console.log('4/4 建提交并推进分支…');
  const treeObj = await api('POST', `/repos/${owner}/${repoName}/git/trees`, { tree });

  // 空仓库没有 ref，直接建 main；已有则基于最新提交追加
  let parents = [];
  let branch = 'main';
  try {
    const refs = await api('GET', `/repos/${owner}/${repoName}/git/matching-refs/heads/`);
    const main = (refs || []).find((r) => r.ref === 'refs/heads/main') || (refs || []).find((r) => r.ref === 'refs/heads/master');
    if (main) {
      branch = main.ref.replace('refs/heads/', '');
      parents = [{ sha: main.object.sha }];
    }
  } catch { /* 空仓库 */ }

  const commit = await api('POST', `/repos/${owner}/${repoName}/git/commits`, {
    message: `chore: 快手插件 v${JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version}\n\n刷视频/回评论/点赞/发布 + 本地视频流水线（背景/字体/语音可自定义）+ DSH 设置页（总开关、环境检查、说话与打字）`,
    tree: treeObj.sha,
    parents
  });

  if (parents.length) {
    await api('PATCH', `/repos/${owner}/${repoName}/git/refs/heads/${branch}`, { sha: commit.sha, force: true });
  } else {
    await api('POST', `/repos/${owner}/${repoName}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  }

  console.log('\n✅ 上传完成');
  console.log(`   仓库：${repo.html_url}`);
  console.log(`   代码：${repo.html_url}/tree/${branch}`);
  console.log(`   提交：${repo.html_url}/commit/${commit.sha}`);
  console.log(`   文件数：${tree.length}`);
})().catch((error) => {
  console.error(`\n❌ 失败：${error.message}`);
  if (error.data?.errors) console.error(JSON.stringify(error.data.errors, null, 2));
  process.exit(1);
});
