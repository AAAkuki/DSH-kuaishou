// 诊断 token 的权限：能不能读、能不能写
const token = process.env.GH_TOKEN || '';
if (!token) { console.error('缺 GH_TOKEN'); process.exit(2); }
const H = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'kuaishou-ops-release', 'content-type': 'application/json' };
const REPO = process.env.GH_REPO || 'AAAkuki/DSH-kuaishou';

async function probe(label, method, p, body) {
  const r = await fetch(`https://api.github.com${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let msg = '';
  try { const j = JSON.parse(text); msg = j.message || ''; } catch { msg = text.slice(0, 80); }
  console.log(`${r.ok ? '✅' : '❌'} ${label.padEnd(30)} ${r.status} ${msg}`);
  return r.ok;
}

// token 自己声明的权限（细粒度 token 会返回 x-accepted / 权限头）
const r = await fetch('https://api.github.com/user', { headers: H });
console.log('token 可接受权限:', r.headers.get('x-accepted-github-permissions') || '(无)');
console.log('OAuth scopes:', r.headers.get('x-oauth-scopes') || '(细粒度 token 不返回)');
console.log('');

await probe('读仓库信息', 'GET', `/repos/${REPO}`);
await probe('读文件树', 'GET', `/repos/${REPO}/git/trees/main`);
await probe('列 commits', 'GET', `/repos/${REPO}/commits?per_page=1`);
await probe('读 git ref', 'GET', `/repos/${REPO}/git/ref/heads/main`);
await probe('建 blob（写 Contents）', 'POST', `/repos/${REPO}/git/blobs`, { content: 'test', encoding: 'utf-8' });
await probe('读用户信息', 'GET', '/user');
