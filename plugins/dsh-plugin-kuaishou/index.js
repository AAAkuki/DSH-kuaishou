// 快手插件的「设置」页（DSH settings 命名空间）。
//
// 为什么它是独立的一个小插件，而不是塞进 MCP server：
//   DSH 的设置页只认 **loader entry** —— 命名空间由 entry id 推导（这里 id 必须正好是 `kuaishou`，
//   见 cordis.patch.yml），schema 读 entry 的 `fiber.runtime.Config`，且至少一个字段要带
//   `.extra('volatile', true)`（可热改、不重挂载）。MCP server 是独立进程，不参与 profile 装配，
//   拿不到这个位置。与 qq-bridge 用 qq-mode-console 暴露 `qq-mode` 命名空间是同一套机制。
//
// 数据流：设置页改 → cordis 重新 apply(ctx, config) → 本插件拍平写 `state/settings.json`
//       → MCP server 每次 loadConfig() 把这份覆盖层贴到 config.json 之上。
//
// ⚠️ 实测坑：apply 拿到的 config 字段**不是原始值**，而是 `{ get() }` 访问器对象
//   （`config.mode.get() === 'auto'`）。直接 String(config.mode) 会得到 "[object Object]"。
//   所以下面所有取值都先过 unwrapValue()。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { AssetServer } from '../../src/assets.mjs';

export const name = 'dsh-plugin-kuaishou';
/** 命名空间属于 settings seam：声明依赖让 entry 等 settings 就绪后再 activate。 */
export const inject = ['settings'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 找项目根：先 realpath 解掉 junction，再向上找 name=kuaishou-ops 的 package.json。 */
function projectRoot() {
  if (process.env.KSOPS_ROOT) return path.resolve(process.env.KSOPS_ROOT);
  let dir;
  try { dir = fs.realpathSync(__dirname); } catch { dir = __dirname; }
  let cur = dir;
  for (let i = 0; i < 6; i++) {
    const pkg = path.join(cur, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        if (JSON.parse(fs.readFileSync(pkg, 'utf8')).name === 'kuaishou-ops') return cur;
      } catch {}
    }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return path.resolve(dir, '..', '..');
}

/** 现算一份生效配置（含 DSH 设置覆盖），供 /env 用。 */
async function loadRuntimeConfig() {
  const url = (p) => import('node:url').then((u) => u.pathToFileURL(p).href);
  const mod = await import(await url(path.join(projectRoot(), 'src', 'config.mjs')));
  return mod.loadConfig({});
}

function settingsFile() {
  return path.join(projectRoot(), 'state', 'settings.json');
}

function diag(msg) {
  const dest = process.env.KSOPS_DIAG ?? path.join(projectRoot(), 'state', 'plugin.log');
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.appendFileSync(dest, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

/** DSH 把每个字段包成 `{ get() }`；也兼容裸值（测试里直接传对象）。 */
export function unwrapValue(v) {
  if (v && typeof v === 'object' && typeof v.get === 'function') {
    try { return v.get(); } catch { return undefined; }
  }
  return v;
}

const nonEmpty = (v) => v !== undefined && v !== null && String(v).trim() !== '';

/**
 * 设置页的值 → 扁平 settings.json（只写用户真的给了值的键）。
 * 空字符串/非法数字不写：让 config.json 的默认值继续生效，避免"设置页把配置清空"。
 */
export function toSettingsJson(config = {}) {
  const raw = Object.fromEntries(Object.entries(config ?? {}).map(([k, v]) => [k, unwrapValue(v)]));
  const out = {};
  // 开关始终落盘（false 也要写，否则关不掉）
  out.enabled = raw.enabled === undefined ? true : Boolean(raw.enabled);
  if (['auto', 'adb', 'web'].includes(raw.mode)) out.mode = raw.mode;
  if (nonEmpty(raw.webProfileDir)) out.webProfileDir = String(raw.webProfileDir).trim();
  if (nonEmpty(raw.browserPath)) out.browserPath = String(raw.browserPath).trim();
  if (nonEmpty(raw.ffmpegPath)) out.ffmpegPath = String(raw.ffmpegPath).trim();
  if (nonEmpty(raw.videoVoice)) out.videoVoice = String(raw.videoVoice).trim();
  for (const k of ['scrollPerRun', 'replyPerRun', 'likePerRun', 'publishPerDay']) {
    const n = Number(raw[k]);
    if (Number.isFinite(n) && n >= 0) out[k] = n;
  }
  // 视频样式
  for (const k of ['videoBgColor', 'videoBgImage', 'videoBgVideo', 'videoBgPreset', 'videoBgGradientFrom', 'videoBgGradientTo', 'videoFontPath', 'videoFontColor', 'videoTitleColor', 'videoVoice', 'videoBgmFile', 'videoPiperExe', 'videoPiperModel', 'speakCallUser', 'speakCallSelf', 'speakCatchphrases', 'speakForbid']) {
    if (typeof raw[k] === 'string' && raw[k].trim() !== '') out[k] = raw[k].trim();
  }
  if (['cover', 'contain'].includes(raw.videoBgFit)) out.videoBgFit = raw.videoBgFit;
  if (['gentle', 'calm', 'sharp', 'lively', 'pro'].includes(raw.speakTone)) out.speakTone = raw.speakTone;
  {
    const n = Number(raw.speakMaxChars);
    if (Number.isFinite(n) && n > 0) out.speakMaxChars = n;
  }
  for (const k of ['typeEmoji', 'typeTilde', 'typePeriod', 'typeParticles']) {
    if (typeof raw[k] === 'boolean') out[k] = raw[k];
  }
  if (['sapi', 'piper'].includes(raw.videoTtsEngine)) out.videoTtsEngine = raw.videoTtsEngine;
  if (['vertical', 'horizontal'].includes(raw.videoBgGradientAxis)) out.videoBgGradientAxis = raw.videoBgGradientAxis;
  for (const k of ['videoBgDim', 'videoBgBlur', 'videoFontSize', 'videoTitleFontSize', 'videoBoxAlpha', 'videoSubtitleY', 'videoVoiceRate', 'videoBgmGainDb']) {
    const n = Number(raw[k]);
    if (Number.isFinite(n)) out[k] = n;
  }
  for (const k of ['assetsDir']) {
    if (typeof raw[k] === 'string' && raw[k].trim() !== '') out[k] = raw[k].trim();
  }
  for (const k of ['assetsPort', 'assetsMaxMB']) {
    const n = Number(raw[k]);
    if (Number.isFinite(n) && n > 0) out[k] = n;
  }
  if (nonEmpty(raw.personaId)) out.personaId = String(raw.personaId).trim();
  if (typeof raw.personaOverride === 'string' && raw.personaOverride.trim() !== '') out.personaOverride = raw.personaOverride.trim();
  for (const k of ['replyPromptId', 'scriptPromptId']) {
    if (nonEmpty(raw[k])) out[k] = String(raw[k]).trim();
  }
  return out;
}

export const Config = z.object({
  enabled: z.boolean().default(true).description('总开关：打开就自动运行，关掉所有动作都会被拒绝（只看状态/检查环境不受影响）').extra('volatile', true),
  assetsPort: z.number().default(32801).description('设置页「上传」用的本地端口（只监听 127.0.0.1）').extra('volatile', true),
  assetsDir: z.string().default('').description('上传落盘目录；留空 = <项目>/state/assets').extra('volatile', true),
  assetsMaxMB: z.number().default(64).description('单个上传文件大小上限（MB）').extra('volatile', true),
  mode: z.union([
    z.const('auto'), z.const('adb'), z.const('web')
  ]).default('auto').description('后端：auto=有 adb 设备就用模拟器，否则用网页版；adb=强制模拟器/真机；web=强制网页版').extra('volatile', true),
  webProfileDir: z.string().default('.web-profile').description('网页版登录态目录（扫码一次，Cookie 存这里）').extra('volatile', true),
  browserPath: z.string().default('').description('浏览器路径；留空自动找 Edge/Chrome').extra('volatile', true),
  scrollPerRun: z.number().default(30).description('每轮最多刷多少条视频').extra('volatile', true),
  replyPerRun: z.number().default(8).description('每轮最多回复多少条评论').extra('volatile', true),
  likePerRun: z.number().default(5).description('每轮最多点多少个赞').extra('volatile', true),
  publishPerDay: z.number().default(2).description('每天最多发多少条视频').extra('volatile', true),
  // ── 视频：背景 ──
  videoBgColor: z.string().default('0x0f1419').description('纯色背景（如 0x0f1419）；有背景图时忽略').extra('volatile', true),
  videoBgImage: z.string().default('').description('背景图绝对路径（jpg/png）').extra('volatile', true),
  videoBgVideo: z.string().default('').description('背景视频绝对路径（循环、静音）；优先级最高').extra('volatile', true),
  videoBgPreset: z.union([
    z.const(''), z.const('deep-sea'), z.const('night-purple'), z.const('whale-blue'),
    z.const('sakura'), z.const('paper'), z.const('mint')
  ]).default('').description('渐变预设：深海/夜紫/鲸蓝/樱粉/米纸/薄荷；留空=纯色').extra('volatile', true),
  videoBgGradientFrom: z.string().default('').description('自定义渐变起始色（0xRRGGBB）').extra('volatile', true),
  videoBgGradientTo: z.string().default('').description('自定义渐变结束色（0xRRGGBB）').extra('volatile', true),
  videoBgGradientAxis: z.union([z.const('vertical'), z.const('horizontal')]).default('vertical').description('渐变方向').extra('volatile', true),
  videoBgBlur: z.number().default(0).description('背景模糊强度（0~60，图片/视频有效）').extra('volatile', true),
  videoBgFit: z.union([z.const('cover'), z.const('contain')]).default('cover').description('背景图适配：cover 铺满裁切 / contain 完整留边').extra('volatile', true),
  videoBgDim: z.number().default(0.35).description('图片背景压暗 0~1（字幕更清楚）').extra('volatile', true),
  // ── 视频：字体 ──
  videoFontPath: z.string().default('').description('字体文件路径（.ttf/.ttc）；留空自动找微软雅黑').extra('volatile', true),
  videoFontSize: z.number().default(54).description('字幕字号').extra('volatile', true),
  videoTitleFontSize: z.number().default(76).description('标题字号').extra('volatile', true),
  videoFontColor: z.string().default('white').description('字幕颜色（white / yellow / 0xFFE066）').extra('volatile', true),
  videoTitleColor: z.string().default('white').description('标题颜色').extra('volatile', true),
  videoBoxAlpha: z.number().default(0.45).description('字幕底色块透明度 0~1').extra('volatile', true),
  videoSubtitleY: z.number().default(0.76).description('字幕底边位置（占画面高度 0.3~0.98）').extra('volatile', true),
  // ── 视频：声音 ──
  videoTtsEngine: z.union([z.const('sapi'), z.const('piper')]).default('sapi').description('语音引擎：sapi=系统语音（免文件）/ piper=.onnx 模型（自定义音色）').extra('volatile', true),
  videoVoice: z.string().default('Microsoft Huihui Desktop').description('SAPI 语音名；换声音只改这里（不需要文件）').extra('volatile', true),
  videoPiperExe: z.string().default('').description('Piper 可执行文件路径（引擎=piper 时必填）').extra('volatile', true),
  videoPiperModel: z.string().default('').description('Piper 语音模型 .onnx 路径（可上传）').extra('volatile', true),
  videoVoiceRate: z.number().default(0).description('语速 -10~10').extra('volatile', true),
  videoBgmFile: z.string().default('').description('BGM 文件绝对路径；留空=不加').extra('volatile', true),
  videoBgmGainDb: z.number().default(-24).description('BGM 音量（相对配音，dB，负数更小）').extra('volatile', true),
  ffmpegPath: z.string().default('').description('ffmpeg 路径；留空用 node_modules 里 npm 自带的那份').extra('volatile', true),
  personaId: z.union([
    z.const('persona-whale-maid'), z.const('persona'), z.const('persona-cool'), z.const('persona-warm'), z.const('persona-sharp')
  ]).default('persona-whale-maid').description('人设预设：鲸鱼女仆娘（默认）/ 温和技术宅 / 冷面技术宅 / 热心姐姐 / 毒舌但真诚').extra('volatile', true),
  personaOverride: z.string().default('').description('自定义人设正文（非空时优先于上面的预设）').extra('volatile', true),
  speakCallUser: z.string().default('主人').description('怎么称呼你').extra('volatile', true),
  speakCallSelf: z.string().default('我').description('它怎么自称').extra('volatile', true),
  speakTone: z.union([z.const('gentle'), z.const('calm'), z.const('sharp'), z.const('lively'), z.const('pro')]).default('gentle').description('语气：温柔/冷静/毒舌/活泼/专业').extra('volatile', true),
  speakCatchphrases: z.string().default('').description('口头禅，逗号分隔').extra('volatile', true),
  speakMaxChars: z.number().default(40).description('单条回复字数上限').extra('volatile', true),
  typeEmoji: z.boolean().default(true).description('可以用 emoji').extra('volatile', true),
  typeTilde: z.boolean().default(true).description('可以用「～」').extra('volatile', true),
  typePeriod: z.boolean().default(false).description('句末用「。」').extra('volatile', true),
  typeParticles: z.boolean().default(true).description('可以带语气词').extra('volatile', true),
  speakForbid: z.string().default('不承诺收益，不导流，不刷量，不人身攻击').description('禁区，逗号分隔').extra('volatile', true),
  replyPromptId: z.string().default('reply').description('回评论用哪个提示词（prompts/<id>.md 或 state/prompts/<id>.md）').extra('volatile', true),
  scriptPromptId: z.string().default('script').description('口播脚本用哪个提示词').extra('volatile', true)
});

/**
 * 装配：把当前设置写到 state/settings.json。
 * 设置页改动会触发重新 apply，所以不需要额外监听；写失败只记日志，绝不打断 DSH 启动。
 */
let assetServer = null;

export function apply(ctx, config = {}) {
  const flat = toSettingsJson(config);

  // 总开关：关掉时把上传服务停掉（连同"改了就生效"的语义）
  if (flat.enabled === false) {
    try { assetServer?.stop?.(); } catch {}
    assetServer = null;
    diag('apply: disabled → asset server stopped');
  }

  // 上传服务：幂等启动；端口/目录改了要重启 DSH 才换（换端口要重绑）
  if (flat.enabled !== false) try {
    const root = projectRoot();
    const dir = flat.assetsDir ? path.resolve(flat.assetsDir) : path.join(root, 'state', 'assets');
    const port = Number.isFinite(Number(flat.assetsPort)) ? Number(flat.assetsPort) : 32801;
    const maxBytes = (Number.isFinite(Number(flat.assetsMaxMB)) ? Number(flat.assetsMaxMB) : 64) * 1024 * 1024;
    if (!assetServer) {
      assetServer = new AssetServer({ dir, port, maxBytes, log: diag, envProvider: async () => {
        const { pathToFileURL } = await import('node:url');
        const m = await import(pathToFileURL(path.join(projectRoot(), 'src', 'env-check.mjs')).href);
        return m.checkEnvironment({ cfg: await loadRuntimeConfig(), assetsPort: assetServer?.actualPort ?? null, root: projectRoot() });
      },
      styleProvider: async () => {
        const { pathToFileURL } = await import('node:url');
        const [styleMod, cfgMod] = await Promise.all([
          import(pathToFileURL(path.join(projectRoot(), 'src', 'style.mjs')).href),
          loadRuntimeConfig()
        ]);
        const live = cfgMod ?? (await loadRuntimeConfig());
        return { style: live.style ?? {}, guide: styleMod.composeSpeakingGuide(live.style) };
      } });
      assetServer.start().catch((error) => {
        const hint = String(error?.message || '').includes('EADDRINUSE')
          ? `端口 ${port} 被占用：可能是上一次插件实例没释放。换 assetsPort，或重启 DSH`
          : '上传服务启动失败，设置页上传会报 Failed to fetch';
        diag(`[assets] 启动失败：${error?.message ?? error}（${hint}）`);
      });
      // 插件被卸载/热重载时尽量释放端口（cordis 没有统一 dispose 时退化为进程退出回收）
      try { ctx?.effect?.(() => () => { assetServer?.stop?.(); }); } catch {}
    }
  } catch (error) {
    diag(`asset server init failed: ${error?.message ?? error}`);
  }
  const target = settingsFile();
  try {
    // 空 config（例如手工 apply({}) 或装配早期）不该覆盖已有快照——否则会把用户设置清空
    if (Object.keys(flat).length === 0) {
      diag('apply skipped: empty config (keeping previous settings.json)');
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify({ updatedAt: new Date().toISOString(), source: 'dsh-settings', ...flat }, null, 2)}\n`, 'utf8');
      diag(`apply ok → ${target} (${Object.keys(flat).length} keys: ${Object.keys(flat).join(',')})`);
    }
  } catch (error) {
    diag(`apply failed: ${error?.message ?? error}`);
  }
  if (ctx?.logger?.info) ctx.logger.info(`[kuaishou] settings synced → ${target}`);
}
