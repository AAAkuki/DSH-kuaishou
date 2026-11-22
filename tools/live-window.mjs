// 直播画面窗口（直播台版）：有头 Edge 窗口显示「游戏 + 直播台胶囊 + 右下角角色」，
// AI 一直玩，弹幕从 state/live/danmaku.jsonl 里读，读到就：气泡回一句 + 用发视频那套嗓子念出来。
//
// 用法：快手直播伴侣 → 添加「窗口采集」→ 选这个窗口 → 开播。
//   node tools/live-window.mjs            # 直播台版（有胶囊）
//   node tools/live-window.mjs --bare     # 只有游戏+角色
//   node tools/live-window.mjs --size 405x720 --no-play
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import('playwright-core');
const { pickLiveReply, fitBubble } = await import('../src/live-reply.mjs');
const { speakLine, wavDuration } = await import('../src/live-voice.mjs');
const { loadConfig } = await import('../src/config.mjs');
const { resolveTools } = await import('../src/video.mjs');
const { tokenBalance, formatBalance } = await import('../src/live.mjs');

const cfg = loadConfig({});
const tools = resolveTools({ ffmpegPath: cfg.video?.ffmpegPath, ffprobePath: cfg.video?.ffprobePath });
const log = (m) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`);

const args = process.argv.slice(2);
const sizeArg = args.includes('--size') ? args[args.indexOf('--size') + 1] : 'fit';
const autoPlay = !args.includes('--no-play');
const bareMode = args.includes('--bare');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const stageFile = path.join(root, 'state', 'live', bareMode ? 'stage-bare.html' : 'stage.html');
const stageUrl = 'file:///' + stageFile.replace(/\\/g, '/');
const queueFile = path.join(root, 'state', 'live', 'danmaku.jsonl');

if (!fs.existsSync(stageFile)) {
  console.error(`找不到直播画面：${stageFile}`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(queueFile), { recursive: true });
if (!fs.existsSync(queueFile)) fs.writeFileSync(queueFile, '', 'utf8');

/** 播一串 wav（系统播放器，顺序播；直播伴侣采系统声音就能听到） */
function playOnHost(files = []) {
  const list = files.filter((f) => f && fs.existsSync(f));
  if (!list.length) return false;
  const cmds = list.map((f) => `(New-Object Media.SoundPlayer '${String(f).replace(/'/g, "''")}').PlaySync()`).join('; ');
  try {
    const ps = spawn('powershell.exe', ['-NoProfile', '-Command', cmds], { stdio: 'ignore', windowsHide: true });
    ps.on('error', () => {});
    ps.unref?.();
    return true;
  } catch {
    return false;
  }
}

/* ---------- 窗口尺寸：默认按屏幕算一个刚好放得下的 9:16 ---------- */
let W = 1080;
let H = 1920;
if (sizeArg !== 'fit') {
  const m = /^(\d+)x(\d+)$/.exec(String(sizeArg));
  if (!m) { console.error('--size 要写成 405x720'); process.exit(2); }
  W = Number(m[1]); H = Number(m[2]);
} else {
  const probe = await chromium.launch({ executablePath: EDGE, headless: true });
  const p = await probe.newPage();
  const s = await p.evaluate(() => ({ w: screen.availWidth, h: screen.availHeight })).catch(() => ({ w: 1280, h: 720 }));
  await probe.close();
  const availH = Math.max(480, s.h - 40);
  const availW = Math.max(270, s.w - 20);
  H = Math.floor(Math.min(availH, availW * (1920 / 1080)));
  W = Math.floor(H * (1080 / 1920));
}

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: false,
  args: [
    `--window-size=${W},${H}`, '--window-position=0,0',
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required'
  ]
});
const page = browser.contexts()[0]?.pages()[0] || (await browser.newPage());
await page.goto(stageUrl, { waitUntil: 'load' });
await page.waitForTimeout(1000);

const game = page.frames().find((f) => f.url().includes('jump-jump'));
if (!game) { console.error('游戏 iframe 没加载出来'); process.exit(1); }
await game.waitForFunction(() => window.__jj && window.__jj.read, null, { timeout: 15000 });

/* ---------- 余额 ---------- */
const bal = formatBalance(await tokenBalance({ apiKey: cfg.live?.tokenKey || '' }));
await page.evaluate(([v, n]) => { if (window.__stage?.setBalance) window.__stage.setBalance(v, n); }, [bal.value, bal.note])
  .catch(() => {});
log(`余额卡：${bal.value}${bal.note ? `（${bal.note}）` : ''}`);

/* ---------- 弹幕队列 ---------- */
const FALLBACK_DM = [
  { who: '小鱼干', text: '这AI手真稳' },
  { who: '路过的猫', text: '它是AI吧' },
  { who: '阿蓝', text: '跳啊别停' },
  { who: '不吃香菜', text: 'token 还有多少' }
];
let fb = 0;
let offset = 0;
const pending = [];
function readNewDanmaku() {
  try {
    const buf = fs.readFileSync(queueFile, 'utf8');
    // 文件被清空/重写时 offset 会大于长度，必须归零，否则从此再也读不到
    if (buf.length < offset) offset = 0;
    if (buf.length === offset) return;
    const chunk = buf.slice(offset);
    const lastNl = chunk.lastIndexOf('\n');
    // 只吃完整的行，半截行留到下一轮（避免 JSON 解析失败丢一条）
    if (lastNl < 0) return;
    offset += lastNl + 1;
    for (const line of chunk.slice(0, lastNl).split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const o = JSON.parse(s);
        if (o && typeof o.text === 'string' && o.text.trim()) {
          pending.push({ who: String(o.who || '观众').slice(0, 16), text: o.text.trim().slice(0, 60) });
        }
      } catch { /* 坏行跳过 */ }
    }
    // 直播里弹幕可能刷得比回话快，队列别无限涨
    while (pending.length > 20) pending.shift();
  } catch { /* 文件被占用时下一轮再读 */ }
}

/* 语音排队：一句一句排到时间轴上播，避免两条声音叠在一起 */
let audioUntil = 0;
function scheduleAudio(files) {
  const list = (files || []).filter((f) => f && fs.existsSync(f));
  if (!list.length) return false;
  const now = Date.now();
  const wait = Math.max(0, audioUntil - now);
  const totalMs = list.reduce((a, f) => a + wavDuration(f, tools.ffprobe) * 1000, 0) + 150 * list.length;
  audioUntil = now + wait + totalMs;
  const fire = () => playOnHost(list);
  if (wait > 0) setTimeout(fire, wait);
  else fire();
  return true;
}

let dmTotal = 0;
async function sayBubble(d) {
  const reply = pickLiveReply(d.text);
  const text = fitBubble(reply);
  await page.evaluate(([t, who]) => { if (window.__pet) window.__pet.say(t, who); }, [text, `回 ${d.who}`]).catch(() => {});
  dmTotal += 1;
  await page.evaluate((n) => { if (window.__stage?.setDanmakuCount) window.__stage.setDanmakuCount(n); }, dmTotal).catch(() => {});

  // 说话：先念观众这条，再回话（和发视频同一个嗓子：piper 华颜 + cute + soft）
  const wavs = [];
  for (const line of [`${d.who}说，${d.text}`, reply]) {
    const r = await speakLine(line, { cfg, tools, log });
    if (r.ok) wavs.push(r.file);
    else log(`语音合成失败：${r.reason}`);
  }
  const queued = scheduleAudio(wavs);
  log(`回弹幕 ${d.who}：${d.text} → ${text}${queued ? '（已排进语音队列）' : '（没念出来）'}`);
}

/* ---------- 开局 ---------- */
async function pressStart() {
  await game.evaluate(() => {
    const btn = document.querySelector('.btn');
    if (btn) btn.click();
  }).catch(() => {});
}

// 把游戏的 WebAudio 唤醒：直播里没人点页面，不唤醒的话跳跃/落地音效全哑
const audioState = await game.evaluate(() => {
  try { window.__jj.sound(true); return window.__jj.audio(); } catch { return 'none'; }
}).catch(() => 'none');
log(`游戏音效：AudioContext = ${audioState}${audioState === 'running' ? '（有声音）' : '（可能没声音）'}`);

await pressStart();
await page.waitForTimeout(700);

log(`直播画面已打开 ${W}x${H}（${bareMode ? '纯净' : '直播台'}）；Ctrl+C 或关窗口结束`);

/* ---------- 主循环：一条弹幕念完再念下一条 ---------- */
let jumps = 0;
let stuck = 0;
let lastSpokenJump = 0;
const speakIdle = () => Date.now() >= audioUntil; // 语音队列播完了才轮到下一条
while (true) {
  readNewDanmaku();

  if (!autoPlay) {
    if (pending.length && speakIdle()) await sayBubble(pending.shift());
    await page.waitForTimeout(400);
    continue;
  }

  const st = await game.evaluate(() => window.__jj.read()).catch(() => null);
  if (!st) {
    await page.waitForTimeout(800);
    continue;
  }

  // 结算/未开始 → 重开，直播不能停在结算页
  if (st.state === 'over' || st.state === 'ready' || st.state === 'dead') {
    if (pending.length && speakIdle()) await sayBubble(pending.shift());
    await page.waitForTimeout(900);
    await pressStart();
    await page.waitForTimeout(700);
    stuck = 0;
    continue;
  }
  if (st.state !== 'idle') {
    await page.waitForTimeout(150);
    stuck += 1;
    if (stuck > 120) { await pressStart(); stuck = 0; }
    continue;
  }

  const { MIN_JUMP, MAX_JUMP, CHARGE_MS } = st.consts;
  let pw = (st.need - MIN_JUMP) / (MAX_JUMP - MIN_JUMP);
  if (!Number.isFinite(pw)) pw = 0.5;
  pw = Math.max(0.06, Math.min(1, pw));

  await game.evaluate(() => window.__jj.press()).catch(() => {});
  await page.waitForTimeout(Math.round(pw * CHARGE_MS));
  await game.evaluate(() => window.__jj.release()).catch(() => {});
  jumps += 1;
  stuck = 0;
  await page.waitForTimeout(680);

  // 一次只念一条：上一条（读评论+回话）语音播完，才开口念下一条
  if (speakIdle()) {
    const hasPending = pending.length > 0;
    // 有真弹幕就优先念真弹幕；没有的话每两跳说一句自说自话
    if (hasPending) {
      await sayBubble(pending.shift());
      lastSpokenJump = jumps;
    } else if (jumps - lastSpokenJump >= 2) {
      await sayBubble(FALLBACK_DM[fb++ % FALLBACK_DM.length]);
      lastSpokenJump = jumps;
    }
  }
}
