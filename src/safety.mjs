// 防崩溃工具箱：把「一次异常就整个插件/宿主跟着倒」的地方全部堵上。
//
// 背景（真实事故）：
//   · 插件跑在 DSH 宿主进程里 —— 它抛一个未捕获异常，倒的是**整个 App**，
//     用户看到的是"DSH 打不开"，不会知道是插件。
//   · 素材上传服务是 async 的：`http.createServer((req,res)=>this.handle(req,res))`
//     一旦 handle 里 reject 而没人接，就是 unhandledRejection → Node 默认直接退出。
//   · 状态文件是 writeFileSync 直写：写到一半断电/被杀，下次 load 解析失败，
//     旧版直接 catch 成空状态 —— 计数归零，于是重复发视频。
//
// 这里只做三件事：进程级兜底、原子写、安全读。不引入依赖。
import fs from 'node:fs';
import path from 'node:path';

/** 崩溃/异常日志：state/crash.log，超过 512KB 自动轮转一份 .1 */
export function crashLogFile(root) {
  return path.join(root, 'state', 'crash.log');
}

function rotate(file, maxBytes = 512 * 1024) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`);
  } catch {}
}

/**
 * 进程级兜底：任何漏网的异常都只写日志，不让进程退出。
 * 注意：这只在**独立进程**（MCP server）里安全；宿主里也要装，因为
 * 插件把宿主搞崩的代价比"少做一次操作"大得多。
 *
 * @param {object} opts
 * @param {string} opts.root 项目根（写 crash.log 的位置）
 * @param {(s:string)=>void} [opts.log] 额外输出（stderr / diag）
 * @param {string} [opts.tag] 日志前缀
 * @returns {{record:(error:any,ctx?:string)=>void, file:string, installed:boolean}}
 */
export function installCrashGuard({ root, log = () => {}, tag = 'kuaishou-ops' } = {}) {
  const file = crashLogFile(root);
  let installed = false;

  const record = (error, ctx = '') => {
    const stack = error?.stack || String(error);
    const line = `[${new Date().toISOString()}] ${tag}${ctx ? ` (${ctx})` : ''} ${stack}\n`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      rotate(file);
      fs.appendFileSync(file, line, 'utf8');
    } catch {}
    try { log(`[crash-guard] ${ctx || 'exception'}: ${String(error?.message || error).slice(0, 300)}`); } catch {}
  };

  if (!globalThis.__ksopsCrashGuard) {
    globalThis.__ksopsCrashGuard = true;
    try {
      process.on('uncaughtException', (error) => {
        // 不 exit：插件活着比"干净退出"重要；写日志就够了
        record(error, 'uncaughtException');
      });
      process.on('unhandledRejection', (reason) => {
        record(reason, 'unhandledRejection');
      });
      installed = true;
    } catch {}
  }

  return { record, file, installed };
}

/** 最近 n 条崩溃记录（给 /env 和 ks_env 看）。 */
export function recentCrashes({ root, limit = 5, sinceMs = 24 * 3600 * 1000 } = {}) {
  const file = crashLogFile(root);
  try {
    const st = fs.statSync(file);
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n').filter((l) => l.startsWith('['));
    const since = Date.now() - sinceMs;
    const recent = lines.filter((l) => {
      const t = Date.parse(l.slice(1, 25));
      return Number.isFinite(t) ? t >= since : true;
    });
    return { exists: true, total: lines.length, recent: recent.length, bytes: st.size, last: recent.slice(-limit) };
  } catch {
    return { exists: false, total: 0, recent: 0, bytes: 0, last: [] };
  }
}

/**
 * 原子写 JSON：先写临时文件再 rename。
 * rename 在同一分区上是原子的 —— 中途被杀也只会留下完整旧文件或完整新文件。
 * 同时留一份 .bak，读失败时可回退。
 */
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const text = `${JSON.stringify(data, null, 2)}\n`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    // rename 失败（例如被占用）时退化成直写，至少别丢数据
    fs.writeFileSync(file, text, 'utf8');
    throw Object.assign(error, { degraded: true });
  }
  return file;
}

/**
 * 安全读 JSON：解析失败时把坏文件留档（.corrupt-时间戳），再试 .bak，最后用兜底值。
 * 返回值里的 recovered 说明走了哪条路，调用方可以据此记一条 trace。
 */
export function readJsonSafe(file, fallback = null) {
  const tryParse = (p) => {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  };
  try {
    return { value: tryParse(file), source: 'main', recovered: false };
  } catch (error) {
    if (error?.code === 'ENOENT') return { value: fallback, source: 'missing', recovered: false };
  }
  // 坏文件留档，别直接覆盖掉（可能是手工改坏的，用户还想看）
  try {
    fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
  } catch {}
  try {
    return { value: tryParse(`${file}.bak`), source: 'bak', recovered: true };
  } catch {}
  return { value: fallback, source: 'fallback', recovered: true };
}

/** 给任意 Promise 套超时：卡住的 Edge/ffmpeg 不该把整轮冻结。 */
export function withTimeout(promise, ms, label = 'operation') {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // 打标记：调用方要能区分「超时（可以跳过）」和「真报错（该按失败处理）」
      const error = new Error(`${label} 超时（${Math.round(ms / 1000)} 秒没动静）`);
      error.isTimeout = true;
      reject(error);
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 一段异步代码里出任何错都不往外抛，只记日志。 */
export async function bestEffort(fn, { onError = () => {}, label = 'task' } = {}) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    try { onError(error, label); } catch {}
    return { ok: false, error };
  }
}
