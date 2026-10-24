// MCP 冒烟：不装 DSH 也能验证 server 能起来、工具列得全、调用链不炸。
// 用 adb 后端 + 干跑，避免在无设备环境下启动浏览器；
// ks_status 在没设备时会返回**可操作**的错误，这本身就是被测行为。
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['src/mcp.mjs'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, KSOPS_DRY: '1', KSOPS_MODE: 'adb' }
});
let buf = '';
const waiters = new Map();

child.stdout.on('data', (c) => {
  buf += c.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
  }
});
child.stderr.on('data', (c) => process.stderr.write(`[server] ${c}`));

function rpc(id, method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), 20000);
    waiters.set(id, (msg) => { clearTimeout(t); resolve(msg); });
  });
}

function textOf(res) { return res?.result?.content?.[0]?.text ?? ''; }

const init = await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
console.log('initialize:', JSON.stringify(init.result?.serverInfo ?? init.error));
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

const tools = await rpc(2, 'tools/list', {});
const names = (tools.result?.tools ?? []).map((t) => t.name);
console.log(`tools (${names.length}):`, names.join(', '));

const status = await rpc(3, 'tools/call', { name: 'ks_status', arguments: {} });
console.log('ks_status →', textOf(status).slice(0, 220).replace(/\n/g, ' '));

const plan = await rpc(4, 'tools/call', { name: 'ks_plan', arguments: {} });
console.log('ks_plan →', textOf(plan).slice(0, 160).replace(/\n/g, ' '));

const state = await rpc(5, 'tools/call', { name: 'ks_state', arguments: {} });
console.log('ks_state →', textOf(state).slice(0, 120).replace(/\n/g, ' '));

const probe = await rpc(6, 'tools/call', { name: 'ks_video_probe', arguments: { file: 'demo/deepseek-demo.mp4' } });
console.log('ks_video_probe →', textOf(probe).slice(0, 160).replace(/\n/g, ' '));

const plist = await rpc(7, 'tools/call', { name: 'ks_prompt_list', arguments: {} });
console.log('ks_prompt_list →', textOf(plist).slice(0, 200).replace(/\n/g, ' '));

const prender = await rpc(8, 'tools/call', { name: 'ks_prompt_render', arguments: { id: 'script', vars: { topic: '测试', durationSec: 30, targetChars: 135, personaSummary: '技术向', platform: '快手' } } });
console.log('ks_prompt_render →', textOf(prender).slice(0, 120).replace(/\n/g, ' '));

child.kill();

const okTools = names.length >= 22;
const statusSane = /❌|没有在线设备|backend/.test(textOf(status));
if (!okTools || !statusSane) {
  console.error('smoke failed:', { okTools, statusSane });
  process.exit(1);
}
console.log('✅ MCP smoke passed');
