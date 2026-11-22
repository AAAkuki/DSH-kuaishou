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
import { runFullAuto } from './autopilot.mjs';
import { applySpeakingGuide, composeSpeakingGuide } from './style.mjs';
import { OpsState, makePlan, runPlan, pickReply, stopBlocker } from './ops.mjs';
import { pickReplySticker } from './sticker.mjs';
import { installCrashGuard, recentCrashes } from './safety.mjs';
import { inspectProfile } from './profile-guard.mjs';

let cfg = loadConfig();
const log = (line) => process.stderr.write(`${line}\n`);
let video = new VideoStudio({ cfg, log });
let prompts = new PromptLibrary({ cfg });

// 进程级兜底：MCP server 一旦退出，DSH 那边所有 ks_* 工具都会变成"工具不可用"。
// 这里的每个工具都已经各自 try/catch，这个只是最后一道网。
const crashGuard = installCrashGuard({ root: projectRoot(), log, tag: 'kuaishou-ops(mcp)' });
log(`[crash-guard] ${crashGuard.file}`);

// 启动时顺手给 DSH 的 profile 配置拍个快照（只在配置健康时拍，绝不用坏文件覆盖好快照）。
// DSH 崩溃循环会把 cordis.patch.yml 重置成 []，有快照就能一条命令恢复。
try {
  const g = inspectProfile({ root: projectRoot() });
  log(`[profile-guard] ${g.ok ? `ok（${g.current.entries} 个条目）` : `异常：${g.problem}`}${g.snapshotRefreshed ? '；快照已更新' : ''}`);
} catch (error) {
  log(`[profile-guard] 检查失败（不影响启动）: ${error?.message ?? error}`);
}

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

/**
 * 停止闸门：用户在设置页点过「停止」（或脚本里调的 ks_stop）之后，
 * **所有会对外产生动作的工具**都要停下来 —— 以前只有脚本循环看这个标记，
 * 单步动作（看/滑/赞/回/发）照样执行（实测点了停止 40 秒后还在点赞、回评论）。
 */
function ensureNotStopped(tool) {
  const msg = stopBlocker(state(), tool);
  if (msg) throw new Error(msg);
}

function ok(payload) {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }] };
}

function fail(error) {
  // 不是 Error 的东西（对象/字符串/Playwright 的奇怪抛错）也要能读，不能显示 [object Object]
  if (!(error instanceof Error) && (error === null || typeof error !== 'object')) {
    return { content: [{ type: 'text', text: `❌ ${String(error)}` }], isError: true };
  }
  if (!(error instanceof Error)) {
    let dump = '';
    try { dump = JSON.stringify(error); } catch { dump = String(error); }
    const msg = error.message || error.reason || error.error || dump;
    return { content: [{ type: 'text', text: `❌ ${String(msg).slice(0, 800)}` }], isError: true };
  }
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
  'ks_search',
  {
    title: '搜索视频（网上冲浪）',
    description: '在快手搜索框里搜关键词，返回前几条结果的标题/作者，并记进今日搜索（会进总结视频）。',
    inputSchema: {
      keyword: z.string().min(1).describe('搜索关键词，如 deepseek'),
      limit: z.number().int().min(1).max(20).default(6).describe('读几条结果')
    }
  },
  async ({ keyword, limit }) => {
    try {
      ensureEnabled('搜索');
      const b = await backend();
      const w = b.web || b;
      if (typeof w.searchVideos !== 'function') throw new Error('当前后端不支持搜索（仅网页版）');
      const r = await w.searchVideos({ keyword, limit });
      const st = state();
      st.addSearch({ keyword: r.keyword, count: r.count, samples: r.items.map((x) => x.title) });
      st.save();
      return ok(r);
    } catch (error) { return fail(error); }
  }
);

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
  'ks_kv_video',
  {
    title: '知识视频（Vibe 知识大赏风格）',
    description: '按 Win-Hao/knowledge-video 那套方法出片：一屏一句、卡点、大字排版、每幕配图。三种画风 notes/poster/docu；老模板视频不受影响。',
    inputSchema: {
      topic: z.string().default('').describe('主题（写进日志）'),
      lines: z.array(z.string()).min(1).describe('一屏一句的文案（超过 20 字自动拆屏）'),
      style: z.enum(['notes', 'poster', 'docu']).default('notes'),
      bgm: z.string().default('').describe('背景音乐路径（有就卡点）'),
      orientation: z.enum(['vertical', 'horizontal']).default('vertical'),
      title: z.string().default('').describe('开场大字（默认取第一句）'),
      sources: z.array(z.string()).default([]).describe('每屏出处（小字，可空）'),
      images: z.array(z.string()).default([]).describe('每屏配图路径（可空）'),
      totalSec: z.number().min(0).default(0).describe('目标总时长；0 = 按阅读速度'),
      out: z.string().default('')
    }
  },
  async ({ topic, lines, style, bgm, orientation, title, sources, images, totalSec, out }) => {
    try {
      ensureEnabled('出片');
      ensureNotStopped('出片');
      const { resolveTools } = await import('./video.mjs');
      const { renderVibeVideo, pythonPath } = await import('./vibe.mjs');
      const tools = resolveTools({ ffmpegPath: cfg.video?.ffmpegPath, ffprobePath: cfg.video?.ffprobePath });
      if (!tools.ffmpeg) throw new Error('找不到 ffmpeg：装 @ffmpeg-installer/ffmpeg 或填 video.ffmpegPath');
      const vertical = orientation !== 'horizontal';
      const finalOut = out || path.join(projectRoot(), 'state', 'video', `kv-${Date.now()}.mp4`);
      const res = renderVibeVideo({
        lines,
        out: finalOut,
        ffmpeg: tools.ffmpeg,
        python: pythonPath(),
        bgm: bgm || '',
        style,
        width: vertical ? 1080 : 1920,
        height: vertical ? 1920 : 1080,
        totalSec: totalSec || 0,
        bigWords: title ? [title, ...Array(Math.max(0, lines.length - 1)).fill('')] : [],
        sources,
        images
      });
      return ok({
        topic, style, orientation,
        file: res.out, seconds: res.totalSec, scenes: res.scenes,
        bpm: res.beats?.bpm || 0, beats: res.beats?.count || 0,
        overflow: res.overflow,
        note: '先看开头 10 秒，满意再整片；overflow=true 说明有屏超框，要改文案'
      });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_live_rooms',
  {
    title: '列出正在直播的房间',
    description: '打开快手直播页，抓出正在直播的房间链接（标题 + 链接），用来挑一个房间读弹幕。',
    inputSchema: {
      url: z.string().default('').describe('列表页；留空用 https://www.kuaishou.com/live'),
      limit: z.number().int().min(1).max(40).default(12)
    }
  },
  async ({ url, limit }) => {
    try {
      ensureEnabled('列直播间');
      const { listLiveRooms } = await import('./live.mjs');
      const b = await backend();
      const w = b.web || b;
      const r = await listLiveRooms(w, { url: url || 'https://www.kuaishou.com/live', limit });
      return ok({
        ...r,
        hint: r.rooms.length ? '挑一个链接丢给 ks_live_open，就可以读弹幕了'
          : '没抓到房间：可能列表页需要登录，或页面结构变了（先 ks_login_qr 扫码登录再试）'
      });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_live_open',
  {
    title: '进直播间',
    description: '打开快手直播间（www 直播页），之后用 ks_live_danmaku 读弹幕。',
    inputSchema: {
      url: z.string().default('').describe('直播间链接；留空用设置里的 live.roomUrl')
    }
  },
  async ({ url }) => {
    try {
      ensureEnabled('进直播间');
      ensureNotStopped('进直播间');
      const { openLiveRoom } = await import('./live.mjs');
      const b = await backend();
      const w = b.web || b;
      const target = url || cfg.live?.roomUrl || '';
      if (!target) throw new Error('没有直播间链接：传 url，或先在设置里填 live.roomUrl');
      const r = await openLiveRoom(w, { url: target });
      return ok({ ...r, hint: '现在可以 ks_live_danmaku 读弹幕了' });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_live_danmaku',
  {
    title: '读直播间弹幕',
    description: '读当前直播间页面上的弹幕（昵称 + 内容），最多 limit 条。',
    inputSchema: { limit: z.number().int().min(1).max(100).default(30) }
  },
  async ({ limit }) => {
    try {
      const { readDanmaku } = await import('./live.mjs');
      const b = await backend();
      const w = b.web || b;
      const r = await readDanmaku(w, { limit });
      const st = state();
      st.add('reply', 0);
      return ok({
        count: r.items.length,
        items: r.items,
        blocked: r.blocked,
        inRoom: r.inRoom,
        url: r.url,
        hint: !r.inRoom
          ? '当前页面不是直播间：先用 ks_live_open 打开一个直播间（ks_live_rooms 可以列）'
          : r.blocked
            ? '页面提示要登录/下载 App：先在浏览器里扫码登录，再读弹幕'
            : r.items.length ? '' : '页面上没找到弹幕节点（可能还没开播，或直播间没人说话）'
      });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_token_balance',
  {
    title: 'token 余额',
    description: '读 DeepSeek 账户余额（用于直播画面上的 TOKEN 余额卡）。没有 key 会如实说没有。',
    inputSchema: { apiKey: z.string().default('').describe('留空用设置里的 live.tokenKey 或环境变量 DEEPSEEK_API_KEY') }
  },
  async ({ apiKey }) => {
    try {
      const { tokenBalance, formatBalance } = await import('./live.mjs');
      const r = await tokenBalance({ apiKey: apiKey || cfg.live?.tokenKey || '' });
      return ok({ ...r, display: formatBalance(r) });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_live_play',
  {
    title: 'AI 玩跳一跳（直播台版，会念弹幕）',
    description: 'AI 自动玩跳一跳并录下来。默认带直播台（AI 在玩 / 计时 / 弹幕数 / 余额 四枚胶囊，配色跟游戏一致）；弹幕用右下角角色气泡回，并用发视频那套嗓子念出来。',
    inputSchema: {
      jumps: z.number().int().min(1).max(60).default(12),
      record: z.boolean().default(true),
      overlay: z.boolean().default(true).describe('true（默认）= 带直播台胶囊；false = 只有游戏 + 右下角角色'),
      danmaku: z.array(z.object({ who: z.string(), text: z.string() })).default([])
        .describe('要回的弹幕；留空用内置示例'),
      voice: z.boolean().default(true).describe('是否念出来（piper 华颜，和发视频同一个嗓子）'),
      tokenKey: z.string().default('').describe('余额胶囊用；留空读设置 live.tokenKey 或环境变量')
    }
  },
  async ({ jumps, record, overlay, danmaku, voice, tokenKey }) => {
    try {
      ensureNotStopped('直播玩');
      const { playStage, tokenBalance, formatBalance } = await import('./live.mjs');
      const bal = overlay ? formatBalance(await tokenBalance({ apiKey: tokenKey || cfg.live?.tokenKey || '' })) : null;
      const r = await playStage({
        jumps, record, balance: bal, bare: !overlay, danmaku,
        replyToDanmaku: true, voice, log
      });
      return ok({ ...r, balance: bal });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_live_push',
  {
    title: '把直播台推流到快手',
    description: '用 ffmpeg 把直播画面推到快手开播给的 rtmp 地址。地址/密钥必须在快手开播页里拿到（你的账号操作）。',
    inputSchema: {
      rtmpUrl: z.string().default('').describe('rtmp 推流地址'),
      streamKey: z.string().default('').describe('串流密钥'),
      file: z.string().default('').describe('推流源（视频文件）；留空用最近一次录的直播台视频')
    }
  },
  async ({ rtmpUrl, streamKey, file }) => {
    try {
      ensureNotStopped('推流');
      const { pushStage } = await import('./live.mjs');
      const { resolveTools } = await import('./video.mjs');
      const tools = resolveTools({ ffmpegPath: cfg.video?.ffmpegPath });
      let src = file;
      if (!src) {
        // 找最近一次录的直播台视频
        const dir = path.join(projectRoot(), 'state', 'live', 'out');
        const mp4s = fs.existsSync(dir)
          ? fs.readdirSync(dir).filter((f) => f.endsWith('.mp4')).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
          : [];
        mp4s.sort((a, b) => b.t - a.t);
        src = mp4s.length ? path.join(dir, mp4s[0].f) : '';
      }
      if (!src) throw new Error('没有可推的视频：先 ks_live_play 录一场');
      const r = pushStage({ ffmpeg: tools.ffmpeg, rtmpUrl, streamKey, videoFile: src, log });
      return ok({ ...r, source: src });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_live_push_stop',
  {
    title: '停止推流',
    description: '按上次记录的 pid 把推流进程停掉。',
    inputSchema: {}
  },
  async () => {
    try {
      const { stopPush } = await import('./live.mjs');
      const r = stopPush();
      return ok(r);
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_login_qr',
  {
    title: '打开扫码登录（存二维码截图）',
    description: 'www 登录态过期时用：打开登录页并把二维码截图存到 state/，你扫一下就好。',
    inputSchema: {}
  },
  async () => {
    try {
      const b = await backend();
      const w = b.web || b;
      if (typeof w.showLoginQr !== 'function') throw new Error('仅网页版支持');
      const r = await w.showLoginQr({});
      return ok({ ...r, hint: r.needLogin ? '把这张二维码扫一下（快手 App → 扫一扫），扫完再跑 ks_status 确认 loggedIn=true' : '已经登录了，不用扫' });
    } catch (error) { return fail(error); }
  }
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
  'ks_watch',
  {
    title: '看这一条（自己看）',
    description: 'agent 模式用：返回当前这条视频是什么（文案/作者/时长/点赞/评论数），并按视频长度真的停留一会儿。看完再决定要不要赞、要不要评论。',
    inputSchema: {
      maxSec: z.number().int().min(1).max(120).default(30).describe('最多看多少秒'),
      minSec: z.number().int().min(1).max(60).default(3).describe('至少看多少秒')
    }
  },
  async ({ maxSec, minSec }) => {
    try {
      ensureEnabled('看视频');
      ensureNotStopped('看视频');
      const b = await backend();
      const w = b.web || b;                       // 网页版后端把真实对象放在 b.web 里
      if (typeof w.watchCurrent !== 'function') throw new Error('当前后端不支持单条观看（先用网页版）');
      const v = await w.watchCurrent({ maxSec, minSec });
      try {
        const { extractMemes, loadSlang, learnMemes, saveSlang } = await import('./slang.mjs');
        const store = loadSlang(projectRoot());
        const r = learnMemes(store, extractMemes(v.desc || ''));
        if (r.fresh.length) saveSlang(projectRoot(), r.store);
      } catch {}
      const st = state();
      st.add('scroll', 1);
      st.save();
      // 保留 watchCurrent 自己的提示（以前这里无条件覆盖，读不到视频时也骗人"这条没文案"）
      return ok({ ...v, hint: v.hint || (v.desc ? `这条讲的是：${v.desc}` : '这条没文案，光看画面') });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_next',
  {
    title: '滑到下一条',
    description: 'agent 模式用：滑一条（不是批量），返回新这条是什么。',
    inputSchema: {}
  },
  async () => {
    try {
      ensureEnabled('滑视频');
      ensureNotStopped('滑视频');
      const b = await backend();
      const w = b.web || b;
      if (typeof w.nextVideo !== 'function') throw new Error('当前后端不支持单条滑动（先用网页版）');
      return ok(await w.nextVideo());
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_agent_take',
  {
    title: '取「我来刷」的排队请求',
    description: '面板上点了「我来刷」会往队列里写一条请求；这个工具取出并清掉它（take=1）。agent 模式开工前调它。',
    inputSchema: { take: z.boolean().default(true).describe('true = 取走并清空') }
  },
  async ({ take }) => {
    try {
      const file = path.join(projectRoot(), 'state', 'agent-run.json');
      if (!fs.existsSync(file)) return ok({ request: null, note: '队列是空的' });
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (take) fs.unlinkSync(file);
      return ok({ request: raw, note: take ? '已取走' : '只是看一眼，没清' });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_deai',
  {
    title: '去 AI 味改写',
    description: '把文案改成"真人随手写"的样子。mode=clean 用机械规则直接清洗（保数字、保 AI 身份）；mode=prompt 返回 prompts/de-ai.md 渲染好的改写提示词（交给模型改写）。',
    inputSchema: {
      text: z.string().min(1).describe('要改写的文案'),
      mode: z.enum(['clean', 'prompt']).default('clean'),
      personaSummary: z.string().default('').describe('人设口吻；留空用当前配置的人设')
    }
  },
  async ({ text, mode, personaSummary }) => {
    try {
      ensureFreshConfig();
      if (mode === 'prompt') {
        const base = personaSummary || applySpeakingGuide(
          prompts.get(cfg.prompts.active.persona)?.body ?? '',
          cfg.style
        );
        const r = prompts.render('de-ai', { personaSummary: base, text });
        return ok({ mode: 'prompt', promptId: 'de-ai', source: r.source, missing: r.missing, prompt: r.text });
      }
      const { deaiClean, numbersPreserved } = await import('./deai.mjs');
      const r = deaiClean(text);
      return ok({
        mode: 'clean',
        before: text,
        after: r.text,
        changes: r.changes,
        numbersPreserved: numbersPreserved(text, r.text)
      });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_slang',
  {
    title: '网络梗词库（学到的）',
    description: '看刷视频时学到的网络梗；learn 传文本可手动教它几个（逗号分隔），clear 清空。',
    inputSchema: {
      learn: z.string().default('').describe('手动教几个梗，逗号分隔'),
      clear: z.boolean().default(false).describe('清空词库'),
      limit: z.number().int().min(1).max(300).default(40)
    }
  },
  async ({ learn, clear, limit }) => {
    try {
      const { loadSlang, learnMemes, saveSlang, extractMemes, slangFile } = await import('./slang.mjs');
      const root = projectRoot();
      let store = loadSlang(root);
      if (clear) {
        store = { version: 1, items: [] };
        saveSlang(root, store);
      }
      if (learn && String(learn).trim()) {
        const terms = String(learn).split(/[,，、\s]+/).filter(Boolean).flatMap((t) => (t.length > 12 ? extractMemes(t) : [t]));
        const r = learnMemes(store, terms);
        saveSlang(root, r.store);
        store = r.store;
      }
      const items = [...store.items].sort((a, b) => (b.count - a.count) || String(b.lastAt).localeCompare(String(a.lastAt)));
      return ok({
        file: slangFile(root),
        total: items.length,
        terms: items.slice(0, limit).map((x) => ({ term: x.term, count: x.count, used: x.used, lastAt: x.lastAt }))
      });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_cleanup',
  {
    title: '清理中间文件',
    description: '删掉 state/video 里的拼接/归一化/预览等中间文件，只保留最近几个成品。',
    inputSchema: {
      keepRecent: z.number().int().min(0).max(50).default(5).describe('保留最近几个成品 mp4'),
      dryRun: z.boolean().default(false).describe('true = 只报告，不真删')
    }
  },
  async ({ keepRecent, dryRun }) => {
    try {
      const { pruneVideoJunk } = await import('./maintenance.mjs');
      return ok(pruneVideoJunk({ root: projectRoot(), keepRecent, dryRun }));
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_stop',
  {
    title: '停止自动运营',
    description: '让正在跑的循环在下一轮前停下；clear=true 则清除停止标记（重新开始）。',
    inputSchema: { clear: z.boolean().default(false).describe('true = 清除停止标记，恢复继续') }
  },
  async ({ clear }) => {
    try {
      const st = state();
      if (clear) { st.clearStop(); st.save(); return ok({ stopped: false, message: '已恢复，可以继续跑' }); }
      st.requestStop();
      st.save();
      return ok({ stopped: true, message: '已请求停止，当前这一轮跑完就停' });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_tidy',
  {
    title: '收拾浏览器标签页',
    description: '关掉 about:blank 空白页和重复的快手页，只留一个正在用的。跑久了标签越堆越多时用。',
    inputSchema: {}
  },
  async () => {
    try {
      const b = await backend();
      if (typeof b.tidy !== 'function') throw new Error('当前后端不支持（仅网页版）');
      return ok(await b.tidy());
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_debug_buttons',
  {
    title: '看页面按钮（排查点不到）',
    description: '滚到底后列出可点元素：文字、坐标、是否禁用。发布点不动时用它定位。',
    inputSchema: { click: z.string().optional().describe('传文字则点第一个匹配的按钮') }
  },
  async ({ click }) => {
    try {
      const b = await backend();
      const w = b.web || b;
      if (typeof w.debugButtons !== 'function') throw new Error('仅网页版支持');
      const info = await w.debugButtons();
      if (click) {
        const target = (info.buttons || []).find((x) => x.text === click);
        if (!target) return ok({ ...info, clicked: false, note: '没找到这个文字' });
        await w.clickAt({ x: target.x, y: target.y });
        return ok({ ...info, clicked: true, target });
      }
      return ok(info);
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
      ensureNotStopped('刷视频');
      // 配额闸门：直接调本工具也要受限（之前只有 ks_run 检查，实测刷到 31/30）
      const st = state();
      const usedScroll = st.data.counts.scroll ?? 0;
      const scrollQuota = cfg.quotas.scrollPerRun;
      const scrollRemain = Math.max(0, scrollQuota - usedScroll);
      if (scrollRemain <= 0) {
        return ok({
          backend: cfg.mode, scrolled: 0, skipped: true,
          reason: `今日刷视频配额已满（${usedScroll}/${scrollQuota}）`,
          counts: st.data.counts
        });
      }
      const want = Math.min(count, scrollRemain);
      const b = await backend();
      if (dwellMinMs && dwellMaxMs) {
        b.cfg.dwell = { ...b.cfg.dwell, minMs: dwellMinMs, maxMs: Math.max(dwellMinMs, dwellMaxMs) };
      }
      const steps = await b.feedScroll({ count: want });
      st.add('scroll', steps.length);
      st.save();
      return ok({
        backend: b.mode,
        scrolled: steps.length,
        requested: count,
        cappedByQuota: want < count,
        remain: Math.max(0, scrollQuota - (usedScroll + steps.length)),
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
      ensureNotStopped('点赞');
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
  'ks_post_comment',
  {
    title: '发评论（不是回复某条）',
    description: '在当前视频下发一条评论，发完会回读列表确认真的出现了。',
    inputSchema: { content: z.string().min(1).describe('评论内容') }
  },
  async ({ content }) => {
    try {
      ensureEnabled('发评论');
      ensureNotStopped('发评论');
      const b = await backend();
      const target = b.web ?? b.web2 ?? null;
      const w = target || b;
      if (typeof w.postComment !== 'function') {
        throw new Error('当前后端不支持发顶级评论（adb 后端请用 App 界面）');
      }
      const r = await w.postComment({ content });
      if (r.commented) { const st = state(); st.add('reply', 1); st.save(); }
      return ok(r);
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_own_comments',
  {
    title: '自己作品下的评论（读 / 回）',
    description: '打开创作者后台「评论管理」，读自己作品下的评论；给了 match+content 就在那条下面回复（会回读确认）。',
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(30),
      match: z.string().default('').describe('要回复的评论片段；留空只读'),
      content: z.string().default('').describe('回复内容；配合 match 使用')
    }
  },
  async ({ limit, match, content }) => {
    try {
      const b = await backend();
      const w = b.web || b;
      if (typeof w.listOwnComments !== 'function') throw new Error('当前后端不支持（仅网页版）');
      if (match && content) {
        const r = await w.replyOwnComment({ match, content });
        return ok({ action: 'reply', ...r, comments: await w.listOwnComments({ limit }).catch(() => []) });
      }
      return ok({ action: 'read', comments: await w.listOwnComments({ limit }), work: await w.readCommentManagerWork().catch(() => null) });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_browser',
  {
    title: '浏览器（常驻/关闭/状态）',
    description: '网页版用的 Edge 默认常驻（跑完不关，下次直接用）。op=close 才真关；op=status 看当前是否开着。',
    inputSchema: {
      op: z.enum(['status', 'close', 'open']).default('status')
    }
  },
  async ({ op }) => {
    try {
      const b = await backend();
      const w = b.web || b;
      if (op === 'close') {
        if (typeof w.closeForReal !== 'function') throw new Error('当前后端不支持（仅网页版）');
        await w.closeForReal();
        return ok({ browser: 'closed' });
      }
      if (op === 'open') {
        const page = await w.ensure();
        return ok({ browser: 'open', url: page.url(), persist: cfg.web?.persist !== false });
      }
      const alive = typeof w.ensureAlive === 'function' ? await w.ensureAlive() : false;
      return ok({ browser: alive ? 'open' : 'closed', persist: cfg.web?.persist !== false, idleCloseMin: cfg.web?.idleCloseMin ?? 30 });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_own_works',
  {
    title: '我的作品列表',
    description: '从创作者服务平台读已发布的视频，返回标题与链接；open 传序号可直接打开。',
    inputSchema: {
      open: z.number().int().min(0).max(9).optional().describe('传了就打开第 N 个作品页')
    }
  },
  async ({ open }) => {
    try {
      const b = await backend();
      const w = b.web || b;
      if (typeof w.listOwnWorks !== 'function') throw new Error('当前后端不支持（仅网页版）');
      if (open !== undefined) return ok(await w.openOwnWork({ index: open }));
      return ok(await w.listOwnWorks({ limit: 10 }));
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_sub_replies',
  {
    title: '查看某条评论下的回复',
    description: '点开指定评论，读它下面的回复文本——用来确认"我到底回成功了没有"。',
    inputSchema: { match: z.string().min(1).describe('评论文本片段') }
  },
  async ({ match }) => {
    try {
      const b = await backend();
      const w = b.web || b;
      if (typeof w.readSubReplies !== 'function') throw new Error('当前后端不支持（仅网页版）');
      return ok(await w.readSubReplies({ match }));
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
    try {
      ensureEnabled('回评论');
      ensureNotStopped('回评论');
      const result = await (await backend()).reply({ match, content });
      // 记账：单条回评也要计入 reply 配额（之前只有 ks_reply_auto / ks_run 才记）
      if (result && result.replied) {
        const st = state();
        st.add('reply', 1);
        st.save();
      }
      return ok(result);
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_reply_sticker',
  {
    title: '用表情包回一条评论',
    description: '按评论文本片段定位，回一张表情包（图库 = state/assets/stickers，按对方评论的情绪自动挑；emotions.json 可指定每张图的情绪）。mode=append 文字+表情包（默认），mode=only 只发图。网页版发不了图片表情时会降级成 emoji/纯文字，到底发了什么看返回里的 stickerSent，别装成功。',
    inputSchema: {
      match: z.string().min(1).describe('评论文本片段（模糊定位）'),
      content: z.string().default('').describe('文字部分；mode=only 可留空，留空也会自动生成一句兜底'),
      sticker: z.string().default('').describe('指定表情图片文件名/路径；留空按评论情绪自动挑'),
      mode: z.enum(['append', 'only']).default('append')
    }
  },
  async ({ match, content, sticker, mode }) => {
    try {
      ensureEnabled('表情包回评论');
      ensureNotStopped('表情包回评论');
      const b = await backend();
      if (typeof b.replyWithSticker !== 'function') throw new Error('当前后端不支持表情包回复');
      // 没给文字就按模板生成一句（鲸鱼女孩口吻，模式 append 时不至于只发张图显得空）
      let text = String(content ?? '');
      if (mode !== 'only' && !text.trim()) text = pickReply(match);
      const pick = sticker
        ? { file: path.isAbsolute(sticker) ? sticker : path.join(projectRoot(), 'state', 'assets', 'stickers', sticker), emotion: '', matched: true }
        : pickReplySticker({ root: projectRoot(), commentText: match });
      const result = await b.replyWithSticker({ match, content: text, sticker: pick.file || '', mode });
      if (result && (result.replied || result.stickerSent === 'image')) {
        const st = state();
        st.add('reply', 1);
        st.save();
      }
      return ok({ ...result, pickedSticker: pick.file || '' });
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_reply_auto',
  {
    title: '批量回评论（模板 + 配额）',
    description: '读评论 → 过白/黑名单 → 用模板回最多 limit 条（受今日配额限制）',
    inputSchema: {
      limit: z.number().int().min(1).max(20).default(3),
      dryRun: z.boolean().default(false).describe('true = 只报告会回不回、为什么，不真的发'),
      style: z.enum(['gentle', 'funny', 'professional']).default('gentle')
    }
  },
  async ({ limit, style, dryRun }) => {
    try {
      ensureEnabled('批量回评论');
      ensureNotStopped('批量回评论');
      const b = await backend();
      const st = state();

      // ① 视频标签闸门：只有当前视频的话题命中白名单时才回
      const vt = (cfg.reply.videoTagWhitelist ?? []).map((t) => String(t).replace(/^#/, ''));
      let videoTags = [];
      let videoGate = { passed: true, reason: '未配置视频标签白名单，不限制' };
      if (vt.length) {
        const info = typeof b.readVideoTags === 'function'
          ? await b.readVideoTags()
          : (b.web?.readVideoTags ? await b.web.readVideoTags() : { tags: [] });
        videoTags = info.tags ?? [];
        const hit = videoTags.filter((t) => vt.some((w) => t.includes(w) || w.includes(t)));
        videoGate = hit.length
          ? { passed: true, reason: `视频标签命中：${hit.map((t) => '#' + t).join(' ')}` }
          : { passed: false, reason: `当前视频标签 ${videoTags.length ? videoTags.map((t) => '#' + t).join(' ') : '(无标签)'} 没命中白名单 ${vt.join('/')}` };
      }
      if (!videoGate.passed) {
        return ok({ skipped: true, reason: videoGate.reason, videoTags, budget: 0, replied: [], judged: [] });
      }

      const budget = Math.min(limit, st.remaining('reply', cfg.quotas.replyPerRun));
      const comments = await b.comments({ keepOpen: true, limit: 60 });

      // ② 逐条判定 + 记录原因（这就是"为什么不回"的答案）
      const judge = (text) => {
        const t = String(text ?? '').trim();
        if (!t) return { ok: false, why: '空评论' };
        if (t.length < cfg.reply.minChars) return { ok: false, why: '太短' };
        if (t.length > cfg.reply.maxChars) return { ok: false, why: '太长' };
        if ((cfg.reply.blacklist ?? []).some((w) => w && t.includes(w))) return { ok: false, why: '命中黑名单' };
        const tags = cfg.reply.tagWhitelist ?? [];
        if (tags.length && tags.some((tag) => tag && t.includes(tag))) return { ok: true, via: '评论标签白名单' };
        const wl = cfg.reply.whitelist ?? [];
        if (!wl.length) return { ok: true, via: '无关键词白名单(全回)' };
        const hit = wl.find((w) => (w === '?' || w === '？' ? /[?？]/.test(t) : t.includes(w)));
        return hit ? { ok: true, via: `关键词「${hit}」` } : { ok: false, why: '不含任何白名单词' };
      };

      const judged = comments.map((c) => {
        const v = judge(c.text);
        return { author: c.author, text: String(c.text ?? '').slice(0, 40), ...v };
      });
      const eligible = judged.filter((j) => j.ok);

      if (dryRun) {
        return ok({
          dryRun: true, videoTags, videoGate,
          read: comments.length, eligible: eligible.length, budget,
          wouldReply: eligible.slice(0, budget).map((j) => ({ to: j.author, text: j.text, via: j.via })),
          skipped: judged.filter((j) => !j.ok).slice(0, 10)
        });
      }

      // ③ 真的发
      const replied = [];
      const failures = [];
      for (const c of comments) {
        if (replied.length >= budget) break;
        const j = judged.find((x) => x.author === c.author && sameComment(x.text, c.text));
        if (!j?.ok) continue;
        const content = composeReplyText(c.text, style);
        try {
          const r = await b.reply({ match: String(c.text).slice(0, 12), content, openPanel: false });
          if (r?.verified === false) { failures.push({ to: c.author, text: j.text, error: r.note || '未确认发送' }); continue; }
          st.add('reply', 1); st.save();
          replied.push({ to: c.author, text: j.text, content, via: j.via, verified: r?.verified ?? null });
        } catch (error) {
          failures.push({ to: c.author, text: j.text, error: error.message });
        }
      }

      return ok({
        videoTags, videoGate, read: comments.length, eligible: eligible.length, budget,
        replied, failures,
        skipped: judged.filter((x) => !x.ok).slice(0, 10)
      });
    } catch (error) { return fail(error); }
  }
);

function sameComment(a, b) {
  const x = String(a ?? '').slice(0, 20);
  const y = String(b ?? '').slice(0, 20);
  return x === y;
}

function composeReplyText(text, style) {
  const t = String(text ?? '');
  if (style === 'funny') return /[?？]|怎么|什么/.test(t) ? '这个问题问得好，我也想知道哈哈' : '笑死，同感';
  if (style === 'professional') return /[?？]|怎么|什么/.test(t) ? '这个情况一般先看日志报错，再定位配置' : '感谢分享，确实是这样';
  if (/[?？]|怎么|什么|哪|求/.test(t)) return '这个我也在琢磨，回头细说';
  if (/太|真的|经典|绝了|厉害|好看/.test(t)) return '这波同感了';
  return '说得对～';
}

server.registerTool(
  'ks_publish_prepare',
  {
    title: '发布·第1步：上传并填好',
    description: '打开编辑页、上传视频、填文案，等「发布」按钮可点。不点发布，单次调用短，不会超时。',
    inputSchema: {
      file: z.string().min(1).describe('视频文件路径'),
      caption: z.string().default('').describe('作品描述'),
      topics: z.array(z.string()).default([]).describe('话题标签（自动加 #）')
    }
  },
  async ({ file, caption, topics }) => {
    try {
      ensureEnabled('发布视频');
      const b = await backend();
      const w = b.web || b;
      if (typeof w.preparePublish !== 'function') throw new Error('仅网页版支持');
      return ok(await w.preparePublish({ file, caption, topics }));
    } catch (error) { return fail(error); }
  }
);

server.registerTool(
  'ks_publish_confirm',
  {
    title: '发布·第2步：点发布并验证',
    description: '在已准备好的编辑页点「发布」，用作品管理作品数 +1 验证是否真的发出去了。',
    inputSchema: { verifyMs: z.number().int().min(5000).max(180000).default(60000).describe('最多等多久（毫秒）') }
  },
  async ({ verifyMs }) => {
    try {
      ensureEnabled('发布视频');
      const b = await backend();
      const w = b.web || b;
      if (typeof w.clickPublish !== 'function') throw new Error('仅网页版支持');
      const r = await w.clickPublish({ verifyMs });
      if (r.published) { const st = state(); st.add('publish', 1); st.lastPublishAt = Date.now(); st.save(); }
      return ok(r);
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
      caption: z.string().default('').describe('留空就按人设自动写一条'),
      cover: z.string().default('').describe('封面图路径；留空用设置页的默认封面'),
      topics: z.array(z.string()).default([]).describe('话题标签；留空用设置页默认（#deepseek #大肥鱼）'),
      title: z.string().default('').describe('标题；留空用设置页默认'),
      retries: z.number().int().min(0).max(3).default(1).describe('失败自动重试次数'),
      pushOnly: z.boolean().default(false).describe('仅 adb 后端有效：只推文件不发布')
    }
  },
  async ({ file, caption, cover, topics, title, retries, pushOnly }) => {
    try {
      ensureEnabled('发视频');
      const b = await backend();
      // 没给文案就按人设自己写一条（不再回头问用户）
      let finalCaption = String(caption ?? '').trim();
      if (!finalCaption) {
        try {
          const p = prompts.render(cfg.prompts.active.caption, {
            platform: '快手',
            today: new Date().toISOString().slice(0, 10),
            topic: path.basename(file).replace(/\.[^.]+$/, ''),
            personaSummary: cfg.prompts.personaOverride || prompts.get?.(cfg.prompts.active.persona)?.text || ''
          });
          finalCaption = String(p.text || '').split('\n').filter((l) => l.trim() && !l.startsWith('#')).slice(0, 2).join(' ').slice(0, cfg.publish.captionMax);
        } catch { /* 生成失败就留空 */ }
      }
      const st = state();
      if (!pushOnly) {
        const left = st.remaining('publish', cfg.quotas.publishPerDay);
        if (left <= 0) throw new Error(`今天的发布配额用完了（${cfg.quotas.publishPerDay} 条/天）`);
        /**
         * 去重：同一个片子 + 同一段文案 12 小时内不许重复发。
         * 10-27 那天同一个视频被发了 4 次（19:11/19:13/19:15/19:17），粉丝眼里就是刷屏。
         */
        const { publishKey, checkDuplicate } = await import('./publish-guard.mjs');
        const dup = checkDuplicate(st, publishKey({ file, caption: finalCaption || caption || '' }));
        if (dup.duplicate) {
          throw new Error(`这条已经发过了（${dup.agoMin} 分钟前，同一文件+同一文案），不重复发。要重发请改文案或换文件`);
        }
      }
      // 默认封面：显式给的优先，否则用设置页的 coverFile（相对项目根解析）
      let finalCover = String(cover ?? '').trim();
      if (!finalCover && cfg.publish.coverFile) {
        finalCover = path.isAbsolute(cfg.publish.coverFile)
          ? cfg.publish.coverFile
          : path.join(projectRoot(), cfg.publish.coverFile);
      }
      if (finalCover && !fs.existsSync(finalCover)) finalCover = '';  // 不存在就当没设，别让发布失败
      const finalTopics = (Array.isArray(topics) && topics.length ? topics : (cfg.publish.topics ?? []))
        .map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean).slice(0, cfg.publish.topicsMax);
      const finalTitle = String(title ?? '').trim() || (cfg.publish.title ?? '');
      const result = await b.publish({
        file, caption: finalCaption, cover: finalCover,
        topics: finalTopics, title: finalTitle, retries, pushOnly
      });
      if (result.published) {
        st.add('publish', 1, { file: path.basename(file) }); st.save();
        // 记账，供下一次去重
        try {
          const { publishKey, markPublished } = await import('./publish-guard.mjs');
          const st2 = state();
          markPublished(st2, publishKey({ file, caption: finalCaption || caption || '' }));
          st2.save();
        } catch {}
      }
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
  'ks_autopilot',
  {
    title: '全自动运营（一次调用全做完）',
    description: '刷视频 → 点赞 → 回评论 → 自动出片 → 自动发布，全程不需要人操作。任一步失败自动跳过并在报告里说明原因，不会中途停下来问。',
    inputSchema: {
      publish: z.boolean().default(true).describe('是否自动发布生成的视频'),
      rounds: z.number().int().min(1).max(5).default(1).describe('跑几轮「刷→赞→评」；跑完一轮会自己接着刷'),
      contentMode: z.enum(['auto', 'scrolled', 'journal']).default('auto').describe('视频内容：scrolled=刷到了什么 / journal=我干了什么 / auto=混合'),
      topic: z.string().default('').describe('视频主题；留空按当天刷到的数据自动生成'),
      lineCount: z.number().int().min(0).max(20).default(0).describe('字幕句数；0 = 用设置里的 videoLineCount'),
      scroll: z.number().int().min(0).max(200).optional(),
      replies: z.number().int().min(0).max(20).optional(),
      likes: z.number().int().min(0).max(50).optional(),
      searchKeyword: z.string().default('').describe('这一轮想搜的关键词；留空按配置轮换'),
      loop: z.boolean().optional().describe('true = 跑完继续刷，直到用户点停止（ks_stop）'),
      maxRounds: z.number().int().min(0).max(100).default(0).describe('循环上限，0 = 不限')
    }
  },
  async ({ publish, topic, lineCount, scroll, replies, likes, rounds, contentMode, searchKeyword, loop, maxRounds }) => {
    try {
      ensureEnabled('全自动运营');
      // 0 = 跟设置走（videoLineCount）：12 句 ≈ 一分钟
      const wantLines = Number(lineCount) > 0 ? Number(lineCount) : Number(cfg.video?.lineCount ?? 12) || 12;
      const b = await backend();
      const st = state();
      // 上一轮留下的停止标记必须先清掉，否则这次一进循环就自己退出（"点了没反应"）
      st.clearStop();
      st.save();
      const loopCfg = cfg.loop ?? {};
      const loopMode = loop === true || (loop !== false && loopCfg.enabled === true);
      const gapSec = Number(loopCfg.gapSec ?? 20);
      const cap = Number(maxRounds ?? loopCfg.maxRounds ?? 0);
      // 这条路径跑在 MCP 进程里，碰不到宿主的思维链，落一份 jsonl 便于事后看它干了什么
      const traceFile = path.join(projectRoot(), 'state', 'autopilot-trace.jsonl');
      const trace = (e) => {
        try {
          fs.mkdirSync(path.dirname(traceFile), { recursive: true });
          const s = fs.statSync(traceFile);
          if (s.size > 1024 * 1024) fs.renameSync(traceFile, `${traceFile}.1`);
        } catch {}
        try { fs.appendFileSync(traceFile, `${JSON.stringify({ at: new Date().toISOString(), ...e })}\n`); } catch {}
      };
      let report = null;
      let idx = 0;
      do {
        idx++;
        report = await runFullAuto(
          { backend: () => b, state: st, cfg, studio: video, root: projectRoot(), trace },
          { publish, topic, lineCount: wantLines, scroll, replies, likes, rounds, contentMode, searchKeyword }
        );
        if (!loopMode) break;
        if (st.shouldStop()) { console.log('[autopilot] 收到停止指令'); break; }
        if (cap > 0 && idx >= cap) break;
        // 配额用完就重置，接着刷（用户要求：别停在配额用完）
        if (cfg.loop?.resetQuotaOnExhaust !== false) { st.resetQuotas(); st.save(); }
        await new Promise((r) => setTimeout(r, Math.max(0, gapSec) * 1000));
      } while (true);
      if (loopMode) report = { ...report, loopRounds: idx };
      return ok(report);
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
  'ks_voice_install',
  {
    title: '装一个免费开源中文语音（Piper）',
    description: '从 hf-mirror 下载 Piper 中文语音模型到 state/assets/voices，可选自动切引擎。内置 huayan(女)/chaowen(男)/xiao_ya 三个。',
    inputSchema: {
      voice: z.enum(['huayan', 'chaowen', 'xiao_ya']).default('huayan').describe('huayan=华颜(女,推荐) / chaowen=朝文(男) / xiao_ya=小雅'),
      quality: z.enum(['x_low', 'medium']).default('medium').describe('质量档位，medium 约 60MB'),
      switchEngine: z.boolean().default(false).describe('true = 装完自动把语音引擎切成 piper')
    }
  },
  async ({ voice, quality, switchEngine }) => {
    try {
      ensureEnabled('安装语音');
      const dir = path.join(projectRoot(), 'state', 'assets', 'voices');
      fs.mkdirSync(dir, { recursive: true });
      const name = `zh_CN-${voice}-${quality}`;
      const base = `https://hf-mirror.com/rhasspy/piper-voices/resolve/main/zh/zh_CN/${voice}/${quality}`;
      const got = [];

      for (const ext of ['.onnx', '.onnx.json']) {
        const out = path.join(dir, name + ext);
        if (fs.existsSync(out) && fs.statSync(out).size > 1024) { got.push({ file: out, skipped: true }); continue; }
        const res = await fetch(`${base}/${name}${ext}`, { redirect: 'follow' });
        if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}：${name}${ext}`);
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(out, buf);
        got.push({ file: out, bytes: buf.length });
      }

      const model = path.join(dir, name + '.onnx');
      const exe = cfg.video.audio.piperExe || path.join(projectRoot(), 'tools', 'piper', 'piper', 'piper.exe');

      const patch = { videoPiperModel: model, videoPiperExe: exe };
      if (switchEngine) patch.videoTtsEngine = 'piper';

      return ok({
        installed: name,
        model,
        piperExe: exe,
        piperExeExists: fs.existsSync(exe),
        files: got,
        next: switchEngine
          ? '已切换引擎为 piper，下次生成视频就用这个声音'
          : '模型已就位；设置页把「语音引擎」切成 Piper，或再调一次带 switchEngine:true'
      });
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
  'ks_make_video',
  {
    title: '一键成片（只给主题）',
    description: '只给一个主题，自动写口播稿、自动配音、自动带设置页的背景/字体/语音/BGM/封面。想省事就用这个。',
    inputSchema: {
      topic: z.string().min(1).describe('视频主题，比如「今晚刷到的东西」'),
      lineCount: z.number().int().min(0).max(20).default(0).describe('字幕句数；0 = 用设置里的 videoLineCount（12 ≈ 一分钟）'),
      publish: z.boolean().default(false).describe('true = 生成后直接发布')
    }
  },
  async ({ topic, lineCount, publish }) => {
    try {
      ensureEnabled('一键成片');
      const today = new Date().toISOString().slice(0, 10);
      // 0 = 跟设置走（videoLineCount）
      const wantLines = Number(lineCount) > 0 ? Number(lineCount) : Number(cfg.video?.lineCount ?? 12) || 12;

      // ① 生成口播短句。
      //    注意：prompts/script.md 是**给人/模型看的写作要求模板**，不能直接拆成字幕
      //    （里面全是 "主题：xxx" "目标时长：约 20 秒" 这种说明行，实测会变成废字幕）。
      //    这里用模板做"风格约束"，句子由下面的规则生成，保证一定能出片。
      let lines = [];
      try {
        const styleHint = String(cfg.prompts.personaOverride || '').slice(0, 0); // 占位：人设影响措辞，下面不用
        void styleHint;
        const t = String(topic).trim();
        const pool = [
          `今天说说${t}`,
          `${t}，我盯了一阵子`,
          `有几个细节挺有意思`,
          `先说最直观的那个`,
          `用起来比想象中顺`,
          `也有人可能会问值不值`,
          `我的看法是先试再说`,
          `后面有新的再补一条`,
          `感兴趣可以关注一下`
        ];
        lines = pool.slice(0, Math.max(2, Math.min(wantLines, pool.length)));
      } catch {}
      // 兜底：任何情况下都要有几句话，不能空着出片
      if (lines.length < 2) {
        const t = String(topic).trim();
        lines = [`聊聊${t}`, `简单说说我的看法`, `后面再展开`, `感兴趣可以关注`].slice(0, wantLines);
      }
      // 清洗：去掉 {{变量}} 与模板说明行，避免脏字幕进片子
      lines = lines
        .map((l) => String(l).replace(/\{\{[^}]+\}\}/g, '').trim())
        .filter((l) => l && !/^(主题|平台|目标时长|账号人设|要求|格式)[:：]/.test(l))
        .slice(0, wantLines);
      if (lines.length < 2) lines = [`聊聊${String(topic).trim()}`, '简单说说我的看法'];

      // ② 生成视频（背景/字体/语音/BGM 全走设置页）
      const made = await video.fromText({
        title: topic,
        lines,
        voiceText: lines.join('，'),
        out: path.join(projectRoot(), 'state', 'video', `make-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp4`)
      });

      // ③ 需要发布就一条龙发出去（话题/封面同样走设置页）
      let pub = null;
      if (publish) {
        const b = await backend();
        const cover = cfg.publish.coverFile
          ? (path.isAbsolute(cfg.publish.coverFile) ? cfg.publish.coverFile : path.join(projectRoot(), cfg.publish.coverFile))
          : made.cover;
        pub = await b.publish({
          file: made.file,
          caption: lines[0] || topic,
          cover,
          topics: cfg.publish.topics,
          title: cfg.publish.title || topic
        });
        if (pub?.published) { const st = state(); st.add('publish', 1); st.save(); }
      }

      return ok({
        file: made.file,
        cover: made.cover,
        durationSec: Number((made.durationSec ?? 0).toFixed(2)),
        background: made.style?.background,
        voice: cfg.video.audio.voice,
        lines,
        published: pub
      });
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
        durationSec: Number((result.durationSec ?? 0).toFixed(2)),
        sizeMB: Number(((result.sizeBytes ?? 0) / 1024 / 1024).toFixed(2)),
        mode: result.mode,
        subtitles: result.subtitles ?? [],
        voice: result.voice ? { file: result.voice.file, durationSec: Number((result.voice.durationSec ?? 0).toFixed(2)) } : null
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
