// 诊断：直播窗口在不同尺寸下到底看到什么（截图存 state/live/diag/）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import('playwright-core');
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const stage = 'file:///' + path.join(root, 'state', 'live', 'stage-bare.html').replace(/\\/g, '/');
const out = path.join(root, 'state', 'live', 'diag');
fs.mkdirSync(out, { recursive: true });

const screen = await (async () => {
  const b = await chromium.launch({ executablePath: edge, headless: true });
  const p = await b.newPage();
  const s = await p.evaluate(() => ({ w: screen.width, h: screen.height, availW: screen.availWidth, availH: screen.availHeight, dpr: devicePixelRatio }));
  await b.close();
  return s;
})();
console.log('屏幕:', JSON.stringify(screen));

const sizes = [[1080, 1920], [608, 1080], [540, 960]];
for (const [w, h] of sizes) {
  const browser = await chromium.launch({ executablePath: edge, headless: true });
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  await page.goto(stage, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  const game = page.frames().find((f) => f.url().includes('jump-jump'));
  const ok = game ? await game.evaluate(() => !!(window.__jj && window.__jj.read)) : false;
  await page.screenshot({ path: path.join(out, `stage-${w}x${h}.png`) });
  console.log(`${w}x${h}: iframe=${!!game} gameReady=${ok}`);
  await ctx.close();
  await browser.close();
}
