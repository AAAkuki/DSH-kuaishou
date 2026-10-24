// 端到端：MCP server + 网页版后端（会真的开一个 Edge 窗口）。
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['src/mcp.mjs'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, KSOPS_MODE: 'web' }
});
let buf = '';
const waiters = new Map();
child.stdout.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  }
});
child.stderr.on('data', (c) => process.stderr.write(`[server] ${c}`));
const rpc = (id, method, params) => {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout ${method}`)), 90000);
    waiters.set(id, (m) => { clearTimeout(t); res(m); });
  });
};
const text = (r) => r?.result?.content?.[0]?.text ?? '';

await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

const st = await rpc(2, 'tools/call', { name: 'ks_status', arguments: {} });
console.log('ks_status →', text(st).slice(0, 400));

const c = await rpc(3, 'tools/call', { name: 'ks_comments', arguments: { limit: 3 } });
console.log('ks_comments →', text(c).slice(0, 400));

child.kill();
const ok = /"mode": "web"/.test(text(st)) && /"author"/.test(text(c));
console.log(ok ? '✅ web MCP e2e passed' : '❌ web MCP e2e failed');
process.exit(ok ? 0 : 1);
