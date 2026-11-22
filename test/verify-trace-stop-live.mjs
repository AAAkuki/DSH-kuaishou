// 线上验证：对着真的宿主（DSH 里跑着的插件）检查「思维链 + 停止」这两条链路。
// 不启浏览器、不发视频，只打两个接口。
//
// 用法：node test/verify-trace-stop-live.mjs [port]
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.argv[2]) || 32801;
const base = `http://127.0.0.1:${port}`;
const out = [];

function line(ok, text, detail = '') {
  out.push(`${ok ? '✅' : '❌'} ${text}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

async function getJson(url, opts) {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

let bad = 0;
const check = (ok, text, detail) => { if (!line(ok, text, detail)) bad += 1; };

// 1) 思维链接口的形状
try {
  const { status, body } = await getJson(`${base}/autopilot/trace`);
  check(status === 200 && body?.ok === true, '/autopilot/trace 可用', `HTTP ${status}`);
  check(Array.isArray(body?.events), 'trace 带 events 数组', `events=${body?.events?.length ?? 'n/a'}`);
  check(typeof body?.running === 'boolean', 'trace 带 running', String(body?.running));
  check(Number.isFinite(body?.now), 'trace 带 now（前端算「已运行 N 秒」要用）', String(body?.now));
  const last = (body?.events ?? []).at(-1);
  if (last) out.push(`   最后一步：[${last.phase}] ${last.message}`);
} catch (error) {
  check(false, '/autopilot/trace 连不上', error.message);
}

// 2) 停止接口（只在确实没跑任务时点，避免手滑停掉真实任务）
try {
  const trace = await getJson(`${base}/autopilot/trace`);
  const running = Boolean(trace.body?.running);
  if (running) {
    out.push('⏭  /autopilot/stop 跳过：现在有任务在跑，不敢乱停');
  } else {
    const { status, body } = await getJson(`${base}/autopilot/stop`, { method: 'POST' });
    check(status === 200, '/autopilot/stop 返回 200（旧版恒 503）', `HTTP ${status} ${body?.error ?? ''}`);
    check(body?.ok === true && body?.stopped === true, 'stop 回 {ok, stopped}', JSON.stringify(body));
    check(body?.saved === true, '停止标记落盘（MCP 侧的循环也看得到）', String(body?.saved));
    const t2 = await getJson(`${base}/autopilot/trace`);
    const ev = (t2.body?.events ?? []).at(-1);
    check(ev?.phase === 'stop', '思维链里出现 stop 事件', ev ? `[${ev.phase}] ${ev.message}` : '(空)');
  }
} catch (error) {
  check(false, '/autopilot/stop 连不上', error.message);
}

// 3) 顺手看一眼配额状态，确认没有被那次停止标记污染
try {
  const st = JSON.parse(fs.readFileSync(path.resolve('state/ops-state.json'), 'utf8'));
  out.push(`   ops-state: day=${st.day} scroll=${st.counts?.scroll} reply=${st.counts?.reply} publish=${st.counts?.publish} stopRequested=${st.stopRequested}`);
} catch {}

console.log(out.join('\n'));
console.log(bad === 0 ? '\n全部通过：思维链与停止按钮都是活的' : `\n${bad} 项没过`);
process.exit(bad === 0 ? 0 : 1);
