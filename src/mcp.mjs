#!/usr/bin/env node
// MCP server（stdio）：把快手操作暴露成工具。后端自动选 adb（模拟器/真机）或 web（网页版）。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, projectRoot } from './config.mjs';
import { createBackend } from './driver.mjs';
import { VideoStudio } from './video.mjs';
import { PromptLibrary } from './prompts.mjs';
import { checkEnvironment } from './env-check.mjs';
import { applySpeakingGuide, composeSpeakingGuide } from './style.mjs';
import { OpsState, makePlan, runPlan, pickReply } from './ops.mjs';

let cfg = loadConfig();
const log = (line) => process.stderr.write(`${line}\n`);
let video = new VideoStudio({ cfg, log });
let prompts = new PromptLibrary({ cfg });

/**
 * 配置热重载。
 *
 * 之前 cfg 只在进程启动时读一次 —— 用户在设置页改了背景图/配额，MCP 这边**完全不知道**，
 * 直到重启 DSH 才生效（"我明明设了背景图但没生效"就是这个）。这里每次工具调用前比一下
 * config.json / state/settings.json / profile patch 的 mtime，变了就重建 cfg 与依赖它的对象。
 */
const watchedFiles = [
  path.join(projectRoot(), 'config.json'),
  path.join(projectRoot(), 'state', 'settings.json'),
  path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh'), 'profiles', process.env.KSOPS_PROFILE || 'desktop', 'cordis.patch.yml')
];
let configSignature = '';
function computeSignature() {
  return watchedFiles.map((f) => {
    try { const st = fs.statSync(f); return `${f}:${st.mtimeMs}:${st.size}`; } catch { return `${f}:-`; }
  }).join('|');
}
function ensureFreshConfig() {
  const sig = computeSignature();
  if (sig === configSignature) return false;
  const first = !configSignature;
  configSignature = sig;
  cfg = loadConfig();
  video = new VideoStudio({ cfg, log });
  prompts = new PromptLibrary({ cfg });
  cached = null; // 后端也要按新配置重建（mode/profileDir 可能变了）
  if (!first) log('[kuaishou-ops] config reloaded (settings changed on disk)');
  return !first;
}

/** 每次请求现建后端（web 后端内部有 page 复用；adb 后端很轻）。用完不关，靠进程退出回收。 */
let cached = null;
async function backend() {
  if (cached) return cached;
  cached = await createBackend({ cfg, log });
  log(`[kuaishou-ops] backend = ${cached.mode}`);
  return cached;
}

function state() {
  return new OpsState({ file: path.join(projectRoot(), cfg.stateFile) }).load();
}

/** 总开关闸门：关掉时动作类工具直接拒绝（状态/环境/提示词类不受限）。 */
function ensureEnabled(tool) {
  if (cfg.enabled === false) {
    throw new Error(`插件总开关已关闭（设置 → 快手 → 启用）。要执行 ${tool}，先把开关打开`);
  }
}

function ok(payload) {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }] };
}

function fail(error) {
  const parts = [`❌ ${error.name || 'Error'}: ${error.message}`];
  if (error.step) parts.push(`步骤：${error.step}`);
  if (error.hint) parts.push(`建议：${error.hint}`);
  if (Array.isArray(error.screen) && error.screen.length) {
    parts.push('当前屏幕文本：');
    parts.push(error.screen.slice(0, 20).map((n) => `- ${n.text} @(${n.cx},${n.cy})`).join('\n'));
  }
  if (error.cmd) parts.push(`命令：${error.cmd}`);
  return { content: [{ type: 'text', text: parts.join('\n') }], isError: true };
}

const server = new McpServer({ name: 'kuaishou-ops', version: '1.3.0' });

// 所有工具调用前统一热重载配置：设置页改完不用重启 DSH
const registerTool = server.registerTool.bind(server);
server.registerTool = (name, meta, handler) => registerTool(name, meta, async (...args) => {
  ensureFreshConfig();
  return handler(...args);
});

server.registerTool(
  'ks_status',
  { title: '状态（自动选后端）', description: '看当前用哪个后端（adb / 网页版）、设备或页面状态、是否登录。动手前先跑这个。', inputSchema: {} },
  async () => {
    try { return ok(await (await backend()).status()); } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_logout_hint',
  { title: '登录说明', description: '网页版需要登录时该怎么做（扫码一次，登录态存 user-data-dir）', inputSchema: {} },
  async () => ok({
    mode: cfg.mode ?? 'auto',
    webProfile: path.resolve(projectRoot(), cfg.web?.profileDir ?? '.web-profile'),
    steps: [
      '1) 运行 node cli.mjs web-login，会打开一个 Edge 窗口停在快手首页',
      '2) 在那个窗口里点「立即登录」并扫码',
      '3) 登录成功后**别关窗口**，直接跑 node cli.mjs status 看 loggedIn=true',
      '4) 之后所有网页版操作都复用这个 profile，不用重复扫码'
    ]
  })
);

server.registerTool(
  'ks_devices',
  {
    title: 'adb 设备列表（仅 adb 后端）',
    description: '列出 adb 设备；网页版后端下会说明当前没走 adb',
    inputSchema: {}
  },
  async () => {
    try {
      const b = await backend();
      if (b.mode !== 'adb') return ok({ backend: b.mode, note: '当前用网页版后端，没有 adb 设备概念（想强制 adb：config.json 的 mode 设为 adb）' });
      return ok({ backend: 'adb', adbPath: b.adb.adbPath, devices: await b.adb.devices() });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_screen',
  { title: '截屏', description: '截图并返回图片（网页版截当前页；adb 截设备屏）', inputSchema: {} },
  async () => {
    try {
      const b = await backend();
      const shot = await b.screenshot();
      const buf = await (await import('node:fs/promises')).readFile(shot.file);
      return {
        content: [
          { type: 'text', text: `${b.mode} 截图 ${(buf.length / 1024).toFixed(0)} KB → ${shot.file}` },
          { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' }
        ]
      };
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_feed_scroll',
  {
    title: '刷视频（看 N 条）',
    description: 'adb：停留随机时长后上滑；网页版：按视频时长停留后点「下一条」。都不截图，token 成本≈0。',
    inputSchema: {
      count: z.number().int().min(1).max(200).default(10),
      dwellMinMs: z.number().int().min(500).max(300000).optional(),
      dwellMaxMs: z.number().int().min(500).max(600000).optional()
    }
  },
  async ({ count, dwellMinMs, dwellMaxMs }) => {
    try {
      ensureEnabled('刷视频');
      const b = await backend();
      if (dwellMinMs && dwellMaxMs) {
        b.cfg.dwell = { ...b.cfg.dwell, minMs: dwellMinMs, maxMs: Math.max(dwellMinMs, dwellMaxMs) };
      }
      const steps = await b.feedScroll({ count });
      // 记账：ks_plan/ks_run 的配额依赖它，之前只有 ks_run 记，单独刷不算数（bug）
      const st = state();
      st.add('scroll', steps.length);
      st.save();
      return ok({
        backend: b.mode,
        scrolled: steps.length,
        totalDwellMs: steps.reduce((s, x) => s + x.dwellMs, 0),
        steps
      });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_like',
  { title: '点赞当前视频', description: 'adb：双击屏幕中部；网页版：点 .like-btn 并对比赞数是否变化', inputSchema: {} },
  async () => {
    try {
      ensureEnabled('点赞');
      const result = await (await backend()).like();
      if (result?.changed) { const st = state(); st.add('like', 1); st.save(); }
      return ok(result);
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_comments',
  {
    title: '读评论',
    description: '读取当前视频的评论（作者/内容/时间/赞数）。网页版游客态也能读。',
    inputSchema: { keepOpen: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(30) }
  },
  async ({ keepOpen, limit }) => {
    try {
      ensureEnabled('读评论');
      const b = await backend();
      const list = await b.comments({ keepOpen, limit });
      return ok({ backend: b.mode, count: list.length, comments: list });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_reply',
  {
    title: '回一条评论',
    description: '按评论文本片段定位并回复。文案会过长度/拉黑词红线；网页版未登录会明确要求先扫码。',
    inputSchema: { match: z.string().min(1), content: z.string().min(1) }
  },
  async ({ match, content }) => {
    try { ensureEnabled('回评论'); return ok(await (await backend()).reply({ match, content })); } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_reply_auto',
  {
    title: '批量回评论（模板 + 配额）',
    description: '读评论 → 过白/黑名单 → 用模板回最多 limit 条（受今日配额限制）',
    inputSchema: {
      limit: z.number().int().min(1).max(20).default(3),
      style: z.enum(['gentle', 'funny', 'professional']).default('gentle')
    }
  },
  async ({ limit, style }) => {
    try {
      ensureEnabled('批量回评论');
      const b = await backend();
      const st = state();
      const budget = Math.min(limit, st.remaining('reply', cfg.quotas.replyPerRun));
      const comments = await b.comments({ keepOpen: true, limit: 60 });
      const candidates = comments.filter((c) => {
        const t = c.text ?? '';
        if (t.length < cfg.reply.minChars) return false;
        if (cfg.reply.blacklist.some((w) => w && t.includes(w))) return false;
        const wl = cfg.reply.whitelist ?? [];
        return wl.length === 0 || wl.some((w) => (w === '?' || w === '？' ? /[?？]/.test(t) : t.includes(w)));
      }).slice(0, budget);

      const done = [];
      for (const c of candidates) {
        const content = pickReply(c.text) + (style === 'funny' ? ' 😄' : '');
        try {
          await b.reply({ match: c.text.slice(0, 12), content, openPanel: false });
          st.add('reply', 1, { matched: c.text.slice(0, 40) });
          done.push({ matched: c.text.slice(0, 40), content });
        } catch (error) {
          done.push({ matched: c.text.slice(0, 40), error: error.message });
        }
        await new Promise((r) => setTimeout(r, 1200 + Math.random() * 2000));
      }
      st.save();
      return ok({ backend: b.mode, budget, replied: done.filter((d) => !d.error).length, done });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_publish_video',
  {
    title: '发视频',
    description: 'adb：推文件进相册后走 App 发布流程；网页版：调创作者服务平台上传（需登录）',
    inputSchema: {
      file: z.string().min(1),
      caption: z.string().default(''),
      pushOnly: z.boolean().default(false).describe('仅 adb 后端有效：只推文件不发布')
    }
  },
  async ({ file, caption, pushOnly }) => {
    try {
      ensureEnabled('发视频');
      const b = await backend();
      const st = state();
      if (!pushOnly) {
        const left = st.remaining('publish', cfg.quotas.publishPerDay);
        if (left <= 0) throw new Error(`今天的发布配额用完了（${cfg.quotas.publishPerDay} 条/天）`);
      }
      const result = await b.publish({ file, caption, pushOnly });
      if (result.published) { st.add('publish', 1, { file: path.basename(file) }); st.save(); }
      return ok({ backend: b.mode, ...result });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_plan',
  { title: '生成运营计划', description: '按剩余配额算这一轮要做什么', inputSchema: { wantPublish: z.boolean().default(false) } },
  async ({ wantPublish }) => {
    try {
      const st = state();
      return ok({ counts: st.data.counts, plan: makePlan({ quotas: cfg.quotas, state: st, wantPublish }) });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_run',
  {
    title: '跑一轮运营',
    description: '刷视频 + 回评论 + 点赞，按配额执行；后端自动选',
    inputSchema: {
      scroll: z.number().int().min(0).max(200).optional(),
      replies: z.number().int().min(0).max(20).optional(),
      likes: z.number().int().min(0).max(50).optional()
    }
  },
  async ({ scroll, replies, likes }) => {
    try {
      ensureEnabled('跑一轮运营');
      const b = await backend();
      const st = state();
      let plan = makePlan({ quotas: cfg.quotas, state: st });
      if (typeof scroll === 'number' || typeof replies === 'number' || typeof likes === 'number') {
        plan = [];
        if (scroll) plan.push({ kind: 'scroll', count: scroll });
        if (replies) plan.push({ kind: 'reply', count: replies });
        if (likes) plan.push({ kind: 'like', count: likes });
      }
      // 把后端包装成 runPlan 认识的形状（feedScroll / like / openComments / readComments / replyToComment / closeComments / shouldReply）
      const ksLike = {
        feedScroll: (o) => b.feedScroll(o),
        like: () => b.like(),
        openComments: async () => await b.comments({ keepOpen: true, limit: 1 }),
        readComments: async () => await b.comments({ keepOpen: true, limit: 100 }),
        closeComments: async () => {},
        replyToComment: (a) => b.reply(a),
        shouldReply: (t) => {
          if (String(t).length < cfg.reply.minChars) return false;
          if (cfg.reply.blacklist.some((w) => w && String(t).includes(w))) return false;
          const wl = cfg.reply.whitelist ?? [];
          return wl.length === 0 || wl.some((w) => (w === '?' || w === '？' ? /[?？]/.test(t) : String(t).includes(w)));
        }
      };
      const result = await runPlan({ ks: ksLike, state: st, plan });
      return ok({ backend: b.mode, plan, counts: result.counts, events: result.events.slice(-40) });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_state',
  { title: '运营状态', description: '今日计数、上次运行、最近日志', inputSchema: {} },
  async () => {
    try { return ok(state().data); } catch (error) { return fail(error); }
  }
);

// ── 视频流水线（剪辑 / 配音 / 字幕 / 封面） ──────────────────────────────────

server.registerTool(
  'ks_style_preview',
  {
    title: '预览「说话与打字」效果',
    description: '把设置页里的称呼/语气/口头禅/字数/打字习惯拼成一段人设指南，返回文本。改完想确认效果时用。',
    inputSchema: {}
  },
  async () => {
    try {
      const guide = composeSpeakingGuide(cfg.style);
      return ok({ style: cfg.style, guide, chars: guide.length });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_env',
  {
    title: '环境检查',
    description: '检查开关、上传服务、后端、浏览器/登录态、ffmpeg、字体、语音、素材。每项都给"能不能用 + 怎么修"。',
    inputSchema: { deep: z.boolean().default(false).describe('true=额外探测 adb 设备（慢一点）') }
  },
  async ({ deep }) => {
    try { return ok(await checkEnvironment({ cfg, deep })); } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_video_probe',
  {
    title: '探测视频/音频',
    description: '读时长、分辨率、帧率、编码、是否带音轨（剪辑前先看这一步）',
    inputSchema: { file: z.string().min(1) }
  },
  async ({ file }) => {
    try { return ok(await video.probe(path.resolve(file))); } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_video_tts',
  {
    title: '中文配音（离线 TTS）',
    description: '用 Windows 系统语音把文字念成 WAV（默认 Microsoft Huihui Desktop），返回文件与时长',
    inputSchema: {
      text: z.string().min(1),
      voice: z.string().optional().describe('语音名，默认 config.video.voice'),
      rate: z.number().int().min(-10).max(10).optional().describe('语速 -10~10')
    }
  },
  async ({ text, voice, rate }) => {
    try {
      return ok(await video.tts({ text, voice: voice ?? cfg.video.voice, rate }));
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_voice_list',
  {
    title: '可用语音（换声音先看这里）',
    description: '列出系统 SAPI 语音（不需要任何文件）与 Piper 模型是否就绪。换声音只要把名字填进设置页的「配音语音」。',
    inputSchema: {}
  },
  async () => {
    try {
      const info = await video.voices();
      return ok({
        ...info,
        hint: info.engine === 'sapi'
          ? '当前用系统语音：直接改 voice 名即可，不需要文件'
          : '当前用 piper：确认 videoPiperExe / videoPiperModel 两个文件都存在'
      });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_voice_preview',
  {
    title: '试听一段语音',
    description: '用指定引擎/语音合成一句话，返回 wav 路径与时长。换声音之前先听一下最省事。',
    inputSchema: {
      text: z.string().min(1).default('这是一段试听语音'),
      engine: z.enum(['sapi', 'piper']).optional(),
      voice: z.string().optional().describe('SAPI 语音名，如 Microsoft Huihui Desktop'),
      rate: z.number().int().min(-10).max(10).optional()
    }
  },
  async ({ text, engine, voice, rate }) => {
    try {
      const r = await video.tts({ text, engine, voice, rate });
      return ok({ engine: r.engine, voice: r.voice, file: r.file, durationSec: Number((r.durationSec ?? 0).toFixed(2)), bytes: r.bytes });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_video_from_text',
  {
    title: '文案 → 成片（口播视频）',
    description: '一条龙：文案 → 中文配音 → 1080×1920 竖屏底 → 逐句字幕 → 成片 + 封面。适合做"DeepSeek 风格"的讲述类短视频。',
    inputSchema: {
      title: z.string().default('').describe('顶部大标题'),
      lines: z.array(z.string()).default([]).describe('逐句字幕（也按顺序念出来）'),
      voiceText: z.string().default('').describe('配音原文；留空则用 title + lines 拼'),
      // 背景
      bgColor: z.string().optional().describe('纯色背景，如 0x0f1419（默认取设置页 videoBgColor）'),
      bgImage: z.string().optional().describe('背景图绝对路径（jpg/png）'),
      bgVideo: z.string().optional().describe('背景视频绝对路径（循环+静音），优先级最高'),
      bgPreset: z.string().optional().describe('渐变预设：deep-sea / night-purple / whale-blue / sakura / paper / mint'),
      bgGradientFrom: z.string().optional().describe('渐变起始色 0xRRGGBB'),
      bgGradientTo: z.string().optional().describe('渐变结束色 0xRRGGBB'),
      bgGradientAxis: z.enum(['vertical', 'horizontal']).optional().describe('渐变方向'),
      bgBlur: z.number().min(0).max(60).optional().describe('背景模糊强度（图片/视频有效）'),
      bgFit: z.enum(['cover', 'contain']).optional().describe('背景图适配方式'),
      bgDim: z.number().min(0).max(1).optional().describe('背景图压暗 0~1'),
      // 字体
      fontPath: z.string().optional().describe('字体文件路径（ttf/ttc）；默认取设置页 videoFontPath 或系统微软雅黑'),
      fontSize: z.number().int().min(16).max(200).optional().describe('字幕字号'),
      titleFontSize: z.number().int().min(16).max(300).optional().describe('标题字号'),
      fontColor: z.string().optional().describe('字幕颜色，如 white / yellow / 0xFFE066'),
      titleColor: z.string().optional().describe('标题颜色'),
      boxAlpha: z.number().min(0).max(1).optional().describe('字幕底色块透明度'),
      subtitleY: z.number().min(0.3).max(0.98).optional().describe('字幕底边位置（占画面高度）'),
      // 声音
      voice: z.string().optional().describe('系统语音名，如 Microsoft Huihui Desktop'),
      rate: z.number().int().min(-10).max(10).optional().describe('语速 -10~10'),
      bgmFile: z.string().optional().describe('BGM 文件路径；空=不加'),
      bgmGainDb: z.number().min(-60).max(12).optional().describe('BGM 音量（相对配音，dB）'),
      out: z.string().default('').describe('输出路径；留空写到 state/video/')
    }
  },
  async (args) => {
    try {
      ensureEnabled('生成视频');
      const result = await video.fromText({
        title: args.title, lines: args.lines, voiceText: args.voiceText,
        bgColor: args.bgColor, bgImage: args.bgImage, bgVideo: args.bgVideo, bgFit: args.bgFit, bgDim: args.bgDim, bgBlur: args.bgBlur,
        bgPreset: args.bgPreset, bgGradientFrom: args.bgGradientFrom, bgGradientTo: args.bgGradientTo, bgGradientAxis: args.bgGradientAxis,
        fontPath: args.fontPath, fontSize: args.fontSize, titleFontSize: args.titleFontSize,
        fontColor: args.fontColor, titleColor: args.titleColor, boxAlpha: args.boxAlpha, subtitleY: args.subtitleY,
        voice: args.voice, rate: args.rate, bgmFile: args.bgmFile, bgmGainDb: args.bgmGainDb,
        width: cfg.video.width, height: cfg.video.height, fps: cfg.video.fps,
        out: args.out ? path.resolve(args.out) : ''
      });
      return ok({
        file: result.file,
        cover: result.cover,
        durationSec: Number(result.durationSec.toFixed(2)),
        sizeMB: Number((result.sizeBytes / 1024 / 1024).toFixed(2)),
        subtitles: result.subtitles,
        voice: { file: result.voice.file, durationSec: Number(result.voice.durationSec.toFixed(2)) }
      });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_video_style',
  {
    title: '看当前视频样式',
    description: '返回生效的背景 / 字体 / 声音设置（来自设置页与 config.json）。想改就写同名字段或传参给 ks_video_from_text。',
    inputSchema: {}
  },
  async () => {
    try {
      const style = video.resolveStyle({});
      return ok({
        effective: {
          background: style.bg,
          typography: style.ty,
          audio: style.au,
          canvas: { width: style.width, height: style.height, fps: style.fps }
        },
        settingsKeys: {
          videoBgColor: '纯色背景', videoBgImage: '背景图路径', videoBgFit: 'cover|contain', videoBgDim: '压暗 0~1',
          videoFontPath: '字体文件', videoFontSize: '字幕字号', videoTitleFontSize: '标题字号',
          videoFontColor: '字幕颜色', videoTitleColor: '标题颜色', videoBoxAlpha: '字幕底色透明度', videoSubtitleY: '字幕底边位置',
          videoVoice: '语音名', videoVoiceRate: '语速', videoBgmFile: 'BGM 路径', videoBgmGainDb: 'BGM 音量 dB'
        }
      });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_video_compose',
  {
    title: '剪辑已有素材 → 成片',
    description: '素材（视频/图片）→ 竖屏归一化 → 顺序拼接 → 逐句字幕 → 配音/BGM → 封面。素材可以是自己录的片段。',
    inputSchema: {
      clips: z.array(z.string()).default([]).describe('视频文件路径，按顺序拼接'),
      images: z.array(z.string()).default([]).describe('图片路径（每张 3 秒）'),
      lines: z.array(z.string()).default([]).describe('逐句字幕'),
      voiceText: z.string().default('').describe('配音文案；留空则只上字幕不配音'),
      bgmFile: z.string().default('').describe('BGM 文件（会压到 -24dB）'),
      out: z.string().default('')
    }
  },
  async ({ clips, images, lines, voiceText, bgmFile, out }) => {
    try {
      ensureEnabled('剪辑视频');
      const dir = video.workDir();
      const stamp = Date.now();
      const normalized = [];
      for (const [i, f] of [...clips, ...images].entries()) {
        const r = await video.normalize({
          input: path.resolve(f),
          out: path.join(dir, `norm-${stamp}-${i}.mp4`),
          durSec: clips.includes(f) ? 0 : 3,
          width: cfg.video.width, height: cfg.video.height, fps: cfg.video.fps
        });
        normalized.push(r.file);
      }
      if (normalized.length === 0) throw new Error('clips 和 images 至少给一个素材');
      const merged = normalized.length > 1
        ? await video.concat({ files: normalized, out: path.join(dir, `merged-${stamp}.mp4`) })
        : { file: normalized[0] };

      const voice = voiceText
        ? await video.tts({ text: voiceText, voice: cfg.video.audio.voice, engine: cfg.video.audio.engine, rate: cfg.video.audio.rate })
        : null;
      const total = voice ? voice.durationSec + 0.4 : merged.durationSec;
      const items = lines.length ? (await import('./video.mjs')).planSubtitles(lines, Math.max(1, total - 0.3)) : [];
      const subbed = items.length
        ? await video.burnSubtitles({ input: merged.file, out: path.join(dir, `sub-${stamp}.mp4`), items })
        : { file: merged.file };
      const finalOut = out ? path.resolve(out) : path.join(dir, `compose-${stamp}.mp4`);
      const muxed = await video.muxAudio({
        input: subbed.file, out: finalOut, voiceFile: voice?.file ?? '',
        bgmFile: bgmFile || cfg.video.audio.bgmFile,
        bgmGainDb: cfg.video.audio.bgmGainDb,
        voiceGainDb: cfg.video.audio.voiceGainDb
      });
      const cover = await video.cover({ input: muxed.file, out: path.join(dir, `cover-${stamp}.jpg`) });

      for (const f of [...normalized, merged.file, subbed.file]) {
        if (f && f !== finalOut) { try { (await import('node:fs')).rmSync(f, { force: true }); } catch {} }
      }

      return ok({
        file: muxed.file,
        cover: cover.file,
        durationSec: Number(muxed.durationSec.toFixed(2)),
        sizeMB: Number((muxed.sizeBytes / 1024 / 1024).toFixed(2)),
        subtitles: items.length,
        voice: voice ? { durationSec: Number(voice.durationSec.toFixed(2)) } : null
      });
    } catch (error) { return fail(error); }
  }
);

// ── 提示词（这就是「可以放提示词的地方」） ────────────────────────────────────

server.registerTool(
  'ks_prompt_list',
  {
    title: '列出提示词',
    description: '列出 prompts/ 与 state/prompts/ 里的全部提示词（自定义同名会覆盖内置）',
    inputSchema: {}
  },
  async () => {
    try {
      return ok({ dir: cfg.prompts.dir, customDir: cfg.prompts.customDir, active: cfg.prompts.active, prompts: prompts.list() });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_prompt_get',
  {
    title: '读一个提示词',
    description: '返回提示词正文、来源（builtin/custom）与它用到的变量名',
    inputSchema: { id: z.string().min(1) }
  },
  async ({ id }) => {
    try { return ok(prompts.get(id)); } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_prompt_render',
  {
    title: '渲染提示词',
    description: '把 {{变量}} 填成实际值。未知变量会保留原样并记在 missing 里（不会静默变空）',
    inputSchema: {
      id: z.string().min(1),
      vars: z.record(z.string(), z.union([z.string(), z.number()])).default({})
    }
  },
  async ({ id, vars }) => {
    try { return ok(prompts.render(id, vars)); } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_prompt_save',
  {
    title: '保存提示词（自定义覆盖）',
    description: '写到 state/prompts/<id>.md，覆盖内置同名提示词。用 {{变量}} 占位；改完立刻生效，不用重启',
    inputSchema: {
      id: z.string().min(1),
      content: z.string().min(1).describe('markdown 正文，第一行可写 # 标题')
    }
  },
  async ({ id, content }) => {
    try { return ok(prompts.save(id, content)); } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_prompt_reset',
  {
    title: '还原提示词',
    description: '删掉自定义覆盖，让内置版本重新生效',
    inputSchema: { id: z.string().min(1) }
  },
  async ({ id }) => {
    try { return ok(prompts.reset(id)); } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_brief',
  {
    title: '取一份可直接用的提示词（自动填变量）',
    description: 'kind=reply 会顺手读回当前视频的评论并填进去；script/caption/title/ops 会用配置和今日计数填好。拿到就是一段可以直接照做的指令。',
    inputSchema: {
      kind: z.enum(['reply', 'script', 'caption', 'title', 'ops', 'pick', 'persona']).default('reply'),
      topic: z.string().default('').describe('主题（script/title/caption 用）'),
      vars: z.record(z.string(), z.union([z.string(), z.number()])).default({}).describe('额外变量，覆盖自动值'),
      maxReplies: z.number().int().min(1).max(20).default(3),
      durationSec: z.number().int().min(5).max(300).default(30)
    }
  },
  async ({ kind, topic, vars, maxReplies, durationSec }) => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const personaId = cfg.prompts.active.persona;
      let personaSummary = '';
      // 设置页里写了自定义人设正文就优先用它（不再读文件）
      if (cfg.prompts.personaOverride) {
        personaSummary = cfg.prompts.personaOverride;
      } else try {
        const p = prompts.render(personaId, {
          personaName: vars.personaName ?? '快手账号',
          personaBio: vars.personaBio ?? '（人设还没写：ks_prompt_save id=persona 写一段）',
          platform: '快手',
          today
        });
        // 只取人设正文的前几行有效内容，别把标题层级再嵌进别的提示词里
        personaSummary = p.text
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'))
          .slice(0, 8)
          .join('\n');
      } catch {}

      // 把设置页「说话与打字」拼到人设后面（用户不填就是默认值，几乎不改变内置人设）
      personaSummary = applySpeakingGuide(personaSummary, cfg.style);

      const st = state();
      const base = { platform: '快手', today, personaSummary, ...vars };

      if (kind === 'reply' || kind === 'pick') {
        const b = await backend();
        const comments = await b.comments({ keepOpen: true, limit: 40 });
        const list = comments.map((c) => `- ${c.author}：${c.text}`).join('\n') || '(没读到评论)';
        const id = kind === 'reply' ? cfg.prompts.active.reply : cfg.prompts.active.pick;
        const r = prompts.render(id, {
          ...base,
          videoTitle: comments[0]?.videoTitle ?? '(未知)',
          comments: list,
          commentCount: comments.length,
          maxReplies,
          maxChars: cfg.reply.maxChars,
          blacklist: cfg.reply.blacklist.join('、')
        });
        return ok({ promptId: id, source: r.source, missing: r.missing, comments: comments.slice(0, 20), text: r.text });
      }

      if (kind === 'script') {
        const targetChars = Math.round(durationSec * 4.5);
        const r = prompts.render(cfg.prompts.active.script, { ...base, topic: topic || '(未指定)', durationSec, targetChars });
        return ok({ promptId: cfg.prompts.active.script, source: r.source, missing: r.missing, text: r.text });
      }

      if (kind === 'title') {
        const r = prompts.render(cfg.prompts.active.title, { ...base, topic: topic || '(未指定)' });
        return ok({ promptId: cfg.prompts.active.title, source: r.source, missing: r.missing, text: r.text });
      }

      if (kind === 'caption') {
        const r = prompts.render(cfg.prompts.active.caption, {
          ...base,
          videoTitle: topic || '(未指定)',
          summary: vars.summary ?? '',
          captionMax: cfg.publish.captionMax,
          topicsMax: cfg.publish.topicsMax
        });
        return ok({ promptId: cfg.prompts.active.caption, source: r.source, missing: r.missing, text: r.text });
      }

      if (kind === 'ops') {
        const r = prompts.render(cfg.prompts.active.ops, {
          ...base,
          personaName: vars.personaName ?? '快手账号',
          scrollDone: st.data.counts.scroll, replyDone: st.data.counts.reply,
          likeDone: st.data.counts.like, publishDone: st.data.counts.publish,
          scrollQuota: cfg.quotas.scrollPerRun, replyQuota: cfg.quotas.replyPerRun,
          likeQuota: cfg.quotas.likePerRun, publishQuota: cfg.quotas.publishPerDay,
          scrollBatch: 10, replyBatch: 3, likeBatch: 5
        });
        return ok({ promptId: cfg.prompts.active.ops, source: r.source, missing: r.missing, text: r.text });
      }

      const r = prompts.render(cfg.prompts.active.persona, {
        ...base,
        personaName: vars.personaName ?? '快手账号',
        personaBio: vars.personaBio ?? ''
      });
      // kind=persona 也要带上「说话与打字」，否则预览/导出的人设跟实际用的不一致
      const personaText = applySpeakingGuide(cfg.prompts.personaOverride || r.text, cfg.style);
      return ok({ promptId: cfg.prompts.active.persona, source: r.source, missing: r.missing, text: personaText });
    } catch (error) { return fail(error); }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
log(`[kuaishou-ops] MCP ready. project=${projectRoot()} mode=${cfg.mode ?? 'auto'} dryRun=${cfg.dryRun}`);
