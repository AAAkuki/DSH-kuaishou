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
import { installCrashGuard, writeJsonAtomic, recentCrashes } from '../../src/safety.mjs';

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

/**
 * 同步读一份 OpsState（停止按钮要用，不能 await）。
 * 直接内联 JSON 读写，避免为一个布尔标记引入异步 import。
 */
function loadOpsState() {
  const file = path.join(projectRoot(), 'state', 'ops-state.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch {}
  return {
    requestStop(reason = '用户停止') {
      data.stopRequested = true;
      data.stopReason = reason;
      data.stopAt = Date.now();
      return true;
    },
    clearStop() {
      data.stopRequested = false;
      data.stopReason = '';
      return true;
    },
    save() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    }
  };
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
  if (typeof raw.webPersist === 'boolean') out.webPersist = raw.webPersist;
  if (Number.isFinite(Number(raw.webIdleCloseMin))) out.webIdleCloseMin = Number(raw.webIdleCloseMin);
  if (nonEmpty(raw.ffmpegPath)) out.ffmpegPath = String(raw.ffmpegPath).trim();
  if (nonEmpty(raw.videoVoice)) out.videoVoice = String(raw.videoVoice).trim();
  for (const k of ['scrollPerRun', 'replyPerRun', 'likePerRun', 'publishPerDay', 'scrollRunMaxMinutes']) {
    const n = Number(raw[k]);
    if (Number.isFinite(n) && n >= 0) out[k] = n;
  }
  // 视频样式
  for (const k of ['videoBgColor', 'videoBgImage', 'videoBgVideo', 'videoBgPreset', 'videoBgGradientFrom', 'videoBgGradientTo', 'videoFontPath', 'videoFontColor', 'videoTitleColor', 'videoVoice', 'videoBgmFile', 'videoPiperExe', 'videoPiperModel', 'speakCallUser', 'speakCallSelf', 'speakCatchphrases', 'speakForbid', 'replyTagWhitelist', 'replyWhitelist', 'replyVideoTagWhitelist', 'replyAtOwner', 'videoTitleBar', 'videoAiBadge', 'videoSpeakerName', 'videoStickerPos', 'videoStickerSizeName', 'videoVoiceSoften', 'videoVoiceCute', 'publishTopics', 'publishCoverFile', 'publishTitle']) {
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
  for (const k of ['cute_stutter', 'cute_breath', 'cute_pause']) {
    if (typeof raw[k] === 'boolean') out[k] = raw[k];
  }
  {
    const n = Number(raw.videoLengthScale);
    if (Number.isFinite(n) && n > 0.5 && n < 3) out.videoLengthScale = n;
  }
  if (typeof raw.videoStickerFile === 'string') out.videoStickerFile = raw.videoStickerFile;
  if (typeof raw.videoStickerPos === 'string') out.videoStickerPos = raw.videoStickerPos;
  if (typeof raw.videoStickerSizeName === 'string') out.videoStickerSizeName = raw.videoStickerSizeName;
  if (typeof raw.videoStickerAutoEmotion === 'boolean') out.videoStickerAutoEmotion = raw.videoStickerAutoEmotion;
  if (typeof raw.videoStickerPerLine === 'boolean') out.videoStickerPerLine = raw.videoStickerPerLine;
  if (typeof raw.loopEnabled === 'boolean') out.loopEnabled = raw.loopEnabled;
  if (typeof raw.replyIncludeOwn === 'boolean') out.replyIncludeOwn = raw.replyIncludeOwn;
  if (typeof raw.liveRecord === 'boolean') out.liveRecord = raw.liveRecord;
  for (const k of ['liveRoomUrl', 'liveTokenKey']) {
    if (typeof raw[k] === 'string') out[k] = raw[k];
  }
  if (Number.isFinite(Number(raw.liveJumps))) out.liveJumps = Math.min(60, Math.max(1, Number(raw.liveJumps)));
  if (typeof raw.loopResetQuota === 'boolean') out.loopResetQuota = raw.loopResetQuota;
  for (const k of ['loopGapSec', 'loopMaxRounds', 'summaryPerDay', 'searchLimit', 'searchFeedToVideo', 'videoLineCount']) {
    const n = Number(raw[k]);
    if (Number.isFinite(n)) out[k] = n;
  }
  if (typeof raw.searchEnabled === 'boolean') out.searchEnabled = raw.searchEnabled;
  if (typeof raw.searchKeywords === 'string') out.searchKeywords = raw.searchKeywords;
  if (typeof raw.summaryRefresh === 'boolean') out.summaryRefresh = raw.summaryRefresh;
  for (const k of ['videoStickerX2', 'videoStickerY2', 'videoMinDurationSec', 'videoTargetDurationSec']) {
    const n = Number(raw[k]);
    if (Number.isFinite(n)) out[k] = n;
  }
  if (typeof raw.videoStickerKey === 'string') out.videoStickerKey = raw.videoStickerKey;
  if (typeof raw.videoTitleBar === 'string') out.videoTitleBar = raw.videoTitleBar;
  if (typeof raw.videoAiBadge === 'string') out.videoAiBadge = raw.videoAiBadge;
  if (typeof raw.videoSpeakerName === 'string') out.videoSpeakerName = raw.videoSpeakerName;
  if (typeof raw.videoTyping === 'boolean') out.videoTyping = raw.videoTyping;
  if (typeof raw.videoStats === 'boolean') out.videoStats = raw.videoStats;
  if (typeof raw.textDeai === 'boolean') out.textDeai = raw.textDeai;
  {
    const n = Number(raw.videoStickerSize);
    if (Number.isFinite(n) && n > 0.05 && n <= 0.5) out.videoStickerSize = n;
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
  webPersist: z.boolean().default(true).description('网页常驻：跑完不关浏览器，下次直接用（关掉每次都要重启，又慢又容易撞锁）').extra('volatile', true),
  webIdleCloseMin: z.number().default(30).description('常驻时闲置多少分钟自动关（0 = 永不关）').extra('volatile', true),
  scrollPerRun: z.number().default(0).description('每轮最多刷多少条视频；0 = 不限（按时间兜底，见下面"最多刷几分钟"）').extra('volatile', true),
  scrollRunMaxMinutes: z.number().default(10).description('不限条数时最多刷几分钟').extra('volatile', true),
  replyPerRun: z.number().default(0).description('每轮最多回多少条评论；0 = 不限额度').extra('volatile', true),
  likePerRun: z.number().default(5).description('每轮最多点多少个赞').extra('volatile', true),
  loopEnabled: z.boolean().default(false).description('自动循环：跑完接着刷，直到用户停止').extra('volatile', true),
  loopResetQuota: z.boolean().default(true).description('配额用完自动重置后继续刷').extra('volatile', true),
  loopGapSec: z.number().default(20).description('每轮之间休息几秒').extra('volatile', true),
  loopMaxRounds: z.number().default(0).description('最多循环几巡（0 = 不限，一直跑到我点停止）').extra('volatile', true),
  searchEnabled: z.boolean().default(true).description('网上冲浪时顺手搜索关键词').extra('volatile', true),
  searchKeywords: z.string().default('deepseek,ai 绘画,大模型 教程,Claude').description('搜索关键词，逗号分隔，轮着搜').extra('volatile', true),
  searchLimit: z.number().default(6).description('每次搜索读几条结果').extra('volatile', true),
  searchFeedToVideo: z.number().default(3).description('把搜索结果写进总结视频的几条').extra('volatile', true),
  videoLineCount: z.number().default(12).description('字幕句数：12 句≈一分钟，想更长就加').extra('volatile', true),
  videoStats: z.boolean().default(true).description('视频里带上自己的真实数据（播放量/点赞/涨粉/最新作品）').extra('volatile', true),
  textDeai: z.boolean().default(true).description('去 AI 味：出片前机械清洗八股连接词/客服腔/大词/形容词堆料（数字不动）').extra('volatile', true),
  goalFans: z.number().default(10000).description('目标粉丝数：视频里会提"冲 X 粉"').extra('volatile', true),
  summaryPerDay: z.number().default(2).description('总结视频每天最多几条').extra('volatile', true),
  summaryRefresh: z.boolean().default(true).description('刷新总结视频（关掉 = 沿用今天的）').extra('volatile', true),
  publishPerDay: z.number().default(2).description('每天最多发多少条视频').extra('volatile', true),
  publishTopics: z.string().default('deepseek,大肥鱼').description('默认话题标签，逗号分隔（不带 #）').extra('volatile', true),
  publishCoverFile: z.string().default('state/assets/cover-whale-maid.jpg').description('默认封面图（可上传）').extra('volatile', true),
  publishTitle: z.string().default('').description('作品标题（可留空）').extra('volatile', true),
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
  videoVoiceCute: z.union([z.const(''), z.const('loli'), z.const('loli_hard'), z.const('loli_soft'), z.const('natural')]).default('').description('萝莉音/自然音：升调+童声塑形，配合 piper 使用；natural = 不升调最不容易诡异').extra('volatile', true),
  cute_stutter: z.boolean().default(true).description('口吃（重复首字）').extra('volatile', true),
  cute_breath: z.boolean().default(true).description('句间喘气').extra('volatile', true),
  cute_pause: z.boolean().default(true).description('随机停顿').extra('volatile', true),
  videoLengthScale: z.number().default(1.12).description('piper 语速（>1 更慢）').extra('volatile', true),
  videoTitleBar: z.string().default('').description('左上角栏目名（参考视频风格）').extra('volatile', true),
  videoAiBadge: z.string().default('').description('右上角合规标识；留空不显示').extra('volatile', true),
  videoSpeakerName: z.string().default('大肥鱼').description('对话框左上角名字标签；留空不显示').extra('volatile', true),
  videoTyping: z.boolean().default(true).description('打字光标闪烁').extra('volatile', true),
  videoStickerFile: z.string().default('').description('指定一张贴纸；留空则用 stickers 目录里的全部按情绪自动挑').extra('volatile', true),
  videoStickerPos: z.string().default('beside-box').description('贴纸位置：beside-box/left-top/left-bottom/right-top/right-bottom/center').extra('volatile', true),
  videoStickerSizeName: z.string().default('medium').description('贴纸大小：small/medium/large').extra('volatile', true),
  videoStickerAutoEmotion: z.boolean().default(true).description('按文案情绪自动挑贴纸').extra('volatile', true),
  videoStickerPerLine: z.boolean().default(true).description('每句换一张表情（中途替换）').extra('volatile', true),
  videoStickerX2: z.number().default(0.20).description('贴纸横向位置 0~1').extra('volatile', true),
  videoStickerY2: z.number().default(0.60).description('贴纸纵向位置 0~1').extra('volatile', true),
  videoStickerKey: z.string().default('auto').description('自动抠底：auto / off').extra('volatile', true),
  videoMinDurationSec: z.number().default(55).description('最短视频时长（秒）').extra('volatile', true),
  videoTargetDurationSec: z.number().default(58).description('目标时长（秒），约 1 分钟').extra('volatile', true),
  videoVoiceSoften: z.union([z.const(''), z.const('none'), z.const('clean'), z.const('soft'), z.const('softer'), z.const('mellow')]).default('soft').description('声音柔化：none/clean/soft/softer/mellow').extra('volatile', true),
  videoBgmFile: z.string().default('').description('BGM 文件绝对路径；留空=不加').extra('volatile', true),
  videoBgmGainDb: z.number().default(-24).description('BGM 音量（相对配音，dB，负数更小）').extra('volatile', true),
  ffmpegPath: z.string().default('').description('ffmpeg 路径；留空用 node_modules 里 npm 自带的那份').extra('volatile', true),
  personaId: z.union([
    z.const('persona-cetacea'), z.const('persona-whale-maid'), z.const('persona'), z.const('persona-cool'), z.const('persona-warm'), z.const('persona-sharp')
  ]).default('persona-cetacea').description('人设预设：鲸鱼女孩 CETACEA_LOLI（默认：傲娇又甜 + 爱吃米饭 + 聪明但懒）/ 鲸鱼女仆娘 / 温和技术宅 / 冷面技术宅 / 热心姐姐 / 毒舌但真诚').extra('volatile', true),
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
  replyWhitelist: z.string().default('').description('关键词白名单：留空 = 只要不是黑名单都回（想积极就留空）').extra('volatile', true),
  replyTagWhitelist: z.string().default('').description('评论标签白名单，逗号分隔；命中即回（优先于关键词白名单）').extra('volatile', true),
  replyVideoTagWhitelist: z.string().default('').description('视频标签白名单：只在带这些话题的视video下回评，逗号分隔；留空不限制').extra('volatile', true),
  replyAtOwner: z.string().default('').description('运营评论时 @ 谁：主人 / 管理员 / 具体昵称；留空不 @').extra('volatile', true),
  replyIncludeOwn: z.boolean().default(true).description('自己作品下的评论也一起回').extra('volatile', true),
  // ── 直播（插件内功能，和 Vibe 视频无关）
  liveRoomUrl: z.string().default('').description('默认直播间链接（www.kuaishou.com 的直播页）').extra('volatile', true),
  liveTokenKey: z.string().default('').description('DeepSeek API key：用来在直播画面上显示 token 余额（留空读环境变量）').extra('volatile', true),
  liveJumps: z.number().default(12).description('一场直播里 AI 玩几次跳一跳').extra('volatile', true),
  liveRecord: z.boolean().default(true).description('把这一场直播画面录下来（推流可用它当源）').extra('volatile', true),
  replyPromptId: z.string().default('reply').description('回评论用哪个提示词（prompts/<id>.md 或 state/prompts/<id>.md）').extra('volatile', true),
  scriptPromptId: z.string().default('script').description('口播脚本用哪个提示词').extra('volatile', true)
});

/**
 * 装配：把当前设置写到 state/settings.json。
 * 设置页改动会触发重新 apply，所以不需要额外监听；写失败只记日志，绝不打断 DSH 启动。
 */
let assetServer = null;
/** 进程级兜底（宿主里装一次就够；装两次会重复写日志） */
let crashGuard = null;
/** 全自动的"思维链"：宿主内存里留着最近 400 条，设置页轮询 /autopilot/trace 显示 */
const autoTrace = { running: false, startedAt: 0, events: [], result: null, seq: 0, lastAt: 0 };
/**
 * 停止闸门：点「停止」立刻返回，但真正的循环跑在 autopilot 里。
 * 运行中的 OpsState 是启动时 load() 出来的一份内存快照，光改文件它是看不见的，
 * 所以这里必须留一个进程内的标记，让 shouldStop() 每轮都能读到。
 */
const autoStop = { requested: false, at: 0, reason: '' };
function pushTrace(event) {
  autoTrace.seq += 1;
  autoTrace.lastAt = Date.now();
  autoTrace.events.push({ at: new Date().toISOString(), seq: autoTrace.seq, ...event });
  if (autoTrace.events.length > 400) autoTrace.events.splice(0, autoTrace.events.length - 400);
  try { diag(`[autopilot:${event.phase}] ${event.message}`); } catch {}
}

export function apply(ctx, config = {}) {
  // apply 里的任何异常都不能影响 DSH 启动（不然插件坏了 = App 打不开）
  try {
    applyInner(ctx, config);
  } catch (error) {
    try {
      diag('[fatal] apply 失败（已吞掉，不影响 DSH 启动）: ' + (error && error.stack ? error.stack.split('\n').slice(0, 4).join(' | ') : String(error)));
    } catch {}
  }
}

function applyInner(ctx, config = {}) {
  const flat = toSettingsJson(config);

  // 插件跑在 DSH 宿主进程里：一次漏网异常倒的是整个 App。
  // 装上兜底（幂等），把它自己的异常写进 state/crash.log 而不是让宿主退出。
  try {
    crashGuard = crashGuard ?? installCrashGuard({ root: projectRoot(), log: diag, tag: 'kuaishou-ops(host)' });
  } catch (error) {
    diag(`[crash-guard] 安装失败（不影响启动）: ${error?.message ?? error}`);
  }

  // 记一次"宿主启动"：DSH 每次启动都会新增一个 dsh-auth-* cookie，攒到 ~70 个就打不开 App。
  // 那个 Cookie 库运行时被独占锁着（谁读都是 EBUSY），只能靠这个计数当代理指标。
  try {
    const f = path.join(projectRoot(), 'state', 'dsh-launches.json');
    let rec = { pid: 0, count: 0, lastAt: '' };
    try { rec = { ...rec, ...JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch {}
    if (rec.pid !== process.pid) {
      rec = { pid: process.pid, count: Number(rec.count || 0) + 1, lastAt: new Date().toISOString() };
      writeJsonAtomic(f, rec);
      if (rec.count >= 40) diag(`[cookie-guard] DSH 已连续启动 ${rec.count} 次没清理认证 Cookie：跑 fix-dsh-auth-cookies.mjs`);
    }
  } catch (error) {
    diag(`[cookie-guard] 计数失败（不影响启动）: ${error?.message ?? error}`);
  }

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
      stopProvider: () => {
        // 两道闸：进程内标记（运行中的循环立刻看得到）+ 落盘标记（MCP 侧的循环也看得到）
        autoStop.requested = true;
        autoStop.at = Date.now();
        autoStop.reason = '用户点了停止';
        let saved = false;
        try {
          const st = loadOpsState();
          st.requestStop('用户在设置页点了停止');
          st.save();
          saved = true;
        } catch (error) {
          diag('[autopilot] 停止标记落盘失败（进程内仍然生效）: ' + error.message);
        }
        pushTrace({
          phase: 'stop',
          message: autoTrace.running
            ? '收到停止指令：当前这一步跑完就停，不会再开新一轮'
            : '收到停止指令（当前没有在跑的任务，标记已清）'
        });
        if (!autoTrace.running) autoStop.requested = false;
        return { stopped: true, running: autoTrace.running, saved };
      },
      traceProvider: () => ({ running: autoTrace.running, startedAt: autoTrace.startedAt, events: autoTrace.events, result: autoTrace.result }),
      // 「我来刷」= agent 模式：只往队列里写一条请求，真正的刷/看/回由 agent 自己做
      agentQueue: async (opts = {}) => {
        const file = path.join(projectRoot(), 'state', 'agent-run.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const request = {
          requestedAt: new Date().toISOString(),
          rounds: Math.max(1, Number(opts.rounds ?? 1) || 1),
          contentMode: String(opts.contentMode ?? 'auto'),
          lineCount: Number(opts.lineCount ?? 0) || 0,
          topic: String(opts.topic ?? ''),
          note: 'agent 模式：用 ks_watch / ks_next / ks_reply / ks_post_comment / ks_make_video / ks_publish_confirm 自己一步一步做'
        };
        fs.writeFileSync(file, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
        diag(`agent 模式：已排队 ${JSON.stringify(request)}`);
        return { request, file };
      },
      agentTake: async ({ take = false } = {}) => {
        const file = path.join(projectRoot(), 'state', 'agent-run.json');
        if (!fs.existsSync(file)) return { request: null, note: '队列是空的' };
        const request = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (take) fs.unlinkSync(file);
        return { request, note: take ? '已取走' : '只是看一眼' };
      },
      autopilotProvider: async (opts = {}) => {
        const { pathToFileURL } = await import('node:url');
        const url = (rel) => pathToFileURL(path.join(projectRoot(), rel)).href;
        const [autoMod, cfgMod, videoMod, driverMod, opsMod] = await Promise.all([
          import(url('src/autopilot.mjs')),
          import(url('src/config.mjs')),
          import(url('src/video.mjs')),
          import(url('src/driver.mjs')),
          import(url('src/ops.mjs'))
        ]);
        const cfg = cfgMod.loadConfig({});
        if (cfg.enabled === false) throw new Error('插件总开关已关闭，先在顶部打开');
        // 连点两次「开始」不能起两个循环（两个 Edge 抢同一个 profile 会互相踩）
        if (autoTrace.running) throw new Error('已经在跑了：先点停止，等这轮结束');
        // 上一轮如果留了停止标记，不清掉的话这次一开始就会自己退出
        autoStop.requested = false;
        autoStop.reason = '';
        const backend = await driverMod.createBackend({ cfg, log: (l) => diag(l) });
        const st = new opsMod.OpsState({ file: path.join(projectRoot(), 'state', 'ops-state.json') }).load();
        try { st.clearStop(); st.save(); } catch {}
        // 运行中的 st 是启动时的内存快照，看不到后来落盘的停止标记 —— 这里把进程内闸门接进去
        const fileShouldStop = typeof st.shouldStop === 'function' ? st.shouldStop.bind(st) : () => false;
        st.shouldStop = () => autoStop.requested || fileShouldStop();
        const studio = new videoMod.VideoStudio({ cfg, log: (l) => diag(l) });
        autoTrace.running = true;
        autoTrace.startedAt = Date.now();
        autoTrace.events = [];
        autoTrace.result = null;
        // 循环模式：跑完一巡接着刷，直到点停止（或到 maxRounds）
        const loop = Boolean(opts.loop);
        const maxRounds = Math.max(0, Number(opts.maxRounds) || 0) || (loop ? Math.max(0, Number(cfg.loop?.maxRounds) || 0) : 0);
        pushTrace({
          phase: 'start',
          message: `开始全自动：${JSON.stringify(opts)}`
            + (loop ? `｜循环模式，最多 ${maxRounds || '不限'} 巡，点「停止」才收工` : '')
        });
        let report;
        let iteration = 0;
        /**
         * 静默看门狗：12 分钟一个事件都没有，说明卡在某处了（浏览器弹窗、ffmpeg 被占）。
         * 这时主动请求停止，让循环在下一个检查点退出 —— 否则界面永远停在"运行中"，
         * 而且因为 running 一直是 true，用户再点「开始」也点不动。
         */
        const idleLimitMs = 12 * 60 * 1000;
        const watchdog = setInterval(() => {
          if (!autoTrace.running) return;
          const idle = Date.now() - (autoTrace.lastAt || autoTrace.startedAt);
          if (idle < idleLimitMs) return;
          autoStop.requested = true;
          autoStop.reason = '看门狗：长时间无进展';
          pushTrace({ phase: 'act', ok: false, message: `${Math.round(idle / 60000)} 分钟没有任何进展，判定卡住了：已请求停止` });
        }, 60 * 1000);
        watchdog.unref?.();
        try {
          do {
            iteration += 1;
            if (loop) pushTrace({ phase: 'round', message: `— 第 ${iteration} 巡：刷 → 赞 → 评 → 出片 → 发布 —` });
            report = await autoMod.runFullAuto(
              { backend: async () => backend, state: st, cfg, studio, root: projectRoot(), trace: pushTrace },
              opts
            );
            const more = loop && !autoStop.requested && (maxRounds <= 0 || iteration < maxRounds);
            if (more) {
              const gap = Math.max(0, Number(cfg.loop?.gapSec ?? 20));
              pushTrace({ phase: 'round', message: `第 ${iteration} 巡结束，${gap} 秒后接着刷（想停随时点停止）` });
              // 可中断的等待：点停止不用等满
              const until = Date.now() + gap * 1000;
              while (Date.now() < until && !autoStop.requested) await new Promise((r) => setTimeout(r, 250));
            }
          } while (loop && !autoStop.requested && (maxRounds <= 0 || iteration < maxRounds));
        } catch (error) {
          // 失败也要留在思维链里，否则前端只看到"运行中…"突然没了
          pushTrace({ phase: 'end', ok: false, message: '这轮挂了：' + String(error?.message || error).slice(0, 240) });
          throw error;
        } finally {
          clearInterval(watchdog);
          autoTrace.running = false;
          if (report) {
            pushTrace({
              phase: 'end',
              message: loop
                ? (autoStop.requested ? `收到停止，共跑了 ${iteration} 巡` : `循环收工，共跑了 ${iteration} 巡`)
                : '本轮结束'
            });
          }
        }
        autoTrace.result = { summary: report.summary, countsAfter: report.countsAfter };
        diag(`[autopilot] ${report.summary.replace(/\n/g, ' | ')}`);
        return report;
      },
      voiceProvider: async () => {
        const { pathToFileURL } = await import('node:url');
        const mod = await import(pathToFileURL(path.join(projectRoot(), 'src', 'video.mjs')).href);
        const cfg = await loadRuntimeConfig();
        const studio = new mod.VideoStudio({ cfg });
        return await studio.voices();
      },
      ttsProvider: async ({ text = '这是一段试听语音', engine, voice, rate, soften } = {}) => {
        const { pathToFileURL } = await import('node:url');
        const mod = await import(pathToFileURL(path.join(projectRoot(), 'src', 'video.mjs')).href);
        const cfg = await loadRuntimeConfig();
        // 试听时可以临时覆盖柔化设置，让用户边选边听
        if (typeof soften === 'string') cfg.video.audio.soften = soften;
        const studio = new mod.VideoStudio({ cfg });
        const out = path.join(projectRoot(), 'state', 'video', String('preview-' + Date.now() + '.wav'));
        const r = await studio.tts({ text, out, engine, voice, rate });
        // 试听只是听一耳朵，播完就不需要了；留着会堆一堆 wav
        setTimeout(() => { try { fs.rmSync(r.file, { force: true }); } catch {} }, 30000);
        return r;
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
      // 端口被占自动往后找，别让上传服务彻底起不来
      assetServer.startWithFallback().then((actual) => {
        if (Number(actual) !== Number(port)) {
          diag(`[assets] 实际端口 ${actual}（配置是 ${port}）：设置页里上传会打到 ${port}，建议改 assetsPort 或重启 DSH 释放端口`);
        }
      }).catch((error) => {
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
      // 原子写：写到一半被杀，也不会留下半截 JSON 让下次启动读崩
      writeJsonAtomic(target, { updatedAt: new Date().toISOString(), source: 'dsh-settings', ...flat });
      diag(`apply ok → ${target} (${Object.keys(flat).length} keys: ${Object.keys(flat).join(',')})`);
    }
  } catch (error) {
    diag(`apply failed: ${error?.message ?? error}`);
  }
  if (ctx?.logger?.info) ctx.logger.info(`[kuaishou] settings synced → ${target}`);
}
