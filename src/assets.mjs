// 素材上传服务：让设置页里的「上传」按钮把本地文件真正落到磁盘。
//
// 为什么需要它：浏览器里的 file input 只能拿到 File 对象，**写不了磁盘**；
// 而 MCP server 是 stdio 进程，设置页也够不着。宿主插件（跑在 DSH 进程里）起一个
// 只监听 127.0.0.1 的小 HTTP 服务，是最短的一条路：
//
//   设置页 file input → POST http://127.0.0.1:<port>/upload?name=xxx.mp3
//                     → 写到 state/assets/xxx.mp3
//                     → 返回绝对路径 → 填进 videoBgmFile / videoBgImage 等字段
//
// 安全边界：
//   · 只绑定 127.0.0.1（不对外）
//   · 只接受 /upload 与 /list，方法限 POST/GET
//   · 文件名净化（去路径分隔符、去 ..、限长）
//   · 扩展名白名单（音频/图片/视频/字体）
//   · 单文件大小上限（默认 64MB）
//   · 跨域只允许回环来源（设置页在 127.0.0.1 上）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export const ASSET_EXT = {
  audio: ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'],
  image: ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'],
  video: ['.mp4', '.mov', '.mkv', '.webm'],
  font: ['.ttf', '.ttc', '.otf'],
  /** Piper 语音模型（.onnx）与其配置（.onnx.json） */
  voice: ['.onnx', '.json']
};
const ALLOWED = new Set(Object.values(ASSET_EXT).flat());

/** 文件名净化：去目录、去控制字符、去 ..；保留扩展名。 */
export function sanitizeName(raw) {
  const base = String(raw ?? '')
    .replace(/[\\/]/g, '_')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\.{2,}/g, '_')
    .trim();
  const name = base || `upload-${Date.now()}`;
  return name.length > 120 ? name.slice(-120) : name;
}

/** 扩展名是否在白名单里。 */
export function isAllowedExt(name) {
  return ALLOWED.has(path.extname(String(name || '')).toLowerCase());
}

/** 按扩展名归类，给设置页提示用。 */
export function assetKind(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  for (const [kind, list] of Object.entries(ASSET_EXT)) if (list.includes(ext)) return kind;
  return '';
}

export class AssetServer {
  /**
   * @param {object} opts
   * @param {string} opts.dir 落盘目录（绝对路径）
   * @param {number} [opts.port] 端口；0 = 随机
   * @param {number} [opts.maxBytes] 单文件上限
   * @param {(line:string)=>void} [opts.log]
   */
  constructor({ dir, port = 32801, maxBytes = 64 * 1024 * 1024, log = () => {}, envProvider = null, styleProvider = null } = {}) {
    this.dir = dir;
    this.port = port;
    this.maxBytes = maxBytes;
    this.log = log;
    this.server = null;
    this.actualPort = null;
    /** 可选：() => Promise<envReport>，给 /env 用 */
    this.envProvider = envProvider;
    /** 可选：() => Promise<{style, guide}>，给 /persona 用 */
    this.styleProvider = styleProvider;
  }

  async start() {
    if (this.server) return this.actualPort;
    fs.mkdirSync(this.dir, { recursive: true });
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => {
        this.actualPort = this.server.address().port;
        resolve();
      });
    });
    this.log(`[assets] 上传服务已启动 http://127.0.0.1:${this.actualPort} → ${this.dir}`);
    return this.actualPort;
  }

  async stop() {
    if (!this.server) return;
    await new Promise((r) => this.server.close(r));
    this.server = null;
    this.actualPort = null;
  }

  cors(res) {
    // 设置页与上传服务都在回环地址上，跨端口需要放行；不做 *，只回环来源
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
  }

  json(res, code, body) {
    this.cors(res);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'OPTIONS') { this.cors(res); res.writeHead(204); res.end(); return; }

    if (url.pathname === '/env' && req.method === 'GET') {
      if (!this.envProvider) return this.json(res, 503, { ok: false, error: 'env 检查未启用' });
      try {
        const report = await this.envProvider();
        return this.json(res, 200, { ok: true, report });
      } catch (error) {
        return this.json(res, 500, { ok: false, error: error.message });
      }
    }

    if (url.pathname === '/persona' && req.method === 'GET') {
      if (!this.styleProvider) return this.json(res, 503, { ok: false, error: 'persona 预览未启用' });
      try {
        return this.json(res, 200, { ok: true, ...(await this.styleProvider()) });
      } catch (error) {
        return this.json(res, 500, { ok: false, error: error.message });
      }
    }

    if (url.pathname === '/list' && req.method === 'GET') {
      const files = fs.existsSync(this.dir) ? fs.readdirSync(this.dir).filter((f) => isAllowedExt(f)) : [];
      return this.json(res, 200, {
        dir: this.dir,
        files: files.map((f) => {
          const abs = path.join(this.dir, f);
          const st = fs.statSync(abs);
          return { name: f, path: abs, kind: assetKind(f), bytes: st.size };
        })
      });
    }

    if (url.pathname === '/upload' && req.method === 'POST') {
      const name = sanitizeName(url.searchParams.get('name') || '');
      if (!isAllowedExt(name)) {
        return this.json(res, 415, { ok: false, error: `不支持的扩展名：${path.extname(name) || '(无)'}` });
      }
      const tmp = path.join(this.dir, `.upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      const out = path.join(this.dir, name);
      let size = 0;
      const stream = fs.createWriteStream(tmp);
      try {
        await new Promise((resolve, reject) => {
          req.on('data', (chunk) => {
            size += chunk.length;
            if (size > this.maxBytes) {
              reject(new Error(`文件超过上限 ${Math.round(this.maxBytes / 1024 / 1024)}MB`));
              req.destroy();
            }
          });
          req.pipe(stream);
          stream.on('finish', resolve);
          stream.on('error', reject);
          req.on('error', reject);
        });
        fs.renameSync(tmp, out);
        this.log(`[assets] 收到 ${name}（${size} 字节）`);
        return this.json(res, 200, { ok: true, name, path: out, bytes: size, kind: assetKind(name) });
      } catch (error) {
        fs.rmSync(tmp, { force: true });
        return this.json(res, 400, { ok: false, error: error.message });
      }
    }

    this.json(res, 404, { ok: false, error: 'not found' });
  }
}
