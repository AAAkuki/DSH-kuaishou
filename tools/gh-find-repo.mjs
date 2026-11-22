// 用 token 查仓库：找出 kuaishou 相关的仓库（token 从环境变量读，不落盘）
import fs from 'node:fs';

const token = process.env.GH_TOKEN || '';
if (!token) { console.error('缺 GH_TOKEN'); process.exit(2); }

const H = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'kuaishou-ops-release' };

async function api(path) {
  const r = await fetch(`https://api.github.com${path}`, { headers: H });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

const who = await api('/user');
console.log('账号:', who.status === 200 ? `${who.body.login} (${who.body.type})` : `失败 ${who.status} ${who.body.message || ''}`);
if (who.status !== 200) process.exit(1);

// 列出全部仓库（含私有），分页
const repos = [];
for (let page = 1; page <= 5; page += 1) {
  const r = await api(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner`);
  if (r.status !== 200) { console.log('列仓库失败', r.status, r.body.message); break; }
  repos.push(...r.body);
  if (r.body.length < 100) break;
}
console.log('仓库总数:', repos.length);

const hit = repos.filter((r) => /kuaishou|dsh|快手/i.test(r.name));
console.log('\n=== 名字命中 kuaishou/dsh/快手 ===');
if (!hit.length) console.log('（没有）');
for (const r of hit) {
  console.log(`- ${r.full_name} | private=${r.private} | default=${r.default_branch} | empty=${!r.size} | pushed=${r.pushed_at}`);
}

// 精确探测几个可能的名字
console.log('\n=== 精确探测 ===');
for (const name of ['DSH-kuaishou', 'dsh-kuaishou', 'kuaishou-ops', 'Kuaishou-ops']) {
  const r = await api(`/repos/${who.body.login}/${name}`);
  console.log(`${name}: ${r.status === 200 ? `存在 (private=${r.body.private}, branch=${r.body.default_branch})` : r.status}`);
}

fs.writeFileSync('state/release-repos.json', JSON.stringify({ login: who.body.login, repos: repos.map((r) => ({ full: r.full_name, private: r.private, branch: r.default_branch, size: r.size })) }, null, 2), 'utf8');
console.log('\n已写 state/release-repos.json');
