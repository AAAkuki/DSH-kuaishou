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
  // 表情包回复（App 端）：评论框上的表情入口；面板里的表情格子按位置启发式挑（屏幕下半的可点图）
  commentEmojiEntry: { text: ['表情'], desc: ['表情', 'emoji', 'Emoji'] },
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
  /** 循环运营：跑完一轮接着刷，不停 */
  loop: {
    /** 开着就一直刷（配额用完会自动重置） */
    enabled: false,
    /** 配额用完自动重置后继续 */
    resetQuotaOnExhaust: true,
    /** 每轮之间歇几秒 */
    gapSec: 20,
    /** 最多连续多少轮（0 = 不限，直到用户停） */
    maxRounds: 0
  },
  /** 搜索：在网上冲浪时顺手搜关键词，结果进总结视频 */
  /** 直播：进直播间读弹幕 / 显示 token 余额 / AI 玩小游戏 / 推流（和 Vibe 视频无关） */
  live: {
    roomUrl: '',
    tokenKey: '',
    jumps: 12,
    record: true
  },
  /** 网络梗：刷视频时顺手学，回评/视频里低频用出去 */
  slang: {
    learn: true,
    useInVideo: true
  },
  search: {
    enabled: true,
    /** 关键词列表，轮着搜 */
    keywords: ['deepseek', 'ai 绘画', '大模型 教程', 'Claude'],
    /** 一次搜索读几条结果 */
    limit: 6,
    /** 每次总结视频最多引用几条搜索发现 */
    feedToVideo: 3
  },
  /** 去 AI 味：文案出片前机械清洗（八股连接词 / 客服腔 / 大词 / 形容词堆料 / emoji 堆砌） */
  text: {
    deai: true
  },
  /** 账号目标：视频里会提"冲 X 粉"（用户要求"冲击10000粉丝"） */
  goal: {
    fans: 10000
  },
  /** 总结视频：一天最多几条 */
  summary: {
    perDay: 2,
    /** 用户选择"刷新"时才重新生成（false = 沿用今天的） */
    refresh: true
  },
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
    settleMs: 3000,
    /** 常驻：跑完不关浏览器（默认开）。关掉每次都要重新 launch，又慢又容易撞 profile 锁 */
    persist: true,
    /** 常驻时闲置多久自动关（分钟，0 = 永不关） */
    idleCloseMin: 30
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
  quotas: { scrollPerRun: 0, replyPerRun: 0, likePerRun: 5, publishPerDay: 2, runGapMs: 900000 },
  /** 刷视频：0 条数配额时按时间兜底 */
  scroll: { runMaxMinutes: 10 },
  /** 回评论策略 */
  reply: {
    minChars: 2,
    maxChars: 60,
    /** 命中这些词的评论不自动回（引流/拉踩/广告），避免账号被判营销 */
    blacklist: ['加微信', '私信我', '互粉', '返现', '引流', '刷赞', '代运营'],
    /** 只回这些问题/互动型评论 */
    // 白名单：既包括"提问型"，也包括"可附和型"（夸/认同/玩梗）。
    // 只放提问词会把「说的太经典了」「颖宝真的」这类正常互动全跳过（实测踩到）。
    /**
     * 评论标签白名单：命中这些标签就算"可回"（优先于关键词白名单）。
     * 用法：话题标签 / 作品标签 / 自己标记的类别，比如 '#deepseek'、'求推荐'、'提问'。
     * 空数组 = 不启用标签白名单，只按 whitelist 判断。
     */
    tagWhitelist: [],
    /**
     * 视频标签白名单：只有当前视频的 #话题 命中这些词时才回评（空数组 = 不限制）。
     * 例：['deepseek','ai','大模型'] → 只在带这些话题的视频下回评。
     */
    videoTagWhitelist: [],
    /**
     * 运营评论时 @ 谁：填「主人」「管理员」或具体昵称，回复开头会带 @XX。
     * 空字符串 = 不 @（默认，别乱 @ 人）。
     */
    atOwner: '',
    /** 自己作品下的评论也一起回（默认开） */
    includeOwn: true,
    /**
     * 表情包回复：按概率在回复里带一张表情包（图库 = state/assets/stickers，按对方评论的情绪挑）。
     *   enabled       总开关（默认关，开了才有概率带图）
     *   rate          多大比例带图（0~1，0.3 ≈ 三条里一条；别拉满，全是图一眼假）
     *   mode          append=文字+表情包 / only=只发图
     *   fallbackEmoji 网页版发不了图片评论时，退化成在文案里塞个情绪 emoji（false = 宁可纯文字）
     */
    sticker: { enabled: false, rate: 0.3, mode: 'append', fallbackEmoji: true },
    /**
     * 关键词白名单：**空数组 = 只要不是黑名单就回**（用户要求"发评论积极点"）。
     * 以前默认塞了 20 个词，等于大部分评论都被"不含白名单词"挡掉，看起来像不积极。
     */
    whitelist: [],
    /** 黑名单：命中就不回（广告/导流/诈骗），比白名单优先 */
    blacklist: ['加微信', '私信我', '互粉', '返现', '引流', '刷赞', '代运营'],
    /** 界面上这些文本不是评论（输入框占位符、按钮、折叠标签），读列表时要排掉 */
    ignore: ['说点什么', '留下你的评论', '发送', '回复', '展开', '收起', '暂时没有评论']
  },
  /** 发视频 */
  publish: {
    videoExt: ['.mp4', '.mov', '.mkv'],
    captionMax: 120,
    topicsMax: 5,
    /** 默认话题标签（不带 #，发布时自动补；单次调用可覆盖） */
    topics: ['deepseek', '大肥鱼'],
    /** 默认封面图（相对项目根或绝对路径）；文件不存在时退回视频首帧 */
    coverFile: 'state/assets/cover-whale-maid.jpg',
    /** 标题（快手允许留空） */
    title: '',
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
    /**
     * 模板模式：给一张横版模板图（带说话框），只往框里打字。
     * 打开后 background.image 就是模板，templateBox 决定框的位置（相对坐标 0~1）。
     */
    templateMode: false,
    /** 最短视频时长（秒）；太短的片子容易被划走 */
    minDurationSec: 55,
    /** 目标时长（秒）：文案不够长时会补到这时长（默认 58 ≈ 1 分钟） */
    targetDurationSec: 58,
    /** 字幕句数：直接决定视频多长（12 句 ≈ 一分钟；用户要求"字数再长一点"就调这里） */
    lineCount: 12,
    /** 视频里带上自己的真实数据（播放量/点赞/涨粉/最新作品），"活人感"就靠这个 */
    stats: true,
    /** 左上角栏目名（参考视频风格），如「大肥鱼的生活日记」 */
    titleBar: '',
    /** 右上角合规标识 */
    aiBadge: '',
    /** 对话框名字标签 */
    speakerName: '大肥鱼',
    /** 打字光标闪烁 */
    typing: true,
    templateBox: null,
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
      /**
       * 柔化预设：none / clean / soft / softer / mellow
       * 用 ffmpeg 滤镜降调 + 削齿音 + 加厚度，让声音更软（不换模型也能明显变软）
       */
      soften: '',
      /** 萝莉档位：'' = 不用 / loli / loli_hard / loli_soft（升调 + 童声塑形） */
      cute: '',
      /** 口吃（重复首字），配合 cute 使用 */
      stutter: true,
      /** 句间随机喘气 */
      breath: true,
      /** 句中/句间停顿 */
      pause: true,
      /** piper 语速（>1 更慢，萝莉感更足） */
      lengthScale: 1.18,
      /** 用户自定义贴纸图片路径（单选）；空 = 用 stickers 目录里全部贴纸自动挑 */
      stickerFile: '',
      /**
       * 贴纸位置（看得懂的名字，不用填坐标）：
       * beside-box 字幕框左边 / left-top 左上角 / left-bottom 左下角 /
       * right-top 右上角 / right-bottom 右下角 / center 画面中间
       */
      stickerPos: 'beside-box',
      /** 贴纸大小：small 小 / medium 中 / large 大 */
      stickerSizeName: 'medium',
      /** 抠图：auto 自动抠纯色底 / off 不抠（边缘不满意就关掉） */
      stickerKey: 'auto',
      /** 抠完裁掉多少边框（0~0.1，去掉残余白边；默认 0.02） */
      stickerTrim: 0.02,
      /** 按文案情绪自动挑贴纸（用户放多张时用） */
      stickerAutoEmotion: true,
      /** 每句换一张表情（中途替换），关掉就整条只用一张 */
      stickerPerLine: true,
      /** 贴纸中心点（0~1）；预设位置会写入这里，也可以在设置里用 X/Y 微调 */
      stickerX: 0.20,
      stickerY: 0.60,
      /** 贴纸宽度占画面比例 */
      stickerScale: 0.26,
      /** 左侧空白贴的表情（emoji 字符，如 🐳）；空 = 不贴 */
      sticker: '',
      /** 表情大小（占画面宽度比例） */
      stickerSize: 0.22,
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
    tone: 'lively',
    catchphrases: '啧,诶嘿,懒得动,圆滚滚地滚过来了',
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
      persona: 'persona-cetacea',
      reply: 'reply',
      script: 'script',
      title: 'title',
      caption: 'caption',
      pick: 'comment-pick',
      ops: 'ops',
      /** 去AI味改写 */
      deai: 'de-ai'
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
/**
 * 列出 cfg 相对 DEFAULTS 被磁盘配置改过的键。
 * 排查"我改了默认值怎么没生效"时非常有用——最常见的坑是 config.json 里存了旧值。
 */
export function listOverrides(cfg) {
  const out = [];
  for (const group of ['reply', 'publish', 'quotas', 'dwell', 'video']) {
    const a = cfg?.[group] ?? {};
    const d = DEFAULTS[group] ?? {};
    for (const k of Object.keys(a)) {
      if (JSON.stringify(a[k]) !== JSON.stringify(d[k])) out.push(`${group}.${k}`);
    }
  }
  return out;
}

export function applySettingsOverrides(cfg, flat) {
  if (!flat || typeof flat !== 'object') return cfg;
  if (typeof flat.enabled === 'boolean') cfg.enabled = flat.enabled;
  if (Number.isFinite(Number(flat.assetsPort))) cfg.assets.port = Number(flat.assetsPort);
  if (typeof flat.assetsDir === 'string' && flat.assetsDir.trim()) cfg.assets.dir = flat.assetsDir.trim();
  if (Number.isFinite(Number(flat.assetsMaxMB))) cfg.assets.maxMB = Number(flat.assetsMaxMB);
  if (['auto', 'adb', 'web'].includes(flat.mode)) cfg.mode = flat.mode;
  if (flat.webProfileDir) cfg.web.profileDir = String(flat.webProfileDir);
  if (flat.browserPath) cfg.web.browserPath = String(flat.browserPath);
  if (typeof flat.webPersist === 'boolean') cfg.web.persist = flat.webPersist;
  if (Number.isFinite(Number(flat.webIdleCloseMin))) cfg.web.idleCloseMin = Math.max(0, Number(flat.webIdleCloseMin));
  if (flat.ffmpegPath) cfg.video.ffmpegPath = String(flat.ffmpegPath);
  if (flat.videoVoice) cfg.video.voice = String(flat.videoVoice);
  for (const k of ['scrollPerRun', 'replyPerRun', 'likePerRun', 'publishPerDay']) {
    if (Number.isFinite(Number(flat[k]))) cfg.quotas[k] = Number(flat[k]);
  }
  if (flat.replyPromptId) cfg.prompts.active.reply = String(flat.replyPromptId);
  if (flat.scriptPromptId) cfg.prompts.active.script = String(flat.scriptPromptId);
  if (flat.deaiPromptId) cfg.prompts.active.deai = String(flat.deaiPromptId);
  // 表情包回复
  cfg.reply.sticker = { ...DEFAULTS.reply.sticker, ...(cfg.reply.sticker ?? {}) };
  if (typeof flat.replyStickerEnabled === 'boolean') cfg.reply.sticker.enabled = flat.replyStickerEnabled;
  if (Number.isFinite(Number(flat.replyStickerRate))) cfg.reply.sticker.rate = Math.min(1, Math.max(0, Number(flat.replyStickerRate)));
  if (['append', 'only'].includes(flat.replyStickerMode)) cfg.reply.sticker.mode = flat.replyStickerMode;
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
  if (flat.videoTemplateBox && typeof flat.videoTemplateBox === 'object') {
    const b = flat.videoTemplateBox;
    if (Number.isFinite(Number(b.x0)) && Number.isFinite(Number(b.x1))) {
      cfg.video.templateMode = true;
      cfg.video.templateBox = {
        x0: Math.min(1, Math.max(0, Number(b.x0))),
        y0: Math.min(1, Math.max(0, Number(b.y0))),
        x1: Math.min(1, Math.max(0, Number(b.x1))),
        y1: Math.min(1, Math.max(0, Number(b.y1))),
        padX: Number.isFinite(Number(b.padX)) ? Number(b.padX) : 0.02,
        padY: Number.isFinite(Number(b.padY)) ? Number(b.padY) : 0.06,
        color: typeof b.color === 'string' ? b.color : '0x2b4a7d',
        lineGap: Number.isFinite(Number(b.lineGap)) ? Number(b.lineGap) : 1.15
      };
    }
  }
  // video.sticker 存在 audio 段
  if (typeof flat.videoTitleBar === 'string') cfg.video.titleBar = flat.videoTitleBar;
  if (typeof flat.videoAiBadge === 'string') cfg.video.aiBadge = flat.videoAiBadge;
  if (typeof flat.videoSpeakerName === 'string') cfg.video.speakerName = flat.videoSpeakerName;
  if (typeof flat.videoTyping === 'boolean') cfg.video.typing = flat.videoTyping;
  if (typeof flat.videoStickerFile === 'string') cfg.video.audio.stickerFile = flat.videoStickerFile;
  if (typeof flat.videoStickerPos === 'string') cfg.video.audio.stickerPos = flat.videoStickerPos;
  if (typeof flat.videoStickerSizeName === 'string') cfg.video.audio.stickerSizeName = flat.videoStickerSizeName;
  if (typeof flat.videoStickerAutoEmotion === 'boolean') cfg.video.audio.stickerAutoEmotion = flat.videoStickerAutoEmotion;
  if (typeof flat.videoStickerPerLine === 'boolean') cfg.video.audio.stickerPerLine = flat.videoStickerPerLine;
  if (Number.isFinite(Number(flat.videoMinDurationSec))) cfg.video.minDurationSec = Math.min(180, Math.max(3, Number(flat.videoMinDurationSec)));
  if (Number.isFinite(Number(flat.videoTargetDurationSec))) cfg.video.targetDurationSec = Math.min(180, Math.max(5, Number(flat.videoTargetDurationSec)));
  if (typeof flat.videoStickerKey === 'string') cfg.video.audio.stickerKey = flat.videoStickerKey;
  // 贴纸 X/Y 微调（0~1）
  if (Number.isFinite(Number(flat.videoStickerX2))) cfg.video.audio.stickerX = Math.min(1, Math.max(0, Number(flat.videoStickerX2)));
  if (Number.isFinite(Number(flat.videoStickerY2))) cfg.video.audio.stickerY = Math.min(1, Math.max(0, Number(flat.videoStickerY2)));
  if (Number.isFinite(Number(flat.videoStickerX))) cfg.video.audio.stickerX = Math.min(1, Math.max(0, Number(flat.videoStickerX)));
  if (Number.isFinite(Number(flat.videoStickerY))) cfg.video.audio.stickerY = Math.min(1, Math.max(0, Number(flat.videoStickerY)));
  if (Number.isFinite(Number(flat.videoStickerScale))) cfg.video.audio.stickerScale = Math.min(0.9, Math.max(0.05, Number(flat.videoStickerScale)));
  if (typeof flat.videoSticker === 'string') cfg.video.audio.sticker = flat.videoSticker;
  if (Number.isFinite(Number(flat.videoStickerSize))) cfg.video.audio.stickerSize = Math.min(0.4, Math.max(0.08, Number(flat.videoStickerSize)));
  if (Number.isFinite(Number(flat.videoStickerSize))) cfg.video.stickerSize = Math.min(0.4, Math.max(0.08, Number(flat.videoStickerSize)));
  if (typeof flat.videoVoiceCute === 'string') {
    if (['', 'loli', 'loli_hard', 'loli_soft', 'natural'].includes(flat.videoVoiceCute)) cfg.video.audio.cute = flat.videoVoiceCute;
  }
  for (const k of ['stutter', 'breath', 'pause']) {
    const real = k === 'stutter' ? 'stutter' : k;
    if (typeof flat[`cute_${real}`] === 'boolean') cfg.video.audio[real] = flat[`cute_${real}`];
  }
  if (Number.isFinite(Number(flat.videoLengthScale))) cfg.video.audio.lengthScale = Number(flat.videoLengthScale);
  if (typeof flat.videoVoiceSoften === 'string') {
    const ok = ['', 'none', 'clean', 'soft', 'softer', 'mellow'];
    if (ok.includes(flat.videoVoiceSoften)) cfg.video.audio.soften = flat.videoVoiceSoften;
  }
  if (typeof flat.videoVoice === 'string' && flat.videoVoice.trim()) cfg.video.audio.voice = flat.videoVoice.trim();
  if (typeof flat.videoPiperExe === 'string') cfg.video.audio.piperExe = flat.videoPiperExe.trim();
  if (typeof flat.videoPiperModel === 'string') cfg.video.audio.piperModel = flat.videoPiperModel.trim();
  if (Number.isFinite(Number(flat.videoVoiceRate))) cfg.video.audio.rate = Number(flat.videoVoiceRate);
  if (typeof flat.videoBgmFile === 'string') cfg.video.audio.bgmFile = flat.videoBgmFile.trim();
  if (Number.isFinite(Number(flat.videoBgmGainDb))) cfg.video.audio.bgmGainDb = Number(flat.videoBgmGainDb);
  // 发布：默认标签 / 封面 / 标题
  if (typeof flat.publishTopics === 'string') {
    // 常见中文分隔符都要认：逗号/顿号/分号/空白（之前只认逗号和空白，"大肥鱼、测试" 会变成废标签）
    const list = flat.publishTopics.split(/[,，、;；|\s]+/).map((s) => s.replace(/^#/, '').trim()).filter(Boolean);
    cfg.publish.topics = list.slice(0, cfg.publish.topicsMax);
  }
  // 空串代表"清空"：必须是 string 就赋值（之前 trim() 判空导致清不掉）
  if (typeof flat.publishCoverFile === 'string') cfg.publish.coverFile = flat.publishCoverFile.trim();
  if (typeof flat.publishTitle === 'string') cfg.publish.title = flat.publishTitle.trim();

  if (typeof flat.loopEnabled === 'boolean') cfg.loop.enabled = flat.loopEnabled;
  if (typeof flat.loopResetQuota === 'boolean') cfg.loop.resetQuotaOnExhaust = flat.loopResetQuota;
  if (Number.isFinite(Number(flat.scrollRunMaxMinutes))) cfg.scroll.runMaxMinutes = Math.max(1, Number(flat.scrollRunMaxMinutes));
  if (Number.isFinite(Number(flat.loopGapSec))) cfg.loop.gapSec = Math.max(0, Number(flat.loopGapSec));
  if (Number.isFinite(Number(flat.loopMaxRounds))) cfg.loop.maxRounds = Math.max(0, Number(flat.loopMaxRounds));
  if (typeof flat.searchEnabled === 'boolean') cfg.search.enabled = flat.searchEnabled;
  if (typeof flat.searchKeywords === 'string') cfg.search.keywords = flat.searchKeywords.split(/[,，、\s]+/).filter(Boolean);
  if (Number.isFinite(Number(flat.searchLimit))) cfg.search.limit = Math.min(20, Math.max(1, Number(flat.searchLimit)));
  if (Number.isFinite(Number(flat.searchFeedToVideo))) cfg.search.feedToVideo = Math.min(10, Math.max(0, Number(flat.searchFeedToVideo)));
  if (Number.isFinite(Number(flat.summaryPerDay))) cfg.summary.perDay = Math.max(0, Number(flat.summaryPerDay));
  if (typeof flat.summaryRefresh === 'boolean') cfg.summary.refresh = flat.summaryRefresh;
  // 字幕句数：直接决定视频多长（12 句 ≈ 一分钟）
  if (Number.isFinite(Number(flat.videoLineCount))) cfg.video.lineCount = Math.min(20, Math.max(2, Number(flat.videoLineCount)));
  if (Number.isFinite(Number(flat.goalFans))) cfg.goal.fans = Math.max(0, Number(flat.goalFans));
  if (typeof flat.videoStats === 'boolean') cfg.video.stats = flat.videoStats;
  if (typeof flat.textDeai === 'boolean') cfg.text.deai = flat.textDeai;
  // 直播
  if (typeof flat.liveRoomUrl === 'string') cfg.live.roomUrl = flat.liveRoomUrl.trim();
  if (typeof flat.liveTokenKey === 'string') cfg.live.tokenKey = flat.liveTokenKey.trim();
  if (Number.isFinite(Number(flat.liveJumps))) cfg.live.jumps = Math.min(60, Math.max(1, Number(flat.liveJumps)));
  if (typeof flat.liveRecord === 'boolean') cfg.live.record = flat.liveRecord;

  // 视频标签白名单（决定"在哪些视频下回评"）
  if (typeof flat.replyAtOwner === 'string') cfg.reply.atOwner = flat.replyAtOwner.trim();
  if (typeof flat.replyIncludeOwn === 'boolean') cfg.reply.includeOwn = flat.replyIncludeOwn;
  if (typeof flat.replyVideoTagWhitelist === 'string') {
    cfg.reply.videoTagWhitelist = flat.replyVideoTagWhitelist
      .split(/[,，、;；\s]+/).map((s) => s.replace(/^#/, '').trim()).filter(Boolean);
  }

  // 评论标签白名单
  if (typeof flat.replyTagWhitelist === 'string') {
    cfg.reply.tagWhitelist = flat.replyTagWhitelist
      .split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean);
  }

  /**
   * 关键词白名单（决定"回哪些评论"）。
   * 以前根本没有这个映射 —— 面板里改不了，永远用写死的 20 个词，
   * 结果大部分评论都被挡掉（用户反馈"发评论积极点"）。
   * 现在：留空 = 全回（只受黑名单限制）。
   */
  if (typeof flat.replyWhitelist === 'string') {
    cfg.reply.whitelist = flat.replyWhitelist
      .split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean);
  }
  if (typeof flat.replyBlacklist === 'string') {
    const list = flat.replyBlacklist.split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean);
    if (list.length) cfg.reply.blacklist = list;
  }

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
  cfg.quotas.scrollPerRun = clamp(cfg.quotas.scrollPerRun, 0, 500, 0);   // 0 = 不限
  cfg.scroll.runMaxMinutes = clamp(cfg.scroll.runMaxMinutes, 1, 180, 10);
  cfg.quotas.replyPerRun = clamp(cfg.quotas.replyPerRun, 0, 100, 0);   // 0 = 不限
  cfg.quotas.likePerRun = clamp(cfg.quotas.likePerRun, 0, 200, 5);
  cfg.quotas.publishPerDay = clamp(cfg.quotas.publishPerDay, 0, 20, 2);
  cfg.reply.maxChars = clamp(cfg.reply.maxChars, 1, 500, 60);
  cfg.publish.captionMax = clamp(cfg.publish.captionMax, 0, 2000, 120);
  if (!Array.isArray(cfg.reply.blacklist)) cfg.reply.blacklist = DEFAULTS.reply.blacklist;
  // 表情包回复：坏值收敛，别让设置页填错把插件搞挂
  cfg.reply.sticker = { ...DEFAULTS.reply.sticker, ...(cfg.reply.sticker ?? {}) };
  cfg.reply.sticker.rate = clamp(cfg.reply.sticker.rate, 0, 1, 0.3);
  if (!['append', 'only'].includes(cfg.reply.sticker.mode)) cfg.reply.sticker.mode = 'append';
  if (!Array.isArray(cfg.publish.videoExt)) cfg.publish.videoExt = DEFAULTS.publish.videoExt;
  if (typeof cfg.pkg !== 'string' || !cfg.pkg.includes('.')) throw new Error('pkg 必须是 Android 包名');
  return cfg;
}
