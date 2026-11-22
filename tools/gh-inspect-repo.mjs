// 看仓库现状：第一版推了什么、默认分支、最后一次提交
const token = process.env.GH_TOKEN || '';
if (!token) { console.error('缺 GH_TOKEN'); process.exit(2); }
const H = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'kuaishou-ops-release' };
const REPO = process.env.GH_REPO || 'AAAkuki/DSH-kuaishou';

async function api(path) {
  const r = await fetch(`https://api.github.com${path}`, { headers: H });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const info = await api(`/repos/${REPO}`);
console.log('仓库:', info.body.full_name, '| private:', info.body.private, '| default:', info.body.default_branch);
console.log('大小:', info.body.size, 'KB | 创建:', info.body.created_at);

const commits = await api(`/repos/${REPO}/commits?per_page=5`);
console.log('\n=== 最近提交 ===');
if (Array.isArray(commits.body)) {
  for (const c of commits.body) console.log(`- ${c.sha.slice(0, 8)} ${c.commit.message.split('\n')[0]} (${c.commit.author.date})`);
} else console.log(commits.status, commits.body.message);

const tree = await api(`/repos/${REPO}/git/trees/${info.body.default_branch}?recursive=1`);
if (tree.status === 200) {
  const files = tree.body.tree.filter((t) => t.type === 'blob');
  console.log(`\n=== 仓库文件数: ${files.length} ===`);
  const dirs = {};
  for (const f of files) {
    const d = f.path.includes('/') ? f.path.split('/')[0] : '(根)';
    dirs[d] = (dirs[d] || 0) + 1;
  }
  console.log(Object.entries(dirs).sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d}: ${n}`).join('\n'));
  console.log('\n根目录文件:', files.filter((f) => !f.path.includes('/')).map((f) => f.path).join(', '));
} else {
  console.log('读 tree 失败:', tree.status, tree.body.message);
}
