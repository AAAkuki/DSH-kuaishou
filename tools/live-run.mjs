// 直播台驱动（录屏版）：AI 玩跳一跳 + 弹幕 + token 余额，录成 mp4。
// 玩法：读局面 → pw=(need-MIN_JUMP)/(MAX_JUMP-MIN_JUMP) → 按住 pw*CHARGE_MS → 松手。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import('playwright-core');

const outDir = path.join(root, 'state', 'live', 'out');
fs.mkdirSync(outDir, { recursive: true });
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await chromium.launch({ executablePath: edge, headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1080, height: 1920 },
  recordVideo: { dir: outDir, size: { width: 1080, height: 1920 } }
});
const page = await ctx.newPage();
await page.goto('file:///' + path.join(root, 'state', 'live', 'stage.html').replace(/\\/g, '/'));
await page.waitForTimeout(900);

const game = page.frames().find((f) => f.url().includes('jump-jump'));
if (!game) throw new Error('游戏 iframe 没加载出来');
await game.waitForFunction(() => window.__jj && window.__jj.read, null, { timeout: 10000 });

const balance = process.env.DS_BALANCE || '';
await page.evaluate((b) => {
  if (b) window.__stage.setBalance(b, 'DeepSeek 账户');
  else window.__stage.setBalance('—', '未配置 key');
}, balance);

const pool = [
  ['小鱼干', '这AI手真稳'], ['路过的猫', '它知道该按多久吗'], ['阿蓝', '跳啊，别站着不动'],
  ['不吃香菜', '这个力度卡得比我好'], ['晚风', '主播是AI吧'], ['大白', '这才叫包浆手感'],
  ['小林', '再来一个完美！'], ['夜航船', 'token 还有多少啊']
];
let dmIdx = 0;
const pushDm = () => page.evaluate(([w, t]) => window.__stage.pushDanmaku(w, t), pool[dmIdx++ % pool.length]);

// 开局前先让画面停一下，录进去
await page.waitForTimeout(1200);
await game.evaluate(() => { const b = document.querySelector('.btn'); if (b) b.click(); });
await page.waitForTimeout(700);

let jumps = 0;
const maxJumps = Number(process.env.JO_MAX || 16);
for (let i = 0; i < maxJumps; i++) {
  const st = await game.evaluate(() => window.__jj.read());
  if (['over', 'dead', 'falling'].includes(st.state)) { await page.waitForTimeout(300); i--; if (i < -3) break; continue; }
  if (st.state !== 'idle') { await page.waitForTimeout(150); i--; continue; }

  const { MIN_JUMP, MAX_JUMP, CHARGE_MS } = st.consts;
  let pw = (st.need - MIN_JUMP) / (MAX_JUMP - MIN_JUMP);
  pw = Math.max(0.06, Math.min(1, pw));
  await game.evaluate(() => window.__jj.press());
  await page.waitForTimeout(Math.round(pw * CHARGE_MS));
  await game.evaluate(() => window.__jj.release());
  if (i % 2 === 0) await pushDm();
  await page.waitForTimeout(700);
  const after = await game.evaluate(() => window.__jj.read());
  await page.evaluate(([s, c]) => window.__stage.setScore(s, c), [after.score, after.combo]);
  jumps += 1;
}

await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(outDir, 'stage.png') });
const video = page.video();
await ctx.close();
await browser.close();

let mp4 = null;
if (video) {
  const webm = await video.path();
  mp4 = path.join(outDir, 'live-stage.mp4');
  const ff = path.join(root, 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe');
  const r = spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-i', webm,
    '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4],
  { encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr?.slice(-300)); mp4 = null; }
}
console.log(JSON.stringify({ ok: true, jumps, screenshot: path.join(outDir, 'stage.png'), video: mp4 }, null, 2));
