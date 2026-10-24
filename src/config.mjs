// 配置：默认值 + 磁盘覆盖 + 校验。
//
// 设计原则：**所有会变的都放进配置**。快手的 resource-id、停留时长、每日配额、
// 拉黑词、发布目录都是会随版本/账号变化的量，硬编码在代码里就等于每次改版都要改代码。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yamlNs from 'js-yaml';

// js-yaml 4 是 CJS：ESM 下 default 与命名空间两种形状都可能出现，统一取一次
const yaml = yamlNs.default ?? yamlNs;
import { fileURLToPath } from 'node:url';

/** 项目根：优先 KSOPS_ROOT，其次从本文件向上找 name=kuaishou-ops 的 package.json。 */
function detectRoot() {
  if (process.env.KSOPS_ROOT) return path.resolve(process.env.KSOPS_ROOT);
  let cur = path.dirname(fileURLToPath(import.meta.url));
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
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

const ROOT = detectRoot();

export const KS_PKG = 'com.smile.gifmaker';

/** 快手界面选择器。resource-id 随版本变，所以每一类都给多个候选，全部可被配置文件覆盖。 */
export const DEFAULT_SELECTORS = {
  // 底部导航
  tabHome: { text: ['首页'], res: [] },
  tabProfile: { text: ['我'], res: [] },
  // 评论区
  commentEntry: { text: ['评论', '写评论', '说点什么'], res: [] },
  commentList: { res: ['com.smile.gifmaker:id/comment_list'], cls: ['androidx.recyclerview.widget.RecyclerView'] },
  commentReplyAction: { text: ['回复'] },
  commentInput: { text: ['说点什么', '回复 @', '留下你的评论'], res: [] },
  sendButton: { text: ['发送'] },
  // 发布流程
  publishEntry: { text: ['拍摄', '+', '发布'], res: [] },
  albumPick: { text: ['相册', '从相册选择', '上传'] },
  publishNext: { text: ['下一步', '下一步(1/2)'] },
  publishConfirm: { text: ['发布'] },
  captionBox: { text: ['添加作品描述', '说点什么', '标题'] },
  // 通用
  back: { text: [], res: [], desc: ['返回'] }
};

export const DEFAULTS = {
  /** 总开关：false = 所有动作工具直接拒绝（只看状态/环境检查不受影响） */
  enabled: true,
  /** 素材上传服务（设置页上传用） */
  assets: { port: 32801, dir: 'state/assets', maxMB: 64 },
  /** 后端：auto = 有 adb 且有在线设备就用 adb，否则用网页版；adb / web = 强制 */
  mode: 'auto',
  /** 网页版后端（真实浏览器 + 持久化登录态） */
  web: {
    browserPath: '',
    headless: false,
    profileDir: '.web-profile',
    width: 1600,
    height: 1000,
    settleMs: 3000
  },
  /** adb 可执行文件；空 = 自动探测（MuMu 自带 / ANDROID_HOME / PATH） */
  adbPath: '',
  /** 目标设备 serial；空 = 只有一台设备时自动选它 */
  serial: '',
  /** 快手包名与启动 Activity */
  pkg: KS_PKG,
  launcherActivity: 'com.yxcorp.gifshow.HomeActivity',
  /** 超时（毫秒） */
  timeouts: { shell: 20000, dump: 15000, launch: 30000 },
  /** 单条视频的停留区间：看完再滑，接近真人节奏 */
  dwell: { minMs: 6000, maxMs: 22000 },
  /** 拟人化抖动 */
  jitter: { tapPx: 14, sleepPct: 0.3, swipeDurMin: 220, swipeDurMax: 420 },
  /** 每轮配额：防止一口气刷爆、发爆 */
  quotas: { scrollPerRun: 30, replyPerRun: 8, likePerRun: 5, publishPerDay: 2, runGapMs: 900000 },
  /** 回评论策略 */
  reply: {
    minChars: 2,
    maxChars: 60,
    /** 命中这些词的评论不自动回（引流/拉踩/广告），避免账号被判营销 */
    blacklist: ['加微信', '私信我', '互粉', '返现', '引流', '刷赞', '代运营'],
    /** 只回这些问题/互动型评论 */
    whitelist: ['?', '？', '怎么', '什么', '哪', '求', '吗', '有没有', '推荐'],
    /** 界面上这些文本不是评论（输入框占位符、按钮、折叠标签），读列表时要排掉 */
    ignore: ['说点什么', '留下你的评论', '发送', '回复', '展开', '收起', '暂时没有评论']
  },
  /** 发视频 */
  publish: {
    videoExt: ['.mp4', '.mov', '.mkv'],
    captionMax: 120,
    topicsMax: 5,
    /** 推送进模拟器的目录（Kuaishou 需要从相册选） */
    deviceDir: '/sdcard/DCIM/Camera',
    /** 中文输入依赖 ADBKeyboard（见 README）；未安装时只能用 ASCII 文案 */
    imePackage: 'com.android.adbkeyboard',
    imeId: 'com.android.adbkeyboard/.AdbIME'
  },
  /** 状态落盘位置（相对项目根） */
  stateFile: 'state/ops-state.json',
  /** 视频流水线：剪辑 / 配音 / 字幕 / 封面 */
  video: {
    ffmpegPath: '',
    ffprobePath: '',
    /** 中间产物目录（相对项目根） */
    workDir: 'state/video',
    width: 1080,
    height: 1920,
    fps: 30,
    /** 背景：纯色 / 图片（图片优先）。全部可被设置页覆盖 */
    background: {
      color: '0x0f1419',
      /** 背景图绝对路径；空 = 不用图 */
      image: '',
      /** 背景视频绝对路径（循环播放、静音）；优先级最高 */
      video: '',
      /** 渐变预设名（见 video.mjs 的 BACKGROUND_PRESETS） */
      preset: '',
      gradientFrom: '',
      gradientTo: '',
      /** 渐变方向：vertical | horizontal */
      gradientAxis: 'vertical',
      /** 适配：cover=铺满裁切，contain=完整留边 */
      fit: 'cover',
      /** 压暗 0~1（图片/视频背景上压一层黑，让字幕清楚） */
      dim: 0.35,
      /** 模糊强度（gblur sigma，0=不模糊） */
      blur: 0
    },
    /** 字体与文字样式 */
    typography: {
      /** 中文字体路径；空 = 自动找 msyh.ttc / simhei.ttf */
      fontPath: '',
      fontSize: 54,
      titleFontSize: 76,
      /** 标题只出现前 N 秒；0 = 全片常驻 */
      titleHoldSec: 0,
      fontColor: 'white',
      titleColor: 'white',
      /** 字幕底色块透明度 0~1 */
      boxAlpha: 0.45,
      /** 字幕底边位置（占画面高度比例） */
      subtitleY: 0.76,
      borderWidth: 3
    },
    /** 声音：配音 + 背景音乐 */
    audio: {
      /** 引擎：sapi（系统语音，免文件）/ piper（.onnx 模型文件） */
      engine: 'sapi',
      /** SAPI 语音名 */
      voice: 'Microsoft Huihui Desktop',
      /** Piper 可执行文件（引擎=piper 时必填） */
      piperExe: '',
      /** Piper 语音模型 .onnx（引擎=piper 时必填） */
      piperModel: '',
      /** 语速 -10~10 */
      rate: 0,
      /** BGM 文件；空 = 不加 */
      bgmFile: '',
      /** BGM 相对配音的音量（dB，负数=更小） */
      bgmGainDb: -24,
      /** 配音音量（dB，0=原样） */
      voiceGainDb: 0
    }
  },
  /**
   * 说话与打字（设置页图形化编辑）。
   * 生成一段指南追加到人设提示词后面；全默认时基本不改变内置人设。
   */
  style: {
    callUser: '主人',
    callSelf: '我',
    tone: 'gentle',
    catchphrases: '',
    maxChars: 40,
    useEmoji: true,
    useTilde: true,
    usePeriod: false,
    useParticles: true,
    forbid: '不承诺收益，不导流，不刷量，不人身攻击'
  },
  /** true = 只打印将要执行的 adb 命令，不真发 */
  dryRun: false,
  /** 提示词库：人在 prompts/ 里改，模型用 ks_prompt_* / ks_brief 取 */
  prompts: {
    /** 内置提示词目录（相对项目根，随包发布） */
    dir: 'prompts',
    /** 自定义覆盖目录（同名 .md 覆盖内置；不会被升级覆盖） */
    customDir: 'state/prompts',
    /** 自定义人设正文；非空时**优先于** personaId 指向的文件 */
    personaOverride: '',
    /** 各场景默认用哪个提示词 */
    active: {
      persona: 'persona-whale-maid',
      reply: 'reply',
      script: 'script',
      title: 'title',
      caption: 'caption',
      pick: 'comment-pick',
      ops: 'ops'
    }
  },
  selectors: DEFAULT_SELECTORS
};

export function projectRoot() {
  return ROOT;
}

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return override ?? base;
  if (typeof base !== 'object' || base === null) return override ?? base;
  if (typeof override !== 'object' || override === null) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

/**
 * 把「设置页」写出来的扁平 settings.json 贴到 cfg 上。
 *
 * 只覆盖 DSH 设置页能改的那几个键，其余一律以 config.json 为准 —— 这样设置页是
 * **可选覆盖层**，不是第二份真相：删掉 settings.json 就完全回到 config.json。
 */
export function applySettingsOverrides(cfg, flat) {
  if (!flat || typeof flat !== 'object') return cfg;
  if (typeof flat.enabled === 'boolean') cfg.enabled = flat.enabled;
  if (Number.isFinite(Number(flat.assetsPort))) cfg.assets.port = Number(flat.assetsPort);
  if (typeof flat.assetsDir === 'string' && flat.assetsDir.trim()) cfg.assets.dir = flat.assetsDir.trim();
  if (Number.isFinite(Number(flat.assetsMaxMB))) cfg.assets.maxMB = Number(flat.assetsMaxMB);
  if (['auto', 'adb', 'web'].includes(flat.mode)) cfg.mode = flat.mode;
  if (flat.webProfileDir) cfg.web.profileDir = String(flat.webProfileDir);
  if (flat.browserPath) cfg.web.browserPath = String(flat.browserPath);
  if (flat.ffmpegPath) cfg.video.ffmpegPath = String(flat.ffmpegPath);
  if (flat.videoVoice) cfg.video.voice = String(flat.videoVoice);
  for (const k of ['scrollPerRun', 'replyPerRun', 'likePerRun', 'publishPerDay']) {
    if (Number.isFinite(Number(flat[k]))) cfg.quotas[k] = Number(flat[k]);
  }
  if (flat.replyPromptId) cfg.prompts.active.reply = String(flat.replyPromptId);
  if (flat.scriptPromptId) cfg.prompts.active.script = String(flat.scriptPromptId);
  // 视频样式（背景 / 字体 / 声音）
  if (typeof flat.videoBgColor === 'string' && flat.videoBgColor.trim()) cfg.video.background.color = flat.videoBgColor.trim();
  if (typeof flat.videoBgImage === 'string') cfg.video.background.image = flat.videoBgImage.trim();
  if (typeof flat.videoBgVideo === 'string') cfg.video.background.video = flat.videoBgVideo.trim();
  if (typeof flat.videoBgPreset === 'string') cfg.video.background.preset = flat.videoBgPreset.trim();
  if (typeof flat.videoBgGradientFrom === 'string') cfg.video.background.gradientFrom = flat.videoBgGradientFrom.trim();
  if (typeof flat.videoBgGradientTo === 'string') cfg.video.background.gradientTo = flat.videoBgGradientTo.trim();
  if (['vertical', 'horizontal'].includes(flat.videoBgGradientAxis)) cfg.video.background.gradientAxis = flat.videoBgGradientAxis;
  if (Number.isFinite(Number(flat.videoBgBlur))) cfg.video.background.blur = Number(flat.videoBgBlur);
  if (['cover', 'contain'].includes(flat.videoBgFit)) cfg.video.background.fit = flat.videoBgFit;
  if (Number.isFinite(Number(flat.videoBgDim))) cfg.video.background.dim = Number(flat.videoBgDim);
  if (typeof flat.videoFontPath === 'string') cfg.video.typography.fontPath = flat.videoFontPath.trim();
  if (Number.isFinite(Number(flat.videoFontSize))) cfg.video.typography.fontSize = Number(flat.videoFontSize);
  if (Number.isFinite(Number(flat.videoTitleFontSize))) cfg.video.typography.titleFontSize = Number(flat.videoTitleFontSize);
  if (Number.isFinite(Number(flat.videoTitleHoldSec))) cfg.video.typography.titleHoldSec = Number(flat.videoTitleHoldSec);
  if (typeof flat.videoFontColor === 'string' && flat.videoFontColor.trim()) cfg.video.typography.fontColor = flat.videoFontColor.trim();
  if (typeof flat.videoTitleColor === 'string' && flat.videoTitleColor.trim()) cfg.video.typography.titleColor = flat.videoTitleColor.trim();
  if (Number.isFinite(Number(flat.videoBoxAlpha))) cfg.video.typography.boxAlpha = Number(flat.videoBoxAlpha);
  if (Number.isFinite(Number(flat.videoSubtitleY))) cfg.video.typography.subtitleY = Number(flat.videoSubtitleY);
  if (['sapi', 'piper'].includes(flat.videoTtsEngine)) cfg.video.audio.engine = flat.videoTtsEngine;
  if (typeof flat.videoVoice === 'string' && flat.videoVoice.trim()) cfg.video.audio.voice = flat.videoVoice.trim();
  if (typeof flat.videoPiperExe === 'string') cfg.video.audio.piperExe = flat.videoPiperExe.trim();
  if (typeof flat.videoPiperModel === 'string') cfg.video.audio.piperModel = flat.videoPiperModel.trim();
  if (Number.isFinite(Number(flat.videoVoiceRate))) cfg.video.audio.rate = Number(flat.videoVoiceRate);
  if (typeof flat.videoBgmFile === 'string') cfg.video.audio.bgmFile = flat.videoBgmFile.trim();
  if (Number.isFinite(Number(flat.videoBgmGainDb))) cfg.video.audio.bgmGainDb = Number(flat.videoBgmGainDb);
  // 说话与打字
  cfg.style = { ...DEFAULTS.style, ...(cfg.style ?? {}) };
  if (typeof flat.speakCallUser === 'string') cfg.style.callUser = flat.speakCallUser.trim();
  if (typeof flat.speakCallSelf === 'string') cfg.style.callSelf = flat.speakCallSelf.trim();
  if (['gentle', 'calm', 'sharp', 'lively', 'pro'].includes(flat.speakTone)) cfg.style.tone = flat.speakTone;
  if (typeof flat.speakCatchphrases === 'string') cfg.style.catchphrases = flat.speakCatchphrases.trim();
  if (Number.isFinite(Number(flat.speakMaxChars))) cfg.style.maxChars = Math.min(500, Math.max(5, Number(flat.speakMaxChars)));
  for (const k of ['useEmoji', 'useTilde', 'usePeriod', 'useParticles']) {
    if (typeof flat[k] === 'boolean') cfg.style[k] = flat[k];
    const alias = k === 'useEmoji' ? 'typeEmoji' : k === 'useTilde' ? 'typeTilde' : k === 'usePeriod' ? 'typePeriod' : 'typeParticles';
    if (typeof flat[alias] === 'boolean') cfg.style[k] = flat[alias];
  }
  if (typeof flat.speakForbid === 'string') cfg.style.forbid = flat.speakForbid.trim();

  if (flat.personaId) cfg.prompts.active.persona = String(flat.personaId);
  if (typeof flat.personaOverride === 'string') cfg.prompts.personaOverride = flat.personaOverride;
  cfg.__settingsMerged = Object.keys(flat).filter((k) => k !== 'updatedAt' && k !== 'source');
  return cfg;
}

/**
 * 从 DSH 的 profile patch 里读「设置页真正写下去的值」。
 *
 * 为什么要读 patch 而不是只读 state/settings.json：
 *   `settings/update` 把值写进 **user 层**，DSH 落盘的位置就是 profile 的 cordis.patch.yml，
 *   形状是 `- id: kuaishou / config: {...}`；而插件进程内的运行配置在重启前不会变
 *   （qq-bridge 那边踩过同样的坑）。所以"用户刚在设置页改的值"只有从 patch 里读才拿得到。
 *
 * 兼容两种位置：
 *   · 顶层 override：`- id: kuaishou` + `config:`
 *   · bundle 里的 base：`- insert: [ { id: kuaishou, config: {...} } ]`
 * 后出现的覆盖先出现的（与 loader 的层叠方向一致）。
 */
export function readProfileSettings({ dshHome, profile } = {}) {
  const home = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const prof = profile || process.env.KSOPS_PROFILE || 'desktop';
  const file = path.join(home, 'profiles', prof, 'cordis.patch.yml');
  if (!fs.existsSync(file)) return {};
  let doc;
  try {
    doc = yaml.load(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) ?? [];
  } catch {
    return {};
  }
  if (!Array.isArray(doc)) return {};
  let merged = {};
  for (const op of doc) {
    if (!op || typeof op !== 'object') continue;
    if (Array.isArray(op.insert)) {
      for (const entry of op.insert) {
        if (entry?.id === 'kuaishou' && entry.config && typeof entry.config === 'object') {
          merged = { ...merged, ...entry.config };
        }
      }
      continue;
    }
    if (op.id === 'kuaishou' && op.config && typeof op.config === 'object') {
      merged = { ...merged, ...op.config };
    }
  }
  return merged;
}

/** 读 config.json（没有就返回默认值），再叠加：设置页落盘文件 → profile patch → 环境变量。 */
export function loadConfig({ file = path.join(ROOT, 'config.json'), env = process.env, dshHome, profile } = {}) {
  let disk = {};
  if (fs.existsSync(file)) {
    try {
      disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`config.json 解析失败：${error.message}`);
    }
  }
  const cfg = deepMerge(DEFAULTS, disk);

  // ① 插件 apply() 拍平的快照
  const settingsPath = path.join(ROOT, 'state', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      applySettingsOverrides(cfg, JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
    } catch {
      // 坏文件不该让插件起不来：忽略这一层
    }
  }

  // ② 设置页真正写进 user 层的值（最新，优先级最高）
  applySettingsOverrides(cfg, readProfileSettings({ dshHome, profile }));

  if (env.KSOPS_ADB) cfg.adbPath = env.KSOPS_ADB;
  if (env.KSOPS_SERIAL) cfg.serial = env.KSOPS_SERIAL;
  if (env.KSOPS_DRY === '1') cfg.dryRun = true;
  if (env.KSOPS_MODE && ['auto', 'adb', 'web'].includes(env.KSOPS_MODE)) cfg.mode = env.KSOPS_MODE;
  validateConfig(cfg);
  return cfg;
}

/** 校验；只挑**会真出事**的项报错，其余收敛到合法区间。 */
export function validateConfig(cfg) {
  const clamp = (v, lo, hi, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
  };
  if (!['auto', 'adb', 'web'].includes(cfg.mode)) cfg.mode = 'auto';
  // 视频样式：全部收敛到安全范围，坏值不抛（否则设置页一填错整个插件起不来）
  cfg.assets = { ...DEFAULTS.assets, ...(cfg.assets ?? {}) };
  cfg.assets.port = clamp(cfg.assets.port, 1024, 65535, 32801);
  cfg.assets.maxMB = clamp(cfg.assets.maxMB, 1, 2048, 64);
  cfg.video = cfg.video ?? {};
  cfg.video.background = { ...DEFAULTS.video.background, ...(cfg.video.background ?? {}) };
  cfg.video.typography = { ...DEFAULTS.video.typography, ...(cfg.video.typography ?? {}) };
  cfg.video.audio = { ...DEFAULTS.video.audio, ...(cfg.video.audio ?? {}) };
  cfg.video.background.dim = clamp(cfg.video.background.dim, 0, 1, 0.35);
  if (!['cover', 'contain'].includes(cfg.video.background.fit)) cfg.video.background.fit = 'cover';
  if (!['vertical', 'horizontal'].includes(cfg.video.background.gradientAxis)) cfg.video.background.gradientAxis = 'vertical';
  cfg.video.background.blur = clamp(cfg.video.background.blur, 0, 60, 0);
  cfg.video.typography.fontSize = clamp(cfg.video.typography.fontSize, 16, 200, 54);
  cfg.video.typography.titleFontSize = clamp(cfg.video.typography.titleFontSize, 16, 300, 76);
  cfg.video.typography.titleHoldSec = clamp(cfg.video.typography.titleHoldSec, 0, 600, 0);
  cfg.video.typography.boxAlpha = clamp(cfg.video.typography.boxAlpha, 0, 1, 0.45);
  cfg.video.typography.subtitleY = clamp(cfg.video.typography.subtitleY, 0.3, 0.98, 0.76);
  cfg.video.typography.borderWidth = clamp(cfg.video.typography.borderWidth, 0, 12, 3);
  cfg.video.audio.rate = clamp(cfg.video.audio.rate, -10, 10, 0);
  if (!['sapi', 'piper'].includes(cfg.video.audio.engine)) cfg.video.audio.engine = 'sapi';
  cfg.video.audio.bgmGainDb = clamp(cfg.video.audio.bgmGainDb, -60, 12, -24);
  cfg.video.audio.voiceGainDb = clamp(cfg.video.audio.voiceGainDb, -30, 20, 0);
  if (!cfg.web || typeof cfg.web !== 'object') cfg.web = { ...DEFAULTS.web };
  cfg.web.settleMs = clamp(cfg.web.settleMs, 0, 30000, 3000);
  cfg.web.width = clamp(cfg.web.width, 800, 3840, 1600);
  cfg.web.height = clamp(cfg.web.height, 600, 2160, 1000);
  cfg.dwell.minMs = clamp(cfg.dwell.minMs, 500, 600000, 6000);
  cfg.dwell.maxMs = clamp(cfg.dwell.maxMs, cfg.dwell.minMs, 900000, 22000);
  cfg.jitter.tapPx = clamp(cfg.jitter.tapPx, 0, 120, 14);
  cfg.jitter.sleepPct = clamp(cfg.jitter.sleepPct, 0, 1, 0.3);
  cfg.quotas.scrollPerRun = clamp(cfg.quotas.scrollPerRun, 1, 500, 30);
  cfg.quotas.replyPerRun = clamp(cfg.quotas.replyPerRun, 0, 100, 8);
  cfg.quotas.likePerRun = clamp(cfg.quotas.likePerRun, 0, 200, 5);
  cfg.quotas.publishPerDay = clamp(cfg.quotas.publishPerDay, 0, 20, 2);
  cfg.reply.maxChars = clamp(cfg.reply.maxChars, 1, 500, 60);
  cfg.publish.captionMax = clamp(cfg.publish.captionMax, 0, 2000, 120);
  if (!Array.isArray(cfg.reply.blacklist)) cfg.reply.blacklist = DEFAULTS.reply.blacklist;
  if (!Array.isArray(cfg.publish.videoExt)) cfg.publish.videoExt = DEFAULTS.publish.videoExt;
  if (typeof cfg.pkg !== 'string' || !cfg.pkg.includes('.')) throw new Error('pkg 必须是 Android 包名');
  return cfg;
}
