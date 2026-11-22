// 直播（快手插件内的功能，和 Vibe 视频无关）
//
// 目标闭环：
//   ① 进直播间（自己的或别人的）→ 读弹幕
//   ② 读 token 余额（DeepSeek /user/balance）
//   ③ 合成"直播台"画面：游戏 + 弹幕 + 余额
//   ④ 推流：把合成画面推给快手的推流地址（拿不到地址就只本地录制）
//
// 设计原则：**拿不到的东西就明说**，不假装开播成功。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { projectRoot } from './config.mjs';

/** 直播间弹幕的常见选择器（快手网页直播页会变，按优先级试） */
export const DANMAKU_SELECTORS = [
  '.chat-item', '.message-item', '.comment-item',
  '[class*="chat"] [class*="item"]', '[class*="danmu"]', '[class*="comment"] [class*="content"]'
];

/** 直播页里有这些字样说明没登录 / 需要下载 App */
export const LIVE_BLOCK_CUES = /登录后|下载快手|打开快手APP|扫码登录|请先登录/;

/**
 * 从直播间页面文本里抽弹幕（纯函数，好测）。
 * 真实页面里一行通常是 `昵称：内容` 或 `昵称 内容`，也夹杂系统消息。
 */
export function parseDanmakuLines(rawLines = [], { limit = 30 } = {}) {
  const IGNORE = /^(说点什么|发送|进入直播间|关注|分享了直播间|点赞了|送出了|欢迎|公告|礼物)/;
  const out = [];
  const seen = new Set(); // 刷屏去重：同一句（谁+内容）只留一条
  for (const raw of rawLines) {
    const line = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!line || line.length > 80) continue;
    if (IGNORE.test(line)) continue;
    const m = /^(.{1,16}?)\s*[:：]\s*(.+)$/.exec(line);
    let who = '';
    let text = '';
    if (m) {
      who = m[1].trim();
      text = m[2].trim();
    } else {
      // 没有冒号：把第一段短词当昵称
      const parts = line.split(' ');
      if (parts.length >= 2 && parts[0].length <= 12) {
        who = parts[0];
        text = parts.slice(1).join(' ').trim();
      }
    }
    if (!who || !text) continue;
    if (!/[\p{L}\p{N}]/u.test(text)) continue; // 纯符号/空白不算一句话
    const key = `${who}\u0000${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ who, text });
  }
  return out.slice(-limit);
}

/** 读当前直播间页面的弹幕 */
export async function readDanmaku(web, { limit = 30 } = {}) {
  const page = await web.ensure();
  const inRoom = /\/live\/|\/u\//.test(page.url()) && /kuaishou\.com/.test(page.url());
  const lines = await page.evaluate((sels) => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const found = [];
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        const t = norm(el.innerText);
        if (t) found.push(t);
      }
      if (found.length >= 8) break;
    }
    if (!found.length) {
      // 兜底：整页文本里找"某人：某话"的行
      const body = String(document.body.innerText || '').split('\n').map(norm).filter(Boolean);
      for (const l of body) if (/^.{1,16}[:：]/.test(l)) found.push(l);
    }
    return found;
  }, DANMAKU_SELECTORS).catch(() => []);
  const blocked = await page.evaluate((re) => new RegExp(re).test(document.body.innerText || ''), LIVE_BLOCK_CUES.source).catch(() => false);
  return { items: parseDanmakuLines(lines, { limit }), blocked, inRoom, url: page.url() };
}

/** 打开一个直播间（www 或 live 域名都行） */
export async function openLiveRoom(web, { url }) {
  const u = normalizeLiveUrl(url) || String(url || '').trim();
  if (!/^https?:\/\/(www\.|live\.)?kuaishou\.com\/.+/.test(u)) {
    throw new Error('直播间链接要是 kuaishou.com 的直播页，例如 https://live.kuaishou.com/u/xxxx');
  }
  const page = await web.ensure({ url: u });
  await web.sleep(3000);
  return { url: page.url(), title: await page.title().catch(() => '') };
}

/**
 * 直播间地址规范化。
 * 快手首页/直播页里的 href 经常是残的（`https//live.kuaishou.com/u/xxx`、或前面被拼了 www 域名），
 * 这里统一拼回能直接打开的链接。
 */
export function normalizeLiveUrl(raw = '') {
  const s = String(raw || '');
  const m = /kuaishou\.com\/?(?:live|u)\/([A-Za-z0-9_-]{5,})/.exec(s);
  if (!m) return '';
  const isLive = /kuaishou\.com\/live\/[A-Za-z0-9_-]{5,}/.test(s);
  return isLive ? `https://live.kuaishou.com/live/${m[1]}` : `https://live.kuaishou.com/u/${m[1]}`;
}

/** 从直播列表页里抽取房间（纯函数，方便测） */
export function parseLiveRooms(items = [], { limit = 20 } = {}) {
  const out = [];
  const seen = new Set();
  for (const it of items) {
    const raw = String(it?.url || '');
    const direct = /^https?:\/\/[a-z.]*kuaishou\.com\/(live|u)\/[A-Za-z0-9_-]+/.exec(raw)?.[0] || '';
    const url = direct ? direct.split('?')[0] : normalizeLiveUrl(raw);
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const title = String(it?.title || '').trim().slice(0, 40);
    const author = String(it?.author || '').trim().slice(0, 20);
    if (!title && !author) continue;
    out.push({ url, title, author });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 列出正在直播的房间（快手直播页的卡片链接）。
 * 页面结构会变，所以同时尝试 <a href> 和卡片上的文本。
 */
export async function listLiveRooms(web, { url = 'https://www.kuaishou.com/live', limit = 20 } = {}) {
  const page = await web.ensure({ url });
  await web.sleep(3000);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9)).catch(() => {});
    await web.sleep(900);
  }
  const raw = await page.evaluate(() => {
    const abs = (h) => { try { return new URL(h, location.href).href; } catch { return ''; } };
    const out = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const href = abs(a.getAttribute('href'));
      if (!/kuaishou\.com\/(live|u)\//.test(href)) continue;
      const box = a.closest('li,div[class*="card"],div[class*="item"]') || a;
      const txt = String(box.innerText || a.innerText || '').replace(/\s+/g, ' ').trim();
      out.push({ url: href, title: txt, author: '' });
    }
    return out;
  }).catch(() => []);
  return { rooms: parseLiveRooms(raw, { limit }), scanned: raw.length, url: page.url() };
}

/**
 * 读 DeepSeek 账户余额。
 * key 来源：参数 → 环境变量 DEEPSEEK_API_KEY → 配置 live.tokenKey。
 * 没有 key 就返回 { ok:false, reason }，不编数字。
 */
export async function tokenBalance({ apiKey = '', timeoutMs = 15000 } = {}) {
  const key = String(apiKey || process.env.DEEPSEEK_API_KEY || '').trim();
  if (!key) return { ok: false, reason: '没有 key（设置里填 live.tokenKey，或设 DEEPSEEK_API_KEY）' };
  try {
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, body };
    const info = (body.balance_infos || [])[0] || {};
    return {
      ok: true,
      available: body.is_available !== false,
      currency: info.currency || 'CNY',
      total: Number(info.total_balance ?? 0),
      granted: Number(info.granted_balance ?? 0),
      toppedUp: Number(info.topped_up_balance ?? 0)
    };
  } catch (error) {
    return { ok: false, reason: String(error.message || error).slice(0, 120) };
  }
}

/** 余额显示成一行字（数字不可信时显示 —，绝不显示 NaN） */
export function formatBalance(b) {
  if (!b || !b.ok) {
    const r = String(b?.reason || '');
    const note = /401|403|invalid|无效|鉴权/i.test(r) ? 'key 无效' : (r ? r.slice(0, 20) : '未配置 key');
    return { value: '—', note };
  }
  const total = Number(b.total);
  if (!Number.isFinite(total)) return { value: '—', note: '余额读取异常' };
  const g = Number.isFinite(Number(b.granted)) ? Number(b.granted) : 0;
  const t = Number.isFinite(Number(b.toppedUp)) ? Number(b.toppedUp) : 0;
  return {
    value: `${total.toFixed(2)} ${b.currency || 'CNY'}`,
    note: `赠送 ${g.toFixed(2)} / 充值 ${t.toFixed(2)}`
  };
}

/**
 * 把合成画面推流到快手。
 *
 * 快手网页端开播：登录态下在开播页能拿到 rtmp 推流地址 + 串流密钥。
 * 拿不到就只能本地录制 —— 会明确返回 ok:false 并说明原因，不假装在播。
 */
export function pushStage({
  ffmpeg, rtmpUrl, streamKey, videoFile = '', fps = 25, size = '1080x1920', bitrate = '2500k', log = () => {}
} = {}) {
  if (!ffmpeg) throw new Error('pushStage 需要 ffmpeg 路径');
  if (!rtmpUrl || !streamKey) {
    return { ok: false, reason: '没有推流地址/密钥：先在快手开播页拿到 rtmp 地址和串流密钥（这一步必须你的账号里点开播）' };
  }
  if (!videoFile || !fs.existsSync(videoFile)) {
    return { ok: false, reason: `推流源不存在：${videoFile}` };
  }
  const target = `${rtmpUrl.replace(/\/+$/, '')}/${streamKey}`;
  const args = ['-hide_banner', '-loglevel', 'warning', '-re', '-stream_loop', '-1', '-i', videoFile,
    '-vf', `scale=${size.replace('x', ':')}:flags=bicubic,fps=${fps}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-b:v', bitrate,
    '-pix_fmt', 'yuv420p', '-g', String(fps * 2), '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-f', 'flv', target];

  // 以前这里没挂 error 处理：ffmpeg 不存在时整个进程会被 uncaughtException 干掉（MCP 服务器直接挂）
  const child = spawn(ffmpeg, args, { detached: true, stdio: 'ignore' });
  child.on('error', (e) => log(`推流进程启动失败：${e.message}`));
  child.unref();

  const pidFile = path.join(projectRoot(), 'state', 'live', 'push.pid');
  try {
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, String(child.pid || ''), 'utf8');
  } catch { /* 写不进去不影响推流 */ }

  return { ok: true, pid: child.pid, pidFile, target: target.replace(streamKey, '***'), args: args.slice(0, 6) };
}

/** 停掉推流（按上次记录的 pid） */
export function stopPush() {
  const pidFile = path.join(projectRoot(), 'state', 'live', 'push.pid');
  if (!fs.existsSync(pidFile)) return { ok: false, reason: '没有正在推流的记录' };
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: 'pid 文件内容不对' };
  try {
    process.kill(pid);
    fs.unlinkSync(pidFile);
    return { ok: true, pid };
  } catch (error) {
    return { ok: false, reason: String(error.message).slice(0, 120) };
  }
}

/** 直播台页面路径（已渲染好的 1080×1920 合成页 + 游戏） */
export function stagePath() {
  return path.join(projectRoot(), 'state', 'live', 'stage.html');
}

/**
 * 让 AI 在直播台上玩跳一跳，顺便录屏。
 * 玩法：读局面 → pw=(need-MIN_JUMP)/(MAX_JUMP-MIN_JUMP) → 按住 pw*CHARGE_MS → 松手。
 * bare=true：只有游戏 + 右下角角色；false（默认）：多三枚胶囊（AI 在玩 / 计时 / 弹幕 / 余额）。
 * 弹幕一律在角色气泡里回，并用发视频那套嗓子念出来（voice=false 可关）。
 */
export async function playStage({
  jumps = 12, record = true, balance = null, danmaku = [], outDir = '', log = () => {}, bare = false,
  replyToDanmaku = true, voice = true
} = {}) {
  const { chromium } = await import('playwright-core');
  const { pickLiveReply, fitBubble } = await import('./live-reply.mjs');
  const { resolveTools } = await import('./video.mjs');
  const { loadConfig } = await import('./config.mjs');
  const { speakLine, fileUrl } = await import('./live-voice.mjs');
  const root = projectRoot();
  const dir = outDir || path.join(root, 'state', 'live', 'out');
  fs.mkdirSync(dir, { recursive: true });
  const useVoice = voice !== false;
  const cfg = loadConfig({});
  const tools = resolveTools({ ffmpegPath: cfg.video?.ffmpegPath, ffprobePath: cfg.video?.ffprobePath });

  const stage = bare ? path.join(root, 'state', 'live', 'stage-bare.html') : stagePath();
  if (!fs.existsSync(stage)) throw new Error(`直播台页面不存在：${stage}（先跑 tools/instrument-jump.mjs 生成）`);

  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const browser = await chromium.launch({
    executablePath: edge, headless: true,
    // 录的时候也要出声（静音输出到系统不影响混音），并把自动播放限制关掉
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio']
  });
  const ctx = await browser.newContext({
    viewport: { width: 1080, height: 1920 },
    ...(record ? { recordVideo: { dir, size: { width: 1080, height: 1920 } } } : {})
  });
  const page = await ctx.newPage();
  const recStart = Date.now();
  await page.goto('file:///' + stage.replace(/\\/g, '/'));
  await page.waitForTimeout(900);

  const game = page.frames().find((f) => f.url().includes('jump-jump'));
  if (!game) throw new Error('游戏 iframe 没加载出来（state/live/jump-jump.html 在不在？）');
  await game.waitForFunction(() => window.__jj && window.__jj.read, null, { timeout: 10000 });

  const overlay = !bare;
  if (overlay && balance) {
    await page.evaluate(([v, n]) => window.__stage?.setBalance?.(v, n), [balance.value, balance.note]).catch(() => {});
  }
  const dmPool = danmaku.length ? danmaku : [
    { who: '小鱼干', text: '这AI手真稳' }, { who: '路过的猫', text: '它知道该按多久吗' },
    { who: '阿蓝', text: '跳啊，别站着不动' }, { who: '不吃香菜', text: '这力度卡得比我好' },
    { who: '晚风', text: '主播是AI吧' }, { who: '大白', text: '这才叫包浆手感' }
  ];

  let replied = 0;
  let dmi = 0;
  let replyBusyUntil = 0; // 上一条（读评论+回话）语音播完的时间点
  const voiceCues = []; // { file, at(ms) }：录完之后按时间点混进去

  // 游戏本体是 WebAudio 振荡器发声（跳跃 500→780 / 落地 190→105 / 完美 880+1175）。
  // 录屏拿不到页面音频，这里按同样的音色和发声音点补进去。
  const sfxDir = path.join(root, 'state', 'live', 'sfx');
  const sfx = {
    jump: path.join(sfxDir, 'jump.wav'),
    land: path.join(sfxDir, 'land.wav'),
    perfect: path.join(sfxDir, 'perfect.wav')
  };
  const hasSfx = fs.existsSync(sfx.jump) && fs.existsSync(sfx.land);
  const { wavDuration } = await import('./live-voice.mjs');
  const sfxMs = hasSfx ? {
    jump: Math.round(wavDuration(sfx.jump, tools.ffprobe) * 1000),
    land: Math.round(wavDuration(sfx.land, tools.ffprobe) * 1000)
  } : { jump: 180, land: 140 };

  const replyInBubble = async () => {
    const d = dmPool[dmi++ % dmPool.length];
    const reply = pickLiveReply(d.text);
    const text = fitBubble(reply);
    const at = Date.now() - recStart;
    await page.evaluate(([t, who]) => { if (window.__pet) window.__pet.say(t, who); }, [text, `回 ${d.who}`]).catch(() => {});
    if (useVoice) {
      // 先念观众这条，再回话（piper 华颜 + cute + soft，和发视频同一个嗓子）。
      // 两条要**错开**排在时间轴上，否则混音时叠在一起听不清。
      let cursor = at;
      for (const line of [`${d.who || '有人'}说，${d.text}`, reply]) {
        const wav = await speakLine(line, { cfg, tools, log });
        if (!wav.ok) { log(`语音合成失败：${wav.reason}`); continue; }
        voiceCues.push({ file: wav.file, at: cursor });
        cursor += Math.round(wavDuration(wav.file, tools.ffprobe) * 1000) + 120;
        await page.evaluate((u) => { window.__voice?.play([u]).catch(() => {}); }, fileUrl(wav.file)).catch(() => {});
      }
      replyBusyUntil = cursor;
    }
    replied += 1;
    if (overlay) {
      await page.evaluate((n) => { window.__stage?.setDanmakuCount?.(n); }, replied).catch(() => {});
    }
    return text;
  };

  const startGame = () => game.evaluate(() => { document.querySelector('.btn')?.click(); }).catch(() => {});

  await page.waitForTimeout(900);
  await startGame();
  await page.waitForTimeout(600);

  const { decideAction } = await import('./live-agent.mjs');
  let played = 0;
  let score = 0;
  let combo = 0;
  let stuck = 0;
  let thrown = 0;
  while (played < jumps && stuck < 60) {
    const st = await game.evaluate(() => window.__jj.read()).catch(() => null);
    if (!st) { await page.waitForTimeout(300); stuck += 1; continue; }

    const act = decideAction(st);

    // 被杀/结算/未开始 → 重开，别把死亡页录进去
    if (act.action === 'restart') {
      await page.waitForTimeout(600);
      await startGame();
      await page.waitForTimeout(700);
      stuck += 1;
      continue;
    }

    // v2：敌人逼近就用道具打（先选道具 → 瞄敌人 → 投掷）
    if (act.action === 'throw') {
      const ok = await game.evaluate((item) => {
        const j = window.__jj;
        if (!j.selectItem || !j.aimAtEnemy) return false;
        j.selectItem(item);
        j.aimAtEnemy();
        return !!j.throwNow();
      }, act.item).catch(() => false);
      if (ok) {
        thrown += 1;
        log(`扔${act.item}（敌人 ${act.distance.toFixed(2)}）`);
        const t = Date.now() - recStart;
        if (hasSfx) voiceCues.push({ file: sfx.land, at: t }); // 投掷给一声音效点
      }
      await page.waitForTimeout(420);
      continue;
    }

    if (act.action !== 'press') { await page.waitForTimeout(150); stuck += 1; continue; }

    // consts 由 decideAction 已经算好力度了，这里不再碰 st.consts（v2 的读取里也没有它）
    const { MIN_JUMP, MAX_JUMP } = st.consts || { MIN_JUMP: 1.2, MAX_JUMP: 4.9 };
    const pw = act.power;
    const jumpAt = Date.now() - recStart;
    await game.evaluate(() => window.__jj.press()).catch(() => {});
    if (hasSfx) voiceCues.push({ file: sfx.jump, at: jumpAt }); // 起跳音
    await page.waitForTimeout(act.holdMs);
    const releaseAt = Date.now() - recStart;
    await game.evaluate(() => window.__jj.release()).catch(() => {});
    if (hasSfx) {
      // 落地音按跳一次的真实时长排（游戏里 dur = 300 + dist*58 毫秒）
      const dist = MIN_JUMP + pw * (MAX_JUMP - MIN_JUMP);
      const landAt = releaseAt + Math.round(300 + dist * 58);
      voiceCues.push({ file: sfx.land, at: landAt });
    }

    // 一条念完再念下一条：上一条语音还没播完就不开口
    const freeToTalk = (Date.now() - recStart) >= replyBusyUntil;
    if (replyToDanmaku && played % 2 === 1 && freeToTalk) {
      log(`回弹幕：${await replyInBubble()}`);
    }
    await page.waitForTimeout(680);
    const after = await game.evaluate(() => window.__jj.read()).catch(() => null);
    if (after) { score = after.score; combo = after.combo; }
    played += 1;
    stuck = 0;
  }

  await page.waitForTimeout(1200);
  const shot = path.join(dir, bare ? 'game-only.png' : 'stage.png');
  await page.screenshot({ path: shot });
  const video = page.video();
  await ctx.close();
  await browser.close();

  let mp4 = '';
  if (record && video) {
    const webm = await video.path();
    const ff = path.join(root, 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe');
    mp4 = path.join(dir, `live-${Date.now()}.mp4`);
    // 有语音提示点就按时间点混进去（读评论 + 回话，都用发视频那套嗓子）
    const cues = voiceCues.filter((c) => fs.existsSync(c.file));
    let args;
    if (cues.length) {
      const inputs = [];
      cues.forEach((c, i) => inputs.push(['-i', c.file]));
      // 旧版 ffmpeg 不认 adelay 的 all=1、也不认 amix 的 normalize
      // → 按通道给延迟，amix 之后按路数把音量补回来
      const delays = cues.map((c, i) => `[${i + 1}:a]adelay=${Math.max(0, Math.round(c.at))}[a${i}]`);
      const mixIn = cues.map((_, i) => `[a${i}]`).join('');
      const filter = `${delays.join(';')};${mixIn}amix=inputs=${cues.length},volume=${cues.length}[aout]`;
      args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', webm, ...inputs.flat(),
        '-filter_complex', filter, '-map', '0:v', '-map', '[aout]',
        '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', mp4];
    } else {
      args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', webm,
        '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4];
    }
    const r = spawnSync(ff, args, { encoding: 'utf8' });
    if (r.status !== 0) { log(`转码失败：${String(r.stderr).slice(-200)}`); mp4 = ''; }
    // 中间那个 webm 不删会一直堆在 out 目录里（一场几十 MB）
    if (mp4 && fs.existsSync(webm)) {
      try { fs.unlinkSync(webm); } catch { /* 被占用就算了 */ }
    }
  }
  return {
    played, score, combo, screenshot: shot, video: mp4, bare, replied,
    spoken: voiceCues.length,
    partial: played < jumps
  };
}
