// 探路 3：直播伴侣页（live-partner）—— 看是只能下 PC 端，还是有网页开播/推流地址
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import('playwright-core');
const profile = path.join(root, '.web-profile');
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const out = path.join(root, 'state', 'live', 'probe');
fs.mkdirSync(out, { recursive: true });

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: edge, headless: false, viewport: { width: 1440, height: 1000 },
  args: ['--no-first-run', '--no-default-browser-check']
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto('https://live.kuaishou.com/live-partner', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(4000);

const info = await page.evaluate(() => {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const html = document.documentElement.outerHTML;
  const rtmp = [...new Set((html.match(/rtmp:\/\/[^\s"'<>]+/g) || []))].slice(0, 10);
  const links = [...document.querySelectorAll('a[href]')].map((a) => ({ t: norm(a.innerText).slice(0, 20), h: a.href })).filter((x) => x.t).slice(0, 30);
  const btns = [...document.querySelectorAll('button,div[role="button"],a')]
    .map((e) => norm(e.innerText)).filter((t) => t && t.length <= 16 && /下载|开播|网页|推流|直播/.test(t));
  return { url: location.href, title: document.title, text: norm(document.body.innerText).slice(0, 1800), rtmp, links, btns: [...new Set(btns)].slice(0, 20) };
});
await page.screenshot({ path: path.join(out, 'live-partner.png') });
console.log(JSON.stringify(info, null, 2));
await ctx.close();
